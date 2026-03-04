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
import type pg from 'pg';
import { DatabaseAdapter } from './types.js';

export { DatabaseAdapter, RunResult } from './types.js';

/**
 * Create and return a fully-initialised DatabaseAdapter.
 *
 * If DATABASE_URL is set the adapter talks to PostgreSQL.
 * Otherwise it falls back to better-sqlite3 (local / dev).
 */
export async function createDatabaseAdapter(): Promise<DatabaseAdapter> {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    return createPostgresAdapter(databaseUrl);
  }

  return createSQLiteAdapter();
}

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

async function createSQLiteAdapter(): Promise<DatabaseAdapter> {
  // Dynamic import so pg isn't pulled in when not needed
  const { default: Database } = await import('better-sqlite3');
  const { SQLiteAdapter } = await import('./sqlite-adapter.js');

  const dataDir =
    process.env.DATA_DIR || path.join(process.cwd(), 'backend', 'data');
  const dbPath = path.join(dataDir, 'data.sqlite');

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const raw = new Database(dbPath);
  raw.pragma('foreign_keys = ON');
  raw.pragma('journal_mode = WAL');
  raw.pragma('synchronous = FULL');
  raw.pragma('temp_store = MEMORY');
  raw.pragma('mmap_size = 268435456');

  const adapter = new SQLiteAdapter(raw);

  await initializeSQLiteTables(adapter);
  await runSQLiteMigrations(adapter);

  console.log(`SQLite database initialized at: ${dbPath}`);
  return adapter;
}

/** Idempotent table creation for SQLite. */
async function initializeSQLiteTables(db: DatabaseAdapter): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      persona_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      model TEXT,
      images TEXT,
      statistics TEXT,
      artifacts TEXT,
      parent_id TEXT,
      branch_index INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      filename TEXT NOT NULL,
      title TEXT,
      content TEXT,
      metadata TEXT,
      uploaded_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      start_char INTEGER,
      end_char INTEGER,
      embedding TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, key)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      name TEXT NOT NULL,
      description TEXT,
      model TEXT NOT NULL,
      parameters TEXT NOT NULL,
      avatar TEXT,
      background TEXT,
      embedding_model TEXT,
      memory_settings TEXT,
      mutation_settings TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      plugin_id TEXT NOT NULL,
      api_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, plugin_id)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_variables (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      plugin_id TEXT NOT NULL,
      variable_name TEXT NOT NULL,
      variable_value TEXT NOT NULL,
      is_encrypted INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, plugin_id, variable_name)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS generated_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      image_data TEXT NOT NULL,
      size TEXT,
      quality TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS persona_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      timestamp INTEGER NOT NULL,
      context TEXT,
      importance_score REAL DEFAULT 0.5,
      memory_type TEXT DEFAULT 'general',
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER,
      decay_factor REAL DEFAULT 1.0,
      consolidated_from TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS persona_states (
      persona_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      runtime_state TEXT NOT NULL,
      mutation_log TEXT NOT NULL,
      last_updated INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
    )
  `);

  // Indexes
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_messages_parent_id ON session_messages(parent_id);
    CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_document_chunks_index ON document_chunks(chunk_index);
    CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_preferences_key ON user_preferences(key);
    CREATE INDEX IF NOT EXISTS idx_personas_user_id ON personas(user_id);
    CREATE INDEX IF NOT EXISTS idx_personas_name ON personas(name);
    CREATE INDEX IF NOT EXISTS idx_plugin_credentials_user_id ON plugin_credentials(user_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_credentials_plugin_id ON plugin_credentials(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_variables_user_id ON plugin_variables(user_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_variables_plugin_id ON plugin_variables(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON generated_images(user_id);
    CREATE INDEX IF NOT EXISTS idx_generated_images_created_at ON generated_images(created_at);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_user_persona ON persona_memories(user_id, persona_id);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_timestamp ON persona_memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_importance ON persona_memories(importance_score);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_type ON persona_memories(memory_type);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_last_accessed ON persona_memories(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_persona_states_user ON persona_states(user_id);
    CREATE INDEX IF NOT EXISTS idx_persona_states_updated ON persona_states(last_updated);
  `);

  // Seed default system setting
  const now = Date.now();
  await db.run(
    `INSERT INTO system_settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
    'allow_user_model_pull',
    'true',
    now
  );

  // Create default user if none exist
  const userCount = await db.get<{ count: number }>(
    'SELECT COUNT(*) as count FROM users'
  );
  if (userCount && userCount.count === 0) {
    await db.run(
      `INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'default',
      'admin',
      null,
      'default',
      'admin',
      now,
      now
    );
    console.log('Created default user for single-user mode');
  }

  console.log('Database tables initialized successfully');
}

/** Column-add migrations for existing SQLite databases. */
async function runSQLiteMigrations(db: DatabaseAdapter): Promise<void> {
  // session_messages columns
  const smCols = (
    await db.all<{ name: string }>('PRAGMA table_info(session_messages)')
  ).map(c => c.name);
  for (const col of [
    { name: 'model', type: 'TEXT' },
    { name: 'images', type: 'TEXT' },
    { name: 'statistics', type: 'TEXT' },
    { name: 'artifacts', type: 'TEXT' },
    { name: 'parent_id', type: 'TEXT' },
    { name: 'branch_index', type: 'INTEGER DEFAULT 0' },
    { name: 'is_active', type: 'INTEGER DEFAULT 1' },
  ]) {
    if (!smCols.includes(col.name)) {
      await db.exec(
        `ALTER TABLE session_messages ADD COLUMN ${col.name} ${col.type}`
      );
    }
  }

  // sessions.persona_id
  const sCols = (
    await db.all<{ name: string }>('PRAGMA table_info(sessions)')
  ).map(c => c.name);
  if (!sCols.includes('persona_id')) {
    await db.exec('ALTER TABLE sessions ADD COLUMN persona_id TEXT');
  }

  // personas extra columns
  const pCols = (
    await db.all<{ name: string }>('PRAGMA table_info(personas)')
  ).map(c => c.name);
  for (const col of [
    { name: 'embedding_model', type: 'TEXT' },
    { name: 'memory_settings', type: 'TEXT' },
    { name: 'mutation_settings', type: 'TEXT' },
  ]) {
    if (!pCols.includes(col.name)) {
      await db.exec(`ALTER TABLE personas ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // users.avatar
  const uCols = (
    await db.all<{ name: string }>('PRAGMA table_info(users)')
  ).map(c => c.name);
  if (!uCols.includes('avatar')) {
    await db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
  }

  // persona_memories extra columns
  const pmCols = (
    await db.all<{ name: string }>('PRAGMA table_info(persona_memories)')
  ).map(c => c.name);
  for (const col of [
    { name: 'memory_type', type: "TEXT DEFAULT 'general'" },
    { name: 'access_count', type: 'INTEGER DEFAULT 0' },
    { name: 'last_accessed', type: 'INTEGER' },
    { name: 'decay_factor', type: 'REAL DEFAULT 1.0' },
    { name: 'consolidated_from', type: 'TEXT' },
  ]) {
    if (!pmCols.includes(col.name)) {
      try {
        await db.exec(
          `ALTER TABLE persona_memories ADD COLUMN ${col.name} ${col.type}`
        );
      } catch {
        // Column may already exist
      }
    }
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

async function createPostgresAdapter(
  connectionString: string
): Promise<DatabaseAdapter> {
  const pgModule = await import('pg');
  const { PgAdapter } = await import('./pg-adapter.js');

  const poolConfig: pg.PoolConfig = { connectionString };

  // Also support individual params as overrides / fallback
  if (process.env.DB_HOST) {
    poolConfig.host = process.env.DB_HOST;
    poolConfig.port = Number(process.env.DB_PORT) || 5432;
    poolConfig.database = process.env.DB_NAME;
    poolConfig.user = process.env.DB_USER;
    poolConfig.password = process.env.DB_PASSWORD;
  }

  const pool = new pgModule.default.Pool(poolConfig);

  // Quick connectivity check
  const client = await pool.connect();
  client.release();

  const adapter = new PgAdapter(pool);

  await runPostgresMigrations(adapter);

  console.log('PostgreSQL database connected');
  return adapter;
}

/** Run numbered SQL migration files from backend/migrations/. */
async function runPostgresMigrations(db: DatabaseAdapter): Promise<void> {
  // Ensure migrations tracking table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Find migration directory (handle both dev and dist layouts)
  let migrationsDir = path.join(process.cwd(), 'backend', 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    migrationsDir = path.join(process.cwd(), 'migrations');
  }
  if (!fs.existsSync(migrationsDir)) {
    console.warn('No migrations directory found, skipping PG migrations');
    return;
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const applied = await db.get<{ name: string }>(
      'SELECT name FROM _migrations WHERE name = $1',
      file
    );
    if (applied) continue;

    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.exec(sql);
    await db.exec(
      `INSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}')`
    );
  }
}
