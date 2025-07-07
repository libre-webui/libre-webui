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

// Database instance
let db: Database.Database | null = null;

/**
 * Initialize and return the SQLite database connection
 */
export function getDatabase(): Database.Database {
  if (!db) {
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

    // Create tables if they don't exist
    initializeTables();

    // Run migrations
    runMigrations();

    console.log(`SQLite database initialized at: ${dbPath}`);
  }

  return db;
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Sessions table - migrated from sessions.json
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT DEFAULT 'default',
      title TEXT NOT NULL,
      model TEXT NOT NULL,
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
      images TEXT, -- JSON array of base64 images (for multimodal support)
      statistics TEXT, -- JSON object with generation statistics
      artifacts TEXT, -- JSON array of artifacts
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
      metadata TEXT, -- JSON string for additional metadata
      uploaded_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

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
  `);

  console.log('Database tables initialized successfully');

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

      console.log('Created default user for single-user mode');
    }
  } catch (error) {
    console.error('Failed to create default user:', error);
  }
}

/**
 * Run database migrations
 */
function runMigrations(): void {
  if (!db) return;

  try {
    // Check if we need to add new columns to session_messages
    const tableInfo = db
      .prepare('PRAGMA table_info(session_messages)')
      .all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingColumns = tableInfo.map(col => col.name);

    // Add missing columns one by one
    const newColumns = [
      { name: 'model', type: 'TEXT' },
      { name: 'images', type: 'TEXT' },
      { name: 'statistics', type: 'TEXT' },
      { name: 'artifacts', type: 'TEXT' },
    ];

    for (const column of newColumns) {
      if (!existingColumns.includes(column.name)) {
        console.log(`Adding column ${column.name} to session_messages table`);
        db.exec(
          `ALTER TABLE session_messages ADD COLUMN ${column.name} ${column.type}`
        );
      }
    }
  } catch (error) {
    console.error('Error running migrations:', error);
  }
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('Database connection closed');
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
    console.error('Error checking database initialization:', error);
    return false;
  }
}

// Export the database instance getter as default
export default getDatabase;
