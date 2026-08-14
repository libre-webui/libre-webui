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
import { PostgresDurableJobRepository } from '../backend/dist/platform/jobs/postgresDurableJobRepository.js';
import { PostgresDurableJobService } from '../backend/dist/platform/jobs/postgresDurableJobService.js';
import { durableEventId } from '../backend/dist/platform/jobs/durableEventIdentity.js';
import {
  OWNER_DELETE_CONTENT_JOB_TYPE,
  OWNER_DELETE_CONTENT_RECOVERY_IDEMPOTENCY_SCOPE,
  RESOURCE_DELETE_JOB_TYPE,
  RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
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
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  validatePostgresMigrationRegistry(POSTGRES_MIGRATIONS);
  assert.equal(Object.isFrozen(POSTGRES_MIGRATIONS), true);
  assert.equal(POSTGRES_MIGRATIONS.every(Object.isFrozen), true);
  assert.equal(SQLITE_MIGRATION_CONTRACT.at(-1)?.version, 12);
  assert.equal(POSTGRES_MIGRATIONS.at(-1)?.version, 10);
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

class FakeClient {
  queries = [];
  releasedWith = undefined;

  async query(text, parameters = []) {
    this.queries.push({ text, parameters });
    if (text === 'SELECT fail') throw new Error('sentinel failure');
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

  async query(text, parameters = []) {
    this.directQueries.push({ text, parameters });
    return { rows: [{ healthy: 1 }], rowCount: 1 };
  }

  async connect() {
    const client = new FakeClient();
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

  const health = await database.health();
  assert.equal(health.ready, true);
  assert.deepEqual(health.pool, { total: 1, idle: 1, waiting: 0 });
  await Promise.all([database.close(), database.close()]);
  assert.equal(pool.ended, true);
  assert.equal(pool.endCalls, 1);
  await assert.rejects(database.query('SELECT 1'), /pool is closed/);
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
      assert.equal(second.schemaCompatibility.currentVersion, 10);
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
    cleanupSource.close();

    const dryRun = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'dry-run',
    });
    assert.equal(dryRun.compatible, true);
    assert.equal(dryRun.targetEmpty, true);
    const applied = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'apply',
    });
    assert.equal(applied.compatible, true);
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

    await target.query(`UPDATE libre_sqlite_imports SET status = 'failed'`);
    await target.query(
      `UPDATE libre_schema_compatibility
          SET status = 'incompatible', failure_code = 'sqlite_import_incomplete'`
    );
    const codec = {
      encrypt: value => value,
      decryptAuthenticated: value => value,
      decryptBuffer: value => value,
      isEncrypted: () => true,
      lookupToken: value => createHash('sha256').update(value).digest('hex'),
    };
    await assert.rejects(
      initializePostgresPersistence(config, codec),
      /incomplete SQLite import/i
    );
    await assert.rejects(
      migrateSQLiteToPostgres({
        sourcePath,
        postgres: config,
        mode: 'apply',
      }),
      /resume enabled/i
    );
    const resumed = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'apply',
      resume: true,
    });
    assert.equal(resumed.resumed, true);
    assert.equal(
      resumed.tables.every(row => row.status === 'verified'),
      true
    );
    const validated = await migrateSQLiteToPostgres({
      sourcePath,
      postgres: config,
      mode: 'validate',
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
      }),
      /verification failed/i
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
