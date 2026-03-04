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

import { DatabaseAdapter } from './database/types.js';
import { createDatabaseAdapter } from './database/index.js';

export type { DatabaseAdapter, RunResult } from './database/types.js';

// ── Singleton state ──────────────────────────────────────────────────

let db: DatabaseAdapter | null = null;
let initPromise: Promise<DatabaseAdapter> | null = null;
let initFailed = false;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Initialise the database (call once during app startup).
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function initializeDatabase(): Promise<void> {
  if (db) return;
  if (initFailed) throw new Error('Database initialization previously failed');

  if (!initPromise) {
    initPromise = createDatabaseAdapter();
  }

  try {
    db = await initPromise;
    console.log('✅ Database initialized with application-level encryption');
  } catch (error) {
    initFailed = true;
    console.error('Error initializing database:', error);
    console.log('Storage mode: JSON');
    throw error;
  }
}

/**
 * Get the database adapter.
 * Throws if the database has not been initialised yet.
 */
export function getDatabase(): DatabaseAdapter {
  if (!db) {
    if (initFailed) {
      throw new Error('Database initialization previously failed');
    }
    throw new Error(
      'Database not initialized — call initializeDatabase() at startup'
    );
  }
  return db;
}

/**
 * Safely get the database adapter; returns null if not available.
 */
export function getDatabaseSafe(): DatabaseAdapter | null {
  return db;
}

/**
 * Check whether the database has been initialised.
 */
export function isDatabaseInitialized(): boolean {
  return db !== null;
}

/**
 * Close the database connection.
 */
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    initPromise = null;
    console.log('Database connection closed');
  }
}

// Default export for backward compatibility
export default getDatabase;
