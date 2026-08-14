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

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(import.meta.dirname, '..');
process.env.ENCRYPTION_KEY = '11'.repeat(32);
process.env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID = 'test';
process.env.STORAGE_ENCRYPTION_KEYS = JSON.stringify({
  test: '41'.repeat(32),
});
const jobsDirectory = path.join(
  repoRoot,
  'backend',
  'dist',
  'platform',
  'jobs'
);
const importJobModule = name =>
  import(pathToFileURL(path.join(jobsDirectory, `${name}.js`)).href);
const [
  durableJobServiceModule,
  durableJobTypesModule,
  workerModule,
  sqliteRepositoryModule,
  postgresWorkerModule,
  domainContractsModule,
  durableEventIdentityModule,
] = await Promise.all([
  importJobModule('durableJobService'),
  importJobModule('durableJobTypes'),
  importJobModule('embeddedDurableJobWorker'),
  importJobModule('sqliteDurableJobRepository'),
  importJobModule('postgresDurableJobWorker'),
  importJobModule('domainJobContracts'),
  importJobModule('durableEventIdentity'),
]);
const storageModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'platform',
      'storage',
      'aesGcmKeyring.js'
    )
  ).href
);
const migrationModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'sqliteMigrations.js')
  ).href
);
const eventsModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'platform', 'events', 'index.js')
  ).href
);
const coordinationModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'platform',
      'coordination',
      'index.js'
    )
  ).href
);
const workEventModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workEventService.js')
  ).href
);
const chatCompletionModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'durableChatCompletion.js'
    )
  ).href
);

const {
  DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX,
  DOCUMENT_INGEST_JOB_TYPE,
  OWNER_DELETE_CONTENT_JOB_TYPE,
  RESOURCE_DELETE_JOB_TYPE,
  RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
  VIDEO_RESUME_JOB_TYPE,
  WORK_EXECUTE_JOB_TYPE,
} = domainContractsModule;
const { DurableJobService } = durableJobServiceModule;
const { DurableJobError, DurableJobExecutionError } = durableJobTypesModule;
const { EmbeddedDurableJobWorker } = workerModule;
const { SQLiteDurableJobRepository } = sqliteRepositoryModule;
const { PostgresDurableJobWorker, waitForPostgresWorkerPoll } =
  postgresWorkerModule;
const { durableEventId } = durableEventIdentityModule;
/*
 * Deliberately import the durable primitives from their leaf modules. The
 * production jobs barrel also exports registered domain handlers, whose
 * application service graph requires a completed bootstrap and must not run
 * while this isolated repository/worker contract fixture is being created.
 */
const { Aes256GcmKeyring } = storageModule;
const { DurableEventGateway } = eventsModule;
const { LocalCoordinator } = coordinationModule;
const { WorkEventService } = workEventModule;
const { assertDurableChatCompletionEvent } = chatCompletionModule;

function installMigrationFixture(database) {
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE _libre_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
  for (const migration of migrationModule.SQLITE_MIGRATION_CONTRACT) {
    database
      .prepare(
        `INSERT INTO _libre_schema_migrations
           (version, name, checksum, applied_at)
         VALUES (?, ?, ?, 1)`
      )
      .run(migration.version, migration.name, migration.checksum);
  }
  database.exec(migrationModule.PLATFORM_VECTOR_SCHEMA_SQL);
  database.exec(migrationModule.DURABLE_JOBS_EVENTS_SCHEMA_SQL);
  database.exec(migrationModule.DURABLE_EVENT_IDEMPOTENCY_SCHEMA_SQL);
  database.exec(migrationModule.RESOURCE_DELETION_LIFECYCLE_SCHEMA_SQL);
}

function harness(options = {}) {
  const database = options.database ?? new Database(':memory:');
  if (options.install !== false) installMigrationFixture(database);
  let now = options.now ?? 1_000_000;
  const clock = () => now;
  const repository = new SQLiteDurableJobRepository(database, clock);
  const service = new DurableJobService(
    repository,
    new Aes256GcmKeyring('test', { test: Buffer.alloc(32, 0x41) }),
    clock
  );
  return {
    database,
    repository,
    service,
    setNow(value) {
      now = value;
    },
    advance(milliseconds) {
      now += milliseconds;
    },
  };
}

function enqueue(service, overrides = {}) {
  return service.enqueue({
    jobType: 'test.echo',
    actorUserId: 'actor-1',
    payload: { mode: 'encrypted', value: { private: 'secret', number: 1 } },
    idempotencyScope: 'test-suite',
    idempotencyKey: `key-${Math.random()}`,
    ...overrides,
  });
}

test('two independent SQLite claimers cannot own one lease', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-jobs-claim-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'jobs.sqlite');
  const firstDatabase = new Database(databasePath);
  installMigrationFixture(firstDatabase);
  const secondDatabase = new Database(databasePath);
  secondDatabase.pragma('foreign_keys = ON');
  t.after(() => {
    firstDatabase.close();
    secondDatabase.close();
  });
  const now = () => 1000;
  const keyring = new Aes256GcmKeyring('test', {
    test: Buffer.alloc(32, 0x41),
  });
  const first = new DurableJobService(
    new SQLiteDurableJobRepository(firstDatabase, now),
    keyring,
    now
  );
  const second = new DurableJobService(
    new SQLiteDurableJobRepository(secondDatabase, now),
    keyring,
    now
  );
  enqueue(first, { idempotencyKey: 'one-lease' });

  const claims = [
    first.claim('worker-a', 5000),
    second.claim('worker-b', 5000),
  ];
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(
    firstDatabase
      .prepare(
        "SELECT COUNT(*) AS count FROM platform_jobs WHERE state = 'running'"
      )
      .get().count,
    1
  );
  assert.equal(
    firstDatabase
      .prepare(
        "SELECT COUNT(*) AS count FROM platform_job_attempts WHERE outcome = 'running'"
      )
      .get().count,
    1
  );
});

test('expired leases are reclaimed with monotonic fencing tokens', () => {
  const { database, service, repository, advance } = harness();
  const job = enqueue(service, {
    idempotencyKey: 'expiry',
    payload: { mode: 'reference', referenceId: 'blob:payload-1' },
  });
  const first = service.claim('worker-a', 1000);
  assert.ok(first);
  assert.deepEqual(service.readPayload(first), {
    referenceId: 'blob:payload-1',
  });
  advance(1001);
  const second = service.claim('worker-b', 1000);
  assert.ok(second);
  assert.equal(second.id, job.id);
  assert.equal(second.attemptCount, 2);
  assert.equal(second.leaseToken, first.leaseToken + 1);
  assert.equal(service.heartbeat(first, 1000).owned, false);
  assert.throws(
    () => service.complete(first),
    error => error instanceof DurableJobError && error.code === 'lease-lost'
  );
  service.complete(second, 'blob:result-1');
  assert.equal(service.getMetadata(job.id).state, 'succeeded');
  assert.deepEqual(
    repository.listAttempts(job.id).map(attempt => attempt.outcome),
    ['abandoned', 'succeeded']
  );
  database.close();
});

test('heartbeat fencing rejects an expired token before reclaim', () => {
  const { database, service, advance } = harness();
  enqueue(service, { idempotencyKey: 'heartbeat-expired' });
  const lease = service.claim('worker-a', 1000);
  assert.ok(lease);
  advance(1000);
  assert.deepEqual(service.heartbeat(lease, 1000), {
    owned: false,
    cancellationRequested: false,
  });
  database.close();
});

test('idempotency returns one job and rejects semantic reuse', () => {
  const { database, service } = harness();
  const input = {
    jobType: 'test.echo',
    actorUserId: 'actor-1',
    payload: { mode: 'encrypted', value: { b: 2, a: 1 } },
    idempotencyScope: 'session-1',
    idempotencyKey: 'request-1',
  };
  const first = service.enqueue(input);
  const second = service.enqueue({
    ...input,
    payload: { mode: 'encrypted', value: { a: 1, b: 2 } },
  });
  assert.equal(second.id, first.id);
  assert.throws(
    () =>
      service.enqueue({
        ...input,
        payload: { mode: 'encrypted', value: { a: 2 } },
      }),
    error => error instanceof DurableJobError && error.code === 'conflict'
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM platform_jobs').get().count,
    1
  );
  database.close();
});

test('bounded retries stop at the dead-letter ceiling', () => {
  const { database, service, advance, repository } = harness();
  const job = enqueue(service, { idempotencyKey: 'retry', maxAttempts: 2 });
  const first = service.claim('worker-a', 1000);
  assert.ok(first);
  assert.equal(
    service.fail(first, {
      retryable: true,
      errorCode: 'provider-timeout',
      errorSummary: 'The provider timed out',
      backoffMs: 100,
    }),
    'queued'
  );
  assert.equal(service.claim('worker-a', 1000), null);
  advance(100);
  const second = service.claim('worker-b', 1000);
  assert.ok(second);
  assert.equal(
    service.fail(second, {
      retryable: true,
      errorCode: 'provider-timeout',
      errorSummary: 'The provider timed out',
      backoffMs: 100,
    }),
    'dead_letter'
  );
  assert.equal(service.getMetadata(job.id).state, 'dead_letter');
  assert.deepEqual(
    repository.listAttempts(job.id).map(attempt => attempt.outcome),
    ['retry_scheduled', 'dead_letter']
  );
  database.close();
});

test('worker startup reconciles an exhausted deletion without an unbounded retry loop', async () => {
  const { database, service, advance } = harness();
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      account_status TEXT NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE generated_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    INSERT INTO users (id, account_status) VALUES ('actor-1', 'active');
  `);
  const deletionToken = 'a'.repeat(64);
  database
    .prepare(
      `INSERT INTO platform_resource_deletion_tombstones
         (resource_type, resource_id, owner_user_id, deletion_incarnation,
          deletion_token, deleted_at, completed_at)
       VALUES ('document', 'document-1', 'actor-1', 1, ?, 1, NULL)`
    )
    .run(deletionToken);
  const input = {
    jobType: RESOURCE_DELETE_JOB_TYPE,
    actorUserId: 'actor-1',
    idempotencyScope: RESOURCE_DELETE_JOB_TYPE,
    idempotencyKey: deletionToken,
    payload: {
      mode: 'encrypted',
      value: {
        resourceType: 'document',
        resourceId: 'document-1',
        deletionIncarnation: 1,
        deletionToken,
      },
    },
    maxAttempts: 5,
  };
  const exhausted = service.enqueue(input);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lease = service.claim(`failed-worker-${attempt}`, 1000);
    assert.ok(lease);
    service.fail(lease, {
      retryable: true,
      errorCode: 'resource-cleanup-failed',
      errorSummary: 'Object storage is unavailable',
      backoffMs: 0,
    });
    advance(1);
  }
  assert.equal(service.getMetadata(exhausted.id).state, 'dead_letter');
  assert.equal(service.enqueue(input).id, exhausted.id);

  // The successor has an explicit one-minute availability boundary. Advance
  // the deterministic repository clock before worker startup so the focused
  // test does not wait in wall-clock time.
  advance(60_000);
  let cleanupCalls = 0;
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'lifecycle-recovery-worker',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        RESOURCE_DELETE_JOB_TYPE,
        async () => {
          cleanupCalls += 1;
          database
            .prepare(
              `UPDATE platform_resource_deletion_tombstones
                  SET completed_at = 2
                WHERE resource_type = 'document' AND resource_id = 'document-1'`
            )
            .run();
        },
      ],
    ]),
  });
  worker.start();
  const deadline = Date.now() + 3000;
  let recovery;
  while (Date.now() < deadline) {
    recovery = service.getByIdempotency(
      'actor-1',
      RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
      exhausted.id
    );
    if (recovery?.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recovery?.state, 'succeeded');
  assert.equal(cleanupCalls, 1);
  assert.equal((await worker.stop()).failed, 0);
  assert.equal(
    service.getMetadata(exhausted.id).resultReference,
    `${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}${recovery.id}`
  );
  assert.equal(
    service.countNonSucceededForActor('actor-1', {
      jobTypes: [RESOURCE_DELETE_JOB_TYPE],
    }),
    1
  );
  assert.equal(
    service.countNonSucceededForActor('actor-1', {
      jobTypes: [RESOURCE_DELETE_JOB_TYPE],
      excludeHandledLifecycleJobs: true,
    }),
    0,
    'a successful successor resolves its marked terminal predecessor'
  );
  assert.deepEqual(service.reconcileDeletionLifecycleJobs(), {
    examined: 0,
    recoveryJobs: 0,
    skipped: 0,
  });
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_jobs
          WHERE idempotency_scope = ?`
      )
      .get(RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE).count,
    1,
    'a completed tombstone cannot grow another recovery chain'
  );
  database.close();
});

test('running worker reconciles a newly exhausted deletion without restart', async () => {
  const { database, service, advance } = harness();
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      account_status TEXT NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE generated_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    INSERT INTO users (id, account_status) VALUES ('actor-1', 'active');
  `);
  const deletionToken = 'b'.repeat(64);
  database
    .prepare(
      `INSERT INTO platform_resource_deletion_tombstones
         (resource_type, resource_id, owner_user_id, deletion_incarnation,
          deletion_token, deleted_at, completed_at)
       VALUES ('document', 'document-live-recovery', 'actor-1', 1, ?, 1, NULL)`
    )
    .run(deletionToken);
  const exhausted = service.enqueue({
    jobType: RESOURCE_DELETE_JOB_TYPE,
    actorUserId: 'actor-1',
    idempotencyScope: RESOURCE_DELETE_JOB_TYPE,
    idempotencyKey: deletionToken,
    payload: {
      mode: 'encrypted',
      value: {
        resourceType: 'document',
        resourceId: 'document-live-recovery',
        deletionIncarnation: 1,
        deletionToken,
      },
    },
    maxAttempts: 1,
  });
  let handlerCalls = 0;
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'live-lifecycle-recovery-worker',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        RESOURCE_DELETE_JOB_TYPE,
        async () => {
          handlerCalls += 1;
          if (handlerCalls === 1) {
            throw new DurableJobExecutionError(
              true,
              'resource-cleanup-failed',
              'Object storage is unavailable'
            );
          }
          database
            .prepare(
              `UPDATE platform_resource_deletion_tombstones
                  SET completed_at = 2
                WHERE resource_type = 'document'
                  AND resource_id = 'document-live-recovery'`
            )
            .run();
        },
      ],
    ]),
  });
  worker.start();

  const terminalDeadline = Date.now() + 3000;
  let recovery;
  while (Date.now() < terminalDeadline) {
    recovery = service.getByIdempotency(
      'actor-1',
      RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
      exhausted.id
    );
    if (recovery?.state === 'queued') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(service.getMetadata(exhausted.id).state, 'dead_letter');
  assert.equal(recovery?.state, 'queued');
  assert.equal(worker.isOperational(), true);

  advance(60_000);
  const recoveryDeadline = Date.now() + 3000;
  while (Date.now() < recoveryDeadline) {
    recovery = service.getMetadata(recovery.id);
    if (recovery?.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recovery?.state, 'succeeded');
  assert.equal(handlerCalls, 2);
  assert.equal(worker.isOperational(), true);
  assert.equal((await worker.stop()).failed, 0);
  assert.deepEqual(service.reconcileDeletionLifecycleJobs(), {
    examined: 0,
    recoveryJobs: 0,
    skipped: 0,
  });
  database.close();
});

test('running worker reconciles a cleanup terminalized by process-loss lease expiry', async () => {
  const { database, service, advance } = harness();
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      account_status TEXT NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE generated_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    INSERT INTO users (id, account_status) VALUES ('actor-1', 'active');
  `);
  const deletionToken = 'c'.repeat(64);
  database
    .prepare(
      `INSERT INTO platform_resource_deletion_tombstones
         (resource_type, resource_id, owner_user_id, deletion_incarnation,
          deletion_token, deleted_at, completed_at)
       VALUES ('document', 'document-expired-recovery', 'actor-1', 1, ?, 1, NULL)`
    )
    .run(deletionToken);
  const exhausted = service.enqueue({
    jobType: RESOURCE_DELETE_JOB_TYPE,
    actorUserId: 'actor-1',
    idempotencyScope: RESOURCE_DELETE_JOB_TYPE,
    idempotencyKey: deletionToken,
    payload: {
      mode: 'encrypted',
      value: {
        resourceType: 'document',
        resourceId: 'document-expired-recovery',
        deletionIncarnation: 1,
        deletionToken,
      },
    },
    maxAttempts: 1,
  });
  assert.equal(service.claim('crashed-cleanup-worker', 1000)?.id, exhausted.id);

  let cleanupCalls = 0;
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'lease-expiry-recovery-worker',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        RESOURCE_DELETE_JOB_TYPE,
        async () => {
          cleanupCalls += 1;
          database
            .prepare(
              `UPDATE platform_resource_deletion_tombstones
                  SET completed_at = 3
                WHERE resource_type = 'document'
                  AND resource_id = 'document-expired-recovery'`
            )
            .run();
        },
      ],
    ]),
  });
  worker.start();
  advance(1001);

  const terminalDeadline = Date.now() + 3000;
  let recovery;
  while (Date.now() < terminalDeadline) {
    recovery = service.getByIdempotency(
      'actor-1',
      RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
      exhausted.id
    );
    if (recovery?.state === 'queued') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(service.getMetadata(exhausted.id).state, 'dead_letter');
  assert.equal(service.getMetadata(exhausted.id).errorCode, 'lease-expired');
  assert.equal(recovery?.state, 'queued');

  advance(60_000);
  const recoveryDeadline = Date.now() + 3000;
  while (Date.now() < recoveryDeadline) {
    recovery = service.getMetadata(recovery.id);
    if (recovery?.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recovery?.state, 'succeeded');
  assert.equal(cleanupCalls, 1);
  assert.equal(worker.isOperational(), true);
  assert.equal((await worker.stop()).failed, 0);
  database.close();
});

test('queued lifecycle cancellation schedules cleanup without a worker restart', async () => {
  const { database, service, advance } = harness();
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      account_status TEXT NOT NULL
    );
    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE generated_images (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE TABLE personas (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    INSERT INTO users (id, account_status) VALUES ('actor-1', 'active');
  `);
  const deletionToken = 'd'.repeat(64);
  database
    .prepare(
      `INSERT INTO platform_resource_deletion_tombstones
         (resource_type, resource_id, owner_user_id, deletion_incarnation,
          deletion_token, deleted_at, completed_at)
       VALUES ('document', 'document-cancel-recovery', 'actor-1', 1, ?, 1, NULL)`
    )
    .run(deletionToken);

  let cleanupCalls = 0;
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'cancelled-lifecycle-recovery-worker',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        RESOURCE_DELETE_JOB_TYPE,
        async () => {
          cleanupCalls += 1;
          database
            .prepare(
              `UPDATE platform_resource_deletion_tombstones
                  SET completed_at = 4
                WHERE resource_type = 'document'
                  AND resource_id = 'document-cancel-recovery'`
            )
            .run();
        },
      ],
    ]),
  });
  worker.start();
  const cancelled = service.enqueue({
    jobType: RESOURCE_DELETE_JOB_TYPE,
    actorUserId: 'actor-1',
    idempotencyScope: RESOURCE_DELETE_JOB_TYPE,
    idempotencyKey: deletionToken,
    payload: {
      mode: 'encrypted',
      value: {
        resourceType: 'document',
        resourceId: 'document-cancel-recovery',
        deletionIncarnation: 1,
        deletionToken,
      },
    },
    maxAttempts: 5,
  });
  assert.equal(
    service.cancel(cancelled.id, 'actor-1', 'user-requested').state,
    'cancelled'
  );
  const recovery = service.getByIdempotency(
    'actor-1',
    RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
    cancelled.id
  );
  assert.equal(recovery?.state, 'queued');
  assert.equal(
    service.getMetadata(cancelled.id).resultReference,
    `${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}${recovery.id}`
  );

  advance(60_000);
  const deadline = Date.now() + 3000;
  let recovered = recovery;
  while (Date.now() < deadline) {
    recovered = service.getMetadata(recovery.id);
    if (recovered?.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(recovered?.state, 'succeeded');
  assert.equal(cleanupCalls, 1);
  assert.equal(worker.isOperational(), true);
  assert.equal((await worker.stop()).failed, 0);
  database.close();
});

test('queued and running cancellation are durable and cooperative', () => {
  const { database, service } = harness();
  const queued = enqueue(service, { idempotencyKey: 'cancel-queued' });
  assert.throws(
    () => service.cancel(queued.id, 'actor-1', 'private user explanation'),
    /cancellation code/
  );
  assert.equal(
    service.cancel(queued.id, 'actor-1', 'user-requested').state,
    'cancelled'
  );
  assert.equal(service.claim('worker-a', 1000), null);

  const running = enqueue(service, { idempotencyKey: 'cancel-running' });
  const lease = service.claim('worker-a', 1000);
  assert.ok(lease);
  service.reportProgress(lease, {
    current: 25,
    total: 100,
    message: 'Preparing output',
  });
  assert.equal(service.getMetadata(running.id).progressCurrent, 25);
  assert.equal(service.cancel(running.id, 'actor-1').state, 'running');
  assert.deepEqual(service.heartbeat(lease, 1000), {
    owned: true,
    cancellationRequested: true,
  });
  service.complete(lease, 'must-not-survive');
  assert.equal(service.getMetadata(running.id).state, 'cancelled');
  assert.equal(service.getMetadata(running.id).resultReference, null);
  database.close();
});

test('actor-wide cancellation drains every job without list pagination', () => {
  const { database, service } = harness();
  const running = enqueue(service, {
    idempotencyKey: 'actor-drain-running',
    priority: 100,
  });
  const lease = service.claim('worker-a', 1000);
  assert.ok(lease);
  assert.equal(lease.id, running.id);
  for (let index = 0; index < 225; index += 1) {
    enqueue(service, { idempotencyKey: `actor-drain-${index}` });
  }
  const otherActor = enqueue(service, {
    actorUserId: 'actor-2',
    idempotencyKey: 'other-actor-survives',
  });

  assert.deepEqual(service.cancelAllForActor('actor-1', 'actor-revoked'), {
    cancelledQueued: 225,
    cancellationRequestedRunning: 1,
  });
  assert.equal(service.countActiveForActor('actor-1'), 1);
  assert.equal(service.getMetadata(otherActor.id).state, 'queued');
  service.complete(lease, 'must-not-survive');
  assert.equal(service.getMetadata(running.id).state, 'cancelled');
  assert.equal(service.countActiveForActor('actor-1'), 0);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM platform_jobs WHERE actor_user_id = 'actor-1' AND state = 'cancelled'"
      )
      .get().count,
    226
  );
  database.close();
});

test('actor retirement excludes and accounts for initiated owner cleanups beyond pagination', () => {
  const { database, service } = harness();
  for (let index = 0; index < 225; index += 1) {
    enqueue(service, { idempotencyKey: `retiring-ordinary-${index}` });
  }
  for (let index = 0; index < 3; index += 1) {
    enqueue(service, {
      jobType: OWNER_DELETE_CONTENT_JOB_TYPE,
      idempotencyScope: OWNER_DELETE_CONTENT_JOB_TYPE,
      idempotencyKey: `deleted-owner-${index}`,
      priority: 100,
    });
  }

  assert.deepEqual(
    service.cancelAllForActor('actor-1', 'actor-revoked', {
      excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
    }),
    { cancelledQueued: 225, cancellationRequestedRunning: 0 }
  );
  assert.equal(
    service.countActiveForActor('actor-1', {
      excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
    }),
    0
  );
  assert.equal(
    service.countActiveForActor('actor-1', {
      jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
    }),
    3
  );
  assert.equal(
    service.countNonSucceededForActor('actor-1', {
      jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
    }),
    3
  );
  for (let index = 0; index < 3; index += 1) {
    const lease = service.claim('owner-cleanup-worker', 1000);
    assert.equal(lease?.jobType, OWNER_DELETE_CONTENT_JOB_TYPE);
    service.complete(lease, `owner:${index}:deleted`);
  }
  assert.equal(
    service.countNonSucceededForActor('actor-1', {
      jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
    }),
    0
  );
  database.close();
});

test('ordered event replay uses global cursors and per-stream sequences', () => {
  const { database, service } = harness();
  const cursors = [
    service.appendEvent({
      eventId: durableEventId('test', 'session:1', 'created'),
      streamId: 'session:1',
      eventType: 'turn.created',
      subjectId: 'turn-1',
      actorUserId: 'actor-1',
      payload: { mode: 'encrypted', value: { order: 1 } },
    }),
    service.appendEvent({
      eventId: durableEventId('test', 'session:2', 'created'),
      streamId: 'session:2',
      eventType: 'turn.created',
      subjectId: 'turn-2',
      payload: { mode: 'reference', referenceId: 'blob:event-2' },
    }),
    service.appendEvent({
      eventId: durableEventId('test', 'session:1', 'completed'),
      streamId: 'session:1',
      eventType: 'turn.completed',
      subjectId: 'turn-1',
      actorUserId: 'actor-1',
      payload: { mode: 'encrypted', value: { order: 3 } },
    }),
  ];
  assert.ok(cursors[0] < cursors[1] && cursors[1] < cursors[2]);
  assert.deepEqual(
    service
      .replayEvents(0)
      .map(event => [
        event.cursor,
        event.streamId,
        event.streamSequence,
        event.payload,
      ]),
    [
      [cursors[0], 'session:1', 1, { order: 1 }],
      [cursors[1], 'session:2', 1, { referenceId: 'blob:event-2' }],
      [cursors[2], 'session:1', 2, { order: 3 }],
    ]
  );
  assert.deepEqual(
    service
      .replayEvents(cursors[0], { streamId: 'session:1' })
      .map(event => event.streamSequence),
    [2]
  );
  database.close();
});

test('deterministic event identity returns one cursor and rejects semantic reuse', () => {
  const { database, service } = harness();
  const eventId = durableEventId('event-idempotency', 'logical-occurrence');
  const input = {
    eventId,
    streamId: 'idempotent:stream',
    eventType: 'work.tool_result.v1',
    subjectId: 'run-1',
    actorUserId: 'actor-1',
    payload: { mode: 'encrypted', value: { messageId: 'message-1' } },
  };
  const first = service.appendEvent(input);
  const second = service.appendEvent(input);
  assert.equal(second, first);
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM platform_events WHERE event_id = ?'
      )
      .get(eventId).count,
    1
  );
  assert.equal(
    database
      .prepare(
        'SELECT last_sequence FROM platform_event_stream_heads WHERE stream_id = ?'
      )
      .get(input.streamId).last_sequence,
    1,
    'an idempotent retry must not consume a stream sequence'
  );
  assert.throws(
    () =>
      service.appendEvent({
        ...input,
        payload: { mode: 'encrypted', value: { messageId: 'different' } },
      }),
    error => error instanceof DurableJobError && error.code === 'conflict'
  );
  database.close();
});

test('exact terminal-event recovery is independent of a long stream history', () => {
  const { database, service } = harness();
  const sessionId = 'long-chat-session';
  const streamId = `chat:${sessionId}`;
  for (let index = 0; index < 10_001; index += 1) {
    service.appendEvent({
      eventId: durableEventId('long-chat-noise', String(index)),
      streamId,
      eventType: 'chat.stream.v1',
      subjectId: `prior-assistant-${index}`,
      actorUserId: 'actor-1',
      payload: {
        mode: 'reference',
        referenceId: `chat-stream:${index}`,
      },
    });
  }

  const assistantMessageId = 'recovered-assistant';
  const completionId = durableEventId(
    'chat',
    sessionId,
    assistantMessageId,
    'done'
  );
  const completionCursor = service.appendEvent({
    eventId: completionId,
    streamId,
    eventType: 'chat.done.v1',
    subjectId: assistantMessageId,
    actorUserId: 'actor-1',
    payload: {
      mode: 'encrypted',
      value: {
        type: 'done',
        messageId: assistantMessageId,
        content: 'completed response',
      },
    },
  });

  assert.ok(
    completionCursor > 10_000,
    'the terminal event must sit beyond the former bounded forward scan'
  );
  assert.deepEqual(service.getEvent(completionId), {
    cursor: completionCursor,
    eventId: completionId,
    streamId,
    streamSequence: 10_002,
    eventType: 'chat.done.v1',
    subjectId: assistantMessageId,
    actorUserId: 'actor-1',
    payload: {
      type: 'done',
      messageId: assistantMessageId,
      content: 'completed response',
    },
    occurredAt: 1_000_000,
  });
  assert.doesNotThrow(() =>
    assertDurableChatCompletionEvent(service.getEvent(completionId), {
      eventId: completionId,
      sessionId,
      assistantMessageId,
      actorUserId: 'actor-1',
    })
  );

  database
    .prepare(
      `UPDATE platform_events
          SET payload_format = 'reference', payload = 'forged-completion'
        WHERE event_id = ?`
    )
    .run(completionId);
  const unauthenticated = service.getEvent(completionId);
  assert.deepEqual(unauthenticated?.payload, {
    referenceId: 'forged-completion',
  });
  assert.throws(
    () =>
      assertDurableChatCompletionEvent(unauthenticated, {
        eventId: completionId,
        sessionId,
        assistantMessageId,
        actorUserId: 'actor-1',
      }),
    /completion event payload is inconsistent/
  );
  assert.equal(service.getEvent(durableEventId('missing', 'event')), null);
  database.close();
});

test('Work event retry after a lost COMMIT acknowledgement reuses its cursor with an advanced clock', async () => {
  const { database, service } = harness();
  let appendCalls = 0;
  const gateway = {
    async append(input) {
      appendCalls += 1;
      const cursor = service.appendEvent(input);
      if (appendCalls === 1) {
        throw new Error('connection lost after event COMMIT');
      }
      return { cursor, fanoutNotified: true };
    },
  };
  const workEvents = new WorkEventService();
  workEvents.initializeDurableGateway(gateway);
  const data = {
    toolCallId: 'tool-1',
    name: 'write_file',
    phase: 'completed',
    content: 'written',
    error: false,
  };
  await assert.rejects(
    workEvents.publish(
      'task-1',
      'run-1',
      'tool_result',
      data,
      'message:message-1'
    ),
    /lost after event COMMIT/
  );
  await new Promise(resolve => setTimeout(resolve, 5));
  const event = await workEvents.publish(
    'task-1',
    'run-1',
    'tool_result',
    data,
    'message:message-1'
  );
  assert.equal(appendCalls, 2);
  assert.equal(event.id, 1);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM platform_events WHERE event_type = 'work.tool_result.v1'"
      )
      .get().count,
    1
  );
  assert.equal(workEvents.replay('task-1', 'run-1').events.length, 1);
  database.close();
});

test('admin metadata and persisted failures redact payloads and exception text', async () => {
  const { database, service } = harness();
  const secret = 'super-secret-provider-token';
  const job = enqueue(service, {
    idempotencyKey: 'redaction',
    payload: { mode: 'encrypted', value: { secret } },
  });
  const lease = service.claim('worker-a', 1000);
  assert.ok(lease);
  assert.doesNotMatch(
    JSON.stringify(service.getMetadata(job.id)),
    /secret|payload/i
  );
  assert.doesNotMatch(
    database
      .prepare('SELECT payload FROM platform_jobs WHERE id = ?')
      .get(job.id).payload,
    new RegExp(secret)
  );
  service.fail(lease, {
    retryable: false,
    errorCode: 'provider-failed',
    errorSummary: 'The provider rejected the request',
    backoffMs: 0,
  });
  assert.doesNotMatch(
    JSON.stringify(service.getMetadata(job.id)),
    new RegExp(secret)
  );
  assert.throws(
    () =>
      enqueue(service, {
        idempotencyKey: 'oversize',
        payload: { mode: 'encrypted', value: 'x'.repeat(70 * 1024) },
      }),
    /exceeds 64 KiB/
  );
  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () =>
      enqueue(service, {
        idempotencyKey: 'sparse-array',
        payload: { mode: 'encrypted', value: sparse },
      }),
    /only JSON values/
  );
  database.close();
});

test('embedded worker revalidates a revoked actor before side effects', async () => {
  const { database, service } = harness({ now: Date.now() });
  let authorized = true;
  let sideEffects = 0;
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'embedded-test',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    isActorAuthorized: async () => authorized,
    handlers: new Map([
      [
        'test.echo',
        async context => {
          authorized = false;
          await context.assertSideEffectAllowed();
          sideEffects += 1;
        },
      ],
    ]),
  });
  const job = enqueue(service, { idempotencyKey: 'actor-revoked' });
  worker.start();
  const deadline = Date.now() + 3000;
  while (
    service.getMetadata(job.id).state !== 'dead_letter' &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const stop = await worker.stop();
  assert.equal(stop.failed, 0);
  assert.equal(sideEffects, 0);
  assert.equal(service.getMetadata(job.id).state, 'dead_letter');
  assert.equal(service.getMetadata(job.id).errorCode, 'actor-revoked');
  database.close();
});

test('worker persists only handler-declared safe errors', async () => {
  const { database, service } = harness({ now: Date.now() });
  const secret = 'credential-from-stack';
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'embedded-safe-errors',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        'test.echo',
        async () => {
          throw new Error(secret);
        },
      ],
    ]),
  });
  const job = enqueue(service, {
    idempotencyKey: 'safe-error',
    maxAttempts: 1,
  });
  worker.start();
  const deadline = Date.now() + 3000;
  while (
    service.getMetadata(job.id).state !== 'dead_letter' &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await worker.stop();
  const metadata = service.getMetadata(job.id);
  assert.equal(metadata.errorCode, 'handler-failed');
  assert.equal(metadata.errorSummary, 'The durable job handler failed');
  assert.doesNotMatch(JSON.stringify(metadata), new RegExp(secret));
  database.close();
});

test('worker shutdown is bounded and fences an uncooperative handler', async () => {
  const { database, service } = harness({ now: Date.now() });
  let started;
  const didStart = new Promise(resolve => {
    started = resolve;
  });
  let release;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'embedded-bounded-stop',
    leaseMs: 1000,
    shutdownTimeoutMs: 100,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        'test.echo',
        async () => {
          started();
          await blocked;
        },
      ],
    ]),
  });
  const job = enqueue(service, {
    idempotencyKey: 'bounded-stop',
    maxAttempts: 2,
  });
  worker.start();
  await didStart;
  const before = Date.now();
  const result = await worker.stop();
  assert.ok(Date.now() - before < 750);
  assert.equal(result.activeAtStop, 1);
  assert.equal(result.abandoned, 1);
  assert.equal(service.getMetadata(job.id).state, 'queued');
  const reclaimed = service.claim('replacement-worker', 1000);
  assert.ok(reclaimed);
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.getMetadata(job.id).state, 'running');
  service.complete(reclaimed);
  database.close();
});

test('extraction, media, and Work jobs reclaim after a worker kill without duplicate effects', async () => {
  const { database, service } = harness({ now: Date.now() });
  const jobTypes = [
    DOCUMENT_INGEST_JOB_TYPE,
    VIDEO_RESUME_JOB_TYPE,
    WORK_EXECUTE_JOB_TYPE,
  ];
  const jobs = jobTypes.map(jobType =>
    enqueue(service, {
      jobType,
      idempotencyScope: jobType,
      idempotencyKey: `kill-${jobType}`,
      payload: { mode: 'encrypted', value: { resourceId: jobType } },
      maxAttempts: 3,
    })
  );
  let releaseKilled;
  const killedGate = new Promise(resolve => {
    releaseKilled = resolve;
  });
  let killedStarted;
  const didStartKilled = new Promise(resolve => {
    killedStarted = resolve;
  });
  const killed = new EmbeddedDurableJobWorker({
    service,
    workerId: 'representative-killed-worker',
    leaseMs: 1000,
    shutdownTimeoutMs: 100,
    pollIntervalMs: 10,
    random: () => 0,
    isActorAuthorized: async () => true,
    handlers: new Map(
      jobTypes.map(jobType => [
        jobType,
        async context => {
          killedStarted();
          await killedGate;
          await context.assertSideEffectAllowed();
          throw new Error('a fenced worker must never reach this point');
        },
      ])
    ),
  });
  killed.start();
  await didStartKilled;
  const stopped = await killed.stop();
  assert.equal(stopped.abandoned, 1);
  releaseKilled();

  const effects = new Map(jobTypes.map(jobType => [jobType, 0]));
  const replacement = new EmbeddedDurableJobWorker({
    service,
    workerId: 'representative-replacement-worker',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => 0,
    isActorAuthorized: async () => true,
    handlers: new Map(
      jobTypes.map(jobType => [
        jobType,
        async context => {
          await context.assertSideEffectAllowed();
          effects.set(jobType, effects.get(jobType) + 1);
          return { resultReference: `completed:${jobType}` };
        },
      ])
    ),
  });
  replacement.start();
  const deadline = Date.now() + 5_000;
  while (
    jobs.some(job => service.getMetadata(job.id).state !== 'succeeded') &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const replacementStop = await replacement.stop();
  assert.equal(replacementStop.failed, 0);
  for (const job of jobs) {
    assert.equal(service.getMetadata(job.id).state, 'succeeded');
  }
  assert.deepEqual([...effects.values()], [1, 1, 1]);
  database.close();
});

test('idle worker polling removes settled AbortSignal listeners', async () => {
  const { database, service } = harness({ now: Date.now() });
  let polls = 0;
  service.claim = () => {
    polls += 1;
    return null;
  };
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'embedded-idle-listeners',
    leaseMs: 1000,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
    handlers: new Map(),
  });
  worker.start();
  const deadline = Date.now() + 3000;
  while (polls < 50 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(polls >= 50);
  assert.ok(
    getEventListeners(worker.shutdown.signal, 'abort').length <= 1,
    'only the current idle delay may retain an abort listener'
  );
  await worker.stop();
  assert.equal(getEventListeners(worker.shutdown.signal, 'abort').length, 0);
  database.close();
});

test('worker configuration validates lease, backoff, and random bounds', () => {
  const { database, service } = harness();
  const base = {
    service,
    handlers: new Map(),
    isActorAuthorized: async () => true,
  };
  for (const leaseMs of [999, 900_001, 1000.5, Number.NaN]) {
    assert.throws(
      () => new EmbeddedDurableJobWorker({ ...base, leaseMs }),
      /worker lease/
    );
  }
  for (const maxRetryBackoffMs of [999, 900_001, 1000.5, Number.NaN]) {
    assert.throws(
      () => new EmbeddedDurableJobWorker({ ...base, maxRetryBackoffMs }),
      /retry backoff/
    );
  }
  for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => new EmbeddedDurableJobWorker({ ...base, random: () => value }),
      /random source/
    );
  }
  assert.doesNotThrow(
    () =>
      new EmbeddedDurableJobWorker({
        ...base,
        leaseMs: 1000,
        maxRetryBackoffMs: 1000,
        random: () => 0,
      })
  );
  assert.doesNotThrow(
    () =>
      new EmbeddedDurableJobWorker({
        ...base,
        leaseMs: 900_000,
        maxRetryBackoffMs: 900_000,
        random: () => 1,
      })
  );
  database.close();
});

test('a random source that later becomes invalid is contained and redacted', async () => {
  const { database, service } = harness({ now: Date.now() });
  let randomCalls = 0;
  const worker = new EmbeddedDurableJobWorker({
    service,
    workerId: 'embedded-invalid-late-random',
    leaseMs: 1000,
    pollIntervalMs: 10,
    random: () => (randomCalls++ === 0 ? 0.5 : Number.NaN),
    isActorAuthorized: async () => true,
    handlers: new Map([
      [
        'test.echo',
        async () => {
          throw new Error('private handler failure');
        },
      ],
    ]),
  });
  const jobs = [
    enqueue(service, { idempotencyKey: 'invalid-late-random-1' }),
    enqueue(service, { idempotencyKey: 'invalid-late-random-2' }),
  ];
  worker.start();
  const deadline = Date.now() + 3000;
  while (
    !jobs.some(
      job =>
        service.getMetadata(job.id).errorCode === 'worker-configuration-invalid'
    ) &&
    Date.now() < deadline
  ) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await worker.stop();
  const configurationFailure = jobs
    .map(job => service.getMetadata(job.id))
    .find(job => job.errorCode === 'worker-configuration-invalid');
  assert.ok(configurationFailure);
  assert.equal(configurationFailure.state, 'dead_letter');
  assert.equal(
    configurationFailure.errorSummary,
    'The durable job worker configuration is invalid'
  );
  assert.doesNotMatch(JSON.stringify(configurationFailure), /private handler/);
  database.close();
});

test('only DurableJobExecutionError can persist a bounded operator summary', () => {
  const error = new DurableJobExecutionError(
    false,
    'provider-rejected',
    'The provider rejected the request'
  );
  assert.equal(error.retryable, false);
  assert.equal(error.safeCode, 'provider-rejected');
});

test('PostgreSQL worker polling removes every abort listener after timeout and abort', async () => {
  const timeoutController = new AbortController();
  for (let index = 0; index < 250; index += 1) {
    await waitForPostgresWorkerPoll(0, timeoutController.signal);
  }
  assert.equal(getEventListeners(timeoutController.signal, 'abort').length, 0);

  const abortController = new AbortController();
  const pending = waitForPostgresWorkerPoll(60_000, abortController.signal);
  assert.equal(getEventListeners(abortController.signal, 'abort').length, 1);
  abortController.abort();
  await pending;
  assert.equal(getEventListeners(abortController.signal, 'abort').length, 0);
});

test('PostgreSQL worker marks claim failures unhealthy and resumes polling', async () => {
  let claimCalls = 0;
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => {
    releaseRecovery = resolve;
  });
  let observedFailure;
  const failureObserved = new Promise(resolve => {
    observedFailure = resolve;
  });
  const service = {
    async claim() {
      claimCalls += 1;
      if (claimCalls === 1) return null;
      if (claimCalls === 2) {
        observedFailure();
        throw new Error('transient database failure');
      }
      if (claimCalls === 3) await recoveryGate;
      return null;
    },
  };
  const worker = new PostgresDurableJobWorker({
    service,
    handlers: new Map(),
    workerId: 'postgres-claim-recovery',
    leaseMs: 1000,
    shutdownTimeoutMs: 100,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
  });
  worker.start();
  const healthyDeadline = Date.now() + 1000;
  while (!worker.isOperational() && Date.now() < healthyDeadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(worker.isOperational(), true);
  await failureObserved;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    worker.isOperational(),
    false,
    'readiness must drop while PostgreSQL polling is unavailable'
  );
  releaseRecovery();
  const recoveredDeadline = Date.now() + 1000;
  while (!worker.isOperational() && Date.now() < recoveredDeadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(worker.isOperational(), true);
  assert.ok(claimCalls >= 3);
  assert.equal((await worker.stop()).failed, 0);
});

test('PostgreSQL worker survives a committed failure transition with lost acknowledgement', async () => {
  const lease = {
    id: 'job-ack-loss',
    jobType: 'test.echo',
    actorUserId: 'actor-1',
    state: 'running',
    priority: 0,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: 0,
    cancellationRequestedAt: null,
    progressCurrent: 0,
    progressTotal: 0,
    progressMessage: null,
    resultReference: null,
    errorCode: null,
    errorSummary: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: null,
    workerId: 'postgres-fail-ack-loss',
    leaseToken: 1,
    leaseExpiresAt: Date.now() + 1000,
  };
  let claimCalls = 0;
  let failCalls = 0;
  const service = {
    async claim() {
      claimCalls += 1;
      return claimCalls === 1 ? lease : null;
    },
    async heartbeat() {
      return { owned: true, cancellationRequested: false };
    },
    async readPayload() {
      return {};
    },
    async fail() {
      failCalls += 1;
      throw new Error('connection lost after retry transition COMMIT');
    },
    async getMetadata() {
      throw new Error('database still temporarily unavailable');
    },
  };
  const worker = new PostgresDurableJobWorker({
    service,
    handlers: new Map([
      [
        'test.echo',
        async () => {
          throw new Error('handler failure');
        },
      ],
    ]),
    workerId: 'postgres-fail-ack-loss',
    leaseMs: 1000,
    shutdownTimeoutMs: 100,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
  });
  worker.start();
  const deadline = Date.now() + 1000;
  while (claimCalls < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(failCalls, 1);
  assert.ok(claimCalls >= 2, 'the consumer loop must continue after ack loss');
  assert.equal(worker.isOperational(), true);
  assert.equal((await worker.stop()).failed, 0);
});

test('PostgreSQL worker schedules lifecycle recovery at terminal exhaustion without restart', async () => {
  const lease = {
    id: '00000000-0000-4000-8000-000000000021',
    jobType: RESOURCE_DELETE_JOB_TYPE,
    actorUserId: 'actor-1',
    state: 'running',
    priority: 0,
    attemptCount: 5,
    maxAttempts: 5,
    availableAt: 0,
    cancellationRequestedAt: null,
    progressCurrent: 0,
    progressTotal: 0,
    progressMessage: null,
    resultReference: null,
    errorCode: null,
    errorSummary: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: null,
    workerId: 'postgres-lifecycle-recovery',
    leaseToken: 5,
    leaseExpiresAt: Date.now() + 1000,
  };
  let claimCalls = 0;
  let recoveryCalls = 0;
  const service = {
    async claim() {
      claimCalls += 1;
      return claimCalls === 1 ? lease : null;
    },
    async heartbeat() {
      return { owned: true, cancellationRequested: false };
    },
    async readPayload() {
      return {};
    },
    async fail() {
      return 'dead_letter';
    },
    async reconcileDeletionLifecycleJob(id) {
      assert.equal(id, lease.id);
      recoveryCalls += 1;
      return { examined: 1, recoveryJobs: 1, skipped: 0 };
    },
  };
  const worker = new PostgresDurableJobWorker({
    service,
    handlers: new Map([
      [
        RESOURCE_DELETE_JOB_TYPE,
        async () => {
          throw new DurableJobExecutionError(
            true,
            'resource-cleanup-failed',
            'Object storage is unavailable'
          );
        },
      ],
    ]),
    workerId: 'postgres-lifecycle-recovery',
    leaseMs: 1000,
    shutdownTimeoutMs: 100,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
  });
  worker.start();
  const deadline = Date.now() + 1000;
  while ((recoveryCalls === 0 || claimCalls < 2) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(recoveryCalls, 1);
  assert.ok(claimCalls >= 2, 'the same external worker must keep polling');
  assert.equal(worker.isOperational(), true);
  assert.equal((await worker.stop()).failed, 0);
});

test('PostgreSQL worker resolves a successful COMMIT with lost acknowledgement', async () => {
  const lease = {
    id: 'job-complete-ack-loss',
    jobType: 'test.echo',
    actorUserId: 'actor-1',
    state: 'running',
    priority: 0,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: 0,
    cancellationRequestedAt: null,
    progressCurrent: 0,
    progressTotal: 0,
    progressMessage: null,
    resultReference: null,
    errorCode: null,
    errorSummary: null,
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    finishedAt: null,
    workerId: 'postgres-complete-ack-loss',
    leaseToken: 1,
    leaseExpiresAt: Date.now() + 1000,
  };
  let claimCalls = 0;
  let handlerCalls = 0;
  let failCalls = 0;
  const service = {
    async claim() {
      claimCalls += 1;
      return claimCalls === 1 ? lease : null;
    },
    async heartbeat() {
      return { owned: true, cancellationRequested: false };
    },
    async readPayload() {
      return {};
    },
    async complete() {
      throw new Error('connection lost after successful COMMIT');
    },
    async getMetadata() {
      return { ...lease, state: 'succeeded', finishedAt: Date.now() };
    },
    async fail() {
      failCalls += 1;
      return 'queued';
    },
  };
  const worker = new PostgresDurableJobWorker({
    service,
    handlers: new Map([
      [
        'test.echo',
        async () => {
          handlerCalls += 1;
          return { resultReference: 'effect:one' };
        },
      ],
    ]),
    workerId: 'postgres-complete-ack-loss',
    leaseMs: 1000,
    shutdownTimeoutMs: 100,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
  });
  worker.start();
  const deadline = Date.now() + 1000;
  while (claimCalls < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(handlerCalls, 1);
  assert.equal(failCalls, 0, 'a committed success must not be failed/retried');
  assert.ok(claimCalls >= 2);
  assert.equal(worker.isOperational(), true);
  assert.equal((await worker.stop()).failed, 0);
});

test('durable event gateway replays SQL before fan-out and preserves backpressure', async t => {
  const { database, service } = harness();
  t.after(() => database.close());
  const coordinator = new LocalCoordinator();
  await coordinator.connect();
  t.after(() => coordinator.close());
  const producer = new DurableEventGateway(service, coordinator);
  const consumer = new DurableEventGateway(service, coordinator);
  t.after(() => Promise.all([producer.close(), consumer.close()]));

  await producer.append({
    eventId: durableEventId('test', 'chat:one', 'created'),
    streamId: 'chat:one',
    eventType: 'chat.created',
    subjectId: 'one',
    actorUserId: 'actor-1',
    payload: { mode: 'encrypted', value: { sequence: 1 } },
  });

  const delivered = [];
  let releaseSecond;
  const secondGate = new Promise(resolve => {
    releaseSecond = resolve;
  });
  const subscription = await consumer.subscribe({
    afterCursor: 0,
    streamId: 'chat:one',
    pollIntervalMs: 60_000,
    async onEvent(event) {
      delivered.push(event.payload.sequence);
      if (event.payload.sequence === 2) await secondGate;
    },
  });
  assert.deepEqual(delivered, [1], 'initial replay must precede live fan-out');

  const secondAppend = producer.append({
    eventId: durableEventId('test', 'chat:one', 'updated'),
    streamId: 'chat:one',
    eventType: 'chat.updated',
    subjectId: 'one',
    actorUserId: 'actor-1',
    payload: { mode: 'encrypted', value: { sequence: 2 } },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(
    subscription.cursor,
    1,
    'cursor advances only after handler acknowledgement'
  );
  releaseSecond();
  await secondAppend;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(subscription.cursor, 2);
  await subscription.close();
});

function trackingCoordinator() {
  const handlers = new Set();
  return {
    coordinator: {
      async subscribe(_topic, handler) {
        handlers.add(handler);
        return async () => {
          handlers.delete(handler);
        };
      },
    },
    handlers,
  };
}

test('durable event gateway rejects and closes an over-bound initial replay', async t => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    cursor: index + 1,
    streamId: 'bounded-replay',
  }));
  let replayCalls = 0;
  const service = {
    async replayEvents(afterCursor, options) {
      replayCalls += 1;
      return events
        .filter(event => event.cursor > afterCursor)
        .slice(0, options.limit);
    },
  };
  const { coordinator, handlers } = trackingCoordinator();
  const gateway = new DurableEventGateway(service, coordinator);
  t.after(() => gateway.close());
  const delivered = [];
  const reported = [];
  let rejected;

  await assert.rejects(
    gateway.subscribe({
      afterCursor: 0,
      batchSize: 5,
      pollIntervalMs: 100,
      maxReplayEvents: 2,
      onEvent: event => delivered.push(event.cursor),
      onError: error => reported.push(error),
    }),
    error => {
      rejected = error;
      return /replay exceeded the configured delivery bound/.test(
        error.message
      );
    }
  );

  assert.deepEqual(delivered, [1, 2]);
  assert.deepEqual(reported, [rejected], 'the failure must be reported once');
  assert.equal(handlers.size, 0, 'the Redis wake subscription must be removed');
  assert.equal(gateway.subscriptions.size, 0);
  const callsAfterRejection = replayCalls;
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(
    replayCalls,
    callsAfterRejection,
    'the replay timer must be cleared before subscribe rejects'
  );
  assert.deepEqual(
    delivered,
    [1, 2],
    'replay must not resume as live delivery'
  );
});

test('durable event gateway rejects and closes revoked initial authorization', async t => {
  let replayCalls = 0;
  const service = {
    async replayEvents() {
      replayCalls += 1;
      return [{ cursor: 1, streamId: 'revoked-replay' }];
    },
  };
  const { coordinator, handlers } = trackingCoordinator();
  const gateway = new DurableEventGateway(service, coordinator);
  t.after(() => gateway.close());
  const delivered = [];
  const reported = [];
  let rejected;

  await assert.rejects(
    gateway.subscribe({
      afterCursor: 0,
      pollIntervalMs: 100,
      authorize: async () => false,
      onEvent: event => delivered.push(event.cursor),
      onError: error => reported.push(error),
    }),
    error => {
      rejected = error;
      return /authorization was revoked/.test(error.message);
    }
  );

  assert.deepEqual(delivered, []);
  assert.deepEqual(reported, [rejected], 'the failure must be reported once');
  assert.equal(handlers.size, 0, 'the Redis wake subscription must be removed');
  assert.equal(gateway.subscriptions.size, 0);
  const callsAfterRejection = replayCalls;
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(
    replayCalls,
    callsAfterRejection,
    'the replay timer must be cleared before subscribe rejects'
  );
  assert.deepEqual(delivered, []);
});
