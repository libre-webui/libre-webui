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
  closeDatabase,
  getDatabase,
  getDatabaseSafe,
  preflightExistingSQLiteDatabase,
  preflightIdentityMatchesMarker,
  readPreflightVerificationMarker,
  readSQLitePreflightIdentity,
  writePreflightVerificationMarker,
} from '../db.js';
import type { PostgresDatabase } from './postgresDatabase.js';
import { createSQLitePersistence } from './sqlitePersistence.js';
import type {
  IdentityEmailCodec,
  Persistence,
  PersistenceDialect,
} from './types.js';

let current:
  | {
      dialect: PersistenceDialect;
      persistence: Persistence;
      sqliteDatabase?: Database.Database;
      postgresDatabase?: PostgresDatabase;
    }
  | undefined;
let initialization:
  { dialect: PersistenceDialect; promise: Promise<Persistence> } | undefined;

export interface PersistenceInitializationOptions {
  dialect: PersistenceDialect;
  emailCodec: IdentityEmailCodec;
  env?: NodeJS.ProcessEnv;
}

const assertSelectedDialect = (dialect: PersistenceDialect): void => {
  if (current && current.dialect !== dialect) {
    throw new Error(
      `Persistence is already initialized for ${current.dialect}; refusing to open ${dialect}.`
    );
  }
  if (initialization && initialization.dialect !== dialect) {
    throw new Error(
      `Persistence initialization for ${initialization.dialect} is already in progress.`
    );
  }
};

/**
 * Initialize exactly one process-wide persistence backend. Application
 * entrypoints call this before importing routes or stateful service singletons,
 * so PostgreSQL mode can never fall through to a local SQLite sidecar.
 */
export const initializePersistence = (
  options: PersistenceInitializationOptions
): Promise<Persistence> => {
  assertSelectedDialect(options.dialect);
  if (current) return Promise.resolve(current.persistence);
  if (initialization) return initialization.promise;

  const promise = (async (): Promise<Persistence> => {
    if (options.dialect === 'sqlite') {
      const database = getDatabase();
      const persistence = createSQLitePersistence(database, options.emailCodec);
      current = {
        dialect: 'sqlite',
        persistence,
        sqliteDatabase: database,
      };
      return persistence;
    }

    const [
      { resolvePostgresRuntimeConfig },
      { initializePostgresPersistence },
    ] = await Promise.all([
      import('./postgresConfig.js'),
      import('./postgresPersistence.js'),
    ]);
    const persistence = await initializePostgresPersistence(
      resolvePostgresRuntimeConfig(options.env ?? process.env),
      options.emailCodec
    );
    current = {
      dialect: 'postgres',
      persistence,
      postgresDatabase: persistence.database,
    };
    return persistence;
  })();
  initialization = { dialect: options.dialect, promise };
  void promise.then(
    () => {
      if (initialization?.promise === promise) initialization = undefined;
    },
    () => {
      if (initialization?.promise === promise) initialization = undefined;
    }
  );
  return promise;
};

/**
 * Return the initialized persistence kernel. The lazy path exists only for
 * backwards-compatible SQLite tests and maintenance scripts. PostgreSQL must
 * always be initialized explicitly so a missing bootstrap cannot create a
 * misleading SQLite database.
 */
export function getPersistence(emailCodec?: IdentityEmailCodec): Persistence {
  if (current) {
    if (current.dialect === 'sqlite' && emailCodec) {
      const database = getDatabase();
      if (database !== current.sqliteDatabase) {
        current = {
          dialect: 'sqlite',
          sqliteDatabase: database,
          persistence: createSQLitePersistence(database, emailCodec),
        };
      }
    }
    return current.persistence;
  }
  const selected = process.env.DATABASE_BACKEND?.trim().toLowerCase();
  if (selected === 'postgres') {
    throw new Error(
      'PostgreSQL persistence has not been initialized by the application bootstrap.'
    );
  }
  if (!emailCodec) {
    throw new Error('SQLite persistence requires an identity email codec.');
  }
  const database = getDatabase();
  current = {
    dialect: 'sqlite',
    sqliteDatabase: database,
    persistence: createSQLitePersistence(database, emailCodec),
  };
  return current.persistence;
}

export const getInitializedPersistence = (): Persistence | undefined =>
  current?.persistence;

/** Native handles are restricted to backend adapter composition. */
export const getSQLiteAdapterDatabase = (): Database.Database => {
  if (current?.dialect !== 'sqlite' || !current.sqliteDatabase) {
    throw new Error('The selected persistence backend is not SQLite.');
  }
  return current.sqliteDatabase;
};

/**
 * Assert that a SQLite domain repository is currently inside the selected
 * process-wide owning transaction. Transactional outbox publishers use this
 * opaque guard instead of receiving or rediscovering a native driver handle.
 */
export const assertSelectedSQLiteTransaction = (): void => {
  if (
    current?.dialect !== 'sqlite' ||
    !current.sqliteDatabase ||
    !current.sqliteDatabase.inTransaction
  ) {
    throw new Error(
      'SQLite durable enqueue requires the selected owning transaction.'
    );
  }
};

/** Native handles are restricted to backend adapter composition. */
export const getPostgresAdapterDatabase = (): PostgresDatabase => {
  if (current?.dialect !== 'postgres' || !current.postgresDatabase) {
    throw new Error('The selected persistence backend is not PostgreSQL.');
  }
  return current.postgresDatabase;
};

export const closePersistence = async (): Promise<void> => {
  const pending = initialization?.promise;
  if (pending) {
    await pending.catch(() => undefined);
  }
  const selected = current;
  current = undefined;
  initialization = undefined;
  if (!selected) return;
  await selected.persistence.close();
  if (selected.dialect === 'sqlite') closeDatabase();
};

/**
 * Health checks may inspect the configured adapter without making the raw
 * driver a general application dependency. Domain code should use repositories.
 */
export const getSQLiteHealthDatabase = (): Database.Database | null =>
  current?.dialect === 'postgres'
    ? null
    : (current?.sqliteDatabase ?? getDatabaseSafe());

export {
  preflightExistingSQLiteDatabase,
  preflightIdentityMatchesMarker,
  readPreflightVerificationMarker,
  readSQLitePreflightIdentity,
  writePreflightVerificationMarker,
};

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
  PersistenceHealth,
  PersistenceRepositories,
  PersistenceSyncExecutor,
  PersistenceSyncUnitOfWork,
  PersistenceUnitOfWork,
  SynchronousTransactionResult,
} from './types.js';
export type {
  ApplicationResourceRepositories,
  ArchiveNestedOwner,
  ArchiveNestedResource,
  ArchiveOwnedResource,
  ChatSessionRepository,
  DataArchiveRepository,
  KnowledgeCollectionRepository,
  NoteRepository,
  PreferenceRepository,
  SessionFolderRepository,
  StoredChatMessageRecord,
  StoredChatSessionAggregate,
  StoredChatSessionRecord,
  StoredNamedResourceRecord,
  StoredNoteRecord,
  StoredPreferenceRecord,
  SystemSettingRepository,
} from './resourceTypes.js';
export {
  PersistenceResourceConflictError,
  PersistenceResourceLimitError,
} from './resourceTypes.js';
export type {
  ApiTokenRepository,
  AuditResult,
  AuthSessionRepository,
  GrantPermission,
  GrantPrincipalType,
  GroupRepository,
  GroupSyncRepository,
  OAuthIdentityRepository,
  ResourceGrantRepository,
  ResourceGrantSyncRepository,
  SecurityAuditQuery,
  SecurityAuditRepository,
  SecurityAuditSyncRepository,
  SecurityRepositories,
  SecuritySyncRepositories,
  StoredApiTokenRecord,
  StoredAuthSessionRecord,
  StoredGroupMemberRecord,
  StoredGroupRecord,
  StoredOAuthIdentityRecord,
  StoredResourceGrantRecord,
  StoredSecurityAuditEventRecord,
} from './securityTypes.js';
export {
  createSQLitePersistence,
  SQLitePersistence,
} from './sqlitePersistence.js';
export type {
  PostgresPoolLike,
  PostgresQueryExecutor,
  PostgresTransactionOptions,
} from './postgresDatabase.js';
export type {
  PostgresRuntimeConfig,
  PostgresSslMode,
} from './postgresConfig.js';
export type {
  PostgresMigration,
  PostgresMigrationMode,
  PostgresSchemaCompatibility,
  PostgresSchemaCompatibilityStatus,
} from './postgresMigrationTypes.js';
