import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const [{ LocalCoordinator }, controlModule] = await Promise.all([
  distModule('platform/coordination/index.js'),
  distModule('services/workScreenControlService.js'),
]);
const { WorkScreenControlService } = controlModule;

const service = async () => {
  const coordinator = new LocalCoordinator();
  await coordinator.connect();
  return new WorkScreenControlService(() => coordinator, Date.now);
};

test('one human holds the control lease at a time; renewal extends it', async () => {
  const control = await service();

  const first = await control.acquire('task-1', 'alice');
  assert.equal(first.userId, 'alice');
  assert.ok(first.expiresAt > Date.now());

  await assert.rejects(control.acquire('task-1', 'bob'), error => {
    assert.equal(error.code, 'WORK_SCREEN_CONTROL_HELD');
    assert.equal(error.status, 409);
    return true;
  });

  const renewed = await control.acquire('task-1', 'alice');
  assert.equal(renewed.acquiredAt, first.acquiredAt);
  assert.ok(renewed.expiresAt >= first.expiresAt);

  const current = await control.current('task-1');
  assert.equal(current?.userId, 'alice');
  // Another task is unaffected.
  assert.equal(await control.current('task-2'), undefined);
});

test('only the holder releases; release frees the lease for others', async () => {
  const control = await service();
  await control.acquire('task-1', 'alice');

  await assert.rejects(control.release('task-1', 'bob'), error => {
    assert.equal(error.code, 'WORK_SCREEN_CONTROL_NOT_HOLDER');
    return true;
  });
  await control.release('task-1', 'bob', { force: true });
  assert.equal(await control.current('task-1'), undefined);

  const next = await control.acquire('task-1', 'bob');
  assert.equal(next.userId, 'bob');
  await control.release('task-1', 'bob');
  assert.equal(await control.current('task-1'), undefined);
  // Releasing an unheld lease is a no-op.
  await control.release('task-1', 'bob');
});

test('an abandoned takeover lapses on its own TTL', async () => {
  const control = await service();
  await control.acquire('task-1', 'alice', 120);
  assert.equal((await control.current('task-1'))?.userId, 'alice');
  await delay(200);
  assert.equal(await control.current('task-1'), undefined);
  const successor = await control.acquire('task-1', 'bob');
  assert.equal(successor.userId, 'bob');
});

test('request_takeover wait resolves when a human takes over and hands back', async () => {
  const control = await service();

  const wait = control.waitForAssist('task-1', 'Sign in to example.com', {
    timeoutMs: 5_000,
    pollIntervalMs: 25,
  });
  await delay(50);
  const requested = await control.assistState('task-1');
  assert.equal(requested?.phase, 'requested');
  assert.equal(requested?.reason, 'Sign in to example.com');

  await control.acquire('task-1', 'alice');
  assert.equal((await control.assistState('task-1'))?.phase, 'taken');

  await control.release('task-1', 'alice');
  assert.equal(await wait, 'released');
  // The request is cleared once the wait settles.
  assert.equal(await control.assistState('task-1'), undefined);
});

test('an unanswered request times out; a held lease reports still_controlled', async () => {
  const control = await service();
  assert.equal(
    await control.waitForAssist('task-1', 'nobody comes', {
      timeoutMs: 150,
      pollIntervalMs: 25,
    }),
    'timeout'
  );

  const wait = control.waitForAssist('task-2', 'user lingers', {
    timeoutMs: 200,
    pollIntervalMs: 25,
  });
  await delay(40);
  await control.acquire('task-2', 'alice');
  assert.equal(await wait, 'still_controlled');
  assert.equal((await control.current('task-2'))?.userId, 'alice');
});

test('a human already driving counts as the takeover having happened', async () => {
  const control = await service();
  await control.acquire('task-1', 'alice');
  const wait = control.waitForAssist('task-1', 'already driving', {
    timeoutMs: 5_000,
    pollIntervalMs: 25,
  });
  await delay(40);
  assert.equal((await control.assistState('task-1'))?.phase, 'taken');
  await control.release('task-1', 'alice');
  assert.equal(await wait, 'released');
});

test('cancelling the run aborts the wait', async () => {
  const control = await service();
  const abort = new AbortController();
  const wait = control.waitForAssist('task-1', 'cancelled run', {
    timeoutMs: 5_000,
    pollIntervalMs: 25,
    signal: abort.signal,
  });
  await delay(40);
  abort.abort();
  await assert.rejects(wait, error => {
    assert.equal(error.code, 'WORK_SCREEN_ASSIST_CANCELLED');
    return true;
  });
});

test('work-screen tickets survive the issue/consume round trip', async () => {
  // Regression: the ticket validator once accepted only chat and
  // work-terminal audiences, so every screen viewer got a 401 and the
  // Work Computer was unwatchable through the relay.
  const { WebSocketTicketService } = await distModule(
    'services/websocketTicketService.js'
  );
  const tickets = new WebSocketTicketService();
  for (const audience of ['chat', 'work-terminal', 'work-screen']) {
    const resource = audience === 'chat' ? undefined : 'task-1';
    const issued = await tickets.issue(
      'user-1',
      Date.now() + 60_000,
      audience,
      resource
    );
    const consumed = await tickets.consume(issued.ticket, audience, resource);
    assert.equal(consumed?.userId, 'user-1', `audience ${audience}`);
  }
});
