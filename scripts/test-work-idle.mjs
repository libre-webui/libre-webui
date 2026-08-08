import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// Must be set before the dist modules load: the runtime config is read once
// at import time.
process.env.WORK_RUNTIME_IDLE_TIMEOUT_MS = '60000';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-idle-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const databaseModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);
const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);
const sharedModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeShared.js')
  ).href
);

const { WorkRuntimeService, WORK_RUNTIME_DEFAULTS } = runtimeModule;
const IDLE_MS = 60_000;

test.after(() => {
  databaseModule.closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const db = databaseModule.getDatabase();
const now = Date.now();
db.prepare(
  `INSERT INTO users (
    id, username, email, password_hash, role, created_at, updated_at
  ) VALUES ('idle-user', 'idle-user', 'i@example.invalid', 'x', 'admin', ?, ?)`
).run(now, now);

const makeTask = id => {
  const task = {
    id,
    userId: 'idle-user',
    title: `task ${id}`,
    model: 'test',
    status: 'idle',
    networkEnabled: true,
    volumeName: `vol-${id}`,
    containerName: `ctr-${id}`,
    previewStatus: 'stopped',
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, volume_name, container_name,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, task.userId, task.title, task.model, task.volumeName,
    task.containerName, now, now);
  return task;
};

const stubDocker = (service, task, calls) => {
  service.driver.docker = async args => {
    calls.push(args);
    if (args[0] === 'ps') {
      return {
        exitCode: 0,
        stdout: `${task.containerName}\trunning\t${task.id}\n`,
        stderr: '',
        truncated: false,
      };
    }
    if (args[0] === 'inspect' || args[0] === 'container') {
      return {
        exitCode: 0,
        stdout: `${task.id}\n`,
        stderr: '',
        truncated: false,
      };
    }
    return { exitCode: 0, stdout: '', stderr: '', truncated: false };
  };
};

test('the idle sweep is off by default and off while recovering', async () => {
  assert.equal(WORK_RUNTIME_DEFAULTS.idleTimeoutMs, 0);
  assert.equal(sharedModule.workRuntimeConfig.idleTimeoutMs, IDLE_MS);

  const service = new WorkRuntimeService();
  service.recoveryTasks.set('anything', {});
  const swept = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(swept, { stopped: 0 });
  service.beginShutdown();
});

test('a first-seen running sandbox starts its clock instead of stopping', async () => {
  const task = makeTask('idle-fresh');
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);

  const first = await service.sweepIdleRuntimes(now + IDLE_MS * 10);
  assert.deepEqual(first, { stopped: 0 });
  assert.ok(!calls.some(args => args[0] === 'stop'));

  // The primed clock now ages past the timeout: the sandbox is stopped.
  const second = await service.sweepIdleRuntimes(Date.now() + IDLE_MS + 1);
  assert.deepEqual(second, { stopped: 1 });
  assert.ok(
    calls.some(args => args[0] === 'stop' && args.includes(task.containerName))
  );
  service.beginShutdown();
});

test('busy sandboxes refresh their clock and are never stopped', async () => {
  const task = makeTask('idle-busy');
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);

  service.noteTaskActivity(task.id);
  service.activeCommands.add(task.id);
  const command = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(command, { stopped: 0 });
  service.activeCommands.delete(task.id);

  service.terminalHolds.set(task.id, 1);
  const terminal = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(terminal, { stopped: 0 });
  service.terminalHolds.delete(task.id);

  // A non-preview operation lease means work is in flight.
  service.runtimeLeases.set(task.id, { userId: task.userId, holders: 1 });
  const leased = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(leased, { stopped: 0 });
  service.runtimeLeases.delete(task.id);

  assert.ok(!calls.some(args => args[0] === 'stop'));
  service.beginShutdown();
});

test('an idle preview is stopped through the preview path', async () => {
  const task = makeTask('idle-preview');
  db.prepare(`UPDATE work_tasks SET preview_status = 'running' WHERE id = ?`).run(
    task.id
  );
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);

  // Simulate a held preview lease well past the idle deadline.
  service.runtimeLeases.set(task.id, { userId: task.userId, holders: 1 });
  service.previewLeaseReleases.set(task.id, () => {});
  const previewStops = [];
  service.stopPreview = async (candidate, hooks) => {
    previewStops.push(candidate.id);
    hooks?.onStopped?.();
  };

  service.noteTaskActivity(task.id);
  const swept = await service.sweepIdleRuntimes(Date.now() + IDLE_MS + 1);
  assert.deepEqual(swept, { stopped: 1 });
  assert.deepEqual(previewStops, [task.id]);
  const row = db
    .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
    .get(task.id);
  assert.equal(row.preview_status, 'stopped');
  // The container itself was not force-stopped behind the preview's back.
  assert.ok(!calls.some(args => args[0] === 'stop'));
  service.beginShutdown();
});

test('preview traffic through the signed proxy refreshes the idle clock', async () => {
  const proxyModule = await import(
    pathToFileURL(
      path.join(
        repoRoot,
        'backend',
        'dist',
        'services',
        'workPreviewProxyService.js'
      )
    ).href
  );
  const activity = [];
  const service = new proxyModule.WorkPreviewProxyService(
    'idle-test-secret',
    taskId =>
      taskId === taskRecordId
        ? { preview_status: 'running', preview_url: previewPath }
        : undefined
  );
  service.onPreviewActivity(taskId => activity.push(taskId));
  const taskRecordId = '9af1c9e2-58c8-4f6e-a9d1-2b7c40de9b12';
  const previewPath = service.createPreviewUrl(taskRecordId, 4173);

  // Resolving an authorized target is the activity signal.
  const target = service.parseTarget(`${previewPath}index.html`);
  assert.ok(target);
  assert.deepEqual(activity, [taskRecordId]);

  // A tampered signature resolves to nothing and records no activity.
  const tampered = previewPath.replace(/.\/$/, 'x/');
  assert.equal(service.parseTarget(`${tampered}index.html`), undefined);
  assert.deepEqual(activity, [taskRecordId]);
});
