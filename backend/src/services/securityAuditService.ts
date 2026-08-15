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
 * Security audit log (AUDIT-01/02).
 *
 * Records security-sensitive actions and denials as append-only events that
 * are separate from usage analytics. Details are redacted before persistence:
 * secret-like keys are dropped, strings are truncated, and the serialized
 * payload is capped, so prompts, passwords, tokens, and provider bodies can
 * never enter the log.
 *
 * Two write paths exist:
 * - `recordAuditEvent` for observations (logins, denials): best-effort, never
 *   throws, so a logging failure cannot block authentication.
 * - `buildAuditEvent` + the transactional audit repositories for
 *   security-critical mutations (group/grant/token/user changes): the caller
 *   writes the event inside the same database transaction as the mutation,
 *   so the mutation cannot commit without its audit trail.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getPersistence } from '../persistence/index.js';
import type {
  AuditResult,
  SecurityAuditQuery,
  StoredSecurityAuditEventRecord,
} from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:security-audit');

export type AuditActorKind = 'user' | 'api-token' | 'system' | 'anonymous';

export interface SecurityAuditEventInput {
  action: string;
  result: AuditResult;
  actorUserId?: string | null;
  actorKind?: AuditActorKind;
  targetType?: string;
  targetId?: string;
  requestId?: string;
  ipHash?: string | null;
  details?: Record<string, unknown>;
}

const SECRET_KEY_PATTERN =
  /pass(word)?|secret|token|key|authorization|cookie|credential|bearer|jwt/i;
const MAX_DETAIL_STRING = 256;
const MAX_DETAIL_BYTES = 4096;
const MAX_DETAIL_DEPTH = 4;

const AUDIT_RETENTION_DAYS_DEFAULT = 180;
const PRUNE_EVERY_N_WRITES = 512;
let writesSincePrune = 0;

export const auditRetentionMs = (): number => {
  const parsed = Number.parseInt(process.env.AUDIT_RETENTION_DAYS ?? '', 10);
  const days =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : AUDIT_RETENTION_DAYS_DEFAULT;
  return days * 24 * 60 * 60 * 1000;
};

const redactValue = (value: unknown, depth: number): unknown => {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_DETAIL_STRING
      ? `${value.slice(0, MAX_DETAIL_STRING)}…`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= MAX_DETAIL_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 32).map(item => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as object)) {
      if (SECRET_KEY_PATTERN.test(key)) continue;
      redacted[key] = redactValue(item, depth + 1);
    }
    return redacted;
  }
  return String(value);
};

/** Serialize event details with secret keys removed and size bounded. */
export const redactAuditDetails = (
  details: Record<string, unknown> | undefined
): string | null => {
  if (!details) return null;
  try {
    const serialized = JSON.stringify(redactValue(details, 0));
    if (!serialized || serialized === '{}') return null;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_DETAIL_BYTES) {
      return JSON.stringify({ truncated: true });
    }
    return serialized;
  } catch {
    return null;
  }
};

/** One-way IP digest: correlates events without storing addresses. */
export const hashClientIp = (ip: string | undefined): string | null => {
  if (!ip) return null;
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
};

/** Build the persisted row shape for direct or transactional inserts. */
export const buildAuditEvent = (
  input: SecurityAuditEventInput
): StoredSecurityAuditEventRecord => ({
  id: randomUUID(),
  occurred_at: Date.now(),
  actor_user_id: input.actorUserId ?? null,
  actor_kind: input.actorKind ?? (input.actorUserId ? 'user' : 'anonymous'),
  action: input.action,
  target_type: input.targetType ?? null,
  target_id: input.targetId ?? null,
  result: input.result,
  request_id: input.requestId ?? null,
  ip_hash: input.ipHash ?? null,
  details: redactAuditDetails(input.details),
});

const pruneOpportunistically = async (): Promise<void> => {
  writesSincePrune += 1;
  if (writesSincePrune < PRUNE_EVERY_N_WRITES) return;
  writesSincePrune = 0;
  try {
    const persistence = getPersistence(encryptionService);
    await persistence.repositories.security.audit.deleteBefore(
      Date.now() - auditRetentionMs()
    );
  } catch (error) {
    logger.warn('Audit retention prune failed', { error });
  }
};

/**
 * Best-effort audit write for observations. Never throws: an audit outage
 * must not turn into an authentication or authorization outage.
 */
export const recordAuditEvent = async (
  input: SecurityAuditEventInput
): Promise<void> => {
  try {
    const persistence = getPersistence(encryptionService);
    await persistence.repositories.security.audit.insert(
      buildAuditEvent(input)
    );
    await pruneOpportunistically();
  } catch (error) {
    logger.error('Failed to record security audit event', {
      action: input.action,
      error,
    });
  }
};

export const queryAuditEvents = async (query: {
  action?: string;
  actorUserId?: string;
  result?: AuditResult;
  targetType?: string;
  before?: number;
  after?: number;
  limit?: number;
}): Promise<StoredSecurityAuditEventRecord[]> => {
  const persistence = getPersistence(encryptionService);
  const bounded: SecurityAuditQuery = {
    ...(query.action ? { action: query.action } : {}),
    ...(query.actorUserId ? { actorUserId: query.actorUserId } : {}),
    ...(query.result ? { result: query.result } : {}),
    ...(query.targetType ? { targetType: query.targetType } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
    ...(query.after !== undefined ? { after: query.after } : {}),
    limit: Math.min(Math.max(query.limit ?? 100, 1), 500),
  };
  return persistence.repositories.security.audit.query(bounded);
};
