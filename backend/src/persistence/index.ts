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

import type Database from 'better-sqlite3';
import {
  getDatabase,
  getDatabaseSafe,
  preflightExistingSQLiteDatabase,
} from '../db.js';
import { createSQLitePersistence } from './sqlitePersistence.js';
import type { IdentityEmailCodec, Persistence } from './types.js';

let current:
  { database: Database.Database; persistence: Persistence } | undefined;

/**
 * Return the configured persistence kernel. SQLite remains the only supported
 * backend for now, but application code consumes asynchronous repositories and
 * a transaction-scoped unit of work instead of the native driver.
 */
export function getPersistence(emailCodec: IdentityEmailCodec): Persistence {
  const database = getDatabase();
  if (!current || current.database !== database) {
    current = {
      database,
      persistence: createSQLitePersistence(database, emailCodec),
    };
  }
  return current.persistence;
}

/**
 * Health checks may inspect the configured adapter without making the raw
 * driver a general application dependency. Domain code should use repositories.
 */
export const getSQLiteHealthDatabase = (): Database.Database | null =>
  getDatabaseSafe();

export { preflightExistingSQLiteDatabase };

export type {
  IdentityAccountStatus,
  IdentityEmailCodec,
  IdentityPublicUserRecord,
  IdentityRepository,
  IdentitySyncRepository,
  IdentityRole,
  IdentityUserRecord,
  IdentityUserUpdate,
  PendingApprovalRecord,
  Persistence,
  PersistenceRepositories,
  PersistenceSyncExecutor,
  PersistenceUnitOfWork,
  SynchronousTransactionResult,
} from './types.js';
export {
  createSQLitePersistence,
  SQLitePersistence,
} from './sqlitePersistence.js';
