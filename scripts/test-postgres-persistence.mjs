/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  PostgresConfigurationError,
  resolvePostgresRuntimeConfig,
  summarizePostgresRuntimeConfig,
} from '../backend/dist/persistence/postgresConfig.js';
import { PostgresDatabase } from '../backend/dist/persistence/postgresDatabase.js';
import { POSTGRES_MIGRATIONS } from '../backend/dist/persistence/postgresMigrationRegistry.js';
import { SQLITE_MIGRATION_CONTRACT } from '../backend/dist/persistence/sqliteMigrations.js';
import { initializePostgresPersistence } from '../backend/dist/persistence/postgresPersistence.js';
import { validatePostgresMigrationRegistry } from '../backend/dist/persistence/postgresMigrations.js';
import { inspectPostgresSchema } from '../backend/dist/persistence/postgresSchemaInspector.js';
import { PostgresWorkPersistence } from '../backend/dist/platform/workPersistence/postgresWorkPersistence.js';
import { SQLiteWorkPersistence } from '../backend/dist/platform/workPersistence/sqliteWorkPersistence.js';
import {
  decodePostgresWorkMessageContent,
  encodePostgresWorkMessageContent,
} from '../backend/dist/platform/workPersistence/workMessageContentCodec.js';
import { replaceWorkTextNul } from '../backend/dist/platform/workPersistence/workTextSafety.js';
import { PostgresDurableJobRepository } from '../backend/dist/platform/jobs/postgresDurableJobRepository.js';
import { PostgresDurableJobService } from '../backend/dist/platform/jobs/postgresDurableJobService.js';
import { durableEventId } from '../backend/dist/platform/jobs/durableEventIdentity.js';
import {
  CHAT_GENERATE_JOB_TYPE,
  OWNER_DELETE_CONTENT_JOB_TYPE,
  OWNER_DELETE_CONTENT_RECOVERY_IDEMPOTENCY_SCOPE,
  RESOURCE_DELETE_JOB_TYPE,
  RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
  chatGenerationIdempotencyScope,
} from '../backend/dist/platform/jobs/domainJobContracts.js';
import { Aes256GcmKeyring } from '../backend/dist/platform/storage/aesGcmKeyring.js';
import { getPluginDefinitionFingerprint } from '../backend/dist/utils/pluginDefinitionTrust.js';

test('PostgreSQL configuration is explicit, bounded, and redacted', () => {
  const config = resolvePostgresRuntimeConfig({
    DATABASE_URL: 'postgresql://sentinel:secret@db.example.test/libre',
    DATABASE_SSL_MODE: 'require',
    POSTGRES_POOL_MAX: '12',
    POSTGRES_MIGRATION_MODE: 'validate',
  });
  assert.equal(config.poolMaximum, 12);
  assert.equal(config.migrationMode, 'validate');
  const summary = JSON.stringify(summarizePostgresRuntimeConfig(config));
  assert.doesNotMatch(summary, /sentinel|secret|db\.example\.test/);
  assert.equal(JSON.parse(summary).configured, true);
});

test('PostgreSQL configuration rejects ambiguous TLS and unsafe bounds', () => {
  assert.throws(
    () =>
      resolvePostgresRuntimeConfig({
        DATABASE_URL:
          'postgresql://operator@example.test/libre?sslmode=disable',
        POSTGRES_POOL_MAX: '1000',
      }),
    error => {
      assert.ok(error instanceof PostgresConfigurationError);
      assert.match(error.message, /TLS URL parameters/);
      assert.match(error.message, /POSTGRES_POOL_MAX/);
      assert.doesNotMatch(error.message, /operator@example/);
      return true;
    }
  );
});

test('PostgreSQL migration registry is contiguous, checksummed, and frozen', () => {
  assert.deepEqual(
    POSTGRES_MIGRATIONS.map(migration => migration.version),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
  );
  validatePostgresMigrationRegistry(POSTGRES_MIGRATIONS);
  assert.equal(Object.isFrozen(POSTGRES_MIGRATIONS), true);
  assert.equal(POSTGRES_MIGRATIONS.every(Object.isFrozen), true);
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-1)?.version, 20);
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-1)?.name, 'media-enterprise-ops');
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-2)?.version, 19);
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-2)?.name, 'team-collaboration');
  assert.equal(POSTGRES_MIGRATIONS.at(-3)?.version, 17);
  assert.equal(POSTGRES_MIGRATIONS.at(-3)?.name, 'notes-v2');
  assert.match(
    POSTGRES_MIGRATIONS.at(-3)?.sql ?? '',
    /CREATE TABLE note_revisions/
  );
  assert.equal(POSTGRES_MIGRATIONS.at(-2)?.version, 18);
  assert.equal(POSTGRES_MIGRATIONS.at(-2)?.name, 'team-collaboration');
  assert.match(
    POSTGRES_MIGRATIONS.at(-2)?.sql ?? '',
    /CREATE TABLE channels/
  );
  assert.match(
    POSTGRES_MIGRATIONS.at(-2)?.sql ?? '',
    /CREATE TABLE notifications/
  );
  assert.equal(POSTGRES_MIGRATIONS.at(-1)?.version, 19);
  assert.equal(POSTGRES_MIGRATIONS.at(-1)?.name, 'media-enterprise-ops');
  assert.match(
    POSTGRES_MIGRATIONS.at(-1)?.sql ?? '',
    /CREATE TABLE model_tariffs/
  );
  assert.match(
    POSTGRES_MIGRATIONS.at(-1)?.sql ?? '',
    /CREATE TABLE usage_budgets/
  );
  assert.match(
    POSTGRES_MIGRATIONS.at(-1)?.sql ?? '',
    /CREATE TABLE message_feedback/
  );
  assert.match(POSTGRES_MIGRATIONS.at(-1)?.sql ?? '', /CREATE TABLE eval_runs/);
  assert.equal(
    SQLITE_MIGRATION_CONTRACT.some(
      migration => migration.name === 'blob-quotas'
    ),
    true,
    'SQLite has a later quota migration because PostgreSQL introduced quotas in its immutable blob-store migration'
  );
  assert.equal(
    POSTGRES_MIGRATIONS[1]?.name,
    'platform-blob-store',
    'dialect migration numbers are independent histories, not cross-dialect compatibility IDs'
  );
  const tampered = POSTGRES_MIGRATIONS.map(migration => ({ ...migration }));
  tampered[0].sql += '\nSELECT 1;';
  assert.throws(
    () => validatePostgresMigrationRegistry(tampered),
    /checksum mismatch/
  );
});

test('PostgreSQL event replay applies stream and subject filters before its limit', async () => {
  let observed;
  const repository = new PostgresDurableJobRepository({
    async query(text, parameters) {
      observed = { text, parameters };
      return { rows: [], rowCount: 0 };
    },
  });

  assert.deepEqual(
    await repository.replayStoredEvents(10_001, 100, {
      streamId: 'chat:long-session',
      subjectId: 'current-assistant',
    }),
    []
  );
  assert.match(
    observed.text,
    /WHERE global_cursor > \$1 AND stream_id = \$2 AND subject_id = \$3\s+ORDER BY global_cursor ASC LIMIT \$4/
  );
  assert.deepEqual(observed.parameters, [
    10_001,
    'chat:long-session',
    'current-assistant',
    100,
  ]);
});

class FakeClient {
  queries = [];
  releasedWith = undefined;

  constructor(onQuery) {
    this.onQuery = onQuery;
  }

  async query(text, parameters = []) {
    this.queries.push({ text, parameters });
    if (text === 'SELECT fail') throw new Error('sentinel failure');
    this.onQuery?.(text);
    return { rows: [{ healthy: 1 }], rowCount: 1 };
  }

  release(error) {
    this.releasedWith = error;
  }
}

class FakePool {
  totalCount = 1;
  idleCount = 1;
  waitingCount = 0;
  directQueries = [];
  ended = false;
  endCalls = 0;
  clients = [];
  onClientQuery;

  async query(text, parameters = []) {
    this.directQueries.push({ text, parameters });
    return { rows: [{ healthy: 1 }], rowCount: 1 };
  }

  async connect() {
    const client = new FakeClient(this.onClientQuery);
    this.clients.push(client);
    return client;
  }

  async end() {
    this.endCalls += 1;
    this.ended = true;
  }
}

test('PostgresDatabase pins, commits, rolls back, releases, and closes', async () => {
  const pool = new FakePool();
  const database = new PostgresDatabase(pool);
  const result = await database.transaction(async client => {
    await client.query('INSERT sentinel', ['value']);
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(
    pool.clients[0].queries.map(query => query.text),
    ['BEGIN ISOLATION LEVEL READ COMMITTED', 'INSERT sentinel', 'COMMIT']
  );
  assert.equal(pool.clients[0].releasedWith, undefined);

  await assert.rejects(
    database.transaction(async client => {
      await client.query('SELECT fail');
    }),
    /sentinel failure/
  );
  assert.deepEqual(
    pool.clients[1].queries.map(query => query.text),
    ['BEGIN ISOLATION LEVEL READ COMMITTED', 'SELECT fail', 'ROLLBACK']
  );
  assert.match(pool.clients[1].releasedWith.message, /sentinel failure/);

  const deniedCommit = new AbortController();
  deniedCommit.abort(new Error('shared archive admission was lost'));
  await assert.rejects(
    database.transaction(
      async client => {
        await client.query('INSERT fenced');
      },
      { beforeCommit: () => deniedCommit.signal.throwIfAborted() }
    ),
    /shared archive admission was lost/
  );
  assert.deepEqual(
    pool.clients[2].queries.map(query => query.text),
    ['BEGIN ISOLATION LEVEL READ COMMITTED', 'INSERT fenced', 'ROLLBACK']
  );

  const lossAfterCommitDecision = new AbortController();
  pool.onClientQuery = statement => {
    if (statement === 'COMMIT') {
      lossAfterCommitDecision.abort(
        new Error('renewal failed after COMMIT was selected')
      );
    }
  };
  assert.equal(
    await database.transaction(
      async client => {
        await client.query('INSERT committed-after-fence');
        return 'committed';
      },
      { beforeCommit: () => lossAfterCommitDecision.signal.throwIfAborted() }
    ),
    'committed'
  );
  assert.equal(lossAfterCommitDecision.signal.aborted, true);
  assert.deepEqual(
    pool.clients[3].queries.map(query => query.text),
    [
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'INSERT committed-after-fence',
      'COMMIT',
    ]
  );
  pool.onClientQuery = undefined;

  const health = await database.health();
  assert.equal(health.ready, true);
  assert.deepEqual(health.pool, { total: 1, idle: 1, waiting: 0 });
  await Promise.all([database.close(), database.close()]);
  assert.equal(pool.ended, true);
  assert.equal(pool.endCalls, 1);
  await assert.rejects(database.query('SELECT 1'), /pool is closed/);
});

test('PostgreSQL Work message JSON storage is exact and reversible', () => {
  const ordinary = 'ordinary tool output';
  const encodedOrdinary = encodePostgresWorkMessageContent(ordinary);
  assert.equal(encodedOrdinary, JSON.stringify(ordinary));
  assert.equal(decodePostgresWorkMessageContent(encodedOrdinary), ordinary);

  const withNul = 'bin\u0000\u0001\u0002tail';
  const encodedNul = encodePostgresWorkMessageContent(withNul);
  assert.equal(encodedNul.includes('\u0000'), false);
  assert.equal(decodePostgresWorkMessageContent(encodedNul), withNul);
  assert.throws(
    () => decodePostgresWorkMessageContent('not JSON'),
    /Invalid PostgreSQL Work message content encoding/
  );
});

const integrationUrl = process.env.TEST_POSTGRES_URL?.trim();

test(
  'real PostgreSQL runs concurrent migration leaders and repository parity',
  { skip: integrationUrl ? false : 'TEST_POSTGRES_URL is not configured' },
  async () => {
    const parsed = new URL(integrationUrl);
    const databaseName = parsed.pathname.slice(1);
    assert.match(
      databaseName,
      /test/i,
      'TEST_POSTGRES_URL must name a disposable test database'
    );
    const schema = `libre_test_${process.pid}_${Date.now()}`;
    const schemaUrl = new URL(integrationUrl);
    schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const bootstrapConfig = resolvePostgresRuntimeConfig({
      DATABASE_URL: integrationUrl,
      DATABASE_SSL_MODE: 'disable',
      POSTGRES_APPLICATION_NAME: 'libre-pg-test-bootstrap',
    });
    const { createPostgresDatabase } =
      await import('../backend/dist/persistence/postgresDatabase.js');
    const bootstrap = createPostgresDatabase(bootstrapConfig);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    await bootstrap.close();

    const config = resolvePostgresRuntimeConfig({
      DATABASE_URL: schemaUrl.toString(),
      DATABASE_SSL_MODE: 'disable',
      POSTGRES_APPLICATION_NAME: 'libre-pg-test',
      POSTGRES_MIGRATION_LOCK_TIMEOUT_MS: '10000',
    });
    const prefix = 'a'.repeat(32);
    const suffix = 'b'.repeat(32);
    const codec = {
      encrypt: plaintext =>
        `${prefix}:${Buffer.from(plaintext, 'utf8').toString('hex')}:${suffix}`,
      decryptAuthenticated: ciphertext =>
        Buffer.from(ciphertext.split(':')[1], 'hex').toString('utf8'),
      decryptBuffer: ciphertext => Buffer.from(ciphertext),
      isEncrypted: value =>
        new RegExp(`^${prefix}:[0-9a-f]+:${suffix}$`).test(value),
      lookupToken: plaintext =>
        createHash('sha256').update(plaintext.toLowerCase()).digest('hex'),
    };

    let first;
    let second;
    try {
      [first, second] = await Promise.all([
        initializePostgresPersistence(config, codec),
        initializePostgresPersistence(config, codec),
      ]);
      assert.equal(first.schemaCompatibility.status, 'compatible');
      assert.equal(second.schemaCompatibility.currentVersion, 19);
      assert.equal((await first.health()).ready, true);

      const assertStructuralDamage = async (mutation, expected) => {
        await first.database.withClient(async client => {
          await client.query('BEGIN');
          try {
            await client.query(mutation);
            const inspection = await inspectPostgresSchema(
              client,
              POSTGRES_MIGRATIONS
            );
            assert.equal(inspection.compatible, false);
            assert.match(inspection.problems.join('\n'), expected);
          } finally {
            await client.query('ROLLBACK');
          }
        });
      };
      await assertStructuralDamage(
        'DROP TABLE notes CASCADE',
        /missing table notes/i
      );
      await assertStructuralDamage(
        'ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey',
        /missing foreign key.*sessions/i
      );
      await assertStructuralDamage(
        'DROP EXTENSION vector CASCADE',
        /missing extension vector/i
      );
      await assertStructuralDamage(
        `ALTER TABLE users
           ADD COLUMN audit_unexpected_required text NOT NULL DEFAULT 'sentinel';
         ALTER TABLE users
           ALTER COLUMN audit_unexpected_required DROP DEFAULT`,
        /unexpected column users\.audit_unexpected_required/i
      );
      await assertStructuralDamage(
        'CREATE TABLE audit_unexpected_table (id text PRIMARY KEY)',
        /unexpected relation audit_unexpected_table/i
      );
      await assertStructuralDamage(
        'CREATE INDEX audit_unexpected_index ON users(updated_at)',
        /unexpected index audit_unexpected_index/i
      );
      await assertStructuralDamage(
        'DROP INDEX idx_platform_events_stream_subject_cursor',
        /missing index idx_platform_events_stream_subject_cursor/i
      );
      await assertStructuralDamage(
        `CREATE FUNCTION audit_unexpected_trigger_function()
           RETURNS trigger LANGUAGE plpgsql AS
           'BEGIN RETURN NEW; END';
         CREATE TRIGGER audit_unexpected_trigger
           BEFORE INSERT ON users FOR EACH ROW
           EXECUTE FUNCTION audit_unexpected_trigger_function()`,
        /unexpected trigger users\.audit_unexpected_trigger/i
      );
      await assertStructuralDamage(
        `ALTER TABLE users ADD CONSTRAINT audit_unexpected_constraint
           CHECK (updated_at >= created_at)`,
        /unexpected check constraint users:/i
      );
      const leaseCheck = await first.database.query(
        `SELECT constraint_row.conname
           FROM pg_constraint AS constraint_row
           JOIN pg_class AS relation
             ON relation.oid = constraint_row.conrelid
           JOIN pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relname = 'platform_jobs'
            AND constraint_row.contype = 'c'
            AND pg_get_expr(
                  constraint_row.conbin,
                  constraint_row.conrelid,
                  true
                ) LIKE '%lease_owner%'`
      );
      assert.equal(leaseCheck.rowCount, 1);
      const leaseCheckName = leaseCheck.rows[0].conname;
      assert.match(leaseCheckName, /^[a-z0-9_]+$/);
      await assertStructuralDamage(
        `ALTER TABLE platform_jobs DROP CONSTRAINT ${leaseCheckName};
         ALTER TABLE platform_jobs ADD CONSTRAINT ${leaseCheckName} CHECK (
           state = 'running'
           AND lease_owner IS NOT NULL
           AND (lease_expires_at IS NOT NULL OR state <> 'running')
           AND lease_owner IS NULL
           AND lease_expires_at IS NULL
         )`,
        /missing check constraint platform_jobs:|unexpected check constraint platform_jobs:/i
      );

      // Exact schema drift must fail both validate and apply startup. A failed
      // startup may record an incompatible diagnostic, but it must never bless
      // the altered fingerprint as compatible.
      await first.database.query(
        `ALTER TABLE users
           ADD COLUMN audit_unexpected_required text NOT NULL DEFAULT 'sentinel'`
      );
      await first.database.query(
        `ALTER TABLE users
           ALTER COLUMN audit_unexpected_required DROP DEFAULT`
      );
      for (const migrationMode of ['validate', 'apply']) {
        await assert.rejects(
          initializePostgresPersistence({ ...config, migrationMode }, codec),
          /unexpected column users\.audit_unexpected_required/i
        );
        const state = await first.database.query(
          `SELECT status, failure_code
             FROM libre_schema_compatibility WHERE singleton = 1`
        );
        assert.deepEqual(state.rows[0], {
          status: 'incompatible',
          failure_code: 'schema_structure_invalid',
        });
      }
      await first.database.query(
        'ALTER TABLE users DROP COLUMN audit_unexpected_required'
      );
      const revalidated = await initializePostgresPersistence(
        { ...config, migrationMode: 'validate' },
        codec
      );
      assert.equal(revalidated.schemaCompatibility.status, 'compatible');
      await revalidated.close();

      const identity = first.repositories.identity;
      await identity.insert({
        id: 'default',
        username: 'admin',
        email: null,
        password_hash: 'hash-admin',
        role: 'admin',
        account_status: 'active',
        approved_at: 1,
        approved_by: null,
        avatar: null,
        created_at: 1,
        updated_at: 1,
      });
      await identity.insert({
        id: 'waiting',
        username: 'waiting',
        email: 'waiting@example.test',
        password_hash: 'hash-waiting',
        role: 'user',
        account_status: 'pending',
        approved_at: null,
        approved_by: null,
        avatar: null,
        created_at: 2,
        updated_at: 2,
      });
      await identity.insert({
        id: 'status-only',
        username: 'status-only',
        email: 'status-only@example.test',
        password_hash: 'hash-status-only',
        role: 'user',
        account_status: 'active',
        approved_at: 2,
        approved_by: 'default',
        avatar: null,
        created_at: 2,
        updated_at: 2,
      });
      await first.database.query(
        "UPDATE users SET email = '00:00:00' WHERE id = 'status-only'"
      );
      assert.equal(
        await identity.findAccountStatusById('status-only'),
        'active',
        'authorization status must not decode unrelated identity ciphertext'
      );
      await assert.rejects(
        identity.findPublicById('status-only'),
        /Invalid encrypted identity email/
      );
      await first.database.query("DELETE FROM users WHERE id = 'status-only'");
      assert.equal(await identity.emailExists('waiting@example.test'), true);
      assert.equal(
        (await identity.findByUsername('waiting')).email,
        'waiting@example.test'
      );

      const firstPreferences = first.repositories.resources.preferences;
      const secondPreferences = second.repositories.resources.preferences;
      assert.equal(await firstPreferences.resolveOwner(), 'default');
      const addPreference = (key, value) => current => {
        const next = new Map(current.map(row => [row.key, row.value]));
        next.set(key, value);
        return [...next].map(([entryKey, entryValue]) => ({
          key: entryKey,
          value: entryValue,
        }));
      };
      let releaseOwnerLock;
      let ownerLockReadyResolve;
      let ownerLockReadyReject;
      const ownerLockRelease = new Promise(resolve => {
        releaseOwnerLock = resolve;
      });
      const ownerLockReady = new Promise((resolve, reject) => {
        ownerLockReadyResolve = resolve;
        ownerLockReadyReject = reject;
      });
      const heldOwnerLock = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            "SELECT id FROM users WHERE id = 'waiting' FOR UPDATE"
          );
          ownerLockReadyResolve();
          await ownerLockRelease;
          await client.query('COMMIT');
        } catch (error) {
          ownerLockReadyReject(error);
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await ownerLockReady;
      const concurrentPreferenceMutations = Promise.all([
        firstPreferences.mutateAll(
          'waiting',
          3,
          addPreference('theme', 'dark')
        ),
        secondPreferences.mutateAll(
          'waiting',
          4,
          addPreference('systemMessage', 'hello')
        ),
      ]);
      // Let both independent pools reach the held owner-row lock before it is
      // released. Whichever writer acquires it first, the other must reread
      // that committed result rather than replace a stale snapshot.
      await new Promise(resolve => setImmediate(resolve));
      releaseOwnerLock();
      await heldOwnerLock;
      await concurrentPreferenceMutations;
      assert.deepEqual(await firstPreferences.listByOwner('waiting'), [
        { key: 'systemMessage', value: 'hello' },
        { key: 'theme', value: 'dark' },
      ]);

      let releaseArchiveOwnerLock;
      let archiveOwnerLockReadyResolve;
      let archiveOwnerLockReadyReject;
      const archiveOwnerLockRelease = new Promise(resolve => {
        releaseArchiveOwnerLock = resolve;
      });
      const archiveOwnerLockReady = new Promise((resolve, reject) => {
        archiveOwnerLockReadyResolve = resolve;
        archiveOwnerLockReadyReject = reject;
      });
      const heldArchiveOwnerLock = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            "SELECT id FROM users WHERE id = 'waiting' FOR UPDATE"
          );
          await client.query(
            `INSERT INTO user_preferences
               (id, user_id, key, value, created_at, updated_at)
             VALUES ('archive-concurrent-preference', 'waiting',
                     'replica', 'committed-during-lock-wait', 5, 5)`
          );
          archiveOwnerLockReadyResolve();
          await archiveOwnerLockRelease;
          await client.query('COMMIT');
        } catch (error) {
          archiveOwnerLockReadyReject(error);
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await archiveOwnerLockReady;
      let archiveSawConcurrentValue = false;
      const concurrentArchiveMerge =
        second.repositories.resources.archive.applyImport({
          userId: 'waiting',
          strategy: 'skip',
          timestamp: 6,
          maximumNotes: 10,
          maximumSessionFolders: 10,
          preferences: current => {
            archiveSawConcurrentValue = current.some(
              row =>
                row.key === 'replica' &&
                row.value === 'committed-during-lock-wait'
            );
            return addPreference('archive', 'merged')(current);
          },
          sessionFolders: [],
          sessions: [],
          notes: [],
          knowledgeCollections: [],
          documents: [],
        });
      let archiveWaiterObserved = false;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiters = await first.database.query(
            `SELECT 1
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE $1
              LIMIT 1`,
            ['%SELECT id FROM users WHERE id = $1 FOR UPDATE%']
          );
          if (waiters.rowCount === 1) {
            archiveWaiterObserved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(
          archiveWaiterObserved,
          true,
          'archive merge must wait at the owner-row serialization boundary'
        );
      } finally {
        releaseArchiveOwnerLock();
      }
      await heldArchiveOwnerLock;
      await concurrentArchiveMerge;
      assert.equal(archiveSawConcurrentValue, true);
      assert.deepEqual(await firstPreferences.listByOwner('waiting'), [
        { key: 'archive', value: 'merged' },
        { key: 'replica', value: 'committed-during-lock-wait' },
        { key: 'systemMessage', value: 'hello' },
        { key: 'theme', value: 'dark' },
      ]);

      await first.repositories.resources.notes.replaceWithLimit(
        {
          id: 'concurrent-note',
          user_id: 'waiting',
          title: 'original-title',
          content: 'original-content',
          pinned: 0,
          created_at: 7,
          updated_at: 7,
        },
        10
      );
      let releaseNoteLock;
      let noteLockReadyResolve;
      let noteLockReadyReject;
      const noteLockRelease = new Promise(resolve => {
        releaseNoteLock = resolve;
      });
      const noteLockReady = new Promise((resolve, reject) => {
        noteLockReadyResolve = resolve;
        noteLockReadyReject = reject;
      });
      const heldNoteLock = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE notes SET content = 'worker-content', updated_at = 8
              WHERE id = 'concurrent-note' AND user_id = 'waiting'`
          );
          noteLockReadyResolve();
          await noteLockRelease;
          await client.query('COMMIT');
        } catch (error) {
          noteLockReadyReject(error);
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await noteLockReady;
      const concurrentNotePatch =
        second.repositories.resources.notes.patchByOwner(
          'concurrent-note',
          'waiting',
          { title: 'replica-title', updated_at: 9 }
        );
      let noteWaiterObserved = false;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiters = await first.database.query(
            `SELECT 1
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%UPDATE notes SET title%'
              LIMIT 1`
          );
          if (waiters.rowCount === 1) {
            noteWaiterObserved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(
          noteWaiterObserved,
          true,
          'note patch must wait for the concurrent row writer'
        );
      } finally {
        releaseNoteLock();
      }
      await heldNoteLock;
      assert.deepEqual(await concurrentNotePatch, {
        id: 'concurrent-note',
        user_id: 'waiting',
        title: 'replica-title',
        content: 'worker-content',
        pinned: 0,
        created_at: 7,
        updated_at: 9,
      });
      assert.equal(
        await first.repositories.resources.notes.deleteByOwner(
          'concurrent-note',
          'waiting'
        ),
        true
      );

      const { createPostgresPlatformDomainRepositories } =
        await import('../backend/dist/platform/storage/postgresPlatformDomainRepositories.js');
      const firstDomains = createPostgresPlatformDomainRepositories(
        first.database,
        codec
      );
      const secondDomains = createPostgresPlatformDomainRepositories(
        second.database,
        codec
      );
      await firstDomains.personas.insert({
        id: 'concurrent-persona',
        user_id: 'waiting',
        name: 'Original persona',
        description: 'original-description',
        model: 'original-model',
        parameters: { temperature: 0.7 },
        created_at: 10,
        updated_at: 10,
      });
      let releasePersonaLock;
      let personaLockReadyResolve;
      let personaLockReadyReject;
      const personaLockRelease = new Promise(resolve => {
        releasePersonaLock = resolve;
      });
      const personaLockReady = new Promise((resolve, reject) => {
        personaLockReadyResolve = resolve;
        personaLockReadyReject = reject;
      });
      const heldPersonaLock = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            `UPDATE personas SET model = 'worker-model', updated_at = 11
              WHERE id = 'concurrent-persona' AND user_id = 'waiting'`
          );
          personaLockReadyResolve();
          await personaLockRelease;
          await client.query('COMMIT');
        } catch (error) {
          personaLockReadyReject(error);
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await personaLockReady;
      const concurrentPersonaPatch = secondDomains.personas.patchByOwner(
        'concurrent-persona',
        'waiting',
        { description: 'replica-description', updated_at: 12 }
      );
      let personaWaiterObserved = false;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiters = await first.database.query(
            `SELECT 1
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%UPDATE personas SET description%'
              LIMIT 1`
          );
          if (waiters.rowCount === 1) {
            personaWaiterObserved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(
          personaWaiterObserved,
          true,
          'persona patch must wait for the concurrent row writer'
        );
      } finally {
        releasePersonaLock();
      }
      await heldPersonaLock;
      const patchedPersona = await concurrentPersonaPatch;
      assert.equal(patchedPersona?.name, 'Original persona');
      assert.equal(patchedPersona?.model, 'worker-model');
      assert.equal(patchedPersona?.description, 'replica-description');
      assert.deepEqual(patchedPersona?.parameters, { temperature: 0.7 });
      assert.equal(patchedPersona?.updated_at, 12);
      assert.equal(
        await firstDomains.personas.deleteByOwner(
          'concurrent-persona',
          'waiting'
        ),
        true
      );

      const durableKeyring = new Aes256GcmKeyring('test', {
        test: Buffer.alloc(32, 7),
      });
      const durableInput = {
        jobType: 'test.concurrent.v1',
        actorUserId: 'waiting',
        idempotencyScope: 'real-postgres-concurrency',
        idempotencyKey: 'same-key',
        payload: { mode: 'encrypted', value: { value: 'same-request' } },
      };
      const durableServices = [first, second].map(
        persistence =>
          new PostgresDurableJobService(
            new PostgresDurableJobRepository(persistence.database),
            durableKeyring
          )
      );
      const concurrentJobs = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          durableServices[index % durableServices.length].enqueue(durableInput)
        )
      );
      assert.equal(new Set(concurrentJobs.map(job => job.id)).size, 1);
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count FROM platform_jobs
              WHERE actor_user_id = $1 AND idempotency_scope = $2`,
            ['waiting', 'real-postgres-concurrency']
          )
        ).rows[0].count,
        '1'
      );
      await assert.rejects(
        durableServices[0].enqueue({
          ...durableInput,
          payload: { mode: 'encrypted', value: { value: 'different' } },
        }),
        error => error?.code === 'conflict'
      );

      const cancellationIdentity = (sessionId, assistantMessageId) => ({
        eventId: durableEventId(
          'chat',
          sessionId,
          assistantMessageId,
          'cancel-requested',
          'waiting'
        ),
        streamId: `chat:${sessionId}`,
        subjectId: assistantMessageId,
        actorUserId: 'waiting',
      });
      const chatJobInput = (sessionId, assistantMessageId) => ({
        jobType: CHAT_GENERATE_JOB_TYPE,
        actorUserId: 'waiting',
        idempotencyScope: chatGenerationIdempotencyScope(sessionId),
        idempotencyKey: assistantMessageId,
        payload: {
          mode: 'encrypted',
          value: { sessionId, assistantMessageId },
        },
        priority: 100,
      });
      const chatCompletionInput = (sessionId, assistantMessageId, lease) => ({
        lease: {
          jobId: lease.id,
          workerId: lease.workerId,
          leaseToken: lease.leaseToken,
        },
        actorUserId: 'waiting',
        sessionId,
        expectedJobType: CHAT_GENERATE_JOB_TYPE,
        message: {
          id: assistantMessageId,
          sessionId,
          role: 'assistant',
          content: `protected-${assistantMessageId}`,
          thinking: null,
          timestamp: Date.now(),
          model: 'postgres-model',
          providerMetadata: null,
          images: null,
          statistics: null,
          artifacts: null,
          parentId: null,
          isActive: 1,
          rating: null,
        },
        event: {
          eventId: durableEventId(
            'chat',
            sessionId,
            assistantMessageId,
            'done'
          ),
          streamId: `chat:${sessionId}`,
          eventType: 'chat.done.v1',
          subjectId: assistantMessageId,
          actorUserId: 'waiting',
          payload: {
            mode: 'encrypted',
            value: {
              type: 'done',
              messageId: assistantMessageId,
              content: `answer-${assistantMessageId}`,
            },
          },
        },
      });
      const insertChatSession = sessionId =>
        first.database.query(
          `INSERT INTO sessions
             (id, user_id, title, model, persona_id, provider_type,
              provider_id, created_at, updated_at, archived, settings,
              folder_id, pinned)
           VALUES ($1, 'waiting', $2, 'postgres-model', NULL, NULL, NULL,
                   $3, $3, 0, NULL, NULL, 0)`,
          [sessionId, `protected-${sessionId}`, Date.now()]
        );

      const preCancelledSession = 'postgres-pre-cancelled-chat';
      const preCancelledAssistant = 'postgres-pre-cancelled-assistant';
      const preDecision = await durableServices[0].requestChatCancellation({
        actorUserId: 'waiting',
        sessionId: preCancelledSession,
        assistantMessageId: preCancelledAssistant,
      });
      assert.equal(preDecision.outcome, 'cancellation-recorded');
      assert.equal(preDecision.job, null);
      const preCancelledEnqueue = await first.database.transaction(client =>
        durableServices[0].enqueueChatGenerationWithExecutor(
          client,
          chatJobInput(preCancelledSession, preCancelledAssistant),
          cancellationIdentity(preCancelledSession, preCancelledAssistant)
        )
      );
      assert.equal(preCancelledEnqueue.created, true);
      assert.equal(preCancelledEnqueue.job.state, 'cancelled');
      assert.equal(preCancelledEnqueue.job.attemptCount, 0);

      const acknowledgementSession = 'postgres-chat-ack-loss';
      const acknowledgementAssistant = 'postgres-assistant-ack-loss';
      await insertChatSession(acknowledgementSession);
      let loseCompletionAcknowledgement = false;
      const acknowledgementDatabase = {
        query: first.database.query.bind(first.database),
        async transaction(operation, options) {
          const result = await first.database.transaction(operation, options);
          if (loseCompletionAcknowledgement) {
            loseCompletionAcknowledgement = false;
            throw new Error('connection lost after chat completion COMMIT');
          }
          return result;
        },
      };
      const acknowledgementService = new PostgresDurableJobService(
        new PostgresDurableJobRepository(acknowledgementDatabase),
        durableKeyring
      );
      const acknowledgementJob = await acknowledgementService.enqueue(
        chatJobInput(acknowledgementSession, acknowledgementAssistant)
      );
      const acknowledgementLease = await acknowledgementService.claim(
        'postgres-chat-ack-worker',
        30_000
      );
      assert.equal(acknowledgementLease?.id, acknowledgementJob.id);
      loseCompletionAcknowledgement = true;
      const acknowledgementCursor =
        await acknowledgementService.publishChatCompletion(
          chatCompletionInput(
            acknowledgementSession,
            acknowledgementAssistant,
            acknowledgementLease
          )
        );
      assert.ok(acknowledgementCursor > 0);
      const acknowledgementMetadata = await acknowledgementService.getMetadata(
        acknowledgementJob.id
      );
      assert.equal(acknowledgementMetadata.state, 'succeeded');
      assert.equal(
        acknowledgementMetadata.resultReference,
        `chat-message:${acknowledgementAssistant}`
      );
      assert.equal(
        acknowledgementMetadata.progressCurrent,
        acknowledgementMetadata.progressTotal
      );
      assert.equal(
        (await acknowledgementService.listAttempts(acknowledgementJob.id))[0]
          .outcome,
        'succeeded'
      );
      const completionWon =
        await acknowledgementService.requestChatCancellation({
          actorUserId: 'waiting',
          sessionId: acknowledgementSession,
          assistantMessageId: acknowledgementAssistant,
        });
      assert.equal(completionWon.outcome, 'completion-won');
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count FROM platform_events
              WHERE event_id = $1`,
            [
              cancellationIdentity(
                acknowledgementSession,
                acknowledgementAssistant
              ).eventId,
            ]
          )
        ).rows[0].count,
        '0'
      );

      const cancellationSession = 'postgres-cancel-publish-race';
      const cancellationAssistant = 'postgres-cancel-publish-assistant';
      await insertChatSession(cancellationSession);
      const cancellationJob = await durableServices[0].enqueue(
        chatJobInput(cancellationSession, cancellationAssistant)
      );
      const cancellationLease = await durableServices[0].claim(
        'postgres-cancel-publish-worker',
        30_000
      );
      assert.equal(cancellationLease?.id, cancellationJob.id);
      await first.database.query(
        `INSERT INTO platform_event_stream_heads
           (stream_id, last_sequence) VALUES ($1, 0)
         ON CONFLICT (stream_id) DO NOTHING`,
        [`chat:${cancellationSession}`]
      );
      let releaseChatHead;
      let chatHeadReadyResolve;
      const chatHeadRelease = new Promise(resolve => {
        releaseChatHead = resolve;
      });
      const chatHeadReady = new Promise(resolve => {
        chatHeadReadyResolve = resolve;
      });
      const heldChatHead = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            `SELECT last_sequence FROM platform_event_stream_heads
              WHERE stream_id = $1 FOR UPDATE`,
            [`chat:${cancellationSession}`]
          );
          chatHeadReadyResolve();
          await chatHeadRelease;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await chatHeadReady;
      const cancellationDecision = durableServices[1].requestChatCancellation({
        actorUserId: 'waiting',
        sessionId: cancellationSession,
        assistantMessageId: cancellationAssistant,
      });
      let cancellationWaiterObserved = false;
      let rejectedCompletion;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiters = await first.database.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%platform_event_stream_heads%FOR UPDATE%'
              LIMIT 1`
          );
          if (waiters.rowCount === 1) {
            cancellationWaiterObserved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        rejectedCompletion = durableServices[0].publishChatCompletion(
          chatCompletionInput(
            cancellationSession,
            cancellationAssistant,
            cancellationLease
          )
        );
      } finally {
        releaseChatHead();
        await heldChatHead;
      }
      assert.equal(cancellationWaiterObserved, true);
      const cancellationResult = await cancellationDecision;
      assert.equal(cancellationResult.outcome, 'cancellation-recorded');
      assert.equal(
        cancellationResult.job?.cancellationRequestedAt !== null,
        true
      );
      await assert.rejects(
        rejectedCompletion,
        error => error?.code === 'cancelled'
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count FROM session_messages
              WHERE id = $1`,
            [cancellationAssistant]
          )
        ).rows[0].count,
        '0'
      );
      assert.equal(
        await durableServices[0].fail(cancellationLease, {
          retryable: false,
          errorCode: 'cancelled-at-publish',
          errorSummary: 'Cancellation won the PostgreSQL publish barrier',
          backoffMs: 0,
        }),
        'cancelled'
      );

      const expirySession = 'postgres-chat-expired-after-head-wait';
      const expiryAssistant = 'postgres-expired-assistant';
      await insertChatSession(expirySession);
      let fencedNow = 1_000_000;
      const fencedService = new PostgresDurableJobService(
        new PostgresDurableJobRepository(first.database, () => fencedNow),
        durableKeyring,
        () => fencedNow
      );
      const expiryJob = await fencedService.enqueue(
        chatJobInput(expirySession, expiryAssistant)
      );
      const expiryLease = await fencedService.claim(
        'postgres-expiry-worker',
        1000
      );
      assert.equal(expiryLease?.id, expiryJob.id);
      await first.database.query(
        `INSERT INTO platform_event_stream_heads
           (stream_id, last_sequence) VALUES ($1, 0)
         ON CONFLICT (stream_id) DO NOTHING`,
        [`chat:${expirySession}`]
      );
      let releaseExpiryHead;
      let expiryHeadReadyResolve;
      const expiryHeadRelease = new Promise(resolve => {
        releaseExpiryHead = resolve;
      });
      const expiryHeadReady = new Promise(resolve => {
        expiryHeadReadyResolve = resolve;
      });
      const heldExpiryHead = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            `SELECT last_sequence FROM platform_event_stream_heads
              WHERE stream_id = $1 FOR UPDATE`,
            [`chat:${expirySession}`]
          );
          expiryHeadReadyResolve();
          await expiryHeadRelease;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await expiryHeadReady;
      const expiredCompletion = fencedService.publishChatCompletion(
        chatCompletionInput(expirySession, expiryAssistant, expiryLease)
      );
      let expiryWaiterObserved = false;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiters = await first.database.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%platform_event_stream_heads%FOR UPDATE%'
              LIMIT 1`
          );
          if (waiters.rowCount === 1) {
            expiryWaiterObserved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        fencedNow = expiryLease.leaseExpiresAt + 1;
      } finally {
        releaseExpiryHead();
        await heldExpiryHead;
      }
      assert.equal(expiryWaiterObserved, true);
      await assert.rejects(
        expiredCompletion,
        error => error?.code === 'lease-lost'
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count FROM platform_events
              WHERE event_id = $1`,
            [durableEventId('chat', expirySession, expiryAssistant, 'done')]
          )
        ).rows[0].count,
        '0'
      );
      assert.equal(
        (
          await fencedService.requestChatCancellation({
            actorUserId: 'waiting',
            sessionId: expirySession,
            assistantMessageId: expiryAssistant,
          })
        ).outcome,
        'cancellation-recorded'
      );

      const sessionExpirySession = 'postgres-chat-expired-after-session-wait';
      const sessionExpiryAssistant = 'postgres-session-expired-assistant';
      await insertChatSession(sessionExpirySession);
      let sessionFenceNow = 2_000_000;
      const sessionFencedService = new PostgresDurableJobService(
        new PostgresDurableJobRepository(first.database, () => sessionFenceNow),
        durableKeyring,
        () => sessionFenceNow
      );
      const sessionExpiryJob = await sessionFencedService.enqueue(
        chatJobInput(sessionExpirySession, sessionExpiryAssistant)
      );
      const sessionExpiryLease = await sessionFencedService.claim(
        'postgres-session-expiry-worker',
        1000
      );
      assert.equal(sessionExpiryLease?.id, sessionExpiryJob.id);
      let releaseSessionLock;
      let sessionLockReadyResolve;
      const sessionLockRelease = new Promise(resolve => {
        releaseSessionLock = resolve;
      });
      const sessionLockReady = new Promise(resolve => {
        sessionLockReadyResolve = resolve;
      });
      const heldSessionLock = first.database.withClient(async client => {
        await client.query('BEGIN');
        try {
          await client.query(
            'SELECT user_id FROM sessions WHERE id = $1 FOR UPDATE',
            [sessionExpirySession]
          );
          sessionLockReadyResolve();
          await sessionLockRelease;
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
      await sessionLockReady;
      const sessionExpiredCompletion =
        sessionFencedService.publishChatCompletion(
          chatCompletionInput(
            sessionExpirySession,
            sessionExpiryAssistant,
            sessionExpiryLease
          )
        );
      let sessionWaiterObserved = false;
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiters = await first.database.query(
            `SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%SELECT user_id FROM sessions%FOR UPDATE%'
              LIMIT 1`
          );
          if (waiters.rowCount === 1) {
            sessionWaiterObserved = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        sessionFenceNow = sessionExpiryLease.leaseExpiresAt + 1;
      } finally {
        releaseSessionLock();
        await heldSessionLock;
      }
      assert.equal(sessionWaiterObserved, true);
      await assert.rejects(
        sessionExpiredCompletion,
        error => error?.code === 'lease-lost'
      );
      const sessionExpiredEventId = durableEventId(
        'chat',
        sessionExpirySession,
        sessionExpiryAssistant,
        'done'
      );
      assert.deepEqual(
        (
          await first.database.query(
            `SELECT
               (SELECT COUNT(*)::text FROM session_messages WHERE id = $1)
                 AS messages,
               (SELECT COUNT(*)::text FROM platform_events WHERE event_id = $2)
                 AS events,
               (SELECT state FROM platform_jobs WHERE id = $3) AS job_state,
               (SELECT result_reference FROM platform_jobs WHERE id = $3)
                 AS result_reference,
               (SELECT outcome FROM platform_job_attempts
                 WHERE job_id = $3 AND attempt_number = $4) AS attempt_outcome`,
            [
              sessionExpiryAssistant,
              sessionExpiredEventId,
              sessionExpiryJob.id,
              sessionExpiryLease.attemptCount,
            ]
          )
        ).rows[0],
        {
          messages: '0',
          events: '0',
          job_state: 'running',
          result_reference: null,
          attempt_outcome: 'running',
        },
        'an expired publisher must not commit an assistant, done event, or job success after the session lock wait'
      );
      assert.equal(
        (
          await sessionFencedService.requestChatCancellation({
            actorUserId: 'waiting',
            sessionId: sessionExpirySession,
            assistantMessageId: sessionExpiryAssistant,
          })
        ).outcome,
        'cancellation-recorded'
      );

      const sideEffectExpirySession =
        'postgres-chat-expired-during-event-write';
      const sideEffectExpiryAssistant =
        'postgres-side-effect-expired-assistant';
      const sideEffectExpiryEventId = durableEventId(
        'chat',
        sideEffectExpirySession,
        sideEffectExpiryAssistant,
        'done'
      );
      await insertChatSession(sideEffectExpirySession);
      let sideEffectFenceNow = 3_000_000;
      let sideEffectLeaseExpiresAt = Number.POSITIVE_INFINITY;
      let sideEffectFenceArmed = false;
      const sideEffectFenceDatabase = {
        query: first.database.query.bind(first.database),
        async transaction(operation, options) {
          return first.database.transaction(
            client =>
              operation({
                async query(statement, values) {
                  const result = await client.query(statement, values);
                  if (
                    sideEffectFenceArmed &&
                    typeof statement === 'string' &&
                    statement.includes('INSERT INTO platform_events') &&
                    values?.[0] === sideEffectExpiryEventId
                  ) {
                    sideEffectFenceNow = sideEffectLeaseExpiresAt + 1;
                  }
                  return result;
                },
              }),
            options
          );
        },
      };
      const sideEffectFencedService = new PostgresDurableJobService(
        new PostgresDurableJobRepository(
          sideEffectFenceDatabase,
          () => sideEffectFenceNow
        ),
        durableKeyring,
        () => sideEffectFenceNow
      );
      const sideEffectExpiryJob = await sideEffectFencedService.enqueue(
        chatJobInput(sideEffectExpirySession, sideEffectExpiryAssistant)
      );
      const sideEffectExpiryLease = await sideEffectFencedService.claim(
        'postgres-side-effect-expiry-worker',
        1000
      );
      assert.equal(sideEffectExpiryLease?.id, sideEffectExpiryJob.id);
      sideEffectLeaseExpiresAt = sideEffectExpiryLease.leaseExpiresAt;
      sideEffectFenceArmed = true;
      await assert.rejects(
        sideEffectFencedService.publishChatCompletion(
          chatCompletionInput(
            sideEffectExpirySession,
            sideEffectExpiryAssistant,
            sideEffectExpiryLease
          )
        ),
        error => error?.code === 'lease-lost'
      );
      assert.equal(
        sideEffectFenceNow > sideEffectExpiryLease.leaseExpiresAt,
        true
      );
      assert.deepEqual(
        (
          await first.database.query(
            `SELECT
               (SELECT COUNT(*)::text FROM session_messages WHERE id = $1)
                 AS messages,
               (SELECT COUNT(*)::text FROM platform_events WHERE event_id = $2)
                 AS events,
               (SELECT state FROM platform_jobs WHERE id = $3) AS job_state,
               (SELECT result_reference FROM platform_jobs WHERE id = $3)
                 AS result_reference,
               (SELECT outcome FROM platform_job_attempts
                 WHERE job_id = $3 AND attempt_number = $4) AS attempt_outcome`,
            [
              sideEffectExpiryAssistant,
              sideEffectExpiryEventId,
              sideEffectExpiryJob.id,
              sideEffectExpiryLease.attemptCount,
            ]
          )
        ).rows[0],
        {
          messages: '0',
          events: '0',
          job_state: 'running',
          result_reference: null,
          attempt_outcome: 'running',
        },
        'an event write that crosses lease expiry must roll back the assistant, done event, and job success'
      );
      assert.equal(
        (
          await sideEffectFencedService.requestChatCancellation({
            actorUserId: 'waiting',
            sessionId: sideEffectExpirySession,
            assistantMessageId: sideEffectExpiryAssistant,
          })
        ).outcome,
        'cancellation-recorded'
      );

      const completionEventId = durableEventId(
        'chat',
        'postgres-long-session',
        'postgres-assistant',
        'done'
      );
      const completionCursor = await durableServices[0].appendEvent({
        eventId: completionEventId,
        streamId: 'chat:postgres-long-session',
        eventType: 'chat.done.v1',
        subjectId: 'postgres-assistant',
        actorUserId: 'waiting',
        payload: {
          mode: 'encrypted',
          value: { type: 'done', messageId: 'postgres-assistant' },
        },
      });
      const completionEvent =
        await durableServices[1].getEvent(completionEventId);
      assert.ok(completionEvent);
      assert.deepEqual(
        {
          ...completionEvent,
          occurredAt: Number.isSafeInteger(completionEvent.occurredAt),
        },
        {
          cursor: completionCursor,
          eventId: completionEventId,
          streamId: 'chat:postgres-long-session',
          streamSequence: 1,
          eventType: 'chat.done.v1',
          subjectId: 'postgres-assistant',
          actorUserId: 'waiting',
          payload: { type: 'done', messageId: 'postgres-assistant' },
          occurredAt: true,
        }
      );
      await durableServices[0].appendEvent({
        eventId: durableEventId(
          'chat',
          'postgres-long-session',
          'other-assistant',
          'done'
        ),
        streamId: 'chat:postgres-long-session',
        eventType: 'chat.done.v1',
        subjectId: 'other-assistant',
        actorUserId: 'waiting',
        payload: {
          mode: 'encrypted',
          value: { type: 'done', messageId: 'other-assistant' },
        },
      });
      assert.deepEqual(
        (
          await durableServices[1].replayEvents(0, {
            streamId: 'chat:postgres-long-session',
            subjectId: 'postgres-assistant',
          })
        ).map(event => event.eventId),
        [completionEventId],
        'PostgreSQL generation replay must exclude other chat subjects'
      );

      const deletionToken = 'e'.repeat(64);
      await first.database.query(
        `INSERT INTO platform_resource_deletion_tombstones
           (resource_type, resource_id, owner_user_id, deletion_incarnation,
            deletion_token, deleted_at, completed_at)
         VALUES ('document', 'exhausted-cleanup-document', 'default', 1,
                 $1, $2, NULL)`,
        [deletionToken, Date.now()]
      );
      const exhaustedResource = await durableServices[0].enqueue({
        jobType: RESOURCE_DELETE_JOB_TYPE,
        actorUserId: 'default',
        idempotencyScope: RESOURCE_DELETE_JOB_TYPE,
        idempotencyKey: deletionToken,
        payload: {
          mode: 'encrypted',
          value: {
            resourceType: 'document',
            resourceId: 'exhausted-cleanup-document',
            deletionIncarnation: 1,
            deletionToken,
          },
        },
        maxAttempts: 5,
        priority: 100,
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const lease = await durableServices[0].claim(
          `resource-recovery-${attempt}`,
          1000
        );
        assert.equal(lease?.id, exhaustedResource.id);
        await durableServices[0].fail(lease, {
          retryable: true,
          errorCode: 'resource-cleanup-failed',
          errorSummary: 'Object storage is unavailable',
          backoffMs: 0,
        });
      }
      assert.equal(
        (await durableServices[0].getMetadata(exhaustedResource.id)).state,
        'dead_letter'
      );

      const exhaustedOwner = await durableServices[0].enqueue({
        jobType: OWNER_DELETE_CONTENT_JOB_TYPE,
        actorUserId: 'default',
        idempotencyScope: OWNER_DELETE_CONTENT_JOB_TYPE,
        idempotencyKey: 'exhausted-owner-cleanup',
        payload: {
          mode: 'encrypted',
          value: {
            targetUserId: 'deleted-owner-for-recovery',
            actorUserId: 'default',
          },
        },
        maxAttempts: 10,
        priority: 100,
      });
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const lease = await durableServices[0].claim(
          `owner-recovery-${attempt}`,
          1000
        );
        assert.equal(lease?.id, exhaustedOwner.id);
        await durableServices[0].fail(lease, {
          retryable: true,
          errorCode: 'owner-cleanup-failed',
          errorSummary: 'Object storage is unavailable',
          backoffMs: 0,
        });
      }
      assert.equal(
        (await durableServices[0].getMetadata(exhaustedOwner.id)).state,
        'dead_letter'
      );

      await Promise.all(
        durableServices.map(service => service.reconcileDeletionLifecycleJobs())
      );
      for (const scope of [
        RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
        OWNER_DELETE_CONTENT_RECOVERY_IDEMPOTENCY_SCOPE,
      ]) {
        const recovery = await first.database.query(
          `SELECT state, available_at, updated_at
             FROM platform_jobs
            WHERE actor_user_id = 'default' AND idempotency_scope = $1`,
          [scope]
        );
        assert.equal(
          recovery.rowCount,
          1,
          'two workers must converge on one lifecycle successor'
        );
        assert.equal(recovery.rows[0].state, 'queued');
      }
      assert.equal(
        await durableServices[0].countNonSucceededForActor('default', {
          jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
          excludeHandledLifecycleJobs: true,
        }),
        1,
        'retirement must count only the unresolved owner-cleanup chain leaf'
      );

      // Even if an earlier worker completed the external cleanup immediately
      // before losing its terminal acknowledgement, the retained completed
      // tombstone prevents a failed successor from growing another chain.
      await first.database.query(
        `UPDATE platform_resource_deletion_tombstones
            SET completed_at = deleted_at
          WHERE resource_type = 'document'
            AND resource_id = 'exhausted-cleanup-document'`
      );
      await first.database.query(
        `UPDATE platform_jobs SET state = 'dead_letter',
                error_code = 'resource-cleanup-failed',
                error_summary = 'lost terminal acknowledgement',
                finished_at = updated_at
          WHERE actor_user_id = 'default'
            AND idempotency_scope = $1`,
        [RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE]
      );
      await durableServices[0].reconcileDeletionLifecycleJobs();
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count FROM platform_jobs
              WHERE actor_user_id = 'default'
                AND idempotency_scope = $1`,
            [RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE]
          )
        ).rows[0].count,
        '1'
      );
      assert.deepEqual(
        await durableServices[1].reconcileDeletionLifecycleJobs(),
        { examined: 0, recoveryJobs: 0, skipped: 0 },
        'handled terminal rows must not be rescanned on later worker starts'
      );

      const retiringCleanupInitiator = 'retiring-cleanup-initiator';
      await identity.insert({
        id: retiringCleanupInitiator,
        username: retiringCleanupInitiator,
        email: null,
        password_hash: 'hash',
        role: 'admin',
        account_status: 'active',
        approved_at: 5,
        approved_by: 'default',
        avatar: null,
        created_at: 5,
        updated_at: 5,
      });
      await Promise.all(
        Array.from({ length: 205 }, (_, index) =>
          durableServices[index % durableServices.length].enqueue({
            jobType: 'test.retirement-ordinary.v1',
            actorUserId: 'waiting',
            idempotencyScope: 'real-postgres-retirement-ordinary',
            idempotencyKey: `ordinary-${index}`,
            payload: { mode: 'encrypted', value: { index } },
          })
        )
      );
      for (let index = 0; index < 2; index += 1) {
        await durableServices[0].enqueue({
          jobType: OWNER_DELETE_CONTENT_JOB_TYPE,
          actorUserId: retiringCleanupInitiator,
          idempotencyScope: OWNER_DELETE_CONTENT_JOB_TYPE,
          idempotencyKey: `protected-owner-${index}`,
          payload: {
            mode: 'encrypted',
            value: { targetUserId: `protected-owner-${index}` },
          },
          priority: 100,
        });
      }
      assert.equal(
        await identity.beginRetirement(retiringCleanupInitiator, 6),
        true
      );
      assert.deepEqual(
        await durableServices[0].cancelAllForActor('waiting', 'actor-revoked', {
          excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
        }),
        { cancelledQueued: 206, cancellationRequestedRunning: 0 }
      );
      assert.equal(
        await durableServices[0].countActiveForActor('waiting', {
          excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
        }),
        0
      );
      assert.deepEqual(
        await durableServices[0].cancelAllForActor(
          retiringCleanupInitiator,
          'actor-revoked',
          { excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE] }
        ),
        { cancelledQueued: 0, cancellationRequestedRunning: 0 },
        'retirement must preserve cleanup jobs initiated while the actor was active'
      );
      assert.equal(
        await durableServices[0].countNonSucceededForActor(
          retiringCleanupInitiator,
          { jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE] }
        ),
        2
      );

      const extensions = first.repositories.extensions;
      const sharedPlugin = {
        plugin_id: 'shared-provider',
        definition_json: JSON.stringify({ id: 'shared-provider' }),
        definition_fingerprint: 'd'.repeat(64),
        approved_by_user_id: 'default',
        approved_at: 2,
        created_at: 2,
        updated_at: 2,
      };
      await extensions.pluginDefinitions.replaceApproved(sharedPlugin);
      assert.deepEqual(
        await extensions.pluginDefinitions.find('shared-provider'),
        sharedPlugin
      );
      await extensions.pluginActivations.activate(
        'shared-provider',
        'waiting',
        3
      );
      await extensions.pluginApprovals.upsert({
        plugin_id: 'shared-provider',
        definition_fingerprint: 'd'.repeat(64),
        source_path: '/legacy/source.json',
        approved_by_user_id: 'default',
        approved_at: 3,
      });
      await extensions.pluginDiscovery.upsert({
        user_id: 'waiting',
        plugin_id: 'shared-provider',
        models_json: '["old-model"]',
        updated_at: 3,
      });
      await extensions.pluginDefinitions.replaceApproved({
        ...sharedPlugin,
        definition_fingerprint: 'e'.repeat(64),
        updated_at: 4,
      });
      assert.equal(
        (await extensions.pluginActivations.list('waiting')).includes(
          'shared-provider'
        ),
        false
      );
      assert.equal(
        await extensions.pluginApprovals.find('shared-provider'),
        null
      );
      assert.equal(
        await extensions.pluginDiscovery.get('shared-provider', 'waiting'),
        null
      );
      await extensions.pluginCredentials.upsert({
        id: 'shared-provider-credential',
        user_id: 'waiting',
        plugin_id: 'shared-provider',
        api_key: 'opaque-key',
        routing_auth_fingerprint: 'f'.repeat(64),
        created_at: 4,
        updated_at: 4,
      });
      await extensions.pluginVariables.apply('shared-provider', 'waiting', {
        unsetNames: [],
        upserts: [
          {
            id: 'shared-provider-variable',
            user_id: 'waiting',
            plugin_id: 'shared-provider',
            variable_name: 'BASE_URL',
            variable_value: 'opaque-value',
            is_encrypted: 1,
            created_at: 4,
            updated_at: 4,
          },
        ],
      });
      assert.equal(
        await extensions.pluginDefinitions.deleteWithState('shared-provider'),
        true
      );
      assert.equal(
        await extensions.pluginDefinitions.find('shared-provider'),
        null
      );
      assert.equal(
        await extensions.pluginCredentials.find('shared-provider', 'waiting'),
        null
      );
      assert.deepEqual(
        await extensions.pluginVariables.list('shared-provider', 'waiting'),
        []
      );

      await first.repositories.resources.notes.replaceWithLimit(
        {
          id: 'note-one',
          user_id: 'waiting',
          title: 'encrypted-title',
          content: 'encrypted-content',
          pinned: 0,
          created_at: 3,
          updated_at: 3,
        },
        1
      );
      await assert.rejects(
        first.repositories.resources.notes.replaceWithLimit(
          {
            id: 'note-two',
            user_id: 'waiting',
            title: 'another-title',
            content: 'another-content',
          pinned: 0,
            created_at: 4,
            updated_at: 4,
          },
          1
        ),
        /storage limit/
      );

      await assert.rejects(
        first.transaction(async unitOfWork => {
          await unitOfWork.identity.insert({
            id: 'rolled-back',
            username: 'rolled-back',
            email: null,
            password_hash: 'hash',
            role: 'user',
            account_status: 'pending',
            approved_at: null,
            approved_by: null,
            avatar: null,
            created_at: 5,
            updated_at: 5,
          });
          throw new Error('rollback sentinel');
        }),
        /rollback sentinel/
      );
      assert.equal(await identity.findByUsername('rolled-back'), null);

      await identity.insert({
        id: 'delete-with-outbox',
        username: 'delete-with-outbox',
        email: null,
        password_hash: 'hash',
        role: 'user',
        account_status: 'active',
        approved_at: 5,
        approved_by: 'waiting',
        avatar: null,
        created_at: 5,
        updated_at: 5,
      });
      await extensions.pluginDefinitions.replaceApproved({
        plugin_id: 'deletion-audit-definition',
        definition_json: '{"id":"deletion-audit-definition"}',
        definition_fingerprint: 'a'.repeat(64),
        approved_by_user_id: 'delete-with-outbox',
        approved_at: 5,
        created_at: 5,
        updated_at: 5,
      });
      await extensions.pluginApprovals.upsert({
        plugin_id: 'deletion-audit-approval',
        definition_fingerprint: 'b'.repeat(64),
        source_path: '/historical/provider.json',
        approved_by_user_id: 'delete-with-outbox',
        approved_at: 5,
      });
      assert.equal(
        (await identity.findPublicById('default'))?.account_status,
        'active',
        'identity deletion must be initiated by a current active account'
      );
      assert.equal(
        await identity.deleteAndEnqueue('delete-with-outbox', 'default', {
          enqueueSQLite() {
            throw new Error('wrong persistence dialect');
          },
          async enqueuePostgres() {
            throw new Error('active account must not enqueue deletion');
          },
        }),
        false,
        'identity deletion must require durable retirement'
      );
      assert.equal(
        await identity.beginRetirement('delete-with-outbox', 6),
        true
      );
      assert.equal(
        await identity.beginRetirement('delete-with-outbox', 7),
        true,
        'retirement must be idempotent'
      );
      assert.equal(
        await identity.deleteAndEnqueue('delete-with-outbox', 'default', {
          enqueueSQLite() {
            throw new Error('wrong persistence dialect');
          },
          async enqueuePostgres(executor, input) {
            await executor.query(
              `INSERT INTO system_settings (key, value, updated_at)
                 VALUES ($1, $2, $3)`,
              [`delete:${input.targetUserId}`, input.actorUserId, 5]
            );
          },
        }),
        true
      );
      assert.equal(
        (await extensions.pluginDefinitions.find('deletion-audit-definition'))
          ?.approved_by_user_id,
        'delete-with-outbox',
        'stable plugin approval audit identity must survive account deletion'
      );
      assert.equal(
        (await extensions.pluginApprovals.find('deletion-audit-approval'))
          ?.approved_by_user_id,
        'delete-with-outbox'
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT value FROM system_settings WHERE key = $1`,
            ['delete:delete-with-outbox']
          )
        ).rows[0].value,
        'default'
      );

      const archiveRepository = first.repositories.resources.archive;
      const archivePlan = {
        userId: 'waiting',
        strategy: 'overwrite',
        timestamp: 5,
        maximumNotes: 10,
        maximumSessionFolders: 10,
        preferences: [{ key: 'defaultModel', value: 'archive-model' }],
        sessionFolders: [],
        notes: [],
        knowledgeCollections: [],
        sessions: [
          {
            session: {
              id: 'archive-transaction-session',
              user_id: 'waiting',
              title: 'archive-title',
              model: 'archive-model',
              persona_id: null,
              provider_type: null,
              provider_id: null,
              created_at: 5,
              updated_at: 5,
              archived: 0,
              settings: null,
              folder_id: null,
              pinned: 0,
            },
            messages: [
              {
                id: 'archive-bad-message',
                session_id: 'wrong-session',
                role: 'user',
                content: 'archive-content',
                thinking: null,
                timestamp: 5,
                message_index: 0,
                model: null,
                provider_metadata: null,
                images: null,
                statistics: null,
                artifacts: null,
                parent_id: null,
                branch_index: 0,
                is_active: 1,
                rating: null,
              },
            ],
          },
        ],
        documents: [],
      };
      await assert.rejects(
        archiveRepository.applyImport(archivePlan),
        /does not belong to its aggregate/
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count
               FROM user_preferences
              WHERE user_id = 'waiting' AND key = 'defaultModel'`
          )
        ).rows[0].count,
        '0',
        'a late archive failure must roll back earlier preference writes'
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT COUNT(*)::text AS count
               FROM sessions WHERE id = 'archive-transaction-session'`
          )
        ).rows[0].count,
        '0'
      );

      await identity.insert({
        id: 'delete-outbox-rollback',
        username: 'delete-outbox-rollback',
        email: null,
        password_hash: 'hash',
        role: 'user',
        account_status: 'active',
        approved_at: 5,
        approved_by: 'waiting',
        avatar: null,
        created_at: 5,
        updated_at: 5,
      });
      assert.equal(
        await identity.beginRetirement('delete-outbox-rollback', 6),
        true
      );
      await assert.rejects(
        identity.deleteAndEnqueue('delete-outbox-rollback', 'default', {
          enqueueSQLite() {
            throw new Error('wrong persistence dialect');
          },
          async enqueuePostgres() {
            throw new Error('delete enqueue rollback sentinel');
          },
        }),
        /delete enqueue rollback sentinel/
      );
      assert.equal(
        (await identity.findPublicById('delete-outbox-rollback'))?.id,
        'delete-outbox-rollback'
      );

      for (const id of [
        'retiring-delete-actor',
        'actor-fenced-delete-target',
      ]) {
        await identity.insert({
          id,
          username: id,
          email: null,
          password_hash: 'hash',
          role: 'admin',
          account_status: 'active',
          approved_at: 5,
          approved_by: 'waiting',
          avatar: null,
          created_at: 5,
          updated_at: 5,
        });
      }
      assert.equal(
        await identity.beginRetirement('retiring-delete-actor', 6),
        true
      );
      assert.equal(
        await identity.beginRetirement('actor-fenced-delete-target', 6),
        true
      );
      await assert.rejects(
        identity.deleteAndEnqueue(
          'actor-fenced-delete-target',
          'retiring-delete-actor',
          {
            enqueueSQLite() {
              throw new Error('wrong persistence dialect');
            },
            async enqueuePostgres() {
              throw new Error('inactive actor reached enqueue');
            },
          }
        ),
        /requires an active actor/
      );
      assert.equal(
        (await identity.findPublicById('actor-fenced-delete-target'))
          ?.account_status,
        'retiring'
      );

      const chatAggregate = {
        session: {
          id: 'chat-outbox-session',
          user_id: 'waiting',
          title: 'encrypted-chat-title',
          model: 'model',
          persona_id: null,
          provider_type: null,
          provider_id: null,
          created_at: 5,
          updated_at: 5,
          archived: 0,
          settings: null,
          folder_id: null,
          pinned: 0,
        },
        messages: [
          {
            id: 'chat-user-message',
            session_id: 'chat-outbox-session',
            role: 'user',
            content: 'encrypted-message',
            thinking: null,
            timestamp: 5,
            message_index: 0,
            model: null,
            provider_metadata: null,
            images: null,
            statistics: null,
            artifacts: null,
            parent_id: null,
            branch_index: 0,
            is_active: 1,
            rating: null,
          },
        ],
      };
      const chatInput = {
        sessionId: 'chat-outbox-session',
        actorUserId: 'waiting',
        userMessageId: 'chat-user-message',
        assistantMessageId: 'chat-assistant-message',
        message: 'encrypted-generation-payload',
        options: {},
        webSearch: false,
      };
      await first.repositories.resources.chatSessions.replaceAndEnqueue(
        chatAggregate,
        {
          enqueueSQLite() {
            throw new Error('wrong persistence dialect');
          },
          async enqueuePostgres(executor, input) {
            await executor.query(
              `INSERT INTO system_settings (key, value, updated_at)
               VALUES ($1, $2, $3)`,
              [`chat:${input.assistantMessageId}`, input.sessionId, 5]
            );
            return { created: true };
          },
        },
        chatInput
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT value FROM system_settings WHERE key = $1`,
            ['chat:chat-assistant-message']
          )
        ).rows[0].value,
        'chat-outbox-session'
      );
      await assert.rejects(
        first.repositories.resources.chatSessions.replaceAndEnqueue(
          {
            ...chatAggregate,
            session: {
              ...chatAggregate.session,
              title: 'must-roll-back',
            },
          },
          {
            enqueueSQLite() {
              throw new Error('wrong persistence dialect');
            },
            async enqueuePostgres() {
              throw new Error('chat enqueue rollback sentinel');
            },
          },
          {
            ...chatInput,
            assistantMessageId: 'chat-assistant-message-two',
          }
        ),
        /chat enqueue rollback sentinel/
      );
      assert.equal(
        (
          await first.database.query(
            `SELECT title FROM sessions WHERE id = 'chat-outbox-session'`
          )
        ).rows[0].title,
        'encrypted-chat-title'
      );

      const raw = await first.database.query(
        'SELECT email FROM users WHERE id = $1',
        ['waiting']
      );
      assert.doesNotMatch(raw.rows[0].email, /waiting@example/);

      // Force two empty-database bootstrap decisions to overlap. Serializable
      // transactions must allow exactly one initial administrator instead of
      // committing two first-user decisions under replica concurrency.
      await first.database.query('DELETE FROM users');
      let arrived = 0;
      let releaseBootstrap;
      const bothRead = new Promise(resolve => {
        releaseBootstrap = resolve;
      });
      const bootstrap = (persistence, id) =>
        persistence.transaction(async ({ identity: transactionalIdentity }) => {
          const firstUser =
            (await transactionalIdentity.countRealUsers()) === 0;
          arrived += 1;
          if (arrived === 2) releaseBootstrap();
          await bothRead;
          if (firstUser) {
            await transactionalIdentity.insert({
              id,
              username: id,
              email: null,
              password_hash: `hash-${id}`,
              role: 'admin',
              account_status: 'active',
              approved_at: 6,
              approved_by: null,
              avatar: null,
              created_at: 6,
              updated_at: 6,
            });
          }
        });
      const bootstrapResults = await Promise.allSettled([
        bootstrap(first, 'bootstrap-a'),
        bootstrap(second, 'bootstrap-b'),
      ]);
      assert.equal(
        bootstrapResults.filter(result => result.status === 'fulfilled').length,
        1
      );
      assert.equal(
        bootstrapResults.filter(result => result.status === 'rejected').length,
        1
      );
      const admins = await first.database.query(
        "SELECT COUNT(*)::text AS count FROM users WHERE role = 'admin'"
      );
      assert.equal(admins.rows[0].count, '1');

      // A valid ledger cannot hide schema damage. Readiness and validate-only
      // startup must fail closed until the missing structure is restored.
      await first.database.query('DROP INDEX idx_notes_user_updated');
      const damagedHealth = await first.health();
      assert.equal(damagedHealth.ready, false);
      assert.match(damagedHealth.message, /schema structure/i);
      await assert.rejects(
        initializePostgresPersistence(
          { ...config, migrationMode: 'validate' },
          codec
        ),
        /missing index idx_notes_user_updated/i
      );
    } finally {
      await Promise.allSettled([first?.close(), second?.close()]);
      const cleanup = createPostgresDatabase(bootstrapConfig);
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await cleanup.close();
    }
  }
);

test(
  'SQLite-to-PostgreSQL import is dry-run safe, resumable, and checksummed',
  { skip: integrationUrl ? false : 'TEST_POSTGRES_URL is not configured' },
  async t => {
    const parsed = new URL(integrationUrl);
    assert.match(
      parsed.pathname.slice(1),
      /test/i,
      'TEST_POSTGRES_URL must name a disposable test database'
    );
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'libre-pg-import-test-')
    );
    t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }));
    const initialize = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        "const database = await import('./backend/dist/db.js'); database.getDatabase(); database.closeDatabase();",
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATA_DIR: sourceDirectory },
        encoding: 'utf8',
      }
    );
    assert.equal(initialize.status, 0, initialize.stderr);
    const sourcePath = path.join(sourceDirectory, 'data.sqlite');
    const source = new Database(sourcePath);
    const emailLookup = createHash('sha256')
      .update('person@example.test')
      .digest('hex');
    source
      .prepare(
        `INSERT INTO users
           (id, username, email, email_lookup, password_hash, role,
            account_status, approved_at, approved_by, avatar, created_at,
            updated_at)
         VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, NULL, NULL, ?, ?)`
      )
      .run(
        'import-user',
        'import-person',
        `${'a'.repeat(32)}:opaque-email:${'b'.repeat(32)}`,
        emailLookup,
        'password-hash',
        1,
        1,
        1
      );
    source
      .prepare(
        `INSERT INTO sessions
           (id, user_id, title, model, persona_id, provider_type, provider_id,
            created_at, updated_at, archived, settings, folder_id, pinned)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 0, NULL, NULL, 0)`
      )
      .run(
        'import-session',
        'import-user',
        'opaque-session-title-ciphertext',
        'import-model',
        2,
        2
      );
    const insertSourceMessage = source.prepare(
      `INSERT INTO session_messages
         (id, session_id, role, content, thinking, timestamp, message_index,
          model, provider_metadata, images, statistics, artifacts, parent_id,
          branch_index, is_active, rating)
       VALUES (?, 'import-session', 'assistant', ?, NULL, ?, ?, 'import-model',
               NULL, NULL, NULL, NULL, ?, ?, 1, NULL)`
    );
    // IDs force the child to sort before its parent. The cycle exercises the
    // same two-pass import without relying on a topological row order.
    insertSourceMessage.run(
      'a-out-of-order-child',
      'opaque-child-ciphertext',
      3,
      0,
      'z-out-of-order-parent',
      1
    );
    insertSourceMessage.run(
      'b-cycle-left',
      'opaque-cycle-left-ciphertext',
      4,
      1,
      'c-cycle-right',
      0
    );
    insertSourceMessage.run(
      'c-cycle-right',
      'opaque-cycle-right-ciphertext',
      5,
      2,
      'b-cycle-left',
      1
    );
    insertSourceMessage.run(
      'd-dangling-child',
      'opaque-dangling-ciphertext',
      6,
      3,
      'missing-original-message',
      2
    );
    insertSourceMessage.run(
      'z-out-of-order-parent',
      'opaque-parent-ciphertext',
      2,
      4,
      null,
      0
    );
    const workTaskId = 'import-work-task';
    const workRunId = 'import-work-run';
    const workNulContent = 'bin\u0000\u0001\u0002\u0003\u0004\u0005\u0006';
    assert.equal(workNulContent.length, 10);
    assert.equal(workNulContent.indexOf('\u0000'), 3);
    const workMessageContents = new Map([
      ['import-work-ordinary', 'ordinary tool output'],
      ['import-work-json-looking', '"legacy-looking"'],
      ['import-work-nul', workNulContent],
    ]);
    source
      .prepare(
        `INSERT INTO work_tasks (
           id, user_id, title, model, provider_type, provider_id, status,
           network_enabled, volume_name, container_name, host_path, policy_id,
           preview_url, preview_status, preview_upstream_host,
           preview_upstream_port, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'ollama', NULL, 'completed', 0, ?, ?, NULL,
                   NULL, NULL, 'stopped', NULL, NULL, ?, ?)`
      )
      .run(
        workTaskId,
        'import-user',
        'Imported Work task',
        'import-model',
        'libre-work-import-task-volume',
        'libre-work-import-task-container',
        7,
        7
      );
    source
      .prepare(
        `INSERT INTO work_runs (
           id, task_id, model, provider_type, provider_id, status, error,
           created_at, started_at, finished_at
         ) VALUES (?, ?, ?, 'ollama', NULL, 'completed', NULL, ?, ?, ?)`
      )
      .run(workRunId, workTaskId, 'import-model', 7, 7, 7);
    const sqliteWork = new SQLiteWorkPersistence(source);
    for (const [id, content] of workMessageContents) {
      await sqliteWork.insertMessage({
        id,
        task_id: workTaskId,
        run_id: workRunId,
        role: 'tool',
        kind: 'tool_result',
        content,
        metadata: id === 'import-work-nul' ? '{"source":"binary"}' : null,
        created_at: 8,
      });
    }
    assert.deepEqual(
      (await sqliteWork.listMessages({ taskId: workTaskId, mode: 'all' })).map(
        row => [row.id, row.content]
      ),
      [...workMessageContents]
    );
    assert.equal(
      source
        .prepare('SELECT content FROM work_messages WHERE id = ?')
        .get('import-work-nul').content,
      workNulContent,
      'SQLite Work persistence keeps logical content byte-for-byte'
    );
    const pluginsDirectory = path.join(sourceDirectory, 'plugins');
    fs.mkdirSync(pluginsDirectory, { mode: 0o700 });
    const pluginDefinition = {
      id: 'import-plugin',
      name: 'Imported provider',
      type: 'openai',
      endpoint: 'https://provider.example.test/v1/chat/completions',
      auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'KEY' },
      model_map: ['import-model'],
      created_at: 3,
      updated_at: 3,
    };
    const pluginPath = path.join(pluginsDirectory, 'import-plugin.json');
    const pluginJson = JSON.stringify(pluginDefinition, null, 2);
    const pluginFingerprint = getPluginDefinitionFingerprint(pluginDefinition);
    fs.writeFileSync(pluginPath, pluginJson, { mode: 0o600 });
    source
      .prepare(
        `INSERT INTO plugin_definition_approvals
           (plugin_id, definition_fingerprint, source_path,
            approved_by_user_id, approved_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('import-plugin', pluginFingerprint, pluginPath, 'import-user', 3);
    source
      .prepare(
        `INSERT INTO notes
           (id, user_id, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        'import-note',
        'import-user',
        'opaque-title-ciphertext',
        'opaque-content-ciphertext',
        2,
        2
      );
    source
      .prepare(
        `INSERT INTO plugin_credentials
           (id, user_id, plugin_id, api_key, routing_auth_fingerprint,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'import-credential',
        'import-user',
        'import-plugin',
        'opaque-api-key-ciphertext',
        'c'.repeat(64),
        3,
        3
      );
    source
      .prepare(
        `INSERT INTO generated_images
           (id, user_id, kind, prompt, model, image_data, mime_type,
            created_at)
         VALUES (?, ?, 'image', ?, ?, ?, 'image/png', ?)`
      )
      .run(
        'blocked-media',
        'import-user',
        'opaque-prompt',
        'image-model',
        'opaque-inline-media',
        4
      );
    source.close();

    const schema = `libre_import_test_${process.pid}_${Date.now()}`;
    const { createPostgresDatabase } =
      await import('../backend/dist/persistence/postgresDatabase.js');
    const bootstrapConfig = resolvePostgresRuntimeConfig({
      DATABASE_URL: integrationUrl,
      DATABASE_SSL_MODE: 'disable',
      POSTGRES_APPLICATION_NAME: 'libre-pg-import-bootstrap',
    });
    const bootstrap = createPostgresDatabase(bootstrapConfig);
    await bootstrap.query(`CREATE SCHEMA ${schema}`);
    t.after(async () => {
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await bootstrap.close();
    });
    const schemaUrl = new URL(integrationUrl);
    schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const config = resolvePostgresRuntimeConfig({
      DATABASE_URL: schemaUrl.toString(),
      DATABASE_SSL_MODE: 'disable',
      POSTGRES_APPLICATION_NAME: 'libre-pg-import-test',
    });
    const { migrateSQLiteToPostgres } =
      await import('../backend/dist/persistence/sqliteToPostgresMigration.js');

    const blockedDryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
    });
    assert.equal(blockedDryRun.compatible, false);
    assert.match(
      blockedDryRun.blockers.join('\n'),
      /coordinated blob transfer/
    );
    const dryRunCheck = createPostgresDatabase(config);
    assert.equal(
      (
        await dryRunCheck.query(
          "SELECT to_regclass('libre_schema_migrations')::text AS ledger"
        )
      ).rows[0].ledger,
      null,
      'dry-run must not initialize or mutate the target schema'
    );
    await dryRunCheck.close();

    const cleanupSource = new Database(sourcePath);
    cleanupSource
      .prepare('DELETE FROM generated_images WHERE id = ?')
      .run('blocked-media');
    cleanupSource
      .prepare('UPDATE work_tasks SET title = ? WHERE id = ?')
      .run('invalid\u0000title', workTaskId);
    cleanupSource.close();

    const nulBlockedDryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
    });
    assert.equal(nulBlockedDryRun.compatible, false);
    assert.match(
      nulBlockedDryRun.blockers.join('\n'),
      /PostgreSQL text cannot represent U\+0000.*work_tasks\.title: 1 row/
    );
    assert.match(
      nulBlockedDryRun.warnings.join('\n'),
      /1 Work-message content row contains U\+0000.*reversible JSON-string storage.*raw source checksums remain unchanged/
    );
    const restoreSource = new Database(sourcePath);
    restoreSource
      .prepare('UPDATE work_tasks SET title = ? WHERE id = ?')
      .run('Imported Work task', workTaskId);
    restoreSource.close();

    const cleanTargetPhase = {
      async analyze() {
        return {
          name: 'test-clean-target-preflight',
          items: 0,
          checksum: 'e'.repeat(64),
          warnings: [],
          blockers: [],
        };
      },
      async apply() {},
      async validate() {},
    };
    const dirtyTarget = createPostgresDatabase(config);
    try {
      await dirtyTarget.query(
        'CREATE TABLE dry_run_unknown_sentinel (id integer PRIMARY KEY)'
      );
      const dirtyTargetDryRun = await migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'dry-run',
        storagePhase: cleanTargetPhase,
      });
      assert.equal(dirtyTargetDryRun.targetInitialized, false);
      assert.equal(dirtyTargetDryRun.targetEmpty, false);
      assert.equal(dirtyTargetDryRun.compatible, false);
      assert.match(
        dirtyTargetDryRun.blockers.join('\n'),
        /PostgreSQL target schema is not empty/
      );
      assert.equal(
        (
          await dirtyTarget.query(
            "SELECT to_regclass('dry_run_unknown_sentinel')::text AS sentinel"
          )
        ).rows[0].sentinel,
        'dry_run_unknown_sentinel',
        'dry-run must report an unknown target table without mutating it'
      );
      await dirtyTarget.query('DROP TABLE dry_run_unknown_sentinel');
      await dirtyTarget.query('CREATE TABLE users (id text PRIMARY KEY)');
      const partialTargetDryRun = await migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'dry-run',
        storagePhase: cleanTargetPhase,
      });
      assert.equal(partialTargetDryRun.targetInitialized, false);
      assert.equal(partialTargetDryRun.targetEmpty, false);
      assert.equal(partialTargetDryRun.compatible, false);
      assert.match(
        partialTargetDryRun.blockers.join('\n'),
        /PostgreSQL target schema is not empty/
      );
    } finally {
      await dirtyTarget.query('DROP TABLE IF EXISTS dry_run_unknown_sentinel');
      await dirtyTarget.query('DROP TABLE IF EXISTS users');
      await dirtyTarget.close();
    }

    const interruptedImportPhase = {
      async analyze() {
        return {
          name: 'test-interrupted-relational-import',
          items: 0,
          checksum: 'f'.repeat(64),
          warnings: [],
          blockers: [],
        };
      },
      async apply({ target, resume }) {
        if (resume) {
          await target.query(
            'DROP TRIGGER IF EXISTS reject_session_message_import ON session_messages'
          );
          await target.query(
            'DROP FUNCTION IF EXISTS reject_session_message_import()'
          );
          return;
        }
        await target.query(`
          CREATE FUNCTION reject_session_message_import() RETURNS trigger
          LANGUAGE plpgsql AS $$
          BEGIN
            RAISE EXCEPTION 'sentinel interrupted session-message import';
          END;
          $$;
          CREATE TRIGGER reject_session_message_import
            BEFORE INSERT ON session_messages
            FOR EACH ROW EXECUTE FUNCTION reject_session_message_import();
        `);
      },
      async validate() {},
    };
    const dryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
      storagePhase: interruptedImportPhase,
    });
    assert.equal(dryRun.compatible, true);
    assert.equal(dryRun.targetEmpty, true);
    assert.match(
      dryRun.warnings.join('\n'),
      /1 session-message parent reference points.*imported as NULL.*source checksums remain unchanged/
    );
    assert.match(
      dryRun.warnings.join('\n'),
      /1 Work-message content row contains U\+0000.*reversible JSON-string storage.*raw source checksums remain unchanged/
    );
    assert.equal(
      dryRun.tables.find(row => row.sourceTable === 'session_messages')?.rows,
      5
    );
    await assert.rejects(
      migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'apply',
        storagePhase: interruptedImportPhase,
      }),
      /sentinel interrupted session-message import/
    );
    const interruptedTarget = createPostgresDatabase(config);
    assert.deepEqual(
      (
        await interruptedTarget.query(
          `SELECT
             (SELECT status FROM libre_sqlite_imports) AS status,
             (SELECT source_fingerprint FROM libre_sqlite_imports)
               AS source_fingerprint,
             (SELECT COUNT(*)::text FROM sessions) AS sessions,
             (SELECT COUNT(*)::text FROM session_messages) AS messages,
             (SELECT COUNT(*)::text
                FROM libre_sqlite_import_tables
               WHERE source_table = 'sessions') AS session_journal,
             (SELECT COUNT(*)::text
                FROM libre_sqlite_import_tables
               WHERE source_table = 'session_messages') AS message_journal`
        )
      ).rows[0],
      {
        status: 'failed',
        source_fingerprint: dryRun.sourceFingerprint,
        sessions: '1',
        messages: '0',
        session_journal: '1',
        message_journal: '0',
      }
    );
    await interruptedTarget.query(
      'DROP TRIGGER reject_session_message_import ON session_messages'
    );
    await interruptedTarget.query(
      'DROP FUNCTION reject_session_message_import()'
    );
    await interruptedTarget.close();
    const incompleteDryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
      storagePhase: interruptedImportPhase,
    });
    assert.equal(incompleteDryRun.compatible, false);
    assert.match(
      incompleteDryRun.blockers.join('\n'),
      /matching incomplete SQLite import.*resume enabled/i
    );
    const resumableDryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
      resume: true,
      storagePhase: interruptedImportPhase,
    });
    assert.equal(resumableDryRun.compatible, true);
    await assert.rejects(
      migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'apply',
        storagePhase: interruptedImportPhase,
      }),
      /resume enabled/i
    );
    const applied = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'apply',
      resume: true,
      storagePhase: interruptedImportPhase,
    });
    assert.equal(applied.compatible, true);
    assert.equal(applied.resumed, true);
    assert.equal(
      applied.tables.every(row => row.status === 'verified'),
      true
    );

    const target = createPostgresDatabase(config);
    const completedCompatibility = await target.query(
      `SELECT status, schema_fingerprint
         FROM libre_schema_compatibility WHERE singleton = 1`
    );
    const completedStructure = await (
      await import('../backend/dist/persistence/postgresSchemaInspector.js')
    ).inspectPostgresSchema(target, POSTGRES_MIGRATIONS);
    assert.equal(completedStructure.compatible, true);
    assert.deepEqual(completedCompatibility.rows[0], {
      status: 'compatible',
      schema_fingerprint: completedStructure.fingerprint,
    });
    const healthyImport = await initializePostgresPersistence(config, {
      encrypt: value => value,
      decryptAuthenticated: value => value,
      decryptBuffer: value => value,
      isEncrypted: () => true,
      lookupToken: value => createHash('sha256').update(value).digest('hex'),
    });
    assert.equal((await healthyImport.health()).ready, true);
    await healthyImport.close();

    const healthyImportState = (
      await target.query(
        `SELECT
           (SELECT status FROM libre_schema_compatibility WHERE singleton = 1)
             AS compatibility_status,
           (SELECT failure_code FROM libre_schema_compatibility
             WHERE singleton = 1) AS failure_code,
           (SELECT source_fingerprint FROM libre_sqlite_imports)
             AS source_fingerprint,
           (SELECT status FROM libre_sqlite_imports) AS import_status,
           (SELECT COUNT(*)::text FROM libre_sqlite_imports) AS import_count`
      )
    ).rows[0];
    assert.deepEqual(healthyImportState, {
      compatibility_status: 'compatible',
      failure_code: null,
      source_fingerprint: dryRun.sourceFingerprint,
      import_status: 'complete',
      import_count: '1',
    });

    const differentSnapshot = new Database(sourcePath);
    differentSnapshot
      .prepare('UPDATE notes SET title = ? WHERE id = ?')
      .run('opaque-title-from-different-snapshot', 'import-note');
    differentSnapshot.close();
    try {
      const mismatchedDryRun = await migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'dry-run',
        storagePhase: interruptedImportPhase,
      });
      assert.notEqual(
        mismatchedDryRun.sourceFingerprint,
        dryRun.sourceFingerprint
      );
      assert.equal(mismatchedDryRun.compatible, false);
      assert.match(
        mismatchedDryRun.blockers.join('\n'),
        /different SQLite snapshot/i
      );
      await assert.rejects(
        migrateSQLiteToPostgres({
          sourcePath,
          postgres: config,
          mode: 'apply',
          resume: true,
          storagePhase: interruptedImportPhase,
        }),
        error => {
          assert.match(
            error?.report?.blockers?.join('\n') ?? '',
            /different SQLite snapshot/i
          );
          return true;
        }
      );
      assert.deepEqual(
        (
          await target.query(
            `SELECT
               (SELECT status FROM libre_schema_compatibility
                 WHERE singleton = 1) AS compatibility_status,
               (SELECT failure_code FROM libre_schema_compatibility
                 WHERE singleton = 1) AS failure_code,
               (SELECT source_fingerprint FROM libre_sqlite_imports)
                 AS source_fingerprint,
               (SELECT status FROM libre_sqlite_imports) AS import_status,
               (SELECT COUNT(*)::text FROM libre_sqlite_imports)
                 AS import_count`
          )
        ).rows[0],
        healthyImportState,
        'a mismatched pre-import rejection must not poison a healthy target'
      );
    } finally {
      const restoreSnapshot = new Database(sourcePath);
      restoreSnapshot
        .prepare('UPDATE notes SET title = ? WHERE id = ?')
        .run('opaque-title-ciphertext', 'import-note');
      restoreSnapshot.close();
    }

    const note = await target.query(
      'SELECT title, content FROM notes WHERE id = $1',
      ['import-note']
    );
    const credential = await target.query(
      'SELECT api_key FROM plugin_credentials WHERE id = $1',
      ['import-credential']
    );
    assert.deepEqual(note.rows[0], {
      title: 'opaque-title-ciphertext',
      content: 'opaque-content-ciphertext',
    });
    assert.equal(credential.rows[0].api_key, 'opaque-api-key-ciphertext');
    const messages = await target.query(
      `SELECT id, content, parent_id
         FROM session_messages
        WHERE session_id = 'import-session'
        ORDER BY id`
    );
    assert.deepEqual(messages.rows, [
      {
        id: 'a-out-of-order-child',
        content: 'opaque-child-ciphertext',
        parent_id: 'z-out-of-order-parent',
      },
      {
        id: 'b-cycle-left',
        content: 'opaque-cycle-left-ciphertext',
        parent_id: 'c-cycle-right',
      },
      {
        id: 'c-cycle-right',
        content: 'opaque-cycle-right-ciphertext',
        parent_id: 'b-cycle-left',
      },
      {
        id: 'd-dangling-child',
        content: 'opaque-dangling-ciphertext',
        parent_id: null,
      },
      {
        id: 'z-out-of-order-parent',
        content: 'opaque-parent-ciphertext',
        parent_id: null,
      },
    ]);
    const messageJournal = await target.query(
      `SELECT checksum
         FROM libre_sqlite_import_tables
        WHERE source_table = 'session_messages'`
    );
    assert.equal(
      messageJournal.rows[0].checksum,
      dryRun.tables.find(row => row.sourceTable === 'session_messages')
        ?.checksum,
      'the journal retains the raw SQLite checksum when the target projection clears a dangling reference'
    );
    const rawWorkMessages = await target.query(
      `SELECT id, content, metadata
         FROM work_messages
        WHERE task_id = $1
        ORDER BY message_index`,
      [workTaskId]
    );
    assert.deepEqual(
      rawWorkMessages.rows.map(row => [row.id, row.content]),
      [...workMessageContents].map(([id, content]) => [
        id,
        JSON.stringify(content),
      ]),
      'PostgreSQL stores every Work message as one JSON string'
    );
    assert.equal(
      rawWorkMessages.rows.find(row => row.id === 'import-work-nul').metadata,
      '{"source":"binary"}',
      'the content projection must not alter Work metadata'
    );
    assert.equal(
      rawWorkMessages.rows.some(row => row.content.includes('\u0000')),
      false
    );
    const postgresWork = new PostgresWorkPersistence(target);
    assert.deepEqual(
      (
        await postgresWork.listMessages({ taskId: workTaskId, mode: 'all' })
      ).map(row => [row.id, row.content]),
      [...workMessageContents],
      'PostgreSQL Work reads return exact logical strings'
    );
    const workMessageJournal = await target.query(
      `SELECT checksum
         FROM libre_sqlite_import_tables
        WHERE source_table = 'work_messages'`
    );
    assert.equal(
      workMessageJournal.rows[0].checksum,
      dryRun.tables.find(row => row.sourceTable === 'work_messages')?.checksum,
      'the journal retains the raw SQLite checksum while target validation uses JSON-string storage'
    );
    for (const logical of ['ordinary tool output', '"legacy-looking"']) {
      assert.equal(
        (
          await target.query('SELECT to_json($1::text)::text AS encoded', [
            logical,
          ])
        ).rows[0].encoded,
        encodePostgresWorkMessageContent(logical),
        'the SQL upgrade and JavaScript write codec must agree'
      );
    }
    await target.withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query(
          'CREATE TEMP TABLE work_messages (content text NOT NULL) ON COMMIT DROP'
        );
        const legacyContents = [
          'ordinary v10 content',
          '"JSON-looking v10 content"',
          'v10 control \u0001 content',
        ];
        for (const content of legacyContents) {
          await client.query(
            'INSERT INTO work_messages (content) VALUES ($1)',
            [content]
          );
        }
        await client.query(
          POSTGRES_MIGRATIONS.find(
            migration => migration.name === 'work-message-content-json'
          ).sql
        );
        assert.deepEqual(
          (
            await client.query(
              'SELECT content FROM work_messages ORDER BY ctid'
            )
          ).rows.map(row => row.content),
          legacyContents.map(encodePostgresWorkMessageContent),
          'the v11 SQL upgrade encodes every existing PostgreSQL Work message exactly once'
        );
      } finally {
        await client.query('ROLLBACK');
      }
    });
    await assert.rejects(
      target.query(
        `UPDATE work_messages SET content = 'not a JSON string'
          WHERE id = 'import-work-ordinary'`
      ),
      /work_messages_content_json_string_check|invalid input syntax for type json/i
    );
    assert.equal(
      (
        await postgresWork.listMessages({ taskId: workTaskId, mode: 'all' })
      ).find(row => row.id === 'import-work-ordinary').content,
      'ordinary tool output'
    );
    const importedPlugin = await target.query(
      `SELECT definition_json, definition_fingerprint,
              approved_by_user_id, approved_at::text AS approved_at
         FROM plugin_definitions WHERE plugin_id = $1`,
      ['import-plugin']
    );
    assert.deepEqual(importedPlugin.rows[0], {
      definition_json: pluginJson,
      definition_fingerprint: pluginFingerprint,
      approved_by_user_id: 'import-user',
      approved_at: '3',
    });

    // Recreate the live failure boundary exactly: schema v10, a matching
    // failed import with every relational table journaled except the final
    // work_messages table, and no rows from that rolled-back table.
    await target.query('DELETE FROM work_messages');
    await target.query(
      `DELETE FROM libre_sqlite_import_tables
        WHERE source_table = 'work_messages'`
    );
    await target.query(
      `ALTER TABLE work_messages
         DROP CONSTRAINT work_messages_content_json_string_check`
    );
    await target.query('DROP TABLE eval_runs');
    await target.query('DROP TABLE eval_sets');
    await target.query('DROP TABLE arena_votes');
    await target.query('DROP TABLE message_feedback');
    await target.query('DROP TABLE usage_budgets');
    await target.query('DROP TABLE model_tariffs');
    await target.query(
      'ALTER TABLE voice_profiles DROP COLUMN consent_expires_at'
    );
    await target.query('ALTER TABLE voice_profiles DROP COLUMN revoked_at');
    await target.query('ALTER TABLE voice_profiles DROP COLUMN transfer_count');
    await target.query(
      'ALTER TABLE voice_profiles DROP COLUMN last_transfer_at'
    );
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 19'
    );
    await target.query('DROP TABLE webhook_targets');
    await target.query('DROP TABLE notifications');
    await target.query('DROP TABLE channel_attachments');
    await target.query('DROP TABLE channel_reactions');
    await target.query('DROP TABLE channel_messages');
    await target.query('DROP TABLE channel_members');
    await target.query('DROP TABLE channels');
    await target.query('DROP TABLE calendars');
    await target.query('ALTER TABLE calendar_events DROP COLUMN calendar_id');
    await target.query(
      'ALTER TABLE calendar_events DROP COLUMN reminder_minutes'
    );
    await target.query(
      'ALTER TABLE calendar_events DROP COLUMN last_reminded_occurrence'
    );
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 18'
    );
    await target.query('DROP TABLE note_attachments');
    await target.query('DROP TABLE note_revisions');
    await target.query('ALTER TABLE notes DROP COLUMN pinned');
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 17'
    );
    await target.query('DROP TABLE skill_files');
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 16'
    );
    await target.query('DROP TABLE skill_versions');
    await target.query('DROP TABLE skills');
    await target.query('DROP TABLE prompt_versions');
    await target.query('DROP TABLE prompts');
    await target.query('DROP TABLE tool_approvals');
    await target.query('DROP TABLE tool_server_credentials');
    await target.query('DROP TABLE tool_server_tools');
    await target.query('DROP TABLE tool_servers');
    await target.query('ALTER TABLE personas DROP COLUMN bindings');
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 15'
    );
    await target.query('DROP TABLE automation_runs');
    await target.query('DROP TABLE automations');
    await target.query('DROP TABLE calendar_events');
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 14'
    );
    await target.query('DROP TABLE security_audit_events');
    await target.query('DROP TABLE oauth_identities');
    await target.query('DROP TABLE api_tokens');
    await target.query('DROP TABLE auth_sessions');
    await target.query('DROP TABLE resource_grants');
    await target.query('DROP TABLE user_group_members');
    await target.query('DROP TABLE user_groups');
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 13'
    );
    await target.query('DROP INDEX idx_platform_events_stream_subject_cursor');
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 12'
    );
    await target.query(
      'DELETE FROM libre_schema_migrations WHERE version = 11'
    );
    const v10Structure = await (
      await import('../backend/dist/persistence/postgresSchemaInspector.js')
    ).inspectPostgresSchema(target, POSTGRES_MIGRATIONS.slice(0, 10));
    assert.equal(v10Structure.compatible, true);
    await target.query(
      `UPDATE libre_sqlite_imports
          SET status = 'failed', completed_at = NULL, updated_at = $1`,
      [Date.now()]
    );
    await target.query(
      `UPDATE libre_schema_compatibility
          SET status = 'incompatible', current_version = 10,
              target_version = 10, minimum_reader_version = 10,
              migration_owner = NULL,
              failure_code = 'sqlite_import_incomplete',
              schema_fingerprint = $1, updated_at = $2`,
      [v10Structure.fingerprint, Date.now()]
    );
    const liveFailureState = await target.query(
      `SELECT
         (SELECT MAX(version)::text FROM libre_schema_migrations)
           AS schema_version,
         (SELECT status FROM libre_sqlite_imports) AS import_status,
         (SELECT COUNT(*)::text FROM libre_sqlite_import_tables)
           AS journal_count,
         (SELECT COUNT(*)::text FROM libre_sqlite_import_tables
           WHERE source_table = 'work_messages') AS work_journal,
         (SELECT COUNT(*)::text FROM work_messages) AS work_messages`
    );
    assert.deepEqual(liveFailureState.rows[0], {
      schema_version: '10',
      import_status: 'failed',
      journal_count: String(dryRun.tables.length - 1),
      work_journal: '0',
      work_messages: '0',
    });
    const prefixDryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
      resume: true,
      storagePhase: interruptedImportPhase,
    });
    assert.equal(prefixDryRun.compatible, true);
    assert.equal(prefixDryRun.targetSchemaVersion, 10);
    assert.equal(prefixDryRun.sourceFingerprint, dryRun.sourceFingerprint);
    assert.match(
      prefixDryRun.warnings.join('\n'),
      /exact version 10 migration-ledger prefix.*--resume can safely apply through version 19/i
    );
    const codec = {
      encrypt: value => value,
      decryptAuthenticated: value => value,
      decryptBuffer: value => value,
      isEncrypted: () => true,
      lookupToken: value => createHash('sha256').update(value).digest('hex'),
    };
    await assert.rejects(
      migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'apply',
        storagePhase: interruptedImportPhase,
      }),
      /requires --resume/i
    );
    const resumed = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'apply',
      resume: true,
      storagePhase: interruptedImportPhase,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(
      resumed.tables.every(row => row.status === 'verified'),
      true
    );
    assert.equal(resumed.targetSchemaVersion, 19);
    const resumedState = await target.query(
      `SELECT
         (SELECT MAX(version)::text FROM libre_schema_migrations)
           AS schema_version,
         (SELECT status FROM libre_sqlite_imports) AS import_status,
         (SELECT COUNT(*)::text FROM libre_sqlite_import_tables)
           AS journal_count,
         (SELECT COUNT(*)::text FROM libre_sqlite_import_tables
           WHERE source_table = 'work_messages') AS work_journal,
         (SELECT COUNT(*)::text FROM work_messages) AS work_messages`
    );
    assert.deepEqual(resumedState.rows[0], {
      schema_version: '19',
      import_status: 'complete',
      journal_count: String(dryRun.tables.length),
      work_journal: '1',
      work_messages: String(workMessageContents.size),
    });
    assert.equal(
      (
        await target.query(
          `SELECT checksum
             FROM libre_sqlite_import_tables
            WHERE source_table = 'work_messages'`
        )
      ).rows[0].checksum,
      dryRun.tables.find(row => row.sourceTable === 'work_messages')?.checksum
    );
    const resumedWork = new PostgresWorkPersistence(target);
    assert.deepEqual(
      (await resumedWork.listMessages({ taskId: workTaskId, mode: 'all' })).map(
        row => [row.id, row.content]
      ),
      [...workMessageContents]
    );
    const healthyResumedImport = await initializePostgresPersistence(
      config,
      codec
    );
    assert.equal((await healthyResumedImport.health()).ready, true);
    await healthyResumedImport.close();
    const validated = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'validate',
      storagePhase: interruptedImportPhase,
    });
    assert.equal(validated.compatible, true);
    assert.equal(
      validated.tables.every(row => row.status === 'verified'),
      true
    );

    await target.query(
      `UPDATE notes SET content = 'tampered' WHERE id = 'import-note'`
    );
    await assert.rejects(
      migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'validate',
        storagePhase: interruptedImportPhase,
      }),
      /verification failed/i
    );

    const runtimeMessage = 'Run binary\u0000task';
    const runtimeTaskId = 'runtime-nul-task';
    const runtimeRunId = 'runtime-nul-run';
    await resumedWork.createTaskWithRun(
      {
        task: {
          id: runtimeTaskId,
          user_id: 'import-user',
          title: replaceWorkTextNul(runtimeMessage),
          model: 'import-model',
          provider_type: 'ollama',
          provider_id: null,
          status: 'preparing',
          network_enabled: 0,
          volume_name: 'libre-work-runtime-nul-volume',
          container_name: 'libre-work-runtime-nul-container',
          host_path: null,
          policy_id: null,
          preview_url: null,
          preview_status: 'stopped',
          preview_upstream_host: null,
          preview_upstream_port: null,
          created_at: 20,
          updated_at: 20,
        },
        run: {
          id: runtimeRunId,
          task_id: runtimeTaskId,
          model: 'import-model',
          provider_type: 'ollama',
          provider_id: null,
          status: 'queued',
          error: 'initial\u0000diagnostic',
          created_at: 20,
          started_at: null,
          finished_at: null,
        },
        message: {
          id: 'runtime-nul-message',
          task_id: runtimeTaskId,
          run_id: runtimeRunId,
          role: 'user',
          kind: 'message',
          content: runtimeMessage,
          metadata: null,
          message_index: 0,
          created_at: 20,
        },
        limits: {
          maxActiveRuntimesGlobal: 10,
          maxActiveRuntimesPerUser: 10,
          maxTasksGlobal: 100,
          maxTasksPerUser: 100,
        },
      },
      {
        enqueueSQLite() {
          throw new Error('wrong persistence dialect');
        },
        async enqueuePostgres() {},
      }
    );
    const runtimeRaw = await target.query(
      `SELECT work_tasks.title, work_messages.content, work_runs.error
         FROM work_tasks
         JOIN work_messages ON work_messages.task_id = work_tasks.id
         JOIN work_runs ON work_runs.id = work_messages.run_id
        WHERE work_tasks.id = $1`,
      [runtimeTaskId]
    );
    assert.deepEqual(runtimeRaw.rows[0], {
      title: 'Run binary\uFFFDtask',
      content: JSON.stringify(runtimeMessage),
      error: 'initial\uFFFDdiagnostic',
    });
    assert.equal(
      (
        await resumedWork.listMessages({ taskId: runtimeTaskId, mode: 'all' })
      )[0].content,
      runtimeMessage,
      'a PostgreSQL transaction preserves logical NUL message content'
    );
    await resumedWork.updateRun({
      runId: runtimeRunId,
      status: 'failed',
      error: 'updated\u0000diagnostic',
      started: false,
      finished: true,
      now: 21,
    });
    assert.equal(
      (await resumedWork.findRun(runtimeRunId)).error,
      'updated\uFFFDdiagnostic'
    );
    await target.close();
  }
);

test(
  'team replicas use shared plugin definitions and refuse node-local shadows',
  { skip: integrationUrl ? false : 'TEST_POSTGRES_URL is not configured' },
  async t => {
    const parsed = new URL(integrationUrl);
    assert.match(parsed.pathname.slice(1), /test/i);
    const localRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'libre-pg-plugin-runtime-')
    );
    t.after(() => fs.rmSync(localRoot, { recursive: true, force: true }));
    const writablePlugins = path.join(localRoot, 'plugins');
    const legacyPlugins = path.join(localRoot, 'legacy-plugins');
    fs.mkdirSync(writablePlugins, { recursive: true, mode: 0o700 });
    fs.mkdirSync(legacyPlugins, { recursive: true, mode: 0o700 });

    const previousEnvironment = {
      DATA_DIR: process.env.DATA_DIR,
      PLUGINS_DIR: process.env.PLUGINS_DIR,
      DATABASE_BACKEND: process.env.DATABASE_BACKEND,
      DATABASE_URL: process.env.DATABASE_URL,
      DATABASE_SSL_MODE: process.env.DATABASE_SSL_MODE,
      LIBRE_PLATFORM_MODE: process.env.LIBRE_PLATFORM_MODE,
      COORDINATION_BACKEND: process.env.COORDINATION_BACKEND,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      SHARED_PLUGIN_TEST_KEY: process.env.SHARED_PLUGIN_TEST_KEY,
    };
    process.env.DATA_DIR = path.join(localRoot, 'sqlite-bootstrap');
    process.env.PLUGINS_DIR = writablePlugins;
    delete process.env.DATABASE_BACKEND;
    process.env.ENCRYPTION_KEY = '9'.repeat(64);
    process.env.SHARED_PLUGIN_TEST_KEY = 'must-not-leak-from-process-env';

    const persistenceKernel =
      await import('../backend/dist/persistence/index.js');
    const { PluginService } =
      await import('../backend/dist/services/pluginService.js');
    await persistenceKernel.closePersistence();

    const schema = `libre_plugin_runtime_${process.pid}_${Date.now()}`;
    const bootstrapConfig = resolvePostgresRuntimeConfig({
      DATABASE_URL: integrationUrl,
      DATABASE_SSL_MODE: 'disable',
      POSTGRES_APPLICATION_NAME: 'libre-plugin-runtime-bootstrap',
    });
    const { createPostgresDatabase } =
      await import('../backend/dist/persistence/postgresDatabase.js');
    const adminDatabase = createPostgresDatabase(bootstrapConfig);
    await adminDatabase.query(`CREATE SCHEMA ${schema}`);
    const schemaUrl = new URL(integrationUrl);
    schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const configEnvironment = {
      ...process.env,
      DATABASE_URL: schemaUrl.toString(),
      DATABASE_SSL_MODE: 'disable',
      POSTGRES_APPLICATION_NAME: 'libre-plugin-runtime-test',
    };
    process.env.DATABASE_BACKEND = 'postgres';
    process.env.DATABASE_URL = schemaUrl.toString();
    process.env.DATABASE_SSL_MODE = 'disable';
    process.env.LIBRE_PLATFORM_MODE = 'solo';
    process.env.COORDINATION_BACKEND = 'local';
    const coordination =
      await import('../backend/dist/platform/coordination/service.js');
    try {
      const persistence = await persistenceKernel.initializePersistence({
        dialect: 'postgres',
        emailCodec: {
          encrypt: value => `enc:${value}`,
          decryptAuthenticated: value => value.slice(4),
          decryptBuffer: value => value,
          isEncrypted: value => value.startsWith('enc:'),
          lookupToken: value =>
            createHash('sha256').update(value).digest('hex'),
        },
        env: configEnvironment,
      });
      await persistence.repositories.identity.insert({
        id: 'default',
        username: 'admin',
        email: null,
        password_hash: 'hash',
        role: 'admin',
        account_status: 'active',
        approved_at: 1,
        approved_by: null,
        avatar: null,
        created_at: 1,
        updated_at: 1,
      });
      await coordination.initializeCoordinator();

      fs.writeFileSync(
        path.join(legacyPlugins, 'local-shadow.json'),
        '{"id":"local-shadow"}',
        { mode: 0o600 }
      );
      assert.throws(
        () =>
          new PluginService({
            legacyPluginsDirectories: [legacyPlugins],
          }),
        /local custom plugin definitions.*shared database/i
      );
      fs.unlinkSync(path.join(legacyPlugins, 'local-shadow.json'));

      const firstReplica = new PluginService({ legacyPluginsDirectories: [] });
      const secondReplica = new PluginService({
        legacyPluginsDirectories: [],
      });
      const definition = {
        id: 'shared-runtime-provider',
        name: 'Shared runtime provider',
        type: 'openai',
        endpoint: 'https://one.example.test/v1/chat/completions',
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: 'SHARED_PLUGIN_TEST_KEY',
        },
        model_map: ['shared-model'],
      };
      await firstReplica.installPlugin(definition, 'default');
      const visibleOnSecond = await secondReplica.getPlugin(
        definition.id,
        'default'
      );
      assert.equal(visibleOnSecond?.endpoint, definition.endpoint);
      assert.equal(
        await secondReplica.getApiKey(visibleOnSecond, 'default'),
        null,
        'shared custom definitions cannot consume a process environment credential'
      );
      assert.equal(
        await secondReplica.activatePlugin(definition.id, 'default'),
        true
      );
      assert.equal(
        (await firstReplica.getPlugin(definition.id, 'default'))?.active,
        true
      );
      await firstReplica.installPlugin(
        {
          ...definition,
          endpoint: 'https://two.example.test/v1/chat/completions',
        },
        'default'
      );
      const replaced = await secondReplica.getPlugin(definition.id, 'default');
      assert.equal(
        replaced?.endpoint,
        'https://two.example.test/v1/chat/completions'
      );
      assert.equal(replaced?.active, false);
      assert.equal(await secondReplica.deletePlugin(definition.id), true);
      assert.equal(
        await firstReplica.getPlugin(definition.id, 'default'),
        null
      );
    } finally {
      const { closePluginCacheInvalidation } =
        await import('../backend/dist/services/pluginCacheInvalidation.js');
      await closePluginCacheInvalidation();
      await coordination.closeCoordinator();
      await persistenceKernel.closePersistence();
      await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminDatabase.close();
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }
);
