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
    bucketConfigured: boolean;
    endpointConfigured: boolean;
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
  const s3Endpoint = validateUrl(
    env.S3_ENDPOINT,
    ['http:', 'https:'],
    'S3_ENDPOINT',
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
  if (workerMode === 'external' && coordinationBackend !== 'redis') {
    blockers.push(
      'JOB_WORKER_MODE=external requires COORDINATION_BACKEND=redis so application replicas can verify worker presence.'
    );
  }
  if (workerMode === 'external' && databaseBackend !== 'postgres') {
    blockers.push(
      'JOB_WORKER_MODE=external requires DATABASE_BACKEND=postgres; SQLite is not a supported cross-process production queue.'
    );
  }

  if (blobBackend === 's3') {
    if (!env.S3_BUCKET?.trim()) {
      blockers.push('S3_BUCKET is required when BLOB_STORE_BACKEND=s3.');
    }
    if (!env.S3_REGION?.trim()) {
      blockers.push('S3_REGION is required when BLOB_STORE_BACKEND=s3.');
    }
    if (
      Boolean(env.S3_ACCESS_KEY_ID?.trim()) !==
      Boolean(env.S3_SECRET_ACCESS_KEY?.trim())
    ) {
      blockers.push(
        'S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together.'
      );
    }
    if (env.S3_SESSION_TOKEN?.trim() && !env.S3_ACCESS_KEY_ID?.trim()) {
      blockers.push(
        'S3_SESSION_TOKEN requires explicit S3 access credentials.'
      );
    }
    const pathStyle = env.S3_FORCE_PATH_STYLE?.trim().toLowerCase();
    if (pathStyle && pathStyle !== 'true' && pathStyle !== 'false') {
      blockers.push('S3_FORCE_PATH_STYLE must be true or false.');
    }
    if (databaseBackend !== 'postgres') {
      blockers.push(
        'BLOB_STORE_BACKEND=s3 requires DATABASE_BACKEND=postgres for durable encrypted object metadata.'
      );
    }
  }
  if (vectorBackend === 'pgvector' && databaseBackend !== 'postgres') {
    blockers.push(
      'VECTOR_STORE_BACKEND=pgvector requires DATABASE_BACKEND=postgres.'
    );
  }
  if (vectorBackend === 'embedded' && databaseBackend !== 'sqlite') {
    blockers.push(
      'VECTOR_STORE_BACKEND=embedded requires DATABASE_BACKEND=sqlite.'
    );
  }

  // Selectors fail closed instead of silently combining shared and local
  // state. PostgreSQL, S3, and PGVector are active only as one coherent team
  // profile; every cross-backend mismatch above remains a startup blocker.
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
    if (!env.JWT_SECRET?.trim()) {
      blockers.push(
        'Team mode requires a stable JWT_SECRET shared by every application replica and worker.'
      );
    }
    if (env.AGENT_CLI_MODELS_ENABLED !== 'false') {
      blockers.push(
        'Team mode requires AGENT_CLI_MODELS_ENABLED=false because agent binaries and their credentials are node-local and cannot be routed safely through the external durable worker.'
      );
    }
    if (env.CODEX_OAUTH_MODELS_ENABLED !== 'false') {
      blockers.push(
        'Team mode requires CODEX_OAUTH_MODELS_ENABLED=false because the Codex OAuth token file is node-local and cannot be routed safely through the external durable worker.'
      );
    }
  }

  return {
    mode,
    database: {
      backend: databaseBackend,
      ...(databaseUrl ? { url: databaseUrl } : {}),
    },
    blobs: {
      backend: blobBackend,
      bucketConfigured: Boolean(env.S3_BUCKET?.trim()),
      endpointConfigured: Boolean(s3Endpoint),
    },
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
    s3Bucket: config.blobs.bucketConfigured,
    s3Endpoint: config.blobs.endpointConfigured,
  },
  blockers: [...config.blockers],
});
