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
const jobsModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'platform', 'jobs', 'index.js')
  ).href
);
const storageModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'platform', 'storage', 'index.js')
  ).href
);
const migrationModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'sqliteMigrations.js')
  ).href
);

const {
  DurableJobError,
  DurableJobExecutionError,
  DurableJobService,
  EmbeddedDurableJobWorker,
  SQLiteDurableJobRepository,
} = jobsModule;
const { Aes256GcmKeyring } = storageModule;

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

test('ordered event replay uses global cursors and per-stream sequences', () => {
  const { database, service } = harness();
  const cursors = [
    service.appendEvent({
      streamId: 'session:1',
      eventType: 'turn.created',
      subjectId: 'turn-1',
      actorUserId: 'actor-1',
      payload: { mode: 'encrypted', value: { order: 1 } },
    }),
    service.appendEvent({
      streamId: 'session:2',
      eventType: 'turn.created',
      subjectId: 'turn-2',
      payload: { mode: 'reference', referenceId: 'blob:event-2' },
    }),
    service.appendEvent({
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
