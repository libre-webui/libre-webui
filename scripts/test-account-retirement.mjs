/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = mkdtempSync(path.join(os.tmpdir(), 'libre-retirement-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '83'.repeat(32);
process.env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID = 'retirement-test';
process.env.STORAGE_ENCRYPTION_KEYS = JSON.stringify({
  legacy: '83'.repeat(32),
  'retirement-test': '84'.repeat(32),
});

const built = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const [
  persistence,
  { encryptionService },
  workPersistence,
  platformStorage,
  coordination,
  jobs,
  { createDomainDurableJobHandlers },
  domainContracts,
  { getDatabase },
  { userModel },
  { default: workAgentService },
  { default: workTaskService },
] = await Promise.all([
  built('persistence/index.js'),
  built('services/encryptionService.js'),
  built('platform/workPersistence/index.js'),
  built('platform/storage/index.js'),
  built('platform/coordination/service.js'),
  built('platform/jobs/durableJobRuntime.js'),
  built('platform/jobs/domainJobHandlers.js'),
  built('platform/jobs/domainJobContracts.js'),
  built('db.js'),
  built('models/userModel.js'),
  built('services/workAgentService.js'),
  built('services/workTaskService.js'),
]);

const waitFor = async (predicate, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

test('retirement drains initiated owner cleanups before deleting their actor', async t => {
  let persistenceReady = false;
  let workReady = false;
  let storageReady = false;
  let coordinationReady = false;
  let jobsReady = false;
  t.after(async () => {
    if (jobsReady) await jobs.closeDurableJobRuntime();
    if (coordinationReady) await coordination.closeCoordinator();
    if (storageReady) await platformStorage.closePlatformStorageRuntime();
    if (workReady) workPersistence.resetWorkPersistenceForTests();
    if (persistenceReady) await persistence.closePersistence();
    rmSync(dataDir, { recursive: true, force: true });
  });

  await persistence.initializePersistence({
    dialect: 'sqlite',
    emailCodec: encryptionService,
    env: process.env,
  });
  persistenceReady = true;
  workPersistence.initializeSelectedWorkPersistence('sqlite');
  workReady = true;
  await platformStorage.initializePlatformStorageRuntime({
    persistence: persistence.getInitializedPersistence(),
    cipher: encryptionService,
    env: process.env,
  });
  storageReady = true;
  await coordination.initializeCoordinator();
  coordinationReady = true;
  jobs.initializeDurableJobRuntime({
    role: 'embedded',
    runWorker: false,
    handlers: new Map(),
    env: process.env,
  });
  jobsReady = true;

  const database = getDatabase();
  const now = Date.now();
  const initiatingAdmin = 'retirement-initiating-admin';
  const deletingAdmin = 'retirement-deleting-admin';
  const deletedOwner = 'retirement-deleted-owner';
  const acknowledgementActor = 'work-acknowledgement-actor';
  const insertUser = database.prepare(
    `INSERT INTO users (
       id, username, email, password_hash, role, account_status,
       created_at, updated_at
     ) VALUES (?, ?, NULL, 'unused', 'admin', 'active', ?, ?)`
  );
  for (const id of [
    initiatingAdmin,
    deletingAdmin,
    deletedOwner,
    acknowledgementActor,
  ]) {
    insertUser.run(id, id, now, now);
  }

  const selectedWorkPersistence = workPersistence.getWorkPersistence();
  const originalCreateTaskWithRun =
    selectedWorkPersistence.createTaskWithRun.bind(selectedWorkPersistence);
  selectedWorkPersistence.createTaskWithRun = async (...args) => {
    await originalCreateTaskWithRun(...args);
    throw new Error('injected Work task post-commit acknowledgement loss');
  };
  let acknowledgedTask;
  try {
    acknowledgedTask = await workTaskService.createTaskWithRun(
      acknowledgementActor,
      'Resolve a committed task publication.',
      'test-model',
      false
    );
  } finally {
    selectedWorkPersistence.createTaskWithRun = originalCreateTaskWithRun;
  }
  assert.ok(acknowledgedTask.activeRun?.id);
  await workTaskService.updateRun(acknowledgedTask.activeRun.id, 'completed', {
    finished: true,
  });
  await workTaskService.updateTaskStatus(acknowledgedTask.id, 'completed');

  const originalCreateRun = selectedWorkPersistence.createRun.bind(
    selectedWorkPersistence
  );
  selectedWorkPersistence.createRun = async (...args) => {
    await originalCreateRun(...args);
    throw new Error('injected Work run post-commit acknowledgement loss');
  };
  let acknowledgedRun;
  try {
    acknowledgedRun = await workTaskService.createRun(
      acknowledgedTask.id,
      acknowledgementActor,
      'Resolve a committed follow-up publication.'
    );
  } finally {
    selectedWorkPersistence.createRun = originalCreateRun;
  }
  assert.ok(acknowledgedRun.activeRun?.id);
  assert.notEqual(acknowledgedRun.activeRun.id, acknowledgedTask.activeRun.id);
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_jobs
          WHERE actor_user_id = ? AND job_type = ?`
      )
      .get(acknowledgementActor, domainContracts.WORK_EXECUTE_JOB_TYPE).count,
    2,
    'each committed task/run publication must have exactly one durable job'
  );

  const storageRuntime = platformStorage.getPlatformStorageRuntime();
  await storageRuntime.vectorStore.upsert({
    actor: { userId: deletedOwner },
    records: [
      {
        namespace: 'document-chunk',
        id: 'deleted-owner-vector',
        ownerUserId: deletedOwner,
        resourceId: 'deleted-owner-document',
        model: 'retirement-fixture',
        dimensions: 2,
        version: '1',
        sourceRevision: '1',
        embedding: [1, 0],
      },
    ],
  });

  assert.equal(await userModel.beginUserRetirement(deletedOwner), true);
  assert.equal(
    await userModel.deleteUserAndEnqueueCleanup(deletedOwner, initiatingAdmin),
    true
  );
  const initialRuntime = jobs.getDurableJobRuntime();
  const protectedCleanup = await initialRuntime.service.getByIdempotency(
    initiatingAdmin,
    domainContracts.OWNER_DELETE_CONTENT_IDEMPOTENCY_SCOPE,
    deletedOwner
  );
  assert.ok(protectedCleanup);

  for (let index = 0; index < 225; index += 1) {
    await initialRuntime.service.enqueue({
      jobType: 'retirement.ordinary.v1',
      actorUserId: initiatingAdmin,
      payload: { mode: 'encrypted', value: { index } },
      idempotencyScope: 'retirement.ordinary.v1',
      idempotencyKey: `ordinary-${index}`,
    });
  }

  await jobs.closeDurableJobRuntime();
  jobsReady = false;
  const baseHandlers = createDomainDurableJobHandlers();
  const ownerCleanup = baseHandlers.get(
    domainContracts.OWNER_DELETE_CONTENT_JOB_TYPE
  );
  assert.ok(ownerCleanup);
  let cleanupObservedRetiringActor = false;
  const handlers = new Map([
    [
      domainContracts.OWNER_DELETE_CONTENT_JOB_TYPE,
      async context => {
        if (context.payload?.targetUserId === deletedOwner) {
          await waitFor(
            () =>
              database
                .prepare('SELECT account_status FROM users WHERE id = ?')
                .get(initiatingAdmin)?.account_status === 'retiring',
            'initiating actor never entered retirement'
          );
          await waitFor(
            () =>
              database
                .prepare(
                  `SELECT COUNT(*) AS count FROM platform_jobs
                    WHERE actor_user_id = ?
                      AND job_type <> ?
                      AND state IN ('queued', 'running')`
                )
                .get(
                  initiatingAdmin,
                  domainContracts.OWNER_DELETE_CONTENT_JOB_TYPE
                ).count === 0,
            'ordinary actor jobs were not cancelled before cleanup'
          );
          cleanupObservedRetiringActor = true;
        }
        return ownerCleanup(context);
      },
    ],
  ]);
  jobs.initializeDurableJobRuntime({
    role: 'embedded',
    runWorker: true,
    // The blocked protected cleanup must hold the only slot so the inert
    // ordinary jobs stay queued until retirement cancels them; extra slots
    // would claim them and dead-letter their unregistered job type.
    maxConcurrentJobs: 1,
    handlers,
    env: process.env,
  });
  jobsReady = true;

  assert.equal(
    await workAgentService.retireAndDeleteUser(initiatingAdmin, deletingAdmin),
    true
  );
  assert.equal(cleanupObservedRetiringActor, true);
  assert.equal(await userModel.getUserById(initiatingAdmin), null);
  assert.equal(await userModel.getUserById(deletedOwner), null);
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_vector_entries
          WHERE owner_user_id = ?`
      )
      .get(deletedOwner).count,
    0
  );
  assert.equal(
    (await jobs.getDurableJobRuntime().service.getMetadata(protectedCleanup.id))
      ?.state,
    'succeeded'
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_jobs
          WHERE actor_user_id = ? AND job_type = 'retirement.ordinary.v1'
            AND state = 'cancelled'`
      )
      .get(initiatingAdmin).count,
    225
  );

  const inactiveActor = 'retirement-inactive-actor';
  const fencedTarget = 'retirement-fenced-target';
  for (const id of [inactiveActor, fencedTarget])
    insertUser.run(id, id, now, now);
  assert.equal(await userModel.beginUserRetirement(inactiveActor), true);
  assert.equal(await userModel.beginUserRetirement(fencedTarget), true);
  await assert.rejects(
    userModel.deleteUserAndEnqueueCleanup(fencedTarget, inactiveActor),
    /requires an active actor/
  );
  assert.equal(
    (await userModel.getUserById(fencedTarget))?.status,
    'retiring',
    'actor validation and target deletion must share one transaction'
  );
});
