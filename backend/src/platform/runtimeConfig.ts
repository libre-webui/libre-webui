/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type PlatformMode = 'solo' | 'team';
export type DatabaseBackend = 'sqlite' | 'postgres';
export type BlobStoreBackend = 'local' | 's3';
export type VectorStoreBackend = 'embedded' | 'pgvector';
export type CoordinationBackend = 'local' | 'redis';
export type JobWorkerMode = 'embedded' | 'external';

export interface PlatformRuntimeConfig {
  mode: PlatformMode;
  database: {
    backend: DatabaseBackend;
    url?: string;
  };
  blobs: {
    backend: BlobStoreBackend;
  };
  vectors: {
    backend: VectorStoreBackend;
  };
  coordination: {
    backend: CoordinationBackend;
    redisUrl?: string;
    keyPrefix: string;
    connectTimeoutMs: number;
  };
  jobs: {
    workerMode: JobWorkerMode;
  };
  blockers: string[];
}

export class PlatformConfigurationError extends Error {
  constructor(readonly blockers: string[]) {
    super(`Invalid platform configuration:\n- ${blockers.join('\n- ')}`);
    this.name = 'PlatformConfigurationError';
  }
}

const enumValue = <T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  name: string,
  blockers: string[]
): T => {
  const normalized = value?.trim().toLowerCase() || fallback;
  if (allowed.includes(normalized as T)) return normalized as T;

  blockers.push(`${name} must be one of: ${allowed.join(', ')}.`);
  return fallback;
};

const positiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
  blockers: string[],
  maximum = 60_000
): number => {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    blockers.push(`${name} must be an integer between 1 and ${maximum}.`);
    return fallback;
  }
  return parsed;
};

const validateUrl = (
  value: string | undefined,
  protocols: readonly string[],
  name: string,
  blockers: string[]
): string | undefined => {
  if (!value?.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (!protocols.includes(parsed.protocol)) {
      blockers.push(`${name} must use ${protocols.join(' or ')}.`);
      return undefined;
    }
    return parsed.toString();
  } catch {
    blockers.push(`${name} must be a valid URL.`);
    return undefined;
  }
};

/**
 * Parses the platform profile without opening a network connection.
 *
 * Solo mode remains the zero-dependency default. Team mode is deliberately
 * fail-closed: every stateful dependency must be shared before multiple app
 * replicas can be safe. Redis is coordination only; it never replaces the
 * canonical database or durable job/event records.
 */
export const resolvePlatformRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): PlatformRuntimeConfig => {
  const blockers: string[] = [];
  const mode = enumValue(
    env.LIBRE_PLATFORM_MODE,
    'solo',
    ['solo', 'team'] as const,
    'LIBRE_PLATFORM_MODE',
    blockers
  );
  const databaseBackend = enumValue(
    env.DATABASE_BACKEND,
    'sqlite',
    ['sqlite', 'postgres'] as const,
    'DATABASE_BACKEND',
    blockers
  );
  const blobBackend = enumValue(
    env.BLOB_STORE_BACKEND,
    'local',
    ['local', 's3'] as const,
    'BLOB_STORE_BACKEND',
    blockers
  );
  const vectorBackend = enumValue(
    env.VECTOR_STORE_BACKEND,
    databaseBackend === 'postgres' ? 'pgvector' : 'embedded',
    ['embedded', 'pgvector'] as const,
    'VECTOR_STORE_BACKEND',
    blockers
  );
  const coordinationBackend = enumValue(
    env.COORDINATION_BACKEND,
    mode === 'team' ? 'redis' : 'local',
    ['local', 'redis'] as const,
    'COORDINATION_BACKEND',
    blockers
  );
  const workerMode = enumValue(
    env.JOB_WORKER_MODE,
    mode === 'team' ? 'external' : 'embedded',
    ['embedded', 'external'] as const,
    'JOB_WORKER_MODE',
    blockers
  );

  const databaseUrl = validateUrl(
    env.DATABASE_URL,
    ['postgres:', 'postgresql:'],
    'DATABASE_URL',
    blockers
  );
  const redisUrl = validateUrl(
    env.REDIS_URL,
    ['redis:', 'rediss:'],
    'REDIS_URL',
    blockers
  );
  const keyPrefix = env.REDIS_KEY_PREFIX?.trim() || 'libre';
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/.test(keyPrefix)) {
    blockers.push(
      'REDIS_KEY_PREFIX must contain 1-64 letters, numbers, colons, underscores, or hyphens.'
    );
  }

  if (databaseBackend === 'postgres' && !databaseUrl) {
    blockers.push('DATABASE_URL is required when DATABASE_BACKEND=postgres.');
  }
  if (coordinationBackend === 'redis' && !redisUrl) {
    blockers.push('REDIS_URL is required when COORDINATION_BACKEND=redis.');
  }

  // Selectors land before remote adapters so a deployment fails with an
  // actionable error instead of silently using local state under a team
  // label. Remove each blocker only with its adapter and integration fixture.
  if (databaseBackend === 'postgres') {
    blockers.push(
      'DATABASE_BACKEND=postgres is unavailable: the PostgreSQL repositories and migrations are not installed.'
    );
  }
  if (blobBackend === 's3') {
    blockers.push(
      'BLOB_STORE_BACKEND=s3 is unavailable: no tested S3 adapter is installed.'
    );
  }
  if (vectorBackend === 'pgvector') {
    blockers.push(
      'VECTOR_STORE_BACKEND=pgvector is unavailable: no tested PGVector adapter is installed.'
    );
  }
  if (workerMode === 'external') {
    blockers.push(
      'JOB_WORKER_MODE=external is unavailable: no tested external worker runtime is installed.'
    );
  }

  if (mode === 'team') {
    if (databaseBackend !== 'postgres') {
      blockers.push('Team mode requires DATABASE_BACKEND=postgres.');
    }
    if (blobBackend !== 's3') {
      blockers.push('Team mode requires BLOB_STORE_BACKEND=s3.');
    }
    if (vectorBackend !== 'pgvector') {
      blockers.push('Team mode requires VECTOR_STORE_BACKEND=pgvector.');
    }
    if (coordinationBackend !== 'redis') {
      blockers.push('Team mode requires COORDINATION_BACKEND=redis.');
    }
    if (workerMode !== 'external') {
      blockers.push('Team mode requires JOB_WORKER_MODE=external.');
    }
  }

  return {
    mode,
    database: {
      backend: databaseBackend,
      ...(databaseUrl ? { url: databaseUrl } : {}),
    },
    blobs: { backend: blobBackend },
    vectors: { backend: vectorBackend },
    coordination: {
      backend: coordinationBackend,
      ...(redisUrl ? { redisUrl } : {}),
      keyPrefix,
      connectTimeoutMs: positiveInteger(
        env.REDIS_CONNECT_TIMEOUT_MS,
        5_000,
        'REDIS_CONNECT_TIMEOUT_MS',
        blockers
      ),
    },
    jobs: { workerMode },
    blockers: [...new Set(blockers)],
  };
};

export const assertPlatformRuntimeConfig = (
  config: PlatformRuntimeConfig
): PlatformRuntimeConfig => {
  if (config.blockers.length > 0) {
    throw new PlatformConfigurationError(config.blockers);
  }
  return config;
};

/** Returns only non-secret state suitable for health and support output. */
export const summarizePlatformRuntimeConfig = (
  config: PlatformRuntimeConfig
) => ({
  mode: config.mode,
  database: config.database.backend,
  blobs: config.blobs.backend,
  vectors: config.vectors.backend,
  coordination: config.coordination.backend,
  jobs: config.jobs.workerMode,
  configured: {
    databaseUrl: Boolean(config.database.url),
    redisUrl: Boolean(config.coordination.redisUrl),
  },
  blockers: [...config.blockers],
});
