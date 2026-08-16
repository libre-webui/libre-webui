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
 * Scoped personal API tokens (IAM-05).
 *
 * Tokens are shown once at creation and stored only as a SHA-256 digest.
 * Each token carries an explicit scope list; the auth middleware maps the
 * requested route to a required scope, so a leaked notes-only token cannot
 * touch chats, media, or administration. Expiry, revocation, and last-use
 * are enforced and tracked server-side.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getPersistence } from '../persistence/index.js';
import type { StoredApiTokenRecord } from '../persistence/index.js';
import { getInitializedCoordinator } from '../platform/coordination/service.js';
import { encryptionService } from './encryptionService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:api-tokens');

export const API_TOKEN_PREFIX = 'lwk_';

export const API_TOKEN_SCOPES = [
  'chat',
  'models',
  'documents',
  'notes',
  'personas',
  'media',
  'work',
  'admin',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const isApiTokenScope = (value: unknown): value is ApiTokenScope =>
  typeof value === 'string' &&
  (API_TOKEN_SCOPES as readonly string[]).includes(value);

/** Requests per minute allowed per token across every replica. */
const API_TOKEN_RATE_LIMIT = 600;
const API_TOKEN_RATE_WINDOW_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;
const MAX_TOKENS_PER_USER = 25;

/**
 * Route-prefix to scope mapping. Session management and account routes are
 * deliberately unreachable with an API token; unknown prefixes require the
 * admin scope so a new route family fails closed until mapped here.
 */
const PATH_SCOPES: ReadonlyArray<{ prefix: string; scope: ApiTokenScope }> = [
  { prefix: '/api/chat', scope: 'chat' },
  { prefix: '/api/preferences', scope: 'chat' },
  { prefix: '/api/search', scope: 'chat' },
  { prefix: '/api/jobs', scope: 'chat' },
  { prefix: '/api/ollama', scope: 'models' },
  { prefix: '/api/huggingface-hub', scope: 'models' },
  { prefix: '/api/documents', scope: 'documents' },
  { prefix: '/api/embeddings', scope: 'documents' },
  { prefix: '/api/notes', scope: 'notes' },
  { prefix: '/api/personas', scope: 'personas' },
  { prefix: '/api/tts', scope: 'media' },
  { prefix: '/api/stt', scope: 'media' },
  { prefix: '/api/image-gen', scope: 'media' },
  { prefix: '/api/media', scope: 'media' },
  { prefix: '/api/artifacts', scope: 'media' },
  { prefix: '/api/work', scope: 'work' },
  { prefix: '/api/agent-clis', scope: 'work' },
  { prefix: '/api/health', scope: 'chat' },
  // The OpenAI-compatible surface is the primary consumer of API keys.
  { prefix: '/v1/chat', scope: 'chat' },
  { prefix: '/v1/completions', scope: 'chat' },
  { prefix: '/v1/models', scope: 'models' },
];

const FORBIDDEN_PREFIXES = ['/api/auth'];

export class ApiTokenScopeError extends Error {
  constructor(readonly requiredScope: ApiTokenScope | null) {
    super(
      requiredScope
        ? `This API token is missing the '${requiredScope}' scope`
        : 'This route cannot be used with an API token'
    );
    this.name = 'ApiTokenScopeError';
  }
}

export class ApiTokenRateLimitError extends Error {
  constructor() {
    super('API token rate limit exceeded');
    this.name = 'ApiTokenRateLimitError';
  }
}

const tokens = () =>
  getPersistence(encryptionService).repositories.security.apiTokens;

export const hashApiToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export const looksLikeApiToken = (bearer: string): boolean =>
  bearer.startsWith(API_TOKEN_PREFIX);

export const parseTokenScopes = (
  record: StoredApiTokenRecord
): ApiTokenScope[] => {
  try {
    const parsed: unknown = JSON.parse(record.scopes);
    if (Array.isArray(parsed)) return parsed.filter(isApiTokenScope);
  } catch {
    // fall through to empty scopes: an unreadable list must fail closed.
  }
  return [];
};

export interface CreatedApiToken {
  token: string;
  record: StoredApiTokenRecord;
}

export const createApiToken = async (
  userId: string,
  input: { name: string; scopes: ApiTokenScope[]; expiresInDays?: number }
): Promise<CreatedApiToken> => {
  const name = input.name.trim();
  if (!name || name.length > 128) {
    throw new Error('Token name must be between 1 and 128 characters');
  }
  const scopes = [...new Set(input.scopes)].filter(isApiTokenScope);
  if (scopes.length === 0) {
    throw new Error('At least one valid scope is required');
  }
  const existing = await tokens().listByUser(userId);
  if (
    existing.filter(item => item.revoked_at === null).length >=
    MAX_TOKENS_PER_USER
  ) {
    throw new Error(`A user may hold at most ${MAX_TOKENS_PER_USER} tokens`);
  }
  const secret = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  const now = Date.now();
  const record: StoredApiTokenRecord = {
    id: randomUUID(),
    user_id: userId,
    name,
    token_hash: hashApiToken(secret),
    token_prefix: secret.slice(0, 12),
    scopes: JSON.stringify(scopes),
    created_at: now,
    expires_at:
      input.expiresInDays && input.expiresInDays > 0
        ? now + Math.min(input.expiresInDays, 3650) * 24 * 60 * 60 * 1000
        : null,
    last_used_at: null,
    revoked_at: null,
  };
  await tokens().insert(record);
  return { token: secret, record };
};

/** Resolve a presented bearer to a live token record, or null. */
export const resolveApiToken = async (
  bearer: string
): Promise<StoredApiTokenRecord | null> => {
  if (!looksLikeApiToken(bearer)) return null;
  const record = await tokens().findByHash(hashApiToken(bearer));
  if (!record) return null;
  if (record.revoked_at !== null) return null;
  if (record.expires_at !== null && record.expires_at <= Date.now()) {
    return null;
  }
  return record;
};

/** Distributed per-token rate limit; skipped when no coordinator exists. */
export const consumeApiTokenRateLimit = async (
  tokenId: string
): Promise<void> => {
  const coordinator = getInitializedCoordinator();
  if (!coordinator) return;
  try {
    const result = await coordinator.consumeRateLimit(
      `api-token:${tokenId}`,
      API_TOKEN_RATE_LIMIT,
      API_TOKEN_RATE_WINDOW_MS
    );
    if (!result.allowed) throw new ApiTokenRateLimitError();
  } catch (error) {
    if (error instanceof ApiTokenRateLimitError) throw error;
    // Coordinator trouble must not take API access down with it; the shared
    // HTTP limiters still bound abuse.
    logger.warn('API token rate limit check failed', { error });
  }
};

export const touchApiTokenUse = async (
  record: StoredApiTokenRecord
): Promise<void> => {
  const now = Date.now();
  if (
    record.last_used_at !== null &&
    now - record.last_used_at < LAST_USED_THROTTLE_MS
  ) {
    return;
  }
  await tokens()
    .touchLastUsed(record.id, now)
    .catch(() => undefined);
};

/**
 * The scope a request path requires, or an error when tokens are barred
 * from the route family entirely.
 */
export const requiredScopeForPath = (path: string): ApiTokenScope | null => {
  if (FORBIDDEN_PREFIXES.some(prefix => path.startsWith(prefix))) return null;
  const match = PATH_SCOPES.find(entry => path.startsWith(entry.prefix));
  return match ? match.scope : 'admin';
};

export const assertTokenAllowsPath = (
  record: StoredApiTokenRecord,
  path: string
): ApiTokenScope[] => {
  const scopes = parseTokenScopes(record);
  const required = requiredScopeForPath(path);
  if (required === null) throw new ApiTokenScopeError(null);
  if (scopes.includes('admin') || scopes.includes(required)) return scopes;
  throw new ApiTokenScopeError(required);
};

export const listTokensForUser = (
  userId: string
): Promise<StoredApiTokenRecord[]> => tokens().listByUser(userId);

export const listAllTokens = (): Promise<StoredApiTokenRecord[]> =>
  tokens().listAll();

export const findTokenById = (
  tokenId: string
): Promise<StoredApiTokenRecord | null> => tokens().findById(tokenId);

export const revokeApiToken = async (tokenId: string): Promise<boolean> =>
  tokens().revoke(tokenId, Date.now());

/** Public projection: never exposes the hash. */
export const toPublicToken = (record: StoredApiTokenRecord) => ({
  id: record.id,
  name: record.name,
  tokenPrefix: record.token_prefix,
  scopes: parseTokenScopes(record),
  createdAt: new Date(record.created_at).toISOString(),
  expiresAt: record.expires_at
    ? new Date(record.expires_at).toISOString()
    : null,
  lastUsedAt: record.last_used_at
    ? new Date(record.last_used_at).toISOString()
    : null,
  revokedAt: record.revoked_at
    ? new Date(record.revoked_at).toISOString()
    : null,
});
