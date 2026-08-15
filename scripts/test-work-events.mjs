import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-work-events-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'work-events-test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );
const [
  { getDatabase },
  { authService },
  { default: workRouter },
  { WORK_EVENT_MAX_RESUME_CURSOR, WorkEventService, workEventService },
  { getDurableJobRuntime },
  { getCoordinator },
  { closeDurableEventGateway, initializeDurableEventGateway },
  { default: workTaskService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/work.js'),
  distModule('services/workEventService.js'),
  distModule('platform/jobs/durableJobRuntime.js'),
  distModule('platform/coordination/service.js'),
  distModule('platform/events/service.js'),
  distModule('services/workTaskService.js'),
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
const addTaskAndRun = (taskId, runId, userId, status = 'running') => {
  db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, provider_type, provider_id, status,
      network_enabled, volume_name, container_name, preview_status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'test-model', 'ollama', NULL, ?, 1, ?, ?,
              'stopped', ?, ?)`
  ).run(
    taskId,
    userId,
    `Task ${taskId}`,
    status,
    `volume-${taskId}`,
    `container-${taskId}`,
    now,
    now
  );
  db.prepare(
    `INSERT INTO work_runs (
      id, task_id, model, provider_type, provider_id, status, created_at,
      started_at
    ) VALUES (?, ?, 'test-model', 'ollama', NULL, ?, ?, ?)`
  ).run(runId, taskId, status, now, now);
};

addUser('admin-a', 'admin');
addUser('admin-b', 'admin');
addUser('regular-user', 'user');
addTaskAndRun('task-a', 'run-a', 'admin-a');
addTaskAndRun('task-b', 'run-b', 'admin-b');
addTaskAndRun('task-terminal', 'run-terminal', 'admin-a', 'completed');

const tokenFor = (id, role) =>
  authService.generateToken({
    id,
    username: id,
    email: null,
    role,
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
  throw new Error('Work event test server did not expose a TCP port.');
}
const baseUrl = `http://127.0.0.1:${address.port}/api/work`;

after(async () => {
  workEventService.reset();
  await new Promise(resolve => server.close(resolve));
  await closeDurableEventGateway();
  await closeWorkPlatform();
  await rm(dataDir, { recursive: true, force: true });
});

test('WorkEventService isolates runs, replays monotonically, and unsubscribes', () => {
  const service = new WorkEventService({
    replayLimit: 8,
    replayMaxBytes: 100_000,
    retentionMs: 60_000,
  });
  const received = [];
  const unsubscribe = service.subscribe('task-1', 'run-1', event => {
    received.push(event);
  });

  const first = service.publish('task-1', 'run-1', 'run_state', {
    status: 'running',
    round: 1,
  });
  const second = service.publish('task-1', 'run-1', 'assistant_delta', {
    delta: 'Hello',
  });
  const otherRun = service.publish('task-1', 'run-2', 'assistant_delta', {
    delta: 'Separate',
  });

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.equal(otherRun.id, 1);
  assert.deepEqual(
    received.map(event => event.id),
    [1, 2]
  );
  assert.equal(service.getSubscriberCount('task-1', 'run-1'), 1);

  const replay = service.replay('task-1', 'run-1', 1);
  assert.equal(replay.snapshotEventId, 1);
  assert.equal(replay.latestEventId, 2);
  assert.equal(replay.truncated, false);
  assert.deepEqual(
    replay.events.map(event => event.id),
    [2]
  );
  assert.equal(replay.snapshot.status, 'running');
  assert.equal(replay.snapshot.round, 1);
  assert.equal(replay.snapshot.response, 'Hello');

  unsubscribe();
  unsubscribe();
  assert.equal(service.getSubscriberCount('task-1', 'run-1'), 0);
  service.reset();
});

test('WorkEventService bounds replay and reports a truncated cursor', () => {
  const service = new WorkEventService({
    replayLimit: 2,
    replayMaxBytes: 100_000,
    retentionMs: 60_000,
  });
  for (const delta of ['one', 'two', 'three']) {
    service.publish('task-1', 'run-1', 'assistant_delta', { delta });
  }

  const replay = service.replay('task-1', 'run-1', 0);
  assert.equal(replay.latestEventId, 3);
  assert.equal(replay.snapshotEventId, 1);
  assert.equal(replay.truncated, true);
  assert.deepEqual(
    replay.events.map(event => event.id),
    [2, 3]
  );
  assert.equal(replay.snapshot.response, 'onetwothree');
  service.reset();
});

test('WorkEventService retains bounded active snapshots until the run is terminal', async () => {
  const service = new WorkEventService({ retentionMs: 0 });
  service.publish('task-active', 'run-active', 'run_state', {
    status: 'running',
    phase: 'thinking',
    round: 1,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(
    service.replay('task-active', 'run-active').snapshot.status,
    'running'
  );

  service.publish('task-active', 'run-active', 'done', {
    status: 'completed',
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.replay('task-active', 'run-active').latestEventId, 0);
  service.reset();
});

test('WorkEventService isolates producers from broken subscribers', () => {
  const service = new WorkEventService({ retentionMs: 60_000 });
  const received = [];
  service.subscribe('task-1', 'run-1', () => {
    throw new Error('disconnected');
  });
  service.subscribe('task-1', 'run-1', event => received.push(event.id));

  assert.doesNotThrow(() => {
    service.publish('task-1', 'run-1', 'assistant_delta', {
      delta: 'still delivered',
    });
  });
  assert.deepEqual(received, [1]);
  assert.equal(service.getSubscriberCount('task-1', 'run-1'), 1);
  assert.throws(
    () =>
      service.advanceCursor(
        'task-1',
        'run-1',
        WORK_EVENT_MAX_RESUME_CURSOR + 1
      ),
    /safe range/
  );
  service.reset();
});

test('Work SSE authenticates, emits a snapshot, streams events, and cleans up', async () => {
  workEventService.reset();
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/tasks/task-a/runs/run-a/events?after=0`,
    {
      headers: { Authorization: `Bearer ${tokenFor('admin-a', 'admin')}` },
      signal: controller.signal,
    }
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') || '',
    /^text\/event-stream/
  );
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const stream = createSseReader(response);
  const snapshot = await stream.next();
  assert.equal(snapshot.event, 'snapshot');
  assert.equal(snapshot.id, 0);
  assert.equal(snapshot.data.type, 'snapshot');
  assert.equal(snapshot.data.taskId, 'task-a');
  assert.equal(snapshot.data.runId, 'run-a');
  assert.equal(snapshot.data.data.task.id, 'task-a');
  assert.equal(snapshot.data.data.task.activeRun.id, 'run-a');
  assert.equal(workEventService.getSubscriberCount('task-a', 'run-a'), 1);

  workEventService.publish('task-a', 'run-a', 'reasoning_delta', {
    delta: 'Inspecting the workspace',
  });
  const live = await stream.next();
  assert.equal(live.event, 'reasoning_delta');
  assert.equal(live.id, 1);
  assert.equal(live.data.data.delta, 'Inspecting the workspace');

  controller.abort();
  await stream.cancel();
  await waitFor(
    () => workEventService.getSubscriberCount('task-a', 'run-a') === 0
  );
});

test('Work SSE sends a current terminal snapshot and closes on done', async () => {
  workEventService.reset();
  workEventService.publish('task-a', 'run-a', 'assistant_delta', {
    delta: 'Finished',
  });
  workEventService.publish('task-a', 'run-a', 'done', {
    status: 'completed',
  });

  const response = await fetch(
    `${baseUrl}/tasks/task-a/runs/run-a/events?after=0`,
    {
      headers: { Authorization: `Bearer ${tokenFor('admin-a', 'admin')}` },
    }
  );
  assert.equal(response.status, 200);
  const stream = createSseReader(response);
  const snapshot = await stream.next();
  const done = await stream.next();
  assert.equal(snapshot.event, 'snapshot');
  assert.equal(snapshot.id, 2);
  assert.equal(snapshot.data.data.liveRun.response, 'Finished');
  assert.equal(snapshot.data.data.liveRun.status, 'completed');
  assert.equal(snapshot.data.data.liveRun.terminal, true);
  assert.equal(done.event, 'done');
  assert.equal(done.id, 3);
  assert.equal(await stream.isClosed(), true);
  await waitFor(
    () => workEventService.getSubscriberCount('task-a', 'run-a') === 0
  );
});

test('Work SSE advances a recreated active stream beyond the resume cursor', async () => {
  workEventService.reset();
  const controller = new AbortController();
  const response = await fetch(
    `${baseUrl}/tasks/task-a/runs/run-a/events?after=50`,
    {
      headers: { Authorization: `Bearer ${tokenFor('admin-a', 'admin')}` },
      signal: controller.signal,
    }
  );
  assert.equal(response.status, 200);
  const stream = createSseReader(response);
  const snapshot = await stream.next();
  assert.equal(snapshot.event, 'snapshot');
  assert.equal(snapshot.id, 50);

  const published = workEventService.publish(
    'task-a',
    'run-a',
    'assistant_delta',
    { delta: 'After restart' }
  );
  assert.equal(published.id, 51);
  const live = await stream.next();
  assert.equal(live.id, 51);
  assert.equal(live.data.data.delta, 'After restart');

  controller.abort();
  await stream.cancel();
  await waitFor(
    () => workEventService.getSubscriberCount('task-a', 'run-a') === 0
  );
});

test('Work SSE force disconnects clients that exceed the pending byte budget', async () => {
  workEventService.reset();
  const requestPath = '/api/work/tasks/task-a/runs/run-a/events?after=0';
  const originalDestroy = ServerResponse.prototype.destroy;
  let destroyCalls = 0;
  ServerResponse.prototype.destroy = function (...args) {
    if (this.req?.originalUrl === requestPath) destroyCalls += 1;
    return originalDestroy.apply(this, args);
  };

  const socket = createConnection({
    host: '127.0.0.1',
    port: address.port,
  });
  socket.on('error', () => {
    // The server intentionally resets a client that cannot accept more data.
  });

  try {
    await new Promise(resolve => socket.once('connect', resolve));
    socket.pause();
    socket.write(
      [
        `GET ${requestPath} HTTP/1.1`,
        `Host: 127.0.0.1:${address.port}`,
        `Authorization: Bearer ${tokenFor('admin-a', 'admin')}`,
        'Connection: keep-alive',
        '',
        '',
      ].join('\r\n')
    );
    await waitFor(
      () => workEventService.getSubscriberCount('task-a', 'run-a') === 1
    );

    const largeDelta = 'x'.repeat(64_000);
    for (let index = 0; index < 32; index += 1) {
      workEventService.publish('task-a', 'run-a', 'assistant_delta', {
        delta: largeDelta,
      });
    }

    await waitFor(
      () => workEventService.getSubscriberCount('task-a', 'run-a') === 0
    );
    assert.equal(destroyCalls, 1);
  } finally {
    ServerResponse.prototype.destroy = originalDestroy;
    socket.destroy();
  }
});

test('Work SSE closes a terminal database run after an expired event stream', async () => {
  workEventService.reset();
  const response = await fetch(
    `${baseUrl}/tasks/task-terminal/runs/run-terminal/events?after=73`,
    {
      headers: { Authorization: `Bearer ${tokenFor('admin-a', 'admin')}` },
    }
  );
  assert.equal(response.status, 200);
  const stream = createSseReader(response);
  const snapshot = await stream.next();
  const done = await stream.next();
  assert.equal(snapshot.id, 73);
  assert.equal(snapshot.data.data.liveRun.status, 'completed');
  assert.equal(snapshot.data.data.liveRun.terminal, true);
  assert.equal(done.event, 'done');
  assert.equal(done.id, 74);
  assert.equal(done.data.data.status, 'completed');
  assert.equal(await stream.isClosed(), true);
});

test('Work SSE enforces admin role, ownership, run identity, and cursor input', async () => {
  const cases = [
    {
      path: '/tasks/task-a/runs/run-a/events',
      token: tokenFor('regular-user', 'user'),
      status: 403,
    },
    {
      path: '/tasks/task-a/runs/run-a/events',
      token: tokenFor('admin-b', 'admin'),
      status: 404,
    },
    {
      path: '/tasks/task-a/runs/run-b/events',
      token: tokenFor('admin-a', 'admin'),
      status: 404,
    },
    {
      path: '/tasks/task-a/runs/run-a/events?after=-1',
      token: tokenFor('admin-a', 'admin'),
      status: 400,
    },
    {
      path: `/tasks/task-a/runs/run-a/events?after=${
        WORK_EVENT_MAX_RESUME_CURSOR + 1
      }`,
      token: tokenFor('admin-a', 'admin'),
      status: 400,
    },
  ];

  for (const candidate of cases) {
    const response = await fetch(`${baseUrl}${candidate.path}`, {
      headers: { Authorization: `Bearer ${candidate.token}` },
    });
    assert.equal(response.status, candidate.status);
    assert.match(
      response.headers.get('content-type') || '',
      /application\/json/
    );
  }
});

test('solo Work SSE snapshots an event published during snapshot construction', async () => {
  workEventService.reset();
  const originalRequireTaskDetail = workTaskService.requireTaskDetail;
  let injected = false;
  workTaskService.requireTaskDetail = async (...args) => {
    const detail = await originalRequireTaskDetail.apply(workTaskService, args);
    if (!injected) {
      injected = true;
      workEventService.publish('task-a', 'run-a', 'assistant_delta', {
        delta: 'solo gap',
        total: 'solo gap',
      });
    }
    return detail;
  };

  const controller = new AbortController();
  try {
    const response = await fetch(
      `${baseUrl}/tasks/task-a/runs/run-a/events?after=0`,
      {
        headers: { Authorization: `Bearer ${tokenFor('admin-a', 'admin')}` },
        signal: controller.signal,
      }
    );
    assert.equal(response.status, 200);
    const stream = createSseReader(response);
    const snapshot = await stream.next();
    assert.equal(snapshot.event, 'snapshot');
    assert.equal(snapshot.id, 1);
    assert.equal(snapshot.data.data.liveRun.response, 'solo gap');

    workEventService.publish('task-a', 'run-a', 'assistant_delta', {
      delta: ' live',
      total: 'solo gap live',
    });
    const live = await stream.next();
    assert.equal(live.event, 'assistant_delta');
    assert.equal(live.id, 2);
    assert.equal(live.data.data.total, 'solo gap live');
    await stream.cancel();
  } finally {
    controller.abort();
    workTaskService.requireTaskDetail = originalRequireTaskDetail;
  }
});

test('durable Work SSE compacts more than 512 events and replays the checkpoint gap', async () => {
  workEventService.reset();
  const service = getDurableJobRuntime().service;
  const streamId = 'work:task-a:run-a';
  for (let index = 0; index < 513; index += 1) {
    await service.appendEvent({
      eventId: randomUUID(),
      streamId,
      eventType: 'work.usage.v1',
      subjectId: 'run-a',
      payload: {
        mode: 'encrypted',
        value: {
          type: 'usage',
          taskId: 'task-a',
          runId: 'run-a',
          data: { durationMs: index },
        },
      },
    });
  }
  const checkpoint = await service.latestEventCursor(streamId);
  assert.equal(checkpoint, 513);

  const gateway = initializeDurableEventGateway(service, getCoordinator());
  workEventService.initializeDurableGateway(gateway);
  const originalRequireTaskDetail = workTaskService.requireTaskDetail;
  let injected = false;
  workTaskService.requireTaskDetail = async (...args) => {
    const detail = await originalRequireTaskDetail.apply(workTaskService, args);
    if (!injected) {
      injected = true;
      await workEventService.publish(
        'task-a',
        'run-a',
        'assistant_delta',
        { delta: 'gap', total: 'checkpoint gap' },
        'checkpoint-gap'
      );
    }
    return detail;
  };

  const controller = new AbortController();
  try {
    const response = await fetch(
      `${baseUrl}/tasks/task-a/runs/run-a/events?after=0`,
      {
        headers: { Authorization: `Bearer ${tokenFor('admin-a', 'admin')}` },
        signal: controller.signal,
      }
    );
    assert.equal(response.status, 200);
    const stream = createSseReader(response);
    const snapshot = await stream.next();
    const gap = await stream.next();
    assert.equal(snapshot.event, 'snapshot');
    assert.equal(snapshot.id, checkpoint);
    assert.equal(snapshot.data.data.replayTruncated, true);
    assert.equal(gap.event, 'assistant_delta');
    assert.equal(gap.id, checkpoint + 1);
    // Durable delta copies carry no accumulated total; the delta is the
    // replayable content.
    assert.equal(gap.data.data.delta, 'gap');
    assert.equal(gap.data.data.total, undefined);
    await stream.cancel();
  } finally {
    controller.abort();
    workTaskService.requireTaskDetail = originalRequireTaskDetail;
  }
});

test('an oversized delta event neither rejects nor wedges the durable stream', async () => {
  const runtime = getDurableJobRuntime().service;
  const streamId = 'work:task-a:run-a';
  const before = await runtime.latestEventCursor(streamId);

  // 100 KB accumulated total: over the 64 KiB durable payload cap and over
  // the 2 KiB identity component cap. This crashed the whole server before.
  const big = 'x'.repeat(100_000);
  const event = await workEventService.publish(
    'task-a',
    'run-a',
    'assistant_delta',
    { delta: 'tail', total: big }
  );
  // The durable copy drops the accumulated total (consumers rebuild it from
  // deltas); the delta itself must survive untouched.
  assert.equal(event.data.delta, 'tail');

  const followUp = await workEventService.publish('task-a', 'run-a', 'usage', {
    durationMs: 1,
  });
  assert.ok(followUp.id > event.id, 'the stream continues after the event');

  const after = await runtime.latestEventCursor(streamId);
  assert.ok(
    after >= before + 2,
    'both events must reach the durable log (total stripped, not dropped)'
  );
});

function createSseReader(response) {
  if (!response.body) throw new Error('SSE response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith(':')) return parseSseFrame(frame);
          continue;
        }
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream ended before an event.');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        // Aborting fetch may already have released the reader.
      }
    },
    async isClosed() {
      const chunk = await reader.read();
      return chunk.done;
    },
  };
}

function parseSseFrame(frame) {
  const lines = frame.split('\n');
  const id = Number(lines.find(line => line.startsWith('id: '))?.slice(4));
  const event = lines.find(line => line.startsWith('event: '))?.slice(7);
  const data = lines.find(line => line.startsWith('data: '))?.slice(6);
  if (!Number.isSafeInteger(id) || !event || !data) {
    throw new Error(`Invalid SSE frame: ${frame}`);
  }
  return { id, event, data: JSON.parse(data) };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Work event cleanup.');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
