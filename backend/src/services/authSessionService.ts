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
 * Server-side auth sessions (IAM-04).
 *
 * Every issued JWT is bound to an `auth_sessions` row through its `sid`
 * claim. The database is authoritative: a revoked or expired row makes the
 * token unusable on the next request regardless of the JWT lifetime. The
 * coordinator topic is an advisory fan-out that lets other replicas and live
 * WebSocket connections react immediately.
 *
 * Tokens issued before this feature carry no `sid`. They stay valid until
 * expiry unless the user (or an administrator) revokes all sessions, which
 * also records a per-user invalid-before timestamp that rejects any token
 * minted earlier — so "sign out everywhere" is complete even for legacy
 * tokens.
 */

import { randomUUID } from 'node:crypto';
import type {
  Coordinator,
  CoordinationUnsubscribe,
} from '../platform/coordination/types.js';
import { getInitializedCoordinator } from '../platform/coordination/service.js';
import { getPersistence } from '../persistence/index.js';
import type { StoredAuthSessionRecord } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:auth-sessions');

export const SESSION_REVOCATION_TOPIC = 'security.sessions.revoked.v1';

export interface SessionRevocationEvent {
  version: 1;
  userId: string;
  sessionIds: string[];
}

export interface SessionIssueMetadata {
  kind: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

const LAST_SEEN_THROTTLE_MS = 60_000;
const PURGE_EVERY_N_READS = 1_000;
let readsSincePurge = 0;

const invalidBeforeKey = (userId: string): string =>
  `auth_token_invalid_before:${userId}`;

type SessionRevocationListener = (event: SessionRevocationEvent) => void;

const listeners = new Set<SessionRevocationListener>();
let subscription:
  | { coordinator: Coordinator; unsubscribe: CoordinationUnsubscribe }
  | undefined;

const isRevocationEvent = (value: unknown): value is SessionRevocationEvent => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.userId === 'string' &&
    Array.isArray(candidate.sessionIds) &&
    candidate.sessionIds.every(id => typeof id === 'string')
  );
};

const dispatch = (event: SessionRevocationEvent): void => {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // The database stays authoritative; a broken consumer must not stop
      // other live connections from being closed.
      logger.warn('A session revocation listener failed');
    }
  }
};

/** Register for advisory revocation events (e.g. to close live sockets). */
export const registerSessionRevocationListener = (
  listener: SessionRevocationListener
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const ensureSessionRevocationSubscription = async (): Promise<void> => {
  const coordinator = getInitializedCoordinator();
  if (!coordinator) return;
  if (subscription?.coordinator === coordinator) return;
  const previous = subscription;
  subscription = undefined;
  if (previous) await previous.unsubscribe().catch(() => undefined);
  const unsubscribe = await coordinator.subscribe<unknown>(
    SESSION_REVOCATION_TOPIC,
    event => {
      if (!isRevocationEvent(event.payload)) {
        logger.warn('Ignoring an invalid session revocation message');
        return;
      }
      dispatch(event.payload);
    }
  );
  subscription = { coordinator, unsubscribe };
};

const publishRevocation = async (
  userId: string,
  sessionIds: string[]
): Promise<void> => {
  const event: SessionRevocationEvent = { version: 1, userId, sessionIds };
  // Local listeners first: revocation must reach this replica's sockets even
  // when the coordinator is degraded.
  dispatch(event);
  try {
    const coordinator = getInitializedCoordinator();
    if (!coordinator) return;
    await ensureSessionRevocationSubscription();
    await coordinator.publish(SESSION_REVOCATION_TOPIC, event);
    await coordinator.revoke(`user-sessions:${userId}`).catch(() => undefined);
  } catch {
    // The revoked rows are already committed; every replica enforces them on
    // its next database read even without the advisory fan-out.
    logger.warn('Session revocation publication failed');
  }
};

const security = () => getPersistence(encryptionService).repositories.security;

const purgeOpportunistically = async (): Promise<void> => {
  readsSincePurge += 1;
  if (readsSincePurge < PURGE_EVERY_N_READS) return;
  readsSincePurge = 0;
  try {
    // Keep expired rows for seven days so the session inventory can show
    // recently expired devices before they disappear.
    await security().authSessions.deleteExpired(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    );
  } catch (error) {
    logger.warn('Expired session purge failed', { error });
  }
};

export const createAuthSession = async (
  userId: string,
  metadata: SessionIssueMetadata,
  expiresAt: number
): Promise<StoredAuthSessionRecord> => {
  const now = Date.now();
  const record: StoredAuthSessionRecord = {
    id: randomUUID(),
    user_id: userId,
    kind: metadata.kind,
    ip_hash: null,
    user_agent: metadata.userAgent?.slice(0, 256) ?? null,
    created_at: now,
    last_seen_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    revoked_by: null,
  };
  if (metadata.ip) {
    const { hashClientIp } = await import('./securityAuditService.js');
    record.ip_hash = hashClientIp(metadata.ip);
  }
  await security().authSessions.insert(record);
  return record;
};

/** A session usable for authentication right now, or null. */
export const getValidSession = async (
  sessionId: string
): Promise<StoredAuthSessionRecord | null> => {
  const record = await security().authSessions.findById(sessionId);
  await purgeOpportunistically();
  if (!record) return null;
  if (record.revoked_at !== null) return null;
  if (record.expires_at <= Date.now()) return null;
  return record;
};

export const touchSessionThrottled = async (
  record: StoredAuthSessionRecord
): Promise<void> => {
  const now = Date.now();
  if (now - record.last_seen_at < LAST_SEEN_THROTTLE_MS) return;
  await security()
    .authSessions.touch(record.id, now)
    .catch(() => undefined);
};

export const listSessionsForUser = (
  userId: string
): Promise<StoredAuthSessionRecord[]> =>
  security().authSessions.listByUser(userId);

export const findSessionById = (
  sessionId: string
): Promise<StoredAuthSessionRecord | null> =>
  security().authSessions.findById(sessionId);

export const revokeAuthSession = async (
  sessionId: string,
  revokedBy: string
): Promise<boolean> => {
  const record = await security().authSessions.findById(sessionId);
  if (!record) return false;
  const revoked = await security().authSessions.revoke(
    sessionId,
    Date.now(),
    revokedBy
  );
  if (revoked) await publishRevocation(record.user_id, [sessionId]);
  return revoked;
};

/**
 * Revoke every session for a user (optionally sparing the current one).
 * Also stamps the invalid-before epoch so legacy tokens without a session
 * id are rejected too.
 */
export const revokeAllAuthSessions = async (
  userId: string,
  revokedBy: string,
  exceptSessionId?: string
): Promise<string[]> => {
  const revokedIds = await security().authSessions.revokeAllForUser(
    userId,
    Date.now(),
    revokedBy,
    exceptSessionId
  );
  if (!exceptSessionId) {
    // A full sign-out invalidates sid-less legacy tokens as well.
    await setSystemSetting(invalidBeforeKey(userId), String(Date.now()));
  }
  if (revokedIds.length > 0) await publishRevocation(userId, revokedIds);
  return revokedIds;
};

/** Epoch (ms) before which any token for this user is rejected. */
export const getTokenInvalidBefore = async (
  userId: string
): Promise<number> => {
  const value = await getSystemSetting(invalidBeforeKey(userId));
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const closeSessionRevocationSubscription = async (): Promise<void> => {
  const current = subscription;
  subscription = undefined;
  listeners.clear();
  if (current) await current.unsubscribe().catch(() => undefined);
};
