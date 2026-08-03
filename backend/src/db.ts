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

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createLogger } from './utils/logger.js';

const logger = createLogger('database');

// Database instance
let db: Database.Database | null = null;
let dbInitializationFailed = false;

/**
 * Check if SQLite/better-sqlite3 is available
 */
function isSQLiteAvailable(): boolean {
  try {
    // Try to create a temporary in-memory database to test if better-sqlite3 works
    const testDb = new Database(':memory:');
    testDb.close();
    return true;
  } catch (error) {
    logger.error('SQLite availability check failed:', error);
    return false;
  }
}

/**
 * Initialize and return the SQLite database connection
 */
export function getDatabase(): Database.Database {
  if (dbInitializationFailed) {
    throw new Error('SQLite database initialization previously failed');
  }

  if (!db) {
    // Check if SQLite is available first
    if (!isSQLiteAvailable()) {
      logger.error(
        'better-sqlite3 is not available or compatible with current Node.js version'
      );
      logger.debug('Storage mode: JSON');
      dbInitializationFailed = true;
      throw new Error('SQLite not available');
    }

    try {
      // Use environment variable for database path, default to data directory
      const dataDir =
        process.env.DATA_DIR || path.join(process.cwd(), 'backend', 'data');
      const dbPath = path.join(dataDir, 'data.sqlite');

      // Ensure the directory exists
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Initialize database
      db = new Database(dbPath);

      // Enable foreign keys
      db.pragma('foreign_keys = ON');

      // Set additional security pragmas
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('temp_store = MEMORY');
      db.pragma('mmap_size = 268435456'); // 256MB

      logger.debug('✅ Database initialized with application-level encryption');

      // Create tables if they don't exist
      initializeTables();

      // Run migrations
      runMigrations();

      logger.debug(`SQLite database initialized at: ${dbPath}`);
    } catch (error) {
      logger.error('Error initializing SQLite database:', error);
      logger.debug('Storage mode: JSON');
      dbInitializationFailed = true;
      throw new Error('SQLite database initialization failed');
    }
  }

  return db;
}

/**
 * Safely get the database connection, returns null if not available
 */
export function getDatabaseSafe(): Database.Database | null {
  try {
    return getDatabase();
  } catch (_error) {
    logger.warn('Database not available, continuing without SQLite');
    return null;
  }
}

/**
 * Initialize database tables
 */
function initializeTables(): void {
  if (!db) return;

  // Users table - for future user management
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('pending', 'active')),
      approved_at INTEGER,
      approved_by TEXT,
      avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Migration: Add avatar column if it doesn't exist
  try {
    const tableInfo = db.prepare('PRAGMA table_info(users)').all() as {
      name: string;
    }[];
    const hasAvatar = tableInfo.some(col => col.name === 'avatar');
    if (!hasAvatar) {
      db.exec('ALTER TABLE users ADD COLUMN avatar TEXT');
      logger.debug('Migration: Added avatar column to users table');
    }
    const hasAccountStatus = tableInfo.some(
      col => col.name === 'account_status'
    );
    if (!hasAccountStatus) {
      db.exec(
        "ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'"
      );
      logger.debug('Migration: Added account approval status to users table');
    }
    const hasApprovedAt = tableInfo.some(col => col.name === 'approved_at');
    if (!hasApprovedAt) {
      db.exec('ALTER TABLE users ADD COLUMN approved_at INTEGER');
      logger.debug(
        'Migration: Added account approval timestamp to users table'
      );
    }
    const hasApprovedBy = tableInfo.some(col => col.name === 'approved_by');
    if (!hasApprovedBy) {
      db.exec('ALTER TABLE users ADD COLUMN approved_by TEXT');
      logger.debug('Migration: Added account approver to users table');
    }
  } catch {
    // Column might already exist or table doesn't exist yet
  }

  // Sessions table - migrated from sessions.json
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      persona_id TEXT, -- Reference to persona used for this session
      provider_type TEXT, -- Optional qualified Chat provider (ollama or plugin)
      provider_id TEXT, -- Plugin ID when provider_type is plugin
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER DEFAULT 0, -- Hidden from the sidebar until unarchived
      settings TEXT, -- Encrypted JSON with per-chat overrides
      folder_id TEXT, -- Optional folder this chat lives in
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
    )
  `);

  // Folders for organizing chat sessions
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_folders (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Session messages table - normalized from sessions.json
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      message_index INTEGER NOT NULL,
      model TEXT, -- Model used for this message (for assistant messages)
      provider_metadata TEXT, -- Encrypted JSON with provider-specific replay state
      images TEXT, -- JSON array of base64 images (for multimodal support)
      statistics TEXT, -- JSON object with generation statistics
      artifacts TEXT, -- JSON array of artifacts
      rating INTEGER, -- User feedback: 1 = liked, -1 = disliked
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Documents table - migrated from documents.json
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      filename TEXT NOT NULL,
      title TEXT,
      content TEXT,
      file_type TEXT,
      size INTEGER,
      session_id TEXT,
      metadata TEXT, -- JSON string for additional metadata
      uploaded_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  const documentColumns = db.prepare('PRAGMA table_info(documents)').all() as {
    name: string;
  }[];
  const existingDocumentColumns = new Set(
    documentColumns.map(column => column.name)
  );
  for (const column of [
    { name: 'file_type', type: 'TEXT' },
    { name: 'size', type: 'INTEGER' },
    { name: 'session_id', type: 'TEXT' },
  ]) {
    if (!existingDocumentColumns.has(column.name)) {
      db.exec(`ALTER TABLE documents ADD COLUMN ${column.name} ${column.type}`);
    }
  }

  // Document chunks table - migrated from document-chunks.json
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      start_char INTEGER,
      end_char INTEGER,
      embedding TEXT, -- JSON string for embedding vector
      created_at INTEGER NOT NULL,
      FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
    )
  `);

  // User preferences table - migrated from preferences.json
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL, -- JSON string for complex values
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, key)
    )
  `);

  // Global system settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Personas table - for AI personas/characters
  db.exec(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      name TEXT NOT NULL,
      description TEXT,
      model TEXT NOT NULL,
      parameters TEXT NOT NULL, -- JSON string for model parameters (temperature, top_p, etc.)
      avatar TEXT, -- URL or path to avatar image
      background TEXT, -- URL or path to background image
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Plugin credentials table - for per-user API keys
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      plugin_id TEXT NOT NULL,
      api_key TEXT NOT NULL, -- Encrypted API key
      routing_auth_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, plugin_id)
    )
  `);

  // Plugin variables table - for per-user plugin configuration (valves)
  db.exec(`
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

  // Per-user model discovery results. Provider endpoints and credentials are
  // user-scoped, so discovered model IDs must not mutate the shared plugin
  // manifest or leak between accounts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_discovered_models (
      user_id TEXT DEFAULT 'default',
      plugin_id TEXT NOT NULL,
      models_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, plugin_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_discovered_capability_models (
      user_id TEXT DEFAULT 'default',
      plugin_id TEXT NOT NULL,
      capability TEXT NOT NULL CHECK(capability IN ('image', 'tts', 'audio', 'video')),
      models_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, plugin_id, capability)
    )
  `);

  // Plugin activation is account-scoped. Definitions remain shared files.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_activations (
      user_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      activated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, plugin_id)
    )
  `);

  // Writable definitions are quarantined until an administrator approves
  // their exact normalized contents.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_definition_approvals (
      plugin_id TEXT PRIMARY KEY,
      definition_fingerprint TEXT NOT NULL,
      source_path TEXT NOT NULL,
      approved_by_user_id TEXT NOT NULL,
      approved_at INTEGER NOT NULL
    )
  `);

  // Server-side metering for outbound plugin provider calls. This table stores
  // no prompts, responses, endpoints, credentials, or provider error bodies.
  // Names are snapshotted so historical usage remains understandable after a
  // plugin definition or user account is changed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_usage_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      plugin_name TEXT NOT NULL,
      capability TEXT NOT NULL CHECK(capability IN ('chat', 'embedding', 'image', 'tts', 'audio', 'video')),
      model TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success', 'error', 'cancelled')),
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      input_units INTEGER NOT NULL DEFAULT 0,
      output_units INTEGER NOT NULL DEFAULT 0,
      unit_kind TEXT,
      duration_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Generated images table - for image gallery
  db.exec(`
    CREATE TABLE IF NOT EXISTS generated_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL DEFAULT 'image' CHECK(kind IN ('image', 'video', 'audio')),
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      plugin_id TEXT,
      image_data TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'image/png',
      size TEXT,
      quality TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS media_generation_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_job_id TEXT NOT NULL,
      plugin_id TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      options_json TEXT,
      gallery_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Native Work tasks. Workspace files live in a task-owned Docker volume;
  // SQLite stores ownership, conversation history, and durable run state.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'ollama',
      provider_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      network_enabled INTEGER NOT NULL DEFAULT 1,
      volume_name TEXT NOT NULL UNIQUE,
      container_name TEXT NOT NULL UNIQUE,
      -- Set when the task is bound to a host folder instead of its volume.
      host_path TEXT,
      preview_url TEXT,
      preview_status TEXT NOT NULL DEFAULT 'stopped',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS work_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'ollama',
      provider_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES work_tasks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS work_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      run_id TEXT,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      message_index INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (task_id) REFERENCES work_tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES work_runs(id) ON DELETE SET NULL,
      UNIQUE(task_id, message_index)
    );

    CREATE INDEX IF NOT EXISTS idx_work_tasks_user_updated
      ON work_tasks(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_runs_task_created
      ON work_runs(task_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_runs_one_active
      ON work_runs(task_id)
      WHERE status IN ('queued', 'preparing', 'running');
    CREATE INDEX IF NOT EXISTS idx_work_messages_task_index
      ON work_messages(task_id, message_index);
  `);

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);
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
    CREATE INDEX IF NOT EXISTS idx_plugin_discovered_models_plugin_id ON plugin_discovered_models(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_discovered_capability_models_plugin_id ON plugin_discovered_capability_models(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_activations_plugin_id ON plugin_activations(plugin_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_definition_approvals_approver ON plugin_definition_approvals(approved_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_plugin_usage_events_created_at ON plugin_usage_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugin_usage_events_plugin_created ON plugin_usage_events(plugin_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugin_usage_events_model_created ON plugin_usage_events(model, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_plugin_usage_events_user_created ON plugin_usage_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON generated_images(user_id);
    CREATE INDEX IF NOT EXISTS idx_generated_images_created_at ON generated_images(created_at);
    CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_user_created ON media_generation_jobs(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_media_generation_jobs_updated_at ON media_generation_jobs(updated_at);
  `);

  logger.debug('Database tables initialized successfully');

  // Create default user if no users exist
  createDefaultUserIfNeeded();
}

/**
 * Create a default user if no users exist in the database
 */
function createDefaultUserIfNeeded(): void {
  if (!db) return;

  try {
    const userCount = db
      .prepare('SELECT COUNT(*) as count FROM users')
      .get() as { count: number };

    if (userCount.count === 0) {
      const now = Date.now();
      // Create a default user for single-user mode
      db.prepare(
        `
        INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `
      ).run('default', 'admin', null, 'default', 'admin', now, now);

      logger.debug('Created default user for single-user mode');
    }
  } catch (error) {
    logger.error('Failed to create default user:', error);
  }
}

/**
 * Run database migrations
 */
function runMigrations(): void {
  if (!db) return;
  const migrationDb = db;

  try {
    const usageTableSql = migrationDb
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'plugin_usage_events'`
      )
      .get() as { sql?: string } | undefined;
    if (
      usageTableSql?.sql &&
      (!usageTableSql.sql.includes("'video'") ||
        !usageTableSql.sql.includes("'audio'"))
    ) {
      migrationDb.transaction(() => {
        migrationDb.exec(`
          CREATE TABLE plugin_usage_events_next (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            plugin_id TEXT NOT NULL,
            plugin_name TEXT NOT NULL,
            capability TEXT NOT NULL CHECK(capability IN ('chat', 'embedding', 'image', 'tts', 'audio', 'video')),
            model TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('success', 'error', 'cancelled')),
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER,
            input_units INTEGER NOT NULL DEFAULT 0,
            output_units INTEGER NOT NULL DEFAULT 0,
            unit_kind TEXT,
            duration_ms INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          INSERT INTO plugin_usage_events_next SELECT * FROM plugin_usage_events;
          DROP TABLE plugin_usage_events;
          ALTER TABLE plugin_usage_events_next RENAME TO plugin_usage_events;
          CREATE INDEX idx_plugin_usage_events_created_at ON plugin_usage_events(created_at DESC);
          CREATE INDEX idx_plugin_usage_events_plugin_created ON plugin_usage_events(plugin_id, created_at DESC);
          CREATE INDEX idx_plugin_usage_events_model_created ON plugin_usage_events(model, created_at DESC);
          CREATE INDEX idx_plugin_usage_events_user_created ON plugin_usage_events(user_id, created_at DESC);
        `);
      })();
    }

    const generatedMediaColumns = (
      db.prepare('PRAGMA table_info(generated_images)').all() as Array<{
        name: string;
      }>
    ).map(column => column.name);
    for (const column of [
      {
        name: 'kind',
        definition:
          "TEXT NOT NULL DEFAULT 'image' CHECK(kind IN ('image', 'video', 'audio'))",
      },
      { name: 'plugin_id', definition: 'TEXT' },
      {
        name: 'mime_type',
        definition: "TEXT NOT NULL DEFAULT 'image/png'",
      },
      { name: 'metadata', definition: 'TEXT' },
    ]) {
      if (!generatedMediaColumns.includes(column.name)) {
        db.exec(
          `ALTER TABLE generated_images ADD COLUMN ${column.name} ${column.definition}`
        );
      }
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_generated_images_user_kind_created
       ON generated_images(user_id, kind, created_at DESC)`
    );

    const pluginCredentialColumns = (
      db.prepare('PRAGMA table_info(plugin_credentials)').all() as Array<{
        name: string;
      }>
    ).map(column => column.name);
    if (!pluginCredentialColumns.includes('routing_auth_fingerprint')) {
      db.exec(
        'ALTER TABLE plugin_credentials ADD COLUMN routing_auth_fingerprint TEXT'
      );
      logger.debug(
        'Migration: Added routing/auth binding to plugin credentials'
      );
    }

    const pluginApprovalColumns = (
      db
        .prepare('PRAGMA table_info(plugin_definition_approvals)')
        .all() as Array<{ name: string }>
    ).map(column => column.name);
    if (!pluginApprovalColumns.includes('source_path')) {
      db.exec(
        `ALTER TABLE plugin_definition_approvals
         ADD COLUMN source_path TEXT NOT NULL DEFAULT ''`
      );
    }

    // Check if we need to add new columns to session_messages
    const sessionMessagesTableInfo = db
      .prepare('PRAGMA table_info(session_messages)')
      .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingSessionMessagesColumns = sessionMessagesTableInfo.map(
      col => col.name
    );

    // Add missing columns to session_messages table
    const newSessionMessagesColumns = [
      { name: 'model', type: 'TEXT' },
      { name: 'provider_metadata', type: 'TEXT' },
      { name: 'images', type: 'TEXT' },
      { name: 'statistics', type: 'TEXT' },
      { name: 'artifacts', type: 'TEXT' },
      // Branching support columns
      { name: 'parent_id', type: 'TEXT' }, // ID of the original message this is a variant of
      { name: 'branch_index', type: 'INTEGER DEFAULT 0' }, // Index within branch group (0 = original)
      { name: 'is_active', type: 'INTEGER DEFAULT 1' }, // Whether this is the active variant (1 = true)
      { name: 'rating', type: 'INTEGER' }, // User feedback: 1 = liked, -1 = disliked
    ];

    for (const column of newSessionMessagesColumns) {
      if (!existingSessionMessagesColumns.includes(column.name)) {
        logger.debug(`Adding column ${column.name} to session_messages table`);
        db.exec(
          `ALTER TABLE session_messages ADD COLUMN ${column.name} ${column.type}`
        );
      }
    }

    // Create index for branching queries
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_session_messages_parent_id ON session_messages(parent_id)'
    );

    // Check if we need to add persona_id column to sessions table
    const sessionsTableInfo = db
      .prepare('PRAGMA table_info(sessions)')
      .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingSessionsColumns = sessionsTableInfo.map(col => col.name);

    for (const column of [
      { name: 'provider_type', type: 'TEXT' },
      { name: 'provider_id', type: 'TEXT' },
      { name: 'archived', type: 'INTEGER DEFAULT 0' },
      { name: 'settings', type: 'TEXT' },
      { name: 'folder_id', type: 'TEXT' },
    ]) {
      if (!existingSessionsColumns.includes(column.name)) {
        logger.debug(`Adding column ${column.name} to sessions table`);
        db.exec(
          `ALTER TABLE sessions ADD COLUMN ${column.name} ${column.type}`
        );
      }
    }

    // Add persona_id column to sessions table if it doesn't exist
    if (!existingSessionsColumns.includes('persona_id')) {
      logger.debug('Adding persona_id column to sessions table');
      db.exec('ALTER TABLE sessions ADD COLUMN persona_id TEXT');

      // Create index for the new column
      logger.debug('Creating index for persona_id column');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_sessions_persona_id ON sessions(persona_id)'
      );
    }

    // Check if we need to add embedding_model and advanced features columns to personas table
    const personasTableInfo = db
      .prepare('PRAGMA table_info(personas)')
      .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingPersonasColumns = personasTableInfo.map(col => col.name);

    // Add missing columns to personas table
    const newPersonasColumns = [
      { name: 'embedding_model', type: 'TEXT' },
      { name: 'memory_settings', type: 'TEXT' }, // JSON string
      { name: 'mutation_settings', type: 'TEXT' }, // JSON string
    ];

    for (const column of newPersonasColumns) {
      if (!existingPersonasColumns.includes(column.name)) {
        logger.debug(`Adding column ${column.name} to personas table`);
        db.exec(
          `ALTER TABLE personas ADD COLUMN ${column.name} ${column.type}`
        );
      }
    }

    // Work initially stored only a model name. Preserve those existing tasks as
    // explicit Ollama routes so a newly activated plugin with the same model
    // name can never silently redirect their prompts to a remote provider.
    for (const table of ['work_tasks', 'work_runs']) {
      const tableInfo = db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{
        name: string;
      }>;
      const columns = tableInfo.map(column => column.name);
      if (!columns.includes('provider_type')) {
        db.exec(
          `ALTER TABLE ${table} ADD COLUMN provider_type TEXT NOT NULL DEFAULT 'ollama'`
        );
      }
      if (!columns.includes('provider_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN provider_id TEXT`);
      }
      if (table === 'work_tasks' && !columns.includes('host_path')) {
        db.exec(`ALTER TABLE work_tasks ADD COLUMN host_path TEXT`);
      }
      db.prepare(
        `UPDATE ${table}
         SET provider_type = 'ollama', provider_id = NULL
         WHERE provider_type IS NULL
            OR provider_type NOT IN ('ollama', 'plugin')
            OR (provider_type = 'ollama' AND provider_id IS NOT NULL)`
      ).run();
    }

    // Work networking is now an implementation detail instead of a task-level
    // switch. Existing workspaces must stay preview-capable after the control
    // is removed from the UI.
    db.prepare(
      'UPDATE work_tasks SET network_enabled = 1 WHERE network_enabled != 1'
    ).run();
  } catch (error) {
    logger.error('Error running migrations:', error);
  }
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.debug('Database connection closed');
  }
}

/**
 * Check if the database exists and has tables
 */
export function isDatabaseInitialized(): boolean {
  try {
    const db = getDatabase();
    const result = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      )
      .get();
    return !!result;
  } catch (error) {
    logger.error('Error checking database initialization:', error);
    return false;
  }
}

// Export the database instance getter as default
export default getDatabase;
