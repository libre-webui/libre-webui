/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PostgresMigrationMode } from './postgresMigrationTypes.js';

export type PostgresSslMode = 'disable' | 'require' | 'verify-full';

export interface PostgresRuntimeConfig {
  connectionString: string;
  applicationName: string;
  poolMaximum: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  migrationLockTimeoutMs: number;
  migrationMode: PostgresMigrationMode;
  sslMode: PostgresSslMode;
}

export class PostgresConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid PostgreSQL configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'PostgresConfigurationError';
  }
}

const integer = (
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
  problems: string[]
): number => {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    problems.push(`${name} must be an integer between 1 and ${maximum}.`);
    return fallback;
  }
  return parsed;
};

const selection = <T extends string>(
  value: string | undefined,
  fallback: T,
  allowed: readonly T[],
  name: string,
  problems: string[]
): T => {
  const normalized = value?.trim().toLowerCase() || fallback;
  if (allowed.includes(normalized as T)) return normalized as T;
  problems.push(`${name} must be one of: ${allowed.join(', ')}.`);
  return fallback;
};

/** Parse PostgreSQL-only settings without opening a socket or exposing URLs. */
export const resolvePostgresRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): PostgresRuntimeConfig => {
  const problems: string[] = [];
  const rawUrl = env.DATABASE_URL?.trim();
  let connectionString = '';
  if (!rawUrl) {
    problems.push('DATABASE_URL is required for PostgreSQL.');
  } else {
    try {
      const parsed = new URL(rawUrl);
      if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
        problems.push('DATABASE_URL must use postgres: or postgresql:.');
      } else {
        if (!parsed.hostname)
          problems.push('DATABASE_URL must include a host.');
        connectionString = rawUrl;
      }
      if (
        ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert'].some(parameter =>
          parsed.searchParams.has(parameter)
        )
      ) {
        problems.push(
          'Configure PostgreSQL TLS only with DATABASE_SSL_MODE; TLS URL parameters are rejected to prevent driver precedence from weakening verification.'
        );
      }
    } catch {
      problems.push('DATABASE_URL must be a valid PostgreSQL URL.');
    }
  }

  const applicationName =
    env.POSTGRES_APPLICATION_NAME?.trim() || 'libre-webui';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,62}$/.test(applicationName)) {
    problems.push(
      'POSTGRES_APPLICATION_NAME must contain 1-63 safe identifier characters.'
    );
  }

  const sslMode = selection(
    env.DATABASE_SSL_MODE,
    'verify-full',
    ['disable', 'require', 'verify-full'] as const,
    'DATABASE_SSL_MODE',
    problems
  );
  const migrationMode = selection(
    env.POSTGRES_MIGRATION_MODE,
    'apply',
    ['apply', 'validate'] as const,
    'POSTGRES_MIGRATION_MODE',
    problems
  );

  const config: PostgresRuntimeConfig = {
    connectionString,
    applicationName,
    poolMaximum: integer(env, 'POSTGRES_POOL_MAX', 10, 100, problems),
    connectionTimeoutMs: integer(
      env,
      'POSTGRES_CONNECT_TIMEOUT_MS',
      5_000,
      60_000,
      problems
    ),
    idleTimeoutMs: integer(
      env,
      'POSTGRES_IDLE_TIMEOUT_MS',
      30_000,
      600_000,
      problems
    ),
    statementTimeoutMs: integer(
      env,
      'POSTGRES_STATEMENT_TIMEOUT_MS',
      30_000,
      600_000,
      problems
    ),
    migrationLockTimeoutMs: integer(
      env,
      'POSTGRES_MIGRATION_LOCK_TIMEOUT_MS',
      60_000,
      600_000,
      problems
    ),
    migrationMode,
    sslMode,
  };

  if (problems.length > 0) throw new PostgresConfigurationError(problems);
  return config;
};

/** Redacted support data; connection strings and credentials never leave config. */
export const summarizePostgresRuntimeConfig = (
  config: PostgresRuntimeConfig
) => ({
  applicationName: config.applicationName,
  poolMaximum: config.poolMaximum,
  connectionTimeoutMs: config.connectionTimeoutMs,
  idleTimeoutMs: config.idleTimeoutMs,
  statementTimeoutMs: config.statementTimeoutMs,
  migrationLockTimeoutMs: config.migrationLockTimeoutMs,
  migrationMode: config.migrationMode,
  sslMode: config.sslMode,
  configured: Boolean(config.connectionString),
});
