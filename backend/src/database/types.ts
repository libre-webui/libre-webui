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

export interface RunResult {
  changes: number;
}

export interface DatabaseAdapter {
  /** Execute a query that modifies data (INSERT, UPDATE, DELETE). */
  run(sql: string, ...params: unknown[]): Promise<RunResult>;

  /** Execute a query and return the first row, or undefined. */
  get<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T | undefined>;

  /** Execute a query and return all rows. */
  all<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]>;

  /** Execute raw SQL (DDL, multi-statement). */
  exec(sql: string): Promise<void>;

  /** Execute a function within a database transaction. */
  transaction<T>(fn: (db: DatabaseAdapter) => Promise<T>): Promise<T>;

  /** Close the database connection. */
  close(): Promise<void>;

  /** The database dialect in use. */
  readonly dialect: 'sqlite' | 'postgres';
}
