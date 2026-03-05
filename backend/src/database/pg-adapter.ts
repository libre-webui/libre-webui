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

import pg from 'pg';
import { DatabaseAdapter, RunResult } from './types.js';

type PgPool = InstanceType<typeof pg.Pool>;
type PoolClient = pg.PoolClient;

/** Convert `?` placeholders to PostgreSQL `$1, $2, ...` */
function convertPlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

/** Adapter that executes queries against a pg Pool. */
export class PgAdapter implements DatabaseAdapter {
  readonly dialect = 'postgres' as const;

  constructor(private pool: PgPool) {}

  // lgtm[js/sql-injection] - SQL comes from hardcoded service-layer strings, user data is in params
  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    const result = await this.pool.query(convertPlaceholders(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    const result = await this.pool.query(convertPlaceholders(sql), params);
    return result.rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    const result = await this.pool.query(convertPlaceholders(sql), params);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (db: DatabaseAdapter) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txAdapter = new PgClientAdapter(client);
      const result = await fn(txAdapter);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Adapter that wraps a single PoolClient (used inside transactions). */
class PgClientAdapter implements DatabaseAdapter {
  readonly dialect = 'postgres' as const;

  constructor(private client: PoolClient) {}

  async run(sql: string, ...params: unknown[]): Promise<RunResult> {
    const result = await this.client.query(convertPlaceholders(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined> {
    const result = await this.client.query(convertPlaceholders(sql), params);
    return result.rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    const result = await this.client.query(convertPlaceholders(sql), params);
    return result.rows as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async transaction<T>(fn: (db: DatabaseAdapter) => Promise<T>): Promise<T> {
    // Already inside a transaction — savepoints could be used but just run fn directly.
    return fn(this);
  }

  async close(): Promise<void> {
    // No-op: client is released by the parent PgAdapter.
  }
}
