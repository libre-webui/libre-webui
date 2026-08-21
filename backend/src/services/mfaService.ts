/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * TOTP multi-factor authentication: enrollment, activation, verification,
 * one-time recovery codes, the admin step-up policy, and short-lived login
 * challenge tokens.
 *
 * Secrets are AES-GCM encrypted at rest; recovery codes are stored only as
 * keyed one-way lookup tokens. Challenge tokens are signed with a secret
 * derived from (but distinct from) the session JWT secret, so a challenge
 * can never authenticate a request, and each token is one-use through the
 * coordinator cache.
 */

import jwt from 'jsonwebtoken';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { JWT_SECRET } from './authService.js';
import { getCoordinator } from '../platform/coordination/service.js';
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';
import {
  buildOtpauthUrl,
  generateTotpSecret,
  verifyTotpCode,
} from '../utils/totp.js';
import { createLogger } from '../utils/logger.js';
import type { StoredMfaRecoveryCodeRecord } from '../persistence/securityTypes.js';

const logger = createLogger('services:mfa');

const mfaRepository = () =>
  getPersistence(encryptionService).repositories.security.mfa;

const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Challenge tokens use a derived secret so they can never pass as session JWTs. */
const CHALLENGE_SECRET = createHmac('sha256', JWT_SECRET)
  .update('libre:mfa-challenge:v1')
  .digest();

export type MfaChallengePurpose = 'mfa-verify' | 'mfa-enroll';

export class MfaError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

const normalizeRecoveryCode = (code: string): string =>
  code.toUpperCase().replace(/[\s-]/g, '');

const recoveryCodeLookup = (userId: string, code: string): string =>
  encryptionService.purposeLookupToken(
    'mfa-recovery-code',
    `${userId}:${normalizeRecoveryCode(code)}`
  );

const generateRecoveryCode = (): string => {
  const bytes = randomBytes(10);
  let code = '';
  for (let index = 0; index < 10; index++) {
    code += RECOVERY_ALPHABET[bytes[index] % RECOVERY_ALPHABET.length];
    if (index === 4) code += '-';
  }
  return code;
};

export type MfaRequiredMode = 'optional' | 'required';

const parseMode = (value: string | null | undefined): MfaRequiredMode | null =>
  value === 'optional' || value === 'required' ? value : null;

/** Whether the step-up policy is pinned by environment configuration. */
export const mfaRequiredModeLockedByEnv = (): boolean =>
  parseMode(process.env.MFA_REQUIRED_MODE) !== null;

export const getMfaRequiredMode = async (): Promise<MfaRequiredMode> => {
  const pinned = parseMode(process.env.MFA_REQUIRED_MODE);
  if (pinned) return pinned;
  try {
    return parseMode(await getSystemSetting('mfa_required_mode')) ?? 'optional';
  } catch (error) {
    logger.warn('Failed to read MFA policy; defaulting to optional', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 'optional';
  }
};

export const setMfaRequiredMode = async (
  mode: MfaRequiredMode
): Promise<void> => {
  if (mfaRequiredModeLockedByEnv()) {
    throw new MfaError('The MFA policy is pinned by MFA_REQUIRED_MODE', 409);
  }
  await setSystemSetting('mfa_required_mode', mode);
};

export interface MfaStatus {
  totpEnabled: boolean;
  totpPending: boolean;
  recoveryCodesRemaining: number;
  required: boolean;
  requiredModeLocked: boolean;
}

export const getMfaStatus = async (userId: string): Promise<MfaStatus> => {
  const record = await mfaRepository().find(userId);
  const totpEnabled = record?.activated_at != null;
  return {
    totpEnabled,
    totpPending: record !== null && record.activated_at == null,
    recoveryCodesRemaining: totpEnabled
      ? await mfaRepository().countUnusedRecoveryCodes(userId)
      : 0,
    required: (await getMfaRequiredMode()) === 'required',
    requiredModeLocked: mfaRequiredModeLockedByEnv(),
  };
};

/** Whether password login for this user must complete a second factor. */
export const loginRequirement = async (
  userId: string
): Promise<'none' | 'verify' | 'enroll'> => {
  const record = await mfaRepository().find(userId);
  if (record?.activated_at != null) return 'verify';
  if ((await getMfaRequiredMode()) === 'required') return 'enroll';
  return 'none';
};

/** Begin (or restart) TOTP enrollment. Refused while TOTP is already active. */
export const beginTotpEnrollment = async (
  userId: string,
  accountName: string
): Promise<{ secret: string; otpauthUrl: string }> => {
  const existing = await mfaRepository().find(userId);
  if (existing?.activated_at != null) {
    throw new MfaError(
      'Two-factor authentication is already enabled; disable it first',
      409
    );
  }
  const secret = generateTotpSecret();
  const now = Date.now();
  await mfaRepository().upsert({
    user_id: userId,
    totp_secret: encryptionService.encrypt(secret),
    activated_at: null,
    last_used_step: null,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  return {
    secret,
    otpauthUrl: buildOtpauthUrl(secret, accountName, 'Libre WebUI'),
  };
};

const decryptSecret = (encrypted: string): string =>
  encryptionService.decryptAuthenticated(encrypted);

/**
 * Confirm enrollment with a first valid code. Activates TOTP and returns the
 * one-time recovery codes; they are never readable again.
 */
export const activateTotp = async (
  userId: string,
  code: string
): Promise<string[]> => {
  const record = await mfaRepository().find(userId);
  if (!record) {
    throw new MfaError('No pending two-factor enrollment', 409);
  }
  if (record.activated_at != null) {
    throw new MfaError('Two-factor authentication is already enabled', 409);
  }
  const step = verifyTotpCode(decryptSecret(record.totp_secret), code);
  if (step === null) {
    throw new MfaError('That code is not valid', 401);
  }
  const now = Date.now();
  await mfaRepository().activate(userId, now, now);
  await mfaRepository().markStepUsed(userId, step, now);
  return regenerateRecoveryCodesUnchecked(userId);
};

const regenerateRecoveryCodesUnchecked = async (
  userId: string
): Promise<string[]> => {
  const now = Date.now();
  const codes: string[] = [];
  const records: StoredMfaRecoveryCodeRecord[] = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index++) {
    const code = generateRecoveryCode();
    codes.push(code);
    records.push({
      id: randomUUID(),
      user_id: userId,
      code_lookup: recoveryCodeLookup(userId, code),
      created_at: now,
      used_at: null,
    });
  }
  await mfaRepository().replaceRecoveryCodes(userId, records);
  return codes;
};

/**
 * Verify a TOTP code for an active enrollment. The matched timestep is
 * persisted forward-only, so an intercepted code cannot be replayed.
 */
export const verifyActiveTotp = async (
  userId: string,
  code: string
): Promise<boolean> => {
  const record = await mfaRepository().find(userId);
  if (!record || record.activated_at == null) return false;
  const step = verifyTotpCode(decryptSecret(record.totp_secret), code);
  if (step === null) return false;
  // A false return means this (or a later) step was already accepted once.
  return mfaRepository().markStepUsed(userId, step, Date.now());
};

/** Consume a one-time recovery code. */
export const consumeRecoveryCode = async (
  userId: string,
  code: string
): Promise<{ consumed: boolean; remaining: number }> => {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== 10) {
    return {
      consumed: false,
      remaining: await mfaRepository().countUnusedRecoveryCodes(userId),
    };
  }
  const record = await mfaRepository().findRecoveryCode(
    recoveryCodeLookup(userId, normalized)
  );
  const consumed =
    record !== null &&
    record.user_id === userId &&
    (await mfaRepository().consumeRecoveryCode(record.id, Date.now()));
  return {
    consumed,
    remaining: await mfaRepository().countUnusedRecoveryCodes(userId),
  };
};

/** A submitted second factor: a 6-digit TOTP code or a recovery code. */
export const verifySecondFactor = async (
  userId: string,
  code: string
): Promise<{ verified: boolean; method: 'totp' | 'recovery' | null }> => {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed.replace(/\s/g, ''))) {
    const verified = await verifyActiveTotp(userId, trimmed);
    return { verified, method: verified ? 'totp' : null };
  }
  const { consumed } = await consumeRecoveryCode(userId, trimmed);
  return { verified: consumed, method: consumed ? 'recovery' : null };
};

/** Regenerate recovery codes after re-proving the second factor. */
export const regenerateRecoveryCodes = async (
  userId: string,
  code: string
): Promise<string[]> => {
  const { verified } = await verifySecondFactor(userId, code);
  if (!verified) {
    throw new MfaError('That code is not valid', 401);
  }
  return regenerateRecoveryCodesUnchecked(userId);
};

/** Disable TOTP after re-proving the second factor. */
export const disableTotp = async (
  userId: string,
  code: string
): Promise<void> => {
  const record = await mfaRepository().find(userId);
  if (!record) {
    throw new MfaError('Two-factor authentication is not enabled', 409);
  }
  if (record.activated_at != null) {
    const { verified } = await verifySecondFactor(userId, code);
    if (!verified) {
      throw new MfaError('That code is not valid', 401);
    }
  }
  await mfaRepository().delete(userId);
};

/** Administrator account recovery: removes TOTP state and recovery codes. */
export const adminResetMfa = async (userId: string): Promise<boolean> =>
  mfaRepository().delete(userId);

interface ChallengeClaims {
  sub?: string;
  purpose?: string;
  jti?: string;
}

/**
 * Issue a short-lived, one-use challenge token after password verification.
 * It authorizes exactly one MFA step for one user and nothing else.
 */
export const issueMfaChallenge = async (
  userId: string,
  purpose: MfaChallengePurpose
): Promise<string> => {
  const jti = randomUUID();
  await getCoordinator().setCache(
    `mfa-challenge:${jti}`,
    { userId, purpose },
    CHALLENGE_TTL_MS
  );
  return jwt.sign({ sub: userId, purpose, jti }, CHALLENGE_SECRET, {
    expiresIn: Math.floor(CHALLENGE_TTL_MS / 1000),
  });
};

/** Validate a challenge token without consuming it (for retryable attempts). */
export const peekMfaChallenge = (
  token: string,
  purpose: MfaChallengePurpose
): { userId: string; jti: string } => {
  let claims: ChallengeClaims;
  try {
    claims = jwt.verify(token, CHALLENGE_SECRET) as ChallengeClaims;
  } catch {
    throw new MfaError(
      'This sign-in challenge has expired; sign in again',
      401
    );
  }
  if (claims.purpose !== purpose || !claims.sub || !claims.jti) {
    throw new MfaError('This sign-in challenge is not valid', 401);
  }
  return { userId: claims.sub, jti: claims.jti };
};

/** Burn a challenge after a successful step; false when already used. */
export const consumeMfaChallenge = async (jti: string): Promise<boolean> =>
  (await getCoordinator().consumeCache(`mfa-challenge:${jti}`)) !== null;
