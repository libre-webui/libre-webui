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

import path from 'path';
import fs from 'fs';
import type BetterSqlite3 from 'better-sqlite3';
import { DatabaseAdapter } from './types.js';

const TABLES_IN_ORDER = [
  'users',
  'personas',
  'sessions',
  'session_messages',
  'documents',
  'document_chunks',
  'user_preferences',
  'system_settings',
  'plugin_credentials',
  'plugin_variables',
  'generated_images',
  'persona_memories',
  'persona_states',
];

const MIGRATION_MARKER = '_sqlite_migrated';

/**
 * Check if a SQLite database exists and has data worth migrating.
 */
function findSQLiteDatabase(): string | null {
  const dataDir =
    process.env.DATA_DIR || path.join(process.cwd(), 'backend', 'data');
  const dbPath = path.join(dataDir, 'data.sqlite');

  if (!fs.existsSync(dbPath)) return null;

  // Check file isn't empty
  const stats = fs.statSync(dbPath);
  if (stats.size < 1024) return null;

  return dbPath;
}

/**
 * Check if migration has already been performed.
 */
async function alreadyMigrated(pg: DatabaseAdapter): Promise<boolean> {
  try {
    const row = await pg.get<{ name: string }>(
      `SELECT name FROM _migrations WHERE name = $1`,
      MIGRATION_MARKER
    );
    return !!row;
  } catch {
    // _migrations table might not exist yet
    return false;
  }
}

/**
 * Auto-migrate data from an existing SQLite database into PostgreSQL.
 * Only runs once — marks completion in the _migrations table.
 */
export async function migrateFromSQLite(pg: DatabaseAdapter): Promise<void> {
  const sqlitePath = findSQLiteDatabase();
  if (!sqlitePath) return;

  if (await alreadyMigrated(pg)) return;

  console.log(`Found existing SQLite database at ${sqlitePath}`);
  console.log('Starting auto-migration to PostgreSQL...');

  const { default: Database } = await import('better-sqlite3');
  const sqlite: BetterSqlite3.Database = new Database(sqlitePath, {
    readonly: true,
  });

  try {
    let totalRows = 0;

    for (const table of TABLES_IN_ORDER) {
      // Check table exists in SQLite
      const tableExists = sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
        .get(table) as { name: string } | undefined;
      if (!tableExists) continue;

      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<
        string,
        unknown
      >[];
      if (rows.length === 0) continue;

      // Check if PG table already has data (skip if so)
      const pgCount = await pg.get<{ count: string }>(
        `SELECT COUNT(*) as count FROM ${table}`
      );
      if (pgCount && Number(pgCount.count) > 0) {
        console.log(
          `  Skipping ${table}: already has ${pgCount.count} rows in PostgreSQL`
        );
        continue;
      }

      const columns = Object.keys(rows[0]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const insertSQL = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      for (const row of rows) {
        const values = columns.map(col => {
          const val = row[col];
          // Convert SQLite Buffer/Uint8Array to Node Buffer for BYTEA columns
          if (val instanceof Uint8Array || Buffer.isBuffer(val)) {
            return Buffer.from(val);
          }
          return val;
        });
        await pg.run(insertSQL, ...values);
      }

      totalRows += rows.length;
      console.log(`  Migrated ${table}: ${rows.length} rows`);
    }

    // Mark migration as done
    await pg.exec(
      `INSERT INTO _migrations (name) VALUES ('${MIGRATION_MARKER}')`
    );

    console.log(
      `SQLite to PostgreSQL migration complete: ${totalRows} total rows migrated`
    );
  } finally {
    sqlite.close();
  }
}
