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
import { resolveDataDirectory } from './utils/dataDirectory.js';
import {
  getSchemaCompatibilityState,
  preflightSQLiteBootstrapSchema,
  preflightSQLiteMigrationLedger,
  recordSQLiteSchemaFailure,
  runSQLiteMigrationCoordinator,
  sqliteMigrationsRequireForeignKeysDisabledAfter,
} from './persistence/sqliteMigrations.js';
export type { SchemaCompatibilityState } from './persistence/sqliteMigrations.js';
export { getSchemaCompatibilityState };

const logger = createLogger('database');

// Database instance
let db: Database.Database | null = null;
let dbInitializationFailed = false;

const PREFLIGHT_MARKER_FILE = '.preflight-verification.json';
const PREFLIGHT_MARKER_FORMAT = 'libre-preflight-verification';

/**
 * Cheap identity of an existing database for preflight caching: the inode
 * pair detects a replaced or restored file, and the schema cookie changes
 * exactly when a migration (or any DDL) runs. Ordinary row writes change
 * neither, so a healthy instance keeps one stable identity between upgrades.
 * The cookie is read through a readonly connection so a version still
 * sitting in the WAL is observed the same way on both sides of the marker.
 */
export interface SQLitePreflightIdentity {
  dev: number;
  ino: number;
  schemaCookie: number;
}

export function readSQLitePreflightIdentity(
  databasePath: string
): SQLitePreflightIdentity | null {
  try {
    const stat = fs.lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const probe = new Database(databasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const schemaCookie = probe.pragma('schema_version', {
        simple: true,
      }) as number;
      if (!Number.isSafeInteger(schemaCookie)) return null;
      return { dev: stat.dev, ino: stat.ino, schemaCookie };
    } finally {
      probe.close();
    }
  } catch {
    return null;
  }
}

export function readPreflightVerificationMarker(
  dataDir: string
): SQLitePreflightIdentity | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dataDir, PREFLIGHT_MARKER_FILE), 'utf8')
    ) as {
      format?: string;
      version?: number;
      database?: { dev?: number; ino?: number; schemaCookie?: number };
    };
    if (
      parsed?.format !== PREFLIGHT_MARKER_FORMAT ||
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.database?.dev) ||
      !Number.isSafeInteger(parsed.database?.ino) ||
      !Number.isSafeInteger(parsed.database?.schemaCookie)
    ) {
      return null;
    }
    return {
      dev: parsed.database!.dev!,
      ino: parsed.database!.ino!,
      schemaCookie: parsed.database!.schemaCookie!,
    };
  } catch {
    return null;
  }
}

/** Delete the marker file to force a full preflight on the next start. */
export function writePreflightVerificationMarker(
  dataDir: string,
  identity: SQLitePreflightIdentity
): void {
  const target = path.join(dataDir, PREFLIGHT_MARKER_FILE);
  const staging = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(
      staging,
      `${JSON.stringify(
        {
          format: PREFLIGHT_MARKER_FORMAT,
          version: 1,
          database: identity,
          verifiedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    );
    fs.renameSync(staging, target);
  } catch {
    fs.rmSync(staging, { force: true });
    // The marker is an optimization; a failed write only means the next
    // start repeats the full preflight.
  }
}

export function preflightIdentityMatchesMarker(
  identity: SQLitePreflightIdentity | null,
  marker: SQLitePreflightIdentity | null
): boolean {
  return Boolean(
    identity &&
    marker &&
    identity.dev === marker.dev &&
    identity.ino === marker.ino &&
    identity.schemaCookie === marker.schemaCookie
  );
}

const assertSQLiteIntegrity = (database: Database.Database): void => {
  const result = database.pragma('quick_check', { simple: true });
  if (result !== 'ok') {
    throw new Error('SQLite quick_check reported an integrity failure');
  }
};

/**
 * Validate an existing database before importing stateful application
 * singletons. This reads bounded integrity and schema metadata only; missing
 * database files remain a supported fresh-install state.
 */
export function preflightExistingSQLiteDatabase(
  databasePath: string,
  scratchRoot?: string,
  inspect?: (database: Database.Database) => void
): void {
  let databaseStat: fs.Stats;
  try {
    databaseStat = fs.lstatSync(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Unable to inspect the SQLite bootstrap source');
  }
  if (
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    databaseStat.nlink !== 1
  ) {
    throw new Error(
      'SQLite bootstrap database must be a single-link regular file'
    );
  }

  const sources = ['', '-wal', '-shm'].flatMap(suffix => {
    const sourcePath = `${databasePath}${suffix}`;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Unable to inspect a SQLite bootstrap companion');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(
        'SQLite bootstrap sources must be single-link regular files'
      );
    }
    return [{ sourcePath, suffix, stat }];
  });

  // SQLite may create WAL shared-memory bookkeeping beside a database even
  // when the connection itself is readonly. Inspect a private on-disk clone
  // so startup validation cannot mutate the source directory. COPYFILE_FICLONE
  // uses a copy-on-write clone where the filesystem supports it and safely
  // falls back to a regular file copy elsewhere without buffering the database
  // in process memory.
  if (scratchRoot) {
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const scratchStat = fs.lstatSync(scratchRoot);
    if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()) {
      throw new Error('SQLite bootstrap scratch path must be a directory');
    }
  }
  const inspectionDirectory = fs.mkdtempSync(
    path.join(scratchRoot || path.dirname(databasePath), '.libre-bootstrap-')
  );
  const inspectionDatabasePath = path.join(
    inspectionDirectory,
    path.basename(databasePath)
  );
  let inspectionDatabase: Database.Database | undefined;
  try {
    try {
      for (const source of sources) {
        const sourceDescriptor = fs.openSync(
          source.sourcePath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        );
        let destinationDescriptor: number | undefined;
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        try {
          const openedStat = fs.fstatSync(sourceDescriptor);
          if (
            !openedStat.isFile() ||
            openedStat.dev !== source.stat.dev ||
            openedStat.ino !== source.stat.ino ||
            openedStat.nlink !== 1
          ) {
            throw new Error('SQLite bootstrap source changed during preflight');
          }
          destinationDescriptor = fs.openSync(
            `${inspectionDatabasePath}${source.suffix}`,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
            0o600
          );
          let bytesRead = 0;
          while (
            (bytesRead = fs.readSync(
              sourceDescriptor,
              buffer,
              0,
              buffer.length,
              null
            )) > 0
          ) {
            let offset = 0;
            while (offset < bytesRead) {
              offset += fs.writeSync(
                destinationDescriptor,
                buffer,
                offset,
                bytesRead - offset
              );
            }
          }
          fs.fsyncSync(destinationDescriptor);
        } finally {
          buffer.fill(0);
          if (destinationDescriptor !== undefined)
            fs.closeSync(destinationDescriptor);
          fs.closeSync(sourceDescriptor);
        }
      }
    } catch {
      throw new Error(
        'Unable to create a safe SQLite bootstrap inspection snapshot'
      );
    }

    inspectionDatabase = new Database(inspectionDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    assertSQLiteIntegrity(inspectionDatabase);
    preflightSQLiteBootstrapSchema(inspectionDatabase);
    inspect?.(inspectionDatabase);
  } finally {
    inspectionDatabase?.close();
    fs.rmSync(inspectionDirectory, { recursive: true, force: true });
  }
}

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
    let schemaInitializationStarted = false;
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
      const dataDir = resolveDataDirectory();
      const dbPath = path.join(dataDir, 'data.sqlite');

      // Ensure the directory exists
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const dataDirectoryStat = fs.lstatSync(dir);
      if (
        !dataDirectoryStat.isDirectory() ||
        dataDirectoryStat.isSymbolicLink()
      ) {
        throw new Error('DATA_DIR must be a physical directory');
      }
      fs.chmodSync(dir, 0o700);

      // Initialize database
      db = new Database(dbPath);
      fs.chmodSync(dbPath, 0o600);

      // This check is deliberately read-only and precedes every persistent
      // PRAGMA and historical inline CREATE/ALTER migration. An unsupported
      // or tampered ledger must fail startup without changing the database.
      const schemaCompatibility = preflightSQLiteMigrationLedger(db);

      // Enable foreign keys
      db.pragma('foreign_keys = ON');

      // Set connection-local safety and performance pragmas first. WAL is a
      // persistent database change, so it is enabled only after schema
      // initialization commits successfully.
      db.pragma('synchronous = FULL');
      db.pragma('temp_store = MEMORY');
      db.pragma('mmap_size = 268435456'); // 256MB

      logger.debug('✅ Database initialized with application-level encryption');

      schemaInitializationStarted = true;
      bootstrapSQLiteSchema(db, schemaCompatibility.currentVersion);

      db.pragma('journal_mode = WAL');
      // Under WAL, NORMAL keeps the database consistent through power loss;
      // only the most recent commits can roll back. FULL stays in effect for
      // the schema work above, but steady-state runs without a per-commit
      // fsync, which chat streaming pays on every persisted event batch.
      db.pragma('synchronous = NORMAL');
      for (const suffix of ['-wal', '-shm']) {
        const companion = `${dbPath}${suffix}`;
        if (fs.existsSync(companion)) fs.chmodSync(companion, 0o600);
      }

      logger.debug(`SQLite database initialized at: ${dbPath}`);
    } catch (error) {
      logger.error('Error initializing SQLite database:', error);
      logger.debug('Storage mode: JSON');
      if (schemaInitializationStarted) {
        recordSQLiteSchemaFailure(error);
      }
      if (db) {
        db.close();
        db = null;
      }
      dbInitializationFailed = true;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`SQLite database initialization failed: ${detail}`);
    }
  }

  return db;
}

const bootstrapSQLiteSchema = (
  database: Database.Database,
  initialSchemaVersion: number
): void => {
  const previousDatabase = db;
  if (previousDatabase && previousDatabase !== database) {
    throw new Error(
      'Cannot validate another SQLite database after application initialization'
    );
  }

  db = database;
  const requiresForeignKeysDisabled =
    sqliteMigrationsRequireForeignKeysDisabledAfter(initialSchemaVersion);
  const foreignKeysEnabled = database.pragma('foreign_keys', {
    simple: true,
  }) as number;
  try {
    if (requiresForeignKeysDisabled) {
      if (database.inTransaction) {
        throw new Error(
          'SQLite bootstrap cannot suspend foreign keys inside a transaction'
        );
      }
      database.pragma('foreign_keys = OFF');
      if (database.pragma('foreign_keys', { simple: true }) !== 0) {
        throw new Error('SQLite bootstrap could not suspend foreign keys');
      }
    }
    const initializeSchema = database.transaction(() => {
      // Historical inline initialization and durable ledger adoption form one
      // atomic bootstrap. Pre-start validation checks the same structural
      // contract against a private on-disk snapshot first.
      initializeTables();
      runMigrations();
      runSQLiteMigrationCoordinator(database);
      if (
        requiresForeignKeysDisabled &&
        (database.pragma('foreign_key_check') as unknown[]).length > 0
      ) {
        throw new Error(
          'SQLite bootstrap migrations left foreign-key violations'
        );
      }
    });
    initializeSchema();
  } finally {
    if (requiresForeignKeysDisabled) {
      database.pragma(
        `foreign_keys = ${foreignKeysEnabled === 1 ? 'ON' : 'OFF'}`
      );
    }
    db = previousDatabase;
  }
};

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
      account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('pending', 'active', 'retiring')),
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
  } catch (error) {
    logger.error('Failed to migrate the users table:', error);
    throw error;
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
      pinned INTEGER DEFAULT 0, -- Shown in the sidebar's Pinned group
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

  // Knowledge collections group documents for reuse across chats
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_collections (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Standalone notes
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
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
      thinking TEXT, -- Encrypted model reasoning shown separately from the answer
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
    { name: 'collection_id', type: 'TEXT' },
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
      capability TEXT NOT NULL CHECK(capability IN ('image', 'stt', 'tts', 'audio', 'video')),
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
      capability TEXT NOT NULL CHECK(capability IN ('chat', 'embedding', 'image', 'stt', 'tts', 'audio', 'video')),
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

  // Reusable, user-owned TTS voice profiles. User-provided names, reference
  // recordings, and exact transcripts are AES-GCM encrypted binary envelopes;
  // only the routing and validation metadata remains queryable.
  db.exec(`
    CREATE TABLE IF NOT EXISTS voice_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name BLOB NOT NULL,
      plugin_id TEXT NOT NULL,
      model TEXT NOT NULL,
      routing_fingerprint TEXT NOT NULL,
      reference_audio BLOB NOT NULL,
      reference_text BLOB,
      audio_mime_type TEXT NOT NULL,
      audio_format TEXT NOT NULL CHECK(audio_format IN ('wav', 'mp3', 'flac', 'ogg', 'm4a')),
      audio_size INTEGER NOT NULL CHECK(audio_size > 0),
      consent_confirmed_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const voiceProfileColumns = db
    .prepare('PRAGMA table_info(voice_profiles)')
    .all() as Array<{ name: string }>;
  if (
    !voiceProfileColumns.some(column => column.name === 'routing_fingerprint')
  ) {
    // This table first existed on the unreleased dev branch. Preserve any
    // profiles created by that build, but require explicit re-creation before
    // reuse because their original provider route was not consent-bound.
    db.exec(
      "ALTER TABLE voice_profiles ADD COLUMN routing_fingerprint TEXT NOT NULL DEFAULT ''"
    );
  }

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

    -- Named Work runtime policies. Every column except the name is optional:
    -- a null field falls back to the deployment's global runtime config, so a
    -- policy only has to state what it changes.
    CREATE TABLE IF NOT EXISTS work_policies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      image TEXT,
      memory_limit TEXT,
      cpu_limit TEXT,
      pids_limit INTEGER,
      network_default INTEGER,
      workspace_size TEXT,
      idle_timeout_ms INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Tasks may reference a named policy; null means the global defaults.
  // (SQLite cannot add a foreign key via ALTER TABLE; deleting a policy
  // clears the reference in code, which is the SET NULL semantic.)
  {
    const workTaskColumns = db
      .prepare('PRAGMA table_info(work_tasks)')
      .all() as Array<{ name: string }>;
    if (!workTaskColumns.some(column => column.name === 'policy_id')) {
      logger.debug('Adding column policy_id to work_tasks table');
      db.exec('ALTER TABLE work_tasks ADD COLUMN policy_id TEXT');
    }
  }

  // Create indexes for better performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
    CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at);
    CREATE INDEX IF NOT EXISTS idx_notes_user_updated ON notes(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_session_folders_user_id ON session_folders(user_id);
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
    CREATE INDEX IF NOT EXISTS idx_voice_profiles_user_updated ON voice_profiles(user_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_voice_profiles_user_route ON voice_profiles(user_id, plugin_id, model);
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
    throw error;
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
        !usageTableSql.sql.includes("'audio'") ||
        !usageTableSql.sql.includes("'stt'"))
    ) {
      migrationDb.transaction(() => {
        migrationDb.exec(`
          CREATE TABLE plugin_usage_events_next (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            plugin_id TEXT NOT NULL,
            plugin_name TEXT NOT NULL,
            capability TEXT NOT NULL CHECK(capability IN ('chat', 'embedding', 'image', 'stt', 'tts', 'audio', 'video')),
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

    const capabilityModelsTableSql = migrationDb
      .prepare(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'plugin_discovered_capability_models'`
      )
      .get() as { sql?: string } | undefined;
    if (
      capabilityModelsTableSql?.sql &&
      !capabilityModelsTableSql.sql.includes("'stt'")
    ) {
      migrationDb.transaction(() => {
        migrationDb.exec(`
          CREATE TABLE plugin_discovered_capability_models_next (
            user_id TEXT DEFAULT 'default',
            plugin_id TEXT NOT NULL,
            capability TEXT NOT NULL CHECK(capability IN ('image', 'stt', 'tts', 'audio', 'video')),
            models_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, plugin_id, capability)
          );
          INSERT INTO plugin_discovered_capability_models_next
            SELECT * FROM plugin_discovered_capability_models;
          DROP TABLE plugin_discovered_capability_models;
          ALTER TABLE plugin_discovered_capability_models_next
            RENAME TO plugin_discovered_capability_models;
          CREATE INDEX idx_plugin_discovered_capability_models_plugin_id
            ON plugin_discovered_capability_models(plugin_id);
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
      { name: 'thinking', type: 'TEXT' },
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
      { name: 'pinned', type: 'INTEGER DEFAULT 0' },
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
    throw error;
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
