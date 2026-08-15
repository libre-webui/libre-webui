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
import type {
  IdentityAccountStatus,
  IdentityEmailCodec,
  IdentityPublicUserRecord,
  IdentityRepository,
  IdentitySyncRepository,
  IdentityUserRecord,
  IdentityUserUpdate,
  PendingApprovalRecord,
  PersistenceExecutor,
  PersistenceRepositories,
  PersistenceRunResult,
  PersistenceSyncExecutor,
  PersistenceSyncUnitOfWork,
  SQLitePersistenceContract,
  SynchronousTransactionResult,
} from './types.js';
import { createSQLiteResourceRepositories } from './sqliteResourceRepositories.js';
import { createSQLiteExtensionRepositories } from './sqliteExtensionRepositories.js';
import {
  createSQLiteSecurityRepositories,
  createSQLiteSecuritySyncRepositories,
} from './sqliteSecurityRepositories.js';
import { createVoiceProfileNameLookup } from './voiceProfileNameLookup.js';
import type { IdentityDeletionEnqueuer } from './identityDeletionTypes.js';

type StoredIdentityRecord = { email: string | null };

const isPlausibleLegacyPlaintextEmail = (value: string): boolean =>
  value.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(value);

const resemblesEncryptedEmailEnvelope = (value: string): boolean => {
  const parts = value.split(':');
  return (
    parts.length === 3 &&
    (parts[0]?.length === 32 ||
      parts[1]?.length === 32 ||
      parts.every(part => /^[a-fA-F0-9]*$/.test(part)))
  );
};

const decodeStoredEmail = (
  codec: IdentityEmailCodec,
  value: string | null
): string | null => {
  if (value === null) return null;
  if (codec.isEncrypted(value)) return codec.decryptAuthenticated(value);
  // Legacy releases stored ordinary plaintext addresses, including forms that
  // can contain a colon. Reject values shaped like a damaged legacy envelope
  // instead of returning ciphertext as user data or encrypting it twice.
  if (resemblesEncryptedEmailEnvelope(value)) {
    throw new Error('Invalid encrypted identity email');
  }
  if (!isPlausibleLegacyPlaintextEmail(value)) {
    throw new Error('Invalid legacy identity email');
  }
  return value;
};

const decodeLegacyStoredEmail = (
  codec: IdentityEmailCodec,
  value: string
): string | null => {
  if (codec.isEncrypted(value)) return codec.decryptAuthenticated(value);
  if (resemblesEncryptedEmailEnvelope(value)) {
    throw new Error('Invalid encrypted identity email');
  }
  // Older releases accepted arbitrary strings and used an empty value to
  // clear this optional field. Preserve every non-envelope value during
  // adoption, while normalizing blank legacy values to the canonical NULL.
  return value.trim().length === 0 ? null : value;
};

const encodeEmail = (
  codec: IdentityEmailCodec,
  value: string | null
): string | null => {
  if (value === null) return null;
  if (!isPlausibleLegacyPlaintextEmail(value)) {
    throw new Error('Invalid identity email');
  }
  const encrypted = codec.encrypt(value);
  if (!codec.isEncrypted(encrypted)) {
    throw new Error('Identity email encryption did not produce an envelope');
  }
  return encrypted;
};

const emailLookupToken = (
  codec: IdentityEmailCodec,
  value: string | null
): string | null => {
  if (value === null) return null;
  if (!isPlausibleLegacyPlaintextEmail(value)) {
    throw new Error('Invalid identity email');
  }
  return codec.lookupToken(value);
};

const decodeIdentityRecord = <RecordType extends StoredIdentityRecord>(
  codec: IdentityEmailCodec,
  record: RecordType
): RecordType => ({
  ...record,
  email: decodeStoredEmail(codec, record.email),
});

const migrateLegacyPlaintextEmails = (
  database: Database.Database,
  codec: IdentityEmailCodec
): void => {
  const migrate = database.transaction(() => {
    const rows = database
      .prepare(
        'SELECT id, email, email_lookup FROM users WHERE email IS NOT NULL'
      )
      .all() as Array<{
      id: string;
      email: string;
      email_lookup: string | null;
    }>;
    const update = database.prepare(
      'UPDATE users SET email = ?, email_lookup = ? WHERE id = ?'
    );
    for (const row of rows) {
      const plaintext = decodeLegacyStoredEmail(codec, row.email);
      if (plaintext === null) {
        update.run(null, null, row.id);
        continue;
      }
      const lookup = codec.lookupToken(plaintext);
      if (row.email_lookup !== null && row.email_lookup !== lookup) {
        throw new Error('Invalid identity email lookup token');
      }
      if (codec.isEncrypted(row.email)) {
        if (row.email_lookup === null) update.run(row.email, lookup, row.id);
        continue;
      }
      update.run(codec.encrypt(plaintext), lookup, row.id);
    }
  });
  migrate();
};

const migrateVoiceProfileNameLookups = (
  database: Database.Database,
  codec: IdentityEmailCodec
): void => {
  const table = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'voice_profiles'"
    )
    .get();
  if (!table) return;
  const hasLookupColumn = (
    database.prepare('PRAGMA table_info(voice_profiles)').all() as Array<{
      name: string;
    }>
  ).some(column => column.name === 'name_lookup');
  if (!hasLookupColumn) return;

  const migrate = database.transaction(() => {
    const rows = database
      .prepare(
        `SELECT id, user_id, name, name_lookup
           FROM voice_profiles
          ORDER BY id ASC`
      )
      .all() as Array<{
      id: string;
      user_id: string;
      name: Buffer;
      name_lookup: string | null;
    }>;
    const update = database.prepare(
      'UPDATE voice_profiles SET name_lookup = ? WHERE id = ? AND name_lookup IS NULL'
    );
    for (const row of rows) {
      const plaintextName = codec
        .decryptBuffer(
          row.name,
          Buffer.from(`voice-profile:${row.id}:${row.user_id}:name`, 'utf8')
        )
        .toString('utf8');
      const expected = createVoiceProfileNameLookup(codec, plaintextName);
      if (row.name_lookup !== null && row.name_lookup !== expected) {
        throw new Error('Invalid voice profile name lookup token');
      }
      if (row.name_lookup === null) update.run(expected, row.id);
    }
    const missing = database
      .prepare(
        'SELECT COUNT(*) AS count FROM voice_profiles WHERE name_lookup IS NULL'
      )
      .get() as { count: number };
    if (missing.count !== 0) {
      throw new Error('Voice profile name lookup migration is incomplete');
    }
  });
  try {
    migrate();
  } catch (error) {
    if (error instanceof Error && /unique constraint/i.test(error.message)) {
      throw new Error(
        'Duplicate encrypted voice profile names prevent lookup migration'
      );
    }
    throw error;
  }
};

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class DirectSQLiteExecutor implements PersistenceSyncExecutor {
  constructor(private readonly database: Database.Database) {}

  run(sql: string, parameters: readonly unknown[] = []): PersistenceRunResult {
    const result = this.database.prepare(sql).run(...parameters);
    return { changes: result.changes };
  }

  get<T>(sql: string, parameters: readonly unknown[] = []): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }

  all<T>(sql: string, parameters: readonly unknown[] = []): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }
}

class TransactionSQLiteExecutor implements PersistenceSyncExecutor {
  private active = true;

  constructor(private readonly delegate: DirectSQLiteExecutor) {}

  close(): void {
    this.active = false;
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error('SQLite persistence unit of work is no longer active');
    }
  }

  run(sql: string, parameters: readonly unknown[] = []): PersistenceRunResult {
    this.assertActive();
    return this.delegate.run(sql, parameters);
  }

  get<T>(sql: string, parameters: readonly unknown[] = []): T | undefined {
    this.assertActive();
    return this.delegate.get<T>(sql, parameters);
  }

  all<T>(sql: string, parameters: readonly unknown[] = []): T[] {
    this.assertActive();
    return this.delegate.all<T>(sql, parameters);
  }
}

class SerializedSQLiteExecutor implements PersistenceExecutor {
  constructor(
    private readonly direct: DirectSQLiteExecutor,
    private readonly mutex: AsyncMutex,
    private readonly isTransactionActive: () => boolean
  ) {}

  private assertAvailable(): void {
    if (this.isTransactionActive()) {
      throw new Error(
        'Persistence transactions must use the provided unit of work'
      );
    }
  }

  run(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<PersistenceRunResult> {
    this.assertAvailable();
    return this.mutex.runExclusive(async () =>
      this.direct.run(sql, parameters)
    );
  }

  get<T>(
    sql: string,
    parameters: readonly unknown[] = []
  ): Promise<T | undefined> {
    this.assertAvailable();
    return this.mutex.runExclusive(async () =>
      this.direct.get<T>(sql, parameters)
    );
  }

  all<T>(sql: string, parameters: readonly unknown[] = []): Promise<T[]> {
    this.assertAvailable();
    return this.mutex.runExclusive(async () =>
      this.direct.all<T>(sql, parameters)
    );
  }
}

class SQLiteIdentitySyncRepository implements IdentitySyncRepository {
  constructor(
    private readonly executor: PersistenceSyncExecutor,
    private readonly emailCodec: IdentityEmailCodec
  ) {}

  list(): IdentityPublicUserRecord[] {
    return this.executor
      .all<IdentityPublicUserRecord>(
        `
      SELECT id, username, email, role, account_status, approved_at, approved_by,
             avatar, created_at, updated_at
      FROM users
      WHERE id != 'default'
      ORDER BY created_at DESC
    `
      )
      .map(user => decodeIdentityRecord(this.emailCodec, user));
  }

  findPublicById(id: string): IdentityPublicUserRecord | null {
    const user =
      this.executor.get<IdentityPublicUserRecord>(
        `SELECT id, username, email, role, account_status, approved_at,
                approved_by, avatar, created_at, updated_at
         FROM users WHERE id = ?`,
        [id]
      ) ?? null;
    return user ? decodeIdentityRecord(this.emailCodec, user) : null;
  }

  findAccountStatusById(id: string): IdentityAccountStatus | null {
    return (
      this.executor.get<{ account_status: IdentityAccountStatus }>(
        'SELECT account_status FROM users WHERE id = ?',
        [id]
      )?.account_status ?? null
    );
  }

  findByUsername(username: string): IdentityUserRecord | null {
    const user =
      this.executor.get<IdentityUserRecord>(
        `SELECT id, username, email, password_hash, role, account_status,
                approved_at, approved_by, avatar, created_at, updated_at
         FROM users WHERE username = ?`,
        [username]
      ) ?? null;
    return user ? decodeIdentityRecord(this.emailCodec, user) : null;
  }

  insert(user: IdentityUserRecord): void {
    this.executor.run(
      `INSERT INTO users (
         id, username, email, email_lookup, password_hash, role, account_status,
         approved_at, approved_by, avatar, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id,
        user.username,
        encodeEmail(this.emailCodec, user.email),
        emailLookupToken(this.emailCodec, user.email),
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

  approve(id: string, approvedBy: string, approvedAt: number): boolean {
    return (
      this.executor.run(
        `UPDATE users
         SET account_status = 'active', approved_at = ?, approved_by = ?,
             updated_at = ?
         WHERE id = ? AND id != 'default' AND account_status = 'pending'`,
        [approvedAt, approvedBy, approvedAt, id]
      ).changes > 0
    );
  }

  beginRetirement(id: string, updatedAt: number): boolean {
    const changed = this.executor.run(
      `UPDATE users SET account_status = 'retiring', updated_at = ?
        WHERE id = ? AND id != 'default'
          AND account_status IN ('pending', 'active')`,
      [updatedAt, id]
    ).changes;
    if (changed === 1) return true;
    return Boolean(
      this.executor.get(
        `SELECT 1 FROM users
          WHERE id = ? AND id != 'default' AND account_status = 'retiring'`,
        [id]
      )
    );
  }

  getPendingApprovalSummary(): PendingApprovalRecord {
    return (
      this.executor.get<PendingApprovalRecord>(`
        SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at
        FROM users
        WHERE id != 'default' AND account_status = 'pending'
      `) ?? { count: 0, latest_created_at: null }
    );
  }

  update(id: string, update: IdentityUserUpdate): boolean {
    const assignments: string[] = [];
    const parameters: unknown[] = [];
    for (const [column, value] of [
      ['username', update.username],
      [
        'email',
        update.email === undefined
          ? undefined
          : encodeEmail(this.emailCodec, update.email),
      ],
      ['password_hash', update.passwordHash],
      ['role', update.role],
      ['avatar', update.avatar],
    ] as const) {
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    if (update.email !== undefined) {
      assignments.push('email_lookup = ?');
      parameters.push(emailLookupToken(this.emailCodec, update.email));
    }
    assignments.push('updated_at = ?');
    parameters.push(update.updatedAt, id);
    return (
      this.executor.run(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
        parameters
      ).changes > 0
    );
  }

  delete(id: string): boolean {
    return (
      this.executor.run('DELETE FROM users WHERE id = ?', [id]).changes > 0
    );
  }

  usernameExists(username: string): boolean {
    return Boolean(
      this.executor.get('SELECT 1 FROM users WHERE username = ?', [username])
    );
  }

  emailExists(email: string): boolean {
    return Boolean(
      this.executor.get('SELECT 1 FROM users WHERE email_lookup = ?', [
        this.emailCodec.lookupToken(email),
      ])
    );
  }

  countRealUsers(): number {
    return (
      this.executor.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE id != 'default'"
      )?.count ?? 0
    );
  }
}

class SQLiteIdentityRepository implements IdentityRepository {
  constructor(
    private readonly executor: PersistenceExecutor,
    private readonly emailCodec: IdentityEmailCodec,
    private readonly database: Database.Database
  ) {}

  list(): Promise<IdentityPublicUserRecord[]> {
    return this.executor
      .all<IdentityPublicUserRecord>(
        `
      SELECT id, username, email, role, account_status, approved_at, approved_by,
             avatar, created_at, updated_at
      FROM users
      WHERE id != 'default'
      ORDER BY created_at DESC
    `
      )
      .then(users =>
        users.map(user => decodeIdentityRecord(this.emailCodec, user))
      );
  }

  findPublicById(id: string): Promise<IdentityPublicUserRecord | null> {
    return this.executor
      .get<IdentityPublicUserRecord>(
        `SELECT id, username, email, role, account_status, approved_at,
                approved_by, avatar, created_at, updated_at
         FROM users
         WHERE id = ?`,
        [id]
      )
      .then(user =>
        user ? decodeIdentityRecord(this.emailCodec, user) : null
      );
  }

  findAccountStatusById(id: string): Promise<IdentityAccountStatus | null> {
    return this.executor
      .get<{ account_status: IdentityAccountStatus }>(
        'SELECT account_status FROM users WHERE id = ?',
        [id]
      )
      .then(user => user?.account_status ?? null);
  }

  findByUsername(username: string): Promise<IdentityUserRecord | null> {
    return this.executor
      .get<IdentityUserRecord>(
        `SELECT id, username, email, password_hash, role, account_status,
                approved_at, approved_by, avatar, created_at, updated_at
         FROM users WHERE username = ?`,
        [username]
      )
      .then(user =>
        user ? decodeIdentityRecord(this.emailCodec, user) : null
      );
  }

  insert(user: IdentityUserRecord): Promise<void> {
    return this.executor
      .run(
        `INSERT INTO users (
         id, username, email, email_lookup, password_hash, role, account_status,
         approved_at, approved_by, avatar, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.username,
          encodeEmail(this.emailCodec, user.email),
          emailLookupToken(this.emailCodec, user.email),
          user.password_hash,
          user.role,
          user.account_status,
          user.approved_at,
          user.approved_by,
          user.avatar,
          user.created_at,
          user.updated_at,
        ]
      )
      .then(() => undefined);
  }

  approve(
    id: string,
    approvedBy: string,
    approvedAt: number
  ): Promise<boolean> {
    return this.executor
      .run(
        `UPDATE users
       SET account_status = 'active', approved_at = ?, approved_by = ?,
           updated_at = ?
       WHERE id = ? AND id != 'default' AND account_status = 'pending'`,
        [approvedAt, approvedBy, approvedAt, id]
      )
      .then(result => result.changes > 0);
  }

  getPendingApprovalSummary(): Promise<PendingApprovalRecord> {
    return this.executor
      .get<PendingApprovalRecord>(
        `
        SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at
        FROM users
        WHERE id != 'default' AND account_status = 'pending'
      `
      )
      .then(result => result ?? { count: 0, latest_created_at: null });
  }

  async beginRetirement(id: string, updatedAt: number): Promise<boolean> {
    const operation = this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `UPDATE users SET account_status = 'retiring', updated_at = ?
            WHERE id = ? AND id != 'default'
              AND account_status IN ('pending', 'active')`
        )
        .run(updatedAt, id);
      if (changed.changes === 1) return true;
      return Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM users
              WHERE id = ? AND id != 'default'
                AND account_status = 'retiring'`
          )
          .get(id)
      );
    });
    return operation.immediate();
  }

  update(id: string, update: IdentityUserUpdate): Promise<boolean> {
    const assignments: string[] = [];
    const parameters: unknown[] = [];

    for (const [column, value] of [
      ['username', update.username],
      [
        'email',
        update.email === undefined
          ? undefined
          : encodeEmail(this.emailCodec, update.email),
      ],
      ['password_hash', update.passwordHash],
      ['role', update.role],
      ['avatar', update.avatar],
    ] as const) {
      if (value !== undefined) {
        assignments.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    if (update.email !== undefined) {
      assignments.push('email_lookup = ?');
      parameters.push(emailLookupToken(this.emailCodec, update.email));
    }

    assignments.push('updated_at = ?');
    parameters.push(update.updatedAt, id);
    return this.executor
      .run(
        `UPDATE users SET ${assignments.join(', ')} WHERE id = ?`,
        parameters
      )
      .then(result => result.changes > 0);
  }

  delete(id: string): Promise<boolean> {
    return this.executor
      .run('DELETE FROM users WHERE id = ?', [id])
      .then(result => result.changes > 0);
  }

  async deleteAndEnqueue(
    id: string,
    actorUserId: string,
    enqueuer: IdentityDeletionEnqueuer
  ): Promise<boolean> {
    const operation = this.database.transaction(() => {
      const actor = this.database
        .prepare('SELECT account_status FROM users WHERE id = ?')
        .get(actorUserId) as { account_status: string } | undefined;
      if (actor?.account_status !== 'active') {
        throw new Error('Identity deletion requires an active actor');
      }
      const deleted = this.database
        .prepare(
          "DELETE FROM users WHERE id = ? AND account_status = 'retiring'"
        )
        .run(id);
      if (deleted.changes !== 1) return false;
      enqueuer.enqueueSQLite(new DirectSQLiteExecutor(this.database), {
        targetUserId: id,
        actorUserId,
      });
      return true;
    });
    return operation.immediate();
  }

  usernameExists(username: string): Promise<boolean> {
    return this.executor
      .get('SELECT 1 FROM users WHERE username = ?', [username])
      .then(Boolean);
  }

  emailExists(email: string): Promise<boolean> {
    return this.executor
      .get('SELECT 1 FROM users WHERE email_lookup = ?', [
        this.emailCodec.lookupToken(email),
      ])
      .then(Boolean);
  }

  countRealUsers(): Promise<number> {
    return this.executor
      .get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM users WHERE id != 'default'"
      )
      .then(result => result?.count ?? 0);
  }
}

const repositoriesFor = (
  executor: PersistenceExecutor,
  emailCodec: IdentityEmailCodec,
  database: Database.Database
): PersistenceRepositories => ({
  identity: new SQLiteIdentityRepository(executor, emailCodec, database),
  resources: createSQLiteResourceRepositories(database),
  extensions: createSQLiteExtensionRepositories(database),
  security: createSQLiteSecurityRepositories(database),
});

const unitOfWorkFor = (
  executor: PersistenceSyncExecutor,
  emailCodec: IdentityEmailCodec
): PersistenceSyncUnitOfWork => ({
  identity: new SQLiteIdentitySyncRepository(executor, emailCodec),
  security: createSQLiteSecuritySyncRepositories(executor),
});

export class SQLitePersistence implements SQLitePersistenceContract {
  readonly dialect = 'sqlite' as const;
  readonly repositories: PersistenceRepositories;
  private readonly mutex = new AsyncMutex();
  private transactionActive = false;
  private readonly directExecutor: DirectSQLiteExecutor;

  constructor(
    private readonly database: Database.Database,
    private readonly emailCodec: IdentityEmailCodec
  ) {
    migrateLegacyPlaintextEmails(database, emailCodec);
    migrateVoiceProfileNameLookups(database, emailCodec);
    this.directExecutor = new DirectSQLiteExecutor(database);
    this.repositories = repositoriesFor(
      new SerializedSQLiteExecutor(
        this.directExecutor,
        this.mutex,
        () => this.transactionActive
      ),
      emailCodec,
      database
    );
  }

  async health(): Promise<{
    ready: boolean;
    dialect: 'sqlite';
    latencyMs: number;
    message?: string;
  }> {
    const startedAt = performance.now();
    try {
      this.database.prepare('SELECT 1').get();
      return {
        ready: true,
        dialect: 'sqlite',
        latencyMs: performance.now() - startedAt,
      };
    } catch {
      return {
        ready: false,
        dialect: 'sqlite',
        latencyMs: performance.now() - startedAt,
        message: 'SQLite query failed',
      };
    }
  }

  /** The process-level database owner in db.ts controls SQLite shutdown. */
  async close(): Promise<void> {}

  transaction<T>(
    operation: (
      unitOfWork: PersistenceSyncUnitOfWork
    ) => SynchronousTransactionResult<T>
  ): Promise<T> {
    if (this.transactionActive) {
      throw new Error('Nested persistence transactions are not supported');
    }
    return this.mutex.runExclusive(async () => {
      if (this.database.inTransaction) {
        throw new Error(
          'Persistence transactions must use the provided unit of work'
        );
      }

      this.transactionActive = true;
      const transactionExecutor = new TransactionSQLiteExecutor(
        this.directExecutor
      );
      try {
        this.database.exec('BEGIN IMMEDIATE');
        try {
          const result = operation(
            unitOfWorkFor(transactionExecutor, this.emailCodec)
          );
          if (
            result !== null &&
            typeof result === 'object' &&
            'then' in result &&
            typeof result.then === 'function'
          ) {
            // Consume a later rejection before failing the callback contract.
            // Otherwise an accidental async callback can terminate Node after
            // the transaction has already been rolled back.
            void Promise.resolve(result).catch(() => undefined);
            throw new Error(
              'SQLite persistence transaction callbacks must be synchronous'
            );
          }
          this.database.exec('COMMIT');
          return result;
        } catch (error) {
          if (this.database.inTransaction) this.database.exec('ROLLBACK');
          throw error;
        }
      } finally {
        transactionExecutor.close();
        this.transactionActive = false;
      }
    });
  }
}

export const createSQLitePersistence = (
  database: Database.Database,
  emailCodec: IdentityEmailCodec
): SQLitePersistence => new SQLitePersistence(database, emailCodec);
