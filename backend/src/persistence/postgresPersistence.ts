/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PoolClient, QueryResultRow } from 'pg';
import {
  createPostgresDatabase,
  type PostgresDatabase,
  type PostgresQueryExecutor,
} from './postgresDatabase.js';
import type { PostgresRuntimeConfig } from './postgresConfig.js';
import { POSTGRES_MIGRATIONS } from './postgresMigrationRegistry.js';
import { runPostgresMigrationCoordinator } from './postgresMigrations.js';
import { inspectPostgresSchema } from './postgresSchemaInspector.js';
import { inspectSQLiteImportCompletion } from './postgresImportState.js';
import {
  createPostgresResourceRepositories,
  createPostgresTransactionalResourceRepositories,
} from './postgresResourceRepositories.js';
import {
  createPostgresExtensionRepositories,
  createPostgresTransactionalExtensionRepositories,
} from './postgresExtensionRepositories.js';
import type {
  IdentityEmailCodec,
  IdentityPublicUserRecord,
  IdentityRepository,
  IdentityUserRecord,
  IdentityUserUpdate,
  PendingApprovalRecord,
  PersistenceHealth,
  PersistenceRepositories,
  PersistenceUnitOfWork,
  PostgresPersistenceContract,
} from './types.js';
import type {
  PostgresMigration,
  PostgresSchemaCompatibility,
} from './postgresMigrationTypes.js';
import type { IdentityDeletionEnqueuer } from './identityDeletionTypes.js';

type StoredIdentityRecord = QueryResultRow & {
  id: string;
  username: string;
  email: string | null;
  password_hash?: string;
  role: 'admin' | 'user';
  account_status: 'pending' | 'active' | 'retiring';
  approved_at: string | number | null;
  approved_by: string | null;
  avatar: string | null;
  created_at: string | number;
  updated_at: string | number;
};

const plausibleEmail = (value: string): boolean =>
  value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value);

const encryptedEnvelopeShape = (value: string): boolean => {
  const parts = value.split(':');
  return (
    parts.length === 3 &&
    (parts[0]?.length === 32 ||
      parts[1]?.length === 32 ||
      parts.every(part => /^[a-fA-F0-9]*$/.test(part)))
  );
};

const encodeEmail = (
  codec: IdentityEmailCodec,
  value: string | null
): string | null => {
  if (value === null) return null;
  if (!plausibleEmail(value)) throw new Error('Invalid identity email');
  const encrypted = codec.encrypt(value);
  if (!codec.isEncrypted(encrypted)) {
    throw new Error('Identity email encryption did not produce an envelope');
  }
  return encrypted;
};

const decodeEmail = (
  codec: IdentityEmailCodec,
  value: string | null
): string | null => {
  if (value === null) return null;
  if (!codec.isEncrypted(value)) {
    if (encryptedEnvelopeShape(value)) {
      throw new Error('Invalid encrypted identity email');
    }
    // PostgreSQL has no legacy plaintext adoption path. Accepting plaintext
    // here would silently weaken the storage boundary.
    throw new Error('PostgreSQL identity email is not encrypted');
  }
  const plaintext = codec.decryptAuthenticated(value);
  if (!plausibleEmail(plaintext)) throw new Error('Invalid identity email');
  return plaintext;
};

const lookupEmail = (
  codec: IdentityEmailCodec,
  value: string | null
): string | null => (value === null ? null : codec.lookupToken(value));

const safeInteger = (value: string | number, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return parsed;
};

const decodeUser = (
  codec: IdentityEmailCodec,
  row: StoredIdentityRecord,
  includePassword: boolean
): IdentityUserRecord | IdentityPublicUserRecord => {
  const common = {
    id: row.id,
    username: row.username,
    email: decodeEmail(codec, row.email),
    role: row.role,
    account_status: row.account_status,
    approved_at:
      row.approved_at === null
        ? null
        : safeInteger(row.approved_at, 'approved_at'),
    approved_by: row.approved_by,
    avatar: row.avatar,
    created_at: safeInteger(row.created_at, 'created_at'),
    updated_at: safeInteger(row.updated_at, 'updated_at'),
  };
  if (!includePassword) return common;
  if (typeof row.password_hash !== 'string') {
    throw new Error('PostgreSQL identity password hash is missing');
  }
  return { ...common, password_hash: row.password_hash };
};

class PostgresIdentityRepository implements IdentityRepository {
  constructor(
    private readonly executor: PostgresQueryExecutor,
    private readonly emailCodec: IdentityEmailCodec,
    private readonly database: PostgresDatabase,
    private readonly transactionClient?: PoolClient
  ) {}

  async list(): Promise<IdentityPublicUserRecord[]> {
    const result = await this.executor.query<StoredIdentityRecord>(
      `SELECT id, username, email, role, account_status, approved_at,
              approved_by, avatar, created_at, updated_at
         FROM users
        WHERE id <> 'default'
        ORDER BY created_at DESC`
    );
    return result.rows.map(row =>
      decodeUser(this.emailCodec, row, false)
    ) as IdentityPublicUserRecord[];
  }

  async findPublicById(id: string): Promise<IdentityPublicUserRecord | null> {
    const result = await this.executor.query<StoredIdentityRecord>(
      `SELECT id, username, email, role, account_status, approved_at,
              approved_by, avatar, created_at, updated_at
         FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0]
      ? (decodeUser(
          this.emailCodec,
          result.rows[0],
          false
        ) as IdentityPublicUserRecord)
      : null;
  }

  async findByUsername(username: string): Promise<IdentityUserRecord | null> {
    const result = await this.executor.query<StoredIdentityRecord>(
      `SELECT id, username, email, password_hash, role, account_status,
              approved_at, approved_by, avatar, created_at, updated_at
         FROM users WHERE username = $1`,
      [username]
    );
    return result.rows[0]
      ? (decodeUser(
          this.emailCodec,
          result.rows[0],
          true
        ) as IdentityUserRecord)
      : null;
  }

  async insert(user: IdentityUserRecord): Promise<void> {
    await this.executor.query(
      `INSERT INTO users
         (id, username, email, email_lookup, password_hash, role,
          account_status, approved_at, approved_by, avatar, created_at,
          updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        user.id,
        user.username,
        encodeEmail(this.emailCodec, user.email),
        lookupEmail(this.emailCodec, user.email),
        user.password_hash,
        user.role,
        user.account_status,
        user.approved_at,
        user.approved_by,
        user.avatar,
        user.created_at,
        user.updated_at,
      ]
    );
  }

  async approve(
    id: string,
    approvedBy: string,
    approvedAt: number
  ): Promise<boolean> {
    const result = await this.executor.query(
      `UPDATE users
          SET account_status = 'active', approved_at = $1,
              approved_by = $2, updated_at = $1
        WHERE id = $3 AND id <> 'default' AND account_status = 'pending'`,
      [approvedAt, approvedBy, id]
    );
    return result.rowCount === 1;
  }

  async getPendingApprovalSummary(): Promise<PendingApprovalRecord> {
    const result = await this.executor.query<{
      count: string;
      latest_created_at: string | null;
    }>(
      `SELECT COUNT(*)::text AS count,
              MAX(created_at)::text AS latest_created_at
         FROM users
        WHERE id <> 'default' AND account_status = 'pending'`
    );
    return {
      count: safeInteger(result.rows[0]?.count || '0', 'pending count'),
      latest_created_at: result.rows[0]?.latest_created_at
        ? safeInteger(result.rows[0].latest_created_at, 'latest created_at')
        : null,
    };
  }

  async beginRetirement(id: string, updatedAt: number): Promise<boolean> {
    const changed = await this.executor.query(
      `UPDATE users SET account_status = 'retiring', updated_at = $1
        WHERE id = $2 AND id <> 'default'
          AND account_status IN ('pending', 'active')`,
      [updatedAt, id]
    );
    if (changed.rowCount === 1) return true;
    const existing = await this.executor.query(
      `SELECT 1 FROM users
        WHERE id = $1 AND id <> 'default' AND account_status = 'retiring'`,
      [id]
    );
    return existing.rowCount === 1;
  }

  async update(id: string, update: IdentityUserUpdate): Promise<boolean> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (update.username !== undefined) add('username', update.username);
    if (update.email !== undefined) {
      add('email', encodeEmail(this.emailCodec, update.email));
      add('email_lookup', lookupEmail(this.emailCodec, update.email));
    }
    if (update.passwordHash !== undefined) {
      add('password_hash', update.passwordHash);
    }
    if (update.role !== undefined) add('role', update.role);
    if (update.avatar !== undefined) add('avatar', update.avatar);
    add('updated_at', update.updatedAt);
    values.push(id);
    const result = await this.executor.query(
      `UPDATE users SET ${assignments.join(', ')} WHERE id = $${values.length}`,
      values
    );
    return result.rowCount === 1;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.executor.query(
      'DELETE FROM users WHERE id = $1',
      [id]
    );
    return result.rowCount === 1;
  }

  async deleteAndEnqueue(
    id: string,
    actorUserId: string,
    enqueuer: IdentityDeletionEnqueuer
  ): Promise<boolean> {
    const remove = async (
      executor: PostgresQueryExecutor
    ): Promise<boolean> => {
      const actor = await executor.query<{ account_status: string }>(
        'SELECT account_status FROM users WHERE id = $1 FOR UPDATE',
        [actorUserId]
      );
      if (actor.rows[0]?.account_status !== 'active') {
        throw new Error('Identity deletion requires an active actor');
      }
      const result = await executor.query(
        "DELETE FROM users WHERE id = $1 AND account_status = 'retiring'",
        [id]
      );
      if (result.rowCount !== 1) return false;
      await enqueuer.enqueuePostgres(executor, {
        targetUserId: id,
        actorUserId,
      });
      return true;
    };
    if (this.transactionClient) return remove(this.transactionClient);
    return this.database.transaction(remove, {
      isolationLevel: 'serializable',
    });
  }

  async usernameExists(username: string): Promise<boolean> {
    const result = await this.executor.query(
      'SELECT 1 FROM users WHERE username = $1',
      [username]
    );
    return result.rowCount === 1;
  }

  async emailExists(email: string): Promise<boolean> {
    if (!plausibleEmail(email)) throw new Error('Invalid identity email');
    const result = await this.executor.query(
      'SELECT 1 FROM users WHERE email_lookup = $1',
      [this.emailCodec.lookupToken(email)]
    );
    return result.rowCount === 1;
  }

  async countRealUsers(): Promise<number> {
    const result = await this.executor.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM users WHERE id <> 'default'"
    );
    return safeInteger(result.rows[0]?.count || '0', 'user count');
  }
}

const repositoriesFor = (
  database: PostgresDatabase,
  executor: PostgresQueryExecutor,
  emailCodec: IdentityEmailCodec,
  client?: PoolClient
): PersistenceRepositories => ({
  identity: new PostgresIdentityRepository(
    executor,
    emailCodec,
    database,
    client
  ),
  resources: client
    ? createPostgresTransactionalResourceRepositories(database, client)
    : createPostgresResourceRepositories(database),
  extensions: client
    ? createPostgresTransactionalExtensionRepositories(client)
    : createPostgresExtensionRepositories(database),
});

export class PostgresPersistence implements PostgresPersistenceContract {
  readonly dialect = 'postgres' as const;
  readonly repositories: PersistenceRepositories;

  constructor(
    readonly database: PostgresDatabase,
    private readonly emailCodec: IdentityEmailCodec,
    readonly schemaCompatibility: PostgresSchemaCompatibility
  ) {
    this.repositories = repositoriesFor(database, database, emailCodec);
  }

  transaction<T>(
    operation: (unitOfWork: PersistenceUnitOfWork) => Promise<T>
  ): Promise<T> {
    return this.database.transaction(
      async client =>
        operation(
          repositoriesFor(this.database, client, this.emailCodec, client)
        ),
      { isolationLevel: 'serializable' }
    );
  }

  async health(): Promise<PersistenceHealth> {
    const startedAt = performance.now();
    const poolHealth = await this.database.health();
    if (!poolHealth.ready) return poolHealth;
    try {
      const state = await this.database.query<{
        status: string;
        current_version: number;
        target_version: number;
        schema_fingerprint: string | null;
      }>(
        `SELECT status, current_version, target_version, schema_fingerprint
           FROM libre_schema_compatibility
          WHERE singleton = 1`
      );
      const expectedVersion = POSTGRES_MIGRATIONS.length;
      const row = state.rows[0];
      if (
        state.rowCount !== 1 ||
        row?.status !== 'compatible' ||
        Number(row.current_version) !== expectedVersion ||
        Number(row.target_version) !== expectedVersion ||
        !row.schema_fingerprint
      ) {
        return {
          ...poolHealth,
          ready: false,
          latencyMs: performance.now() - startedAt,
          message: 'PostgreSQL schema is not ready',
        };
      }
      const importStatus = await inspectSQLiteImportCompletion(this.database);
      if (importStatus === 'running' || importStatus === 'failed') {
        return {
          ...poolHealth,
          ready: false,
          latencyMs: performance.now() - startedAt,
          message: 'PostgreSQL SQLite import is incomplete',
        };
      }
      const ledger = await this.database.query<{
        version: number;
        name: string;
        checksum: string;
      }>(
        `SELECT version, name, checksum
           FROM libre_schema_migrations
          ORDER BY version ASC`
      );
      const validLedger = POSTGRES_MIGRATIONS.every(
        (migration, index) =>
          Number(ledger.rows[index]?.version) === migration.version &&
          ledger.rows[index]?.name === migration.name &&
          ledger.rows[index]?.checksum === migration.checksum
      );
      if (ledger.rows.length !== expectedVersion || !validLedger) {
        return {
          ...poolHealth,
          ready: false,
          latencyMs: performance.now() - startedAt,
          message: 'PostgreSQL migration ledger is incompatible',
        };
      }
      const structure = await inspectPostgresSchema(
        this.database,
        POSTGRES_MIGRATIONS
      );
      if (
        !structure.compatible ||
        structure.fingerprint !== row.schema_fingerprint
      ) {
        return {
          ...poolHealth,
          ready: false,
          latencyMs: performance.now() - startedAt,
          message: 'PostgreSQL schema structure is incompatible',
        };
      }
      return {
        ...poolHealth,
        latencyMs: performance.now() - startedAt,
      };
    } catch {
      return {
        ...poolHealth,
        ready: false,
        latencyMs: performance.now() - startedAt,
        message: 'PostgreSQL schema readiness query failed',
      };
    }
  }

  close(): Promise<void> {
    return this.database.close();
  }
}

export const initializePostgresPersistence = async (
  config: PostgresRuntimeConfig,
  emailCodec: IdentityEmailCodec,
  migrations: readonly PostgresMigration[] = POSTGRES_MIGRATIONS
): Promise<PostgresPersistence> => {
  const database = createPostgresDatabase(config);
  try {
    const compatibility = await runPostgresMigrationCoordinator(
      database,
      config,
      migrations
    );
    return new PostgresPersistence(database, emailCodec, compatibility);
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
};
