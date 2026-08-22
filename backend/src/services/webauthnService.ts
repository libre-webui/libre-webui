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
 * Passkey (WebAuthn) registration and passwordless sign-in.
 *
 * Attestation policy is 'none' (statements are not evaluated), credentials
 * are discoverable with user verification required, and ES256/EdDSA are the
 * accepted algorithms. Credential ids are stored as keyed one-way lookup
 * tokens with the key material encrypted at rest. Challenges are one-use
 * through the coordinator cache and carried in a signed token using a secret
 * derived from (but distinct from) the session JWT secret.
 */

import jwt from 'jsonwebtoken';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { JWT_SECRET } from './authService.js';
import { getCoordinator } from '../platform/coordination/service.js';
import {
  WebAuthnError,
  extractPublicKey,
  originMatchesRpId,
  parseAttestationObject,
  parseAuthenticatorData,
  parseClientDataJson,
  sha256,
  verifyAssertionSignature,
  type StoredPublicKey,
} from '../utils/webauthn.js';
import type { StoredWebAuthnCredentialRecord } from '../persistence/securityTypes.js';

const credentialRepository = () =>
  getPersistence(encryptionService).repositories.security.webauthnCredentials;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CREDENTIALS_PER_USER = 10;

const CHALLENGE_SECRET = createHmac('sha256', JWT_SECRET)
  .update('libre:webauthn-challenge:v1')
  .digest();

export class PasskeyError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

interface CredentialData {
  credentialId: string;
  publicKey: StoredPublicKey;
  transports: string[];
}

const credentialLookup = (credentialIdBase64Url: string): string =>
  encryptionService.purposeLookupToken(
    'webauthn-credential',
    credentialIdBase64Url
  );

const decodeBase64Url = (value: unknown, name: string): Buffer => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200_000
  ) {
    throw new PasskeyError(`${name} is required`);
  }
  return Buffer.from(value, 'base64url');
};

/** The relying-party id and origin policy for a request host. */
export const resolveRelyingParty = (requestHost: string): { rpId: string } => {
  const pinned = process.env.WEBAUTHN_RP_ID?.trim();
  if (pinned) return { rpId: pinned };
  const hostname = requestHost.split(':')[0]?.trim().toLowerCase();
  if (!hostname) {
    throw new PasskeyError('Cannot determine the relying-party id', 500);
  }
  return { rpId: hostname };
};

const assertAcceptableOrigin = (origin: string, rpId: string): void => {
  if (!originMatchesRpId(origin, rpId)) {
    throw new PasskeyError('This passkey response came from another site', 401);
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new PasskeyError('This passkey response came from another site', 401);
  }
  const localhost =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !localhost) {
    throw new PasskeyError('Passkeys require a secure (HTTPS) origin', 401);
  }
};

interface ChallengeClaims {
  sub?: string;
  purpose?: string;
  challenge?: string;
  jti?: string;
}

const issueChallenge = async (
  purpose: 'webauthn-register' | 'webauthn-login',
  userId?: string
): Promise<{ token: string; challenge: string }> => {
  const challenge = randomBytes(32).toString('base64url');
  const jti = randomUUID();
  await getCoordinator().setCache(
    `webauthn-challenge:${jti}`,
    { purpose },
    CHALLENGE_TTL_MS
  );
  const token = jwt.sign(
    { sub: userId, purpose, challenge, jti },
    CHALLENGE_SECRET,
    { expiresIn: Math.floor(CHALLENGE_TTL_MS / 1000) }
  );
  return { token, challenge };
};

/** Verify and burn a challenge token; each token authorizes one ceremony. */
const consumeChallenge = async (
  token: string,
  purpose: 'webauthn-register' | 'webauthn-login'
): Promise<{ userId?: string; challenge: string }> => {
  let claims: ChallengeClaims;
  try {
    claims = jwt.verify(token, CHALLENGE_SECRET) as ChallengeClaims;
  } catch {
    throw new PasskeyError('This passkey challenge has expired', 401);
  }
  if (claims.purpose !== purpose || !claims.challenge || !claims.jti) {
    throw new PasskeyError('This passkey challenge is not valid', 401);
  }
  const cached = await getCoordinator().consumeCache(
    `webauthn-challenge:${claims.jti}`
  );
  if (!cached) {
    throw new PasskeyError('This passkey challenge was already used', 401);
  }
  return {
    ...(claims.sub ? { userId: claims.sub } : {}),
    challenge: claims.challenge,
  };
};

export interface PublicPasskey {
  id: string;
  name: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

const toPublic = (record: StoredWebAuthnCredentialRecord): PublicPasskey => ({
  id: record.id,
  name: record.name,
  createdAt: record.created_at,
  lastUsedAt: record.last_used_at,
});

export const listPasskeys = async (userId: string): Promise<PublicPasskey[]> =>
  (await credentialRepository().listByUser(userId)).map(toPublic);

export const deletePasskey = async (
  userId: string,
  passkeyId: string
): Promise<boolean> => credentialRepository().delete(passkeyId, userId);

export const deleteAllPasskeys = async (userId: string): Promise<number> =>
  credentialRepository().deleteForUser(userId);

export const registrationOptions = async (
  user: { id: string; username: string },
  requestHost: string
): Promise<{ challengeToken: string; publicKey: Record<string, unknown> }> => {
  const { rpId } = resolveRelyingParty(requestHost);
  const { token, challenge } = await issueChallenge(
    'webauthn-register',
    user.id
  );
  const existing = await credentialRepository().listByUser(user.id);
  const excludeCredentials = existing
    .map(record => {
      try {
        const data = encryptionService.decryptObject<CredentialData>(
          record.credential_data
        );
        return { type: 'public-key', id: data.credentialId };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    challengeToken: token,
    publicKey: {
      challenge,
      rp: { id: rpId, name: 'Libre WebUI' },
      user: {
        id: Buffer.from(user.id, 'utf8').toString('base64url'),
        name: user.username,
        displayName: user.username,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -8 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
      },
      attestation: 'none',
      timeout: 120_000,
      excludeCredentials,
    },
  };
};

export interface RegistrationSubmission {
  challengeToken: string;
  name?: string;
  credential: {
    rawId: string;
    response: {
      clientDataJSON: string;
      attestationObject: string;
      transports?: string[];
    };
  };
}

export const registerPasskey = async (
  userId: string,
  submission: RegistrationSubmission,
  requestHost: string
): Promise<PublicPasskey> => {
  const { rpId } = resolveRelyingParty(requestHost);
  const consumed = await consumeChallenge(
    submission.challengeToken,
    'webauthn-register'
  );
  if (consumed.userId !== userId) {
    throw new PasskeyError(
      'This passkey challenge belongs to another sign-in',
      401
    );
  }

  const clientDataJson = decodeBase64Url(
    submission.credential?.response?.clientDataJSON,
    'clientDataJSON'
  );
  const clientData = parseClientDataJson(clientDataJson);
  if (clientData.type !== 'webauthn.create') {
    throw new PasskeyError('Unexpected passkey ceremony type', 401);
  }
  if (clientData.challenge !== consumed.challenge) {
    throw new PasskeyError('Passkey challenge mismatch', 401);
  }
  assertAcceptableOrigin(clientData.origin, rpId);

  let authData: Buffer;
  let parsed: ReturnType<typeof parseAuthenticatorData>;
  let publicKey: StoredPublicKey;
  try {
    authData = parseAttestationObject(
      decodeBase64Url(
        submission.credential?.response?.attestationObject,
        'attestationObject'
      )
    );
    parsed = parseAuthenticatorData(authData);
    if (!parsed.publicKey || !parsed.credentialId) {
      throw new WebAuthnError('Attested credential data is missing');
    }
    publicKey = extractPublicKey(parsed.publicKey);
  } catch (error) {
    if (error instanceof WebAuthnError) {
      throw new PasskeyError(`Passkey registration failed: ${error.message}`);
    }
    throw error;
  }

  if (!parsed.rpIdHash.equals(sha256(rpId))) {
    throw new PasskeyError('This passkey was created for another site', 401);
  }
  if (!parsed.userPresent || !parsed.userVerified) {
    throw new PasskeyError('Passkeys require user verification', 401);
  }

  const credentialId = parsed.credentialId.toString('base64url');
  const rawId = submission.credential.rawId;
  if (typeof rawId === 'string' && rawId !== credentialId) {
    throw new PasskeyError('Credential id mismatch', 401);
  }
  const lookup = credentialLookup(credentialId);
  if (await credentialRepository().findByLookup(lookup)) {
    throw new PasskeyError('This passkey is already registered', 409);
  }
  if (
    (await credentialRepository().countForUser(userId)) >=
    MAX_CREDENTIALS_PER_USER
  ) {
    throw new PasskeyError(
      `You can register at most ${MAX_CREDENTIALS_PER_USER} passkeys`,
      409
    );
  }

  const transports = Array.isArray(submission.credential.response.transports)
    ? submission.credential.response.transports
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 8)
    : [];
  const name = submission.name?.trim().slice(0, 64) || null;
  const record: StoredWebAuthnCredentialRecord = {
    id: randomUUID(),
    user_id: userId,
    credential_lookup: lookup,
    credential_data: encryptionService.encryptObject({
      credentialId,
      publicKey,
      transports,
    } satisfies CredentialData),
    name,
    sign_count: parsed.signCount,
    created_at: Date.now(),
    last_used_at: null,
  };
  await credentialRepository().insert(record);
  return toPublic(record);
};

export const loginOptions = async (
  requestHost: string
): Promise<{ challengeToken: string; publicKey: Record<string, unknown> }> => {
  const { rpId } = resolveRelyingParty(requestHost);
  const { token, challenge } = await issueChallenge('webauthn-login');
  return {
    challengeToken: token,
    publicKey: {
      challenge,
      rpId,
      userVerification: 'required',
      timeout: 120_000,
    },
  };
};

export interface AssertionSubmission {
  challengeToken: string;
  credential: {
    rawId: string;
    response: {
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    };
  };
}

/** Verify a passwordless sign-in assertion; returns the credential owner. */
export const verifyPasskeyLogin = async (
  submission: AssertionSubmission,
  requestHost: string
): Promise<{ userId: string; passkeyId: string }> => {
  const { rpId } = resolveRelyingParty(requestHost);
  const consumed = await consumeChallenge(
    submission.challengeToken,
    'webauthn-login'
  );

  const clientDataJson = decodeBase64Url(
    submission.credential?.response?.clientDataJSON,
    'clientDataJSON'
  );
  const clientData = parseClientDataJson(clientDataJson);
  if (clientData.type !== 'webauthn.get') {
    throw new PasskeyError('Unexpected passkey ceremony type', 401);
  }
  if (clientData.challenge !== consumed.challenge) {
    throw new PasskeyError('Passkey challenge mismatch', 401);
  }
  assertAcceptableOrigin(clientData.origin, rpId);

  const rawId = decodeBase64Url(submission.credential?.rawId, 'credential id');
  const record = await credentialRepository().findByLookup(
    credentialLookup(rawId.toString('base64url'))
  );
  if (!record) {
    throw new PasskeyError('This passkey is not registered here', 401);
  }
  let data: CredentialData;
  try {
    data = encryptionService.decryptObject<CredentialData>(
      record.credential_data
    );
  } catch {
    throw new PasskeyError('This passkey is not usable', 401);
  }

  const authData = decodeBase64Url(
    submission.credential?.response?.authenticatorData,
    'authenticatorData'
  );
  let parsed: ReturnType<typeof parseAuthenticatorData>;
  try {
    parsed = parseAuthenticatorData(authData);
  } catch (error) {
    if (error instanceof WebAuthnError) {
      throw new PasskeyError(`Passkey sign-in failed: ${error.message}`, 401);
    }
    throw error;
  }
  if (!parsed.rpIdHash.equals(sha256(rpId))) {
    throw new PasskeyError('This passkey belongs to another site', 401);
  }
  if (!parsed.userPresent || !parsed.userVerified) {
    throw new PasskeyError('Passkeys require user verification', 401);
  }

  const signature = decodeBase64Url(
    submission.credential?.response?.signature,
    'signature'
  );
  if (
    !verifyAssertionSignature(
      data.publicKey,
      authData,
      clientDataJson,
      signature
    )
  ) {
    throw new PasskeyError('Passkey signature verification failed', 401);
  }

  // A nonzero counter that does not advance suggests a cloned authenticator.
  if (
    parsed.signCount !== 0 &&
    record.sign_count !== 0 &&
    parsed.signCount <= record.sign_count
  ) {
    throw new PasskeyError('This passkey failed a clone check', 401);
  }
  await credentialRepository().updateSignCount(
    record.id,
    Math.max(parsed.signCount, record.sign_count),
    Date.now()
  );
  return { userId: record.user_id, passkeyId: record.id };
};
