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

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-access-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const databaseModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);
const accessModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workAccessService.js')
  ).href
);
const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);
const terminalServerModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'workTerminalServer.js'))
    .href
);

const {
  getWorkAccessMode,
  setWorkAccessMode,
  isWorkAccessMode,
  userHasWorkAccess,
} = accessModule;
const { WorkRuntimeService } = runtimeModule;
const { requireCurrentTerminalTask } = terminalServerModule;

test.after(() => {
  databaseModule.closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('the Work access mode defaults to admins and persists changes', () => {
  assert.equal(getWorkAccessMode(), 'admins');
  setWorkAccessMode('all-users');
  assert.equal(getWorkAccessMode(), 'all-users');
  setWorkAccessMode('admins');
  assert.equal(getWorkAccessMode(), 'admins');
  assert.throws(() => setWorkAccessMode('everyone'));
  assert.equal(isWorkAccessMode('all-users'), true);
  assert.equal(isWorkAccessMode('everyone'), false);
});

test('access follows role, account status, and the persisted mode', () => {
  setWorkAccessMode('admins');
  assert.equal(userHasWorkAccess({ role: 'admin', status: 'active' }), true);
  assert.equal(userHasWorkAccess({ role: 'user', status: 'active' }), false);

  setWorkAccessMode('all-users');
  assert.equal(userHasWorkAccess({ role: 'user', status: 'active' }), true);
  // Suspended or pending accounts never gain access from the open mode.
  assert.equal(userHasWorkAccess({ role: 'user', status: 'pending' }), false);
  assert.equal(userHasWorkAccess({ role: 'admin', status: 'pending' }), false);
  // Status unknown to the caller defers to role and mode alone.
  assert.equal(userHasWorkAccess({ role: 'user' }), true);
  setWorkAccessMode('admins');
});

test('runtime mutations honor the owner’s current Work access', async () => {
  const db = databaseModule.getDatabase();
  const now = Date.now();
  const userId = 'work-access-user';
  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'user', ?, ?)`
  ).run(userId, userId, `${userId}@example.invalid`, 'not-a-hash', now, now);
  const task = {
    id: 'work-access-task',
    userId,
    title: 'access test',
    model: 'test',
    status: 'idle',
    networkEnabled: true,
    volumeName: 'libre-work-access0001',
    containerName: 'libre-work-access0001',
    previewStatus: 'stopped',
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, volume_name, container_name,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    task.id,
    userId,
    task.title,
    task.model,
    task.volumeName,
    task.containerName,
    now,
    now
  );

  const service = new WorkRuntimeService();
  let removed = 0;
  service.driver.removeTaskResources = async () => {
    removed += 1;
  };

  // Admins-only mode: a non-admin owner's mutation is refused.
  setWorkAccessMode('admins');
  await assert.rejects(
    service.removeTask(task),
    error => error?.status === 403 && error?.code === 'WORK_ACCESS_REVOKED'
  );
  assert.equal(removed, 0);

  // Opening Work to all users lets the same owner proceed.
  setWorkAccessMode('all-users');
  await service.removeTask(task);
  assert.equal(removed, 1);
  setWorkAccessMode('admins');
});

test('an established terminal rechecks current access and task ownership', async () => {
  const db = databaseModule.getDatabase();
  const now = Date.now();
  const userId = 'terminal-reauth-user';
  const otherUserId = 'terminal-reauth-other-user';
  const taskId = 'terminal-reauth-task';
  const insertUser = db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
  );
  insertUser.run(userId, userId, now, now);
  insertUser.run(otherUserId, otherUserId, now, now);
  db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, volume_name, container_name,
      created_at, updated_at
    ) VALUES (?, ?, 'terminal reauth', 'test', ?, ?, ?, ?)`
  ).run(
    taskId,
    userId,
    'libre-work-terminalreauth01',
    'libre-work-terminalreauth01',
    now,
    now
  );

  setWorkAccessMode('all-users');
  assert.equal((await requireCurrentTerminalTask(userId, taskId)).id, taskId);

  db.prepare("UPDATE users SET account_status = 'pending' WHERE id = ?").run(
    userId
  );
  await assert.rejects(
    requireCurrentTerminalTask(userId, taskId),
    error => error?.status === 403 && error?.code === 'WORK_TERMINAL_FORBIDDEN'
  );
  db.prepare("UPDATE users SET account_status = 'active' WHERE id = ?").run(
    userId
  );

  setWorkAccessMode('admins');
  await assert.rejects(
    requireCurrentTerminalTask(userId, taskId),
    error => error?.status === 403 && error?.code === 'WORK_TERMINAL_FORBIDDEN'
  );

  setWorkAccessMode('all-users');
  db.prepare('UPDATE work_tasks SET user_id = ? WHERE id = ?').run(
    otherUserId,
    taskId
  );
  await assert.rejects(
    requireCurrentTerminalTask(userId, taskId),
    error =>
      error?.status === 404 && error?.code === 'WORK_TERMINAL_TASK_NOT_FOUND'
  );
  setWorkAccessMode('admins');
});

test('the Work routes gate on Work access, not blanket admin', () => {
  const source = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'work.ts'),
    'utf8'
  );
  // The blanket admin gate is gone; the access-mode gate replaces it.
  assert.doesNotMatch(source, /router\.use\(requireAdmin\)/);
  assert.match(source, /router\.use\(requireWorkAccess\)/);
  // The access endpoints are declared before the gate so every
  // authenticated user can ask, and only admins can change the mode.
  const accessRead = source.indexOf(`router.get(\n  '/access'`);
  const gate = source.indexOf('router.use(requireWorkAccess)');
  assert.ok(accessRead !== -1 && gate !== -1 && accessRead < gate);
  assert.match(source, /router\.put\(\s*'\/access',\s*requireAdmin/);
  // Host folders bind-mount server paths: admin-only in every mode.
  assert.match(source, /requestedHostPath && req\.user\?\.role !== 'admin'/);

  const terminal = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'workTerminalServer.ts'),
    'utf8'
  );
  assert.match(terminal, /!userHasWorkAccess\(currentUser\)/);
  assert.match(
    terminal,
    /requireCurrentTerminalTask\(\s*userId,\s*task\.id,\s*\(\) => lifecycle\.isShuttingDown/
  );
  assert.doesNotMatch(terminal, /currentUser\.role !== 'admin'/);
});
