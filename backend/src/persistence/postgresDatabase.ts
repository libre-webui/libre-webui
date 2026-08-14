/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import {
  Pool,
  type PoolClient,
  type PoolConfig,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import type { PostgresRuntimeConfig } from './postgresConfig.js';
import type { PersistenceHealth } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('postgres-persistence');

export interface PostgresQueryExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    parameters?: readonly unknown[]
  ): Promise<QueryResult<Row>>;
}

export interface PostgresTransactionOptions {
  isolationLevel?: 'read committed' | 'repeatable read' | 'serializable';
  readOnly?: boolean;
}

export interface PostgresPoolLike extends PostgresQueryExecutor {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}

const sslFor = (config: PostgresRuntimeConfig): PoolConfig['ssl'] => {
  if (config.sslMode === 'disable') return false;
  if (config.sslMode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
};

export const createPostgresPool = (config: PostgresRuntimeConfig): Pool =>
  new Pool({
    connectionString: config.connectionString,
    application_name: config.applicationName,
    max: config.poolMaximum,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    query_timeout: config.statementTimeoutMs + 1_000,
    ssl: sslFor(config),
    allowExitOnIdle: false,
  });

const beginStatement = (options: PostgresTransactionOptions): string => {
  const isolation = (options.isolationLevel || 'read committed').toUpperCase();
  return `BEGIN ISOLATION LEVEL ${isolation}${options.readOnly ? ' READ ONLY' : ''}`;
};

/**
 * Thin pool boundary for PostgreSQL-specific repositories. Transactions always
 * pin one pooled client, release it in finally, and never expose the pool URL.
 */
export class PostgresDatabase implements PostgresQueryExecutor {
  private closing = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(readonly pool: PostgresPoolLike) {
    // node-postgres emits idle-client failures on the pool. Without a listener
    // Node treats them as uncaught errors. Keep the log deliberately generic:
    // driver errors may carry connection endpoints or server details.
    pool.on?.('error', () => {
      logger.error('An idle PostgreSQL client failed and was removed');
    });
  }

  private assertOpen(): void {
    if (this.closing || this.closed) {
      throw new Error('PostgreSQL pool is closed');
    }
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    parameters: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    this.assertOpen();
    return this.pool.query<Row>(text, [...parameters]);
  }

  async withClient<T>(
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    this.assertOpen();
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      return await operation(client);
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
    options: PostgresTransactionOptions = {}
  ): Promise<T> {
    return this.withClient(async client => {
      await client.query(beginStatement(options));
      try {
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          const combined = new Error(
            'PostgreSQL transaction and rollback both failed'
          );
          Object.defineProperty(combined, 'cause', {
            value: error,
            enumerable: false,
          });
          Object.defineProperty(combined, 'rollbackError', {
            value: rollbackError,
            enumerable: false,
          });
          throw combined;
        }
        throw error;
      }
    });
  }

  async health(): Promise<PersistenceHealth> {
    const startedAt = performance.now();
    try {
      await this.query('SELECT 1 AS healthy');
      return {
        ready: true,
        dialect: 'postgres',
        latencyMs: performance.now() - startedAt,
        pool: {
          total: this.pool.totalCount,
          idle: this.pool.idleCount,
          waiting: this.pool.waitingCount,
        },
      };
    } catch {
      return {
        ready: false,
        dialect: 'postgres',
        latencyMs: performance.now() - startedAt,
        message: 'PostgreSQL query failed',
        pool: {
          total: this.pool.totalCount,
          idle: this.pool.idleCount,
          waiting: this.pool.waitingCount,
        },
      };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.pool
      .end()
      .then(() => {
        this.closed = true;
      })
      .finally(() => {
        this.closing = false;
        this.closePromise = undefined;
      });
    return this.closePromise;
  }
}

export const createPostgresDatabase = (
  config: PostgresRuntimeConfig
): PostgresDatabase => new PostgresDatabase(createPostgresPool(config));
