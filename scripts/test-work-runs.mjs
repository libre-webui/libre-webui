import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-work-runs-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'work-runs-test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );
const [
  { getDatabase },
  { authService },
  { default: workRouter },
  { closeDurableEventGateway },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/work.js'),
  distModule('platform/events/service.js'),
]);
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

const now = Date.now();
const db = getDatabase();

const addUser = (id, role) => {
  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'unused', ?, NULL, ?, ?)`
  ).run(id, id, role, now, now);
};

const addTask = (taskId, userId) => {
  db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, provider_type, provider_id, status,
      network_enabled, volume_name, container_name, preview_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'test-model', 'ollama', NULL, 'completed', 1, ?, ?,
              'stopped', ?, ?)`
  ).run(
    taskId,
    userId,
    `Task ${taskId}`,
    `volume-${taskId}`,
    `container-${taskId}`,
    now,
    now
  );
};

// Explicit column list, exactly like the recovery and event fixtures: a run
// row written without the result columns must still read back cleanly.
const addRun = (runId, taskId, createdAt, results = {}) => {
  db.prepare(
    `INSERT INTO work_runs (
      id, task_id, model, provider_type, provider_id, status, error,
      summary, changed_files, exit_state, created_at, started_at, finished_at
    ) VALUES (?, ?, 'test-model', 'ollama', NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    runId,
    taskId,
    results.status ?? 'completed',
    results.error ?? null,
    results.summary ?? null,
    results.changedFiles ?? null,
    results.exitState ?? null,
    createdAt,
    createdAt,
    results.finishedAt === undefined ? createdAt + 10 : results.finishedAt
  );
};

addUser('runs-owner', 'admin');
addUser('runs-stranger', 'admin');
addTask('runs-task', 'runs-owner');
addTask('runs-other-task', 'runs-owner');
addTask('runs-stranger-task', 'runs-stranger');

addRun('run-oldest', 'runs-task', now - 3_000, {
  status: 'failed',
  error: 'The provider went away.',
  summary: 'The provider went away.',
  exitState: 'failed:work-provider-error',
});
addRun('run-middle', 'runs-task', now - 2_000, {
  summary: 'Renamed the notes.\nRemoved the stale draft.',
  changedFiles: JSON.stringify(['notes.md', 'docs.md']),
  exitState: 'completed',
});
addRun('run-newest', 'runs-task', now - 1_000, {
  status: 'needs_input',
  summary: 'Which environment should this deploy to?',
  exitState: 'needs_input:round',
});
// A row written before results existed, plus a malformed array: neither may
// break the listing.
addRun('run-legacy', 'runs-other-task', now - 500);
addRun('run-malformed', 'runs-other-task', now - 400, {
  summary: 'Still readable.',
  changedFiles: 'not-json',
  exitState: 'completed',
});

const tokenFor = id =>
  authService.generateToken({
    id,
    username: id,
    email: null,
    role: 'admin',
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });

const app = express();
app.use(express.json());
app.use('/api/work', workRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Work runs test server did not expose a TCP port.');
}
const baseUrl = `http://127.0.0.1:${address.port}/api/work`;

const get = async (pathname, userId) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { Authorization: `Bearer ${tokenFor(userId)}` },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await closeDurableEventGateway();
  await closeWorkPlatform();
  await rm(dataDir, { recursive: true, force: true });
});

test('run history lists a task’s runs newest first with its persisted results', async () => {
  const { status, body } = await get('/tasks/runs-task/runs', 'runs-owner');
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(
    body.data.map(run => run.id),
    ['run-newest', 'run-middle', 'run-oldest']
  );

  const completed = body.data[1];
  assert.equal(completed.taskId, 'runs-task');
  assert.equal(
    completed.summary,
    'Renamed the notes.\nRemoved the stale draft.'
  );
  assert.deepEqual(completed.changedFiles, ['notes.md', 'docs.md']);
  assert.equal(completed.exitState, 'completed');

  const failed = body.data[2];
  assert.equal(failed.exitState, 'failed:work-provider-error');
  assert.equal(failed.error, 'The provider went away.');
  assert.equal(failed.changedFiles, undefined);
});

test('run history honors an explicit limit and caps an oversized one', async () => {
  const limited = await get('/tasks/runs-task/runs?limit=2', 'runs-owner');
  assert.equal(limited.status, 200);
  assert.deepEqual(
    limited.body.data.map(run => run.id),
    ['run-newest', 'run-middle']
  );

  // Above the ceiling the request still succeeds, clamped to the maximum.
  const oversized = await get('/tasks/runs-task/runs?limit=5000', 'runs-owner');
  assert.equal(oversized.status, 200);
  assert.equal(oversized.body.data.length, 3);

  // A nonsense limit is a request error, not a silent default.
  const invalid = await get('/tasks/runs-task/runs?limit=-1', 'runs-owner');
  assert.equal(invalid.status, 400);
});

test('legacy and malformed result columns degrade instead of failing', async () => {
  const { status, body } = await get(
    '/tasks/runs-other-task/runs',
    'runs-owner'
  );
  assert.equal(status, 200);
  const [malformed, legacy] = body.data;
  assert.equal(malformed.id, 'run-malformed');
  assert.equal(malformed.summary, 'Still readable.');
  assert.equal(malformed.changedFiles, undefined);
  assert.equal(legacy.id, 'run-legacy');
  assert.equal(legacy.summary, undefined);
  assert.equal(legacy.exitState, undefined);
});

test('a single run reads back by id, scoped to its own task and owner', async () => {
  const owned = await get('/tasks/runs-task/runs/run-middle', 'runs-owner');
  assert.equal(owned.status, 200);
  assert.equal(owned.body.data.id, 'run-middle');
  assert.deepEqual(owned.body.data.changedFiles, ['notes.md', 'docs.md']);

  // A real run id under the wrong task must read as missing, never as a
  // cross-task read.
  const crossTask = await get(
    '/tasks/runs-other-task/runs/run-middle',
    'runs-owner'
  );
  assert.equal(crossTask.status, 404);

  const missing = await get('/tasks/runs-task/runs/no-such-run', 'runs-owner');
  assert.equal(missing.status, 404);
});

test('run history and single runs stay owner-only', async () => {
  const list = await get('/tasks/runs-task/runs', 'runs-stranger');
  assert.equal(list.status, 404);
  assert.equal(list.body.success, false);

  const single = await get('/tasks/runs-task/runs/run-middle', 'runs-stranger');
  assert.equal(single.status, 404);

  // Unauthenticated callers never reach the handler at all.
  const anonymous = await fetch(`${baseUrl}/tasks/runs-task/runs`);
  assert.equal(anonymous.status, 401);
});

test('run reads stay readable while Work is fail-closed on recovery', () => {
  const source = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'work.ts'),
    'utf8'
  );
  // Reading what past runs produced never starts a runtime, so both GETs
  // join the read-only exemption ahead of the assertAcceptingWork gate.
  const listExemption = '/^\\/tasks\\/[^/]+\\/runs$/.test(req.path)';
  const singleExemption = '/^\\/tasks\\/[^/]+\\/runs\\/[^/]+$/.test(req.path)';
  const gateAt = source.indexOf('workRuntimeService.assertAcceptingWork()');
  assert.ok(gateAt !== -1);
  for (const exemption of [listExemption, singleExemption]) {
    const at = source.indexOf(exemption);
    assert.ok(at !== -1, `missing read-only exemption: ${exemption}`);
    assert.ok(at < gateAt);
  }
});
