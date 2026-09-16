import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

// Stateful production modules are imported below. Pin a test-only key before
// those imports so this suite can never generate or persist developer secrets.
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-recovery-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);
const adminModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workAdminService.js')
  ).href
);
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

test.after(async () => {
  await closeWorkPlatform();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const record = (id = 'recovery-task') => ({
  id,
  userId: 'recovery-user',
  title: `task ${id}`,
  model: 'local-tools-model',
  status: 'idle',
  networkEnabled: false,
  volumeName: `vol-${id}`,
  containerName: `ctr-${id}`,
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 2,
});

/**
 * A runtime whose stop calls fail while `stopFails` is set, and whose labeled
 * listing reports the task's container as running so reconciliation has
 * something to stop.
 */
const failingRuntime = () => {
  const service = new runtimeModule.WorkRuntimeService();
  const state = { stopFails: true, stopCalls: 0 };
  service.isRuntimeAvailable = async () => true;
  service.driver.docker = async args => {
    if (args[0] === 'stop') {
      state.stopCalls += 1;
      if (state.stopFails) throw new Error('transient Docker stop failure');
    }
    if (args[0] === 'container') {
      return { exitCode: 0, stdout: '{}', stderr: '', truncated: false };
    }
    if (args[0] === 'inspect') {
      return {
        exitCode: 0,
        stdout: 'recovery-task',
        stderr: '',
        truncated: false,
      };
    }
    return { exitCode: 0, stdout: '', stderr: '', truncated: false };
  };
  return { service, state };
};

test('a failed stop is recorded with its reason, attempts, and last error', async () => {
  const { service } = failingRuntime();
  const task = record();

  await assert.rejects(
    service.stopContainer(task),
    /transient Docker stop failure/
  );

  assert.equal(service.recoveryPending, true);
  const [item, ...rest] = service.recoveryInventoryDetail();
  assert.deepEqual(rest, []);
  assert.equal(item.kind, 'task');
  assert.equal(item.taskId, task.id);
  assert.equal(item.containerName, task.containerName);
  assert.equal(item.reason, 'stop-failed');
  assert.equal(item.attempts, 1);
  assert.equal(item.lastError, 'transient Docker stop failure');
  assert.ok(item.firstSeenAt > 0);
  assert.ok(item.lastAttemptAt >= item.firstSeenAt);
  // The stamp an operator reads as "next attempt" must be in the future.
  assert.ok(item.nextAttemptAt > Date.now());
  // A message, never a stack: an admin payload must not leak server paths.
  assert.ok(!item.lastError.includes('\n'));

  assert.equal(service.recoverySince, item.firstSeenAt);
  assert.equal(service.recoveryNextAttemptAt, item.nextAttemptAt);
  service.beginShutdown();
});

test('an immediate retry clears the item once the runtime cooperates', async () => {
  const { service, state } = failingRuntime();
  const task = record();

  await assert.rejects(
    service.stopContainer(task),
    /transient Docker stop failure/
  );
  const stopsAfterFailure = state.stopCalls;

  // Still broken: the retry is attempted and the item survives, with its
  // attempt count and error updated rather than replaced.
  const firstRetry = await service.retryRecoveryNow();
  assert.deepEqual(firstRetry, { attempted: 1, cleared: 0 });
  assert.ok(state.stopCalls > stopsAfterFailure);
  const [stillPending] = service.recoveryInventoryDetail();
  assert.equal(stillPending.attempts, 2);
  assert.equal(stillPending.reason, 'stop-failed');

  state.stopFails = false;
  const secondRetry = await service.retryRecoveryNow();
  assert.deepEqual(secondRetry, { attempted: 1, cleared: 1 });
  assert.deepEqual(service.recoveryInventoryDetail(), []);
  assert.equal(service.recoveryPending, false);
  assert.equal(service.recoverySince, null);
  assert.equal(service.recoveryNextAttemptAt, null);
  assert.doesNotThrow(() => service.assertAcceptingWork());

  // Nothing pending means nothing to attempt.
  assert.deepEqual(await service.retryRecoveryNow(), {
    attempted: 0,
    cleared: 0,
  });
  service.beginShutdown();
});

test('the retry cadence widens from ten seconds to a one minute ceiling', async () => {
  const service = new runtimeModule.WorkRuntimeService();
  service.isRuntimeAvailable = async () => false;
  const task = record('backoff-task');

  const delays = [];
  for (let round = 0; round < 6; round += 1) {
    const before = Date.now();
    const result = await service.beginRecovery([task]);
    assert.equal(result.failed, 1);
    const [item] = service.recoveryInventoryDetail();
    assert.equal(item.reason, 'runtime-unreachable');
    assert.equal(item.attempts, round + 1);
    assert.ok(item.lastError);
    delays.push(item.nextAttemptAt - before);
  }

  // 10s, 20s, 40s, then pinned at the 60s ceiling.
  assert.ok(delays[0] >= 10_000 && delays[0] < 12_000, `first ${delays[0]}`);
  assert.ok(delays[1] >= 20_000 && delays[1] < 22_000, `second ${delays[1]}`);
  assert.ok(delays[2] >= 40_000 && delays[2] < 42_000, `third ${delays[2]}`);
  for (const delay of delays.slice(3)) {
    assert.ok(delay >= 60_000 && delay < 62_000, `capped ${delay}`);
  }
  service.beginShutdown();
});

test('two sweeps never run at once', async () => {
  const { service, state } = failingRuntime();
  const task = record();
  await assert.rejects(
    service.stopContainer(task),
    /transient Docker stop failure/
  );
  state.stopFails = false;
  const stopsBefore = state.stopCalls;

  const [first, second] = await Promise.all([
    service.retryRecoveryNow(),
    service.retryRecoveryNow(),
  ]);
  // The second call joins the in-flight sweep instead of starting another.
  assert.equal(state.stopCalls - stopsBefore, 1);
  assert.equal(first.cleared + second.cleared >= 1, true);
  assert.equal(service.recoveryPending, false);
  service.beginShutdown();
});

test('the admin recovery list names the owning task, and tolerates a missing one', async () => {
  const items = [
    {
      kind: 'task',
      taskId: 'task-1',
      containerName: 'ctr-task-1',
      reason: 'stop-failed',
      attempts: 2,
      firstSeenAt: 10,
      lastAttemptAt: 20,
      lastError: 'nope',
      nextAttemptAt: 30,
    },
    {
      kind: 'orphan',
      containerName: 'work-ghost',
      reason: 'orphan',
      attempts: 1,
      firstSeenAt: 11,
      lastAttemptAt: 21,
      lastError: null,
      nextAttemptAt: 31,
    },
  ];
  const listed = await adminModule.buildWorkRecoveryList({
    items: () => items,
    listTasksWithOwner: async () => [
      {
        record: { ...record('task-1'), title: 'Rebuild the landing page' },
        ownerUsername: 'alice',
      },
    ],
  });
  assert.deepEqual(
    listed.map(item => [item.containerName, item.title, item.ownerUsername]),
    [
      ['ctr-task-1', 'Rebuild the landing page', 'alice'],
      ['work-ghost', null, null],
    ]
  );

  // A failing owner lookup degrades the names, never the list itself.
  const degraded = await adminModule.buildWorkRecoveryList({
    items: () => items,
    listTasksWithOwner: async () => {
      throw new Error('database unavailable');
    },
  });
  assert.equal(degraded.length, 2);
  assert.equal(degraded[0].title, null);

  // Nothing pending needs no owner query at all.
  let queried = false;
  const empty = await adminModule.buildWorkRecoveryList({
    items: () => [],
    listTasksWithOwner: async () => {
      queried = true;
      return [];
    },
  });
  assert.deepEqual(empty, []);
  assert.equal(queried, false);
});
