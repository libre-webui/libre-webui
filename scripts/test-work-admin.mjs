import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-admin-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const databaseModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);
const adminModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workAdminService.js')
  ).href
);
const taskModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workTaskService.js')
  ).href
);

const { buildWorkAdminOverview } = adminModule;

test.after(() => {
  databaseModule.closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const record = (id, userId, extra = {}) => ({
  id,
  userId,
  title: `task ${id}`,
  model: 'test',
  status: 'idle',
  networkEnabled: true,
  volumeName: `vol-${id}`,
  containerName: `ctr-${id}`,
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 2,
  ...extra,
});

const stubDeps = overrides => ({
  listTasksWithOwner: () => [
    { record: record('t1', 'u1'), ownerUsername: 'alice' },
    {
      record: record('t2', 'u2', { hostPath: '/srv/code', updatedAt: 9 }),
      ownerUsername: 'bob',
    },
  ],
  listManaged: async () => [
    { name: 'ctr-t1', taskId: 't1', running: true },
    { name: 'work-ghost', taskId: 'task-gone', running: false },
  ],
  isRuntimeAvailable: async () => true,
  runtimeUnavailableReason: () => null,
  sessionCount: taskId => (taskId === 't1' ? 2 : 0),
  activeGlobal: () => 1,
  limits: () => ({ maxGlobal: 3, maxPerUser: 2 }),
  recoveryPending: () => 0,
  accessMode: () => 'admins',
  ...overrides,
});

test('the overview aggregates tasks, live state, sessions, and orphans', async () => {
  const overview = await buildWorkAdminOverview(stubDeps());

  assert.equal(overview.accessMode, 'admins');
  assert.equal(overview.runtimeAvailable, true);
  assert.equal(overview.runtimeReason, undefined);
  assert.equal(overview.recoveryPending, 0);
  assert.deepEqual(overview.admission, {
    activeGlobal: 1,
    maxGlobal: 3,
    maxPerUser: 2,
  });

  const [first, second] = overview.tasks;
  assert.equal(first.ownerUsername, 'alice');
  assert.equal(first.running, true);
  assert.equal(first.terminalSessions, 2);
  assert.equal(first.hostWorkspace, false);
  assert.equal(second.ownerUsername, 'bob');
  // A known task with no managed container is at rest, not unknown.
  assert.equal(second.running, false);
  assert.equal(second.hostWorkspace, true);

  assert.deepEqual(overview.orphanContainers, [
    { name: 'work-ghost', taskId: 'task-gone', running: false },
  ]);
});

test('an unavailable runtime degrades state to unknown, never fails', async () => {
  const down = await buildWorkAdminOverview(
    stubDeps({
      isRuntimeAvailable: async () => false,
      runtimeUnavailableReason: () => 'no daemon',
    })
  );
  assert.equal(down.runtimeAvailable, false);
  assert.equal(down.runtimeReason, 'no daemon');
  assert.ok(down.tasks.every(task => task.running === null));
  assert.deepEqual(down.orphanContainers, []);

  const flaky = await buildWorkAdminOverview(
    stubDeps({
      listManaged: async () => {
        throw new Error('listing failed');
      },
    })
  );
  assert.ok(flaky.tasks.every(task => task.running === null));
});

test('tasks are listed across every user with their owner username', () => {
  const db = databaseModule.getDatabase();
  const now = Date.now();
  const insertUser = db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertUser.run('adm', 'admin-a', 'a@example.invalid', 'x', 'admin', now, now);
  insertUser.run('usr', 'user-b', 'b@example.invalid', 'x', 'user', now, now);
  const insertTask = db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, volume_name, container_name,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  insertTask.run('ta', 'adm', 'admin task', 'm', 'v-a', 'c-a', now, now);
  insertTask.run('tb', 'usr', 'user task', 'm', 'v-b', 'c-b', now, now + 1);

  const service = new taskModule.WorkTaskService();
  const listed = service.listAllTasksWithOwner();
  assert.deepEqual(
    listed.map(entry => [entry.record.id, entry.ownerUsername]),
    [
      ['tb', 'user-b'],
      ['ta', 'admin-a'],
    ]
  );
});

test('the overview route is admin-only and reachable while fail-closed', () => {
  const source = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'work.ts'),
    'utf8'
  );
  assert.match(source, /router\.get\(\s*'\/admin\/overview',\s*requireAdmin/);
  // Declared before the assertAcceptingWork gate, so the overview stays
  // readable while Work is blocked on startup recovery.
  const overviewAt = source.indexOf("'/admin/overview'");
  const gateAt = source.indexOf('workRuntimeService.assertAcceptingWork()');
  assert.ok(overviewAt !== -1 && gateAt !== -1 && overviewAt < gateAt);
});
