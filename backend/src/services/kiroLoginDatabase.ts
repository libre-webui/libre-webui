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
 * The Kiro CLI's own SQLite database, which holds its login. This is not
 * Libre WebUI's storage: it is read (never written) to find the login, and
 * copied to build the scrubbed copy a Work sandbox receives. Kept apart so
 * the SQLite driver stays inside an audited boundary.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export interface KiroLoginRow {
  readonly key: string;
  readonly value: string;
}

/** auth_kv rows whose key ends in `:token`, read-only. */
export function readKiroLoginRows(file: string): KiroLoginRow[] {
  if (!fs.existsSync(file)) return [];
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare("SELECT key, value FROM auth_kv WHERE key LIKE '%:token'")
      .all() as KiroLoginRow[];
  } finally {
    database.close();
  }
}

/**
 * A copy of the database with the same schema and nothing of the user's but
 * what `rewriteLogin` keeps: every table other than auth_kv, state, and
 * migrations is emptied; each auth_kv row is replaced by `rewriteLogin`'s
 * value or dropped when it returns null; state keys matching `privateState`
 * are dropped. The copy is vacuumed so no freed page keeps old content.
 */
export async function scrubbedKiroDatabase(
  file: string,
  rewriteLogin: (key: string, value: string) => string | null,
  privateState: RegExp
): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-kiro-'));
  const copy = path.join(scratch, 'data.sqlite3');
  let database: Database.Database | undefined;
  try {
    const source = new Database(file, { readonly: true, fileMustExist: true });
    try {
      await source.backup(copy);
    } finally {
      source.close();
    }
    database = new Database(copy);
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
      )
      .all() as Array<{ name: string }>;
    const keep = new Set(['auth_kv', 'state', 'migrations']);
    for (const { name } of tables) {
      if (!keep.has(name)) {
        database.prepare(`DELETE FROM "${name.replace(/"/g, '""')}"`).run();
      }
    }
    const rows = database
      .prepare('SELECT key, value FROM auth_kv')
      .all() as KiroLoginRow[];
    const update = database.prepare(
      'UPDATE auth_kv SET value = ? WHERE key = ?'
    );
    const remove = database.prepare('DELETE FROM auth_kv WHERE key = ?');
    for (const row of rows) {
      const rewritten = rewriteLogin(row.key, row.value);
      if (rewritten === null) remove.run(row.key);
      else update.run(rewritten, row.key);
    }
    try {
      const state = database.prepare('SELECT key FROM state').all() as Array<{
        key: string;
      }>;
      const dropState = database.prepare('DELETE FROM state WHERE key = ?');
      for (const { key } of state) {
        if (privateState.test(key)) dropState.run(key);
      }
    } catch {
      // Older databases have no state table.
    }
    database.pragma('journal_mode = DELETE');
    database.exec('VACUUM');
    database.close();
    database = undefined;
    return fs.readFileSync(copy);
  } finally {
    database?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
