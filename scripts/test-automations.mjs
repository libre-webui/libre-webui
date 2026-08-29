/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-automations-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'automations-test-secret';
process.env.ENCRYPTION_KEY ||= '1'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});
const workPersistenceModule = await distModule(
  'platform/workPersistence/index.js'
);
workPersistenceModule.initializeSelectedWorkPersistence('sqlite');
const coordinationModule = await distModule('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
const { automationRunIdempotencyScope } = await distModule(
  'platform/jobs/domainJobContracts.js'
);
const durableRuntime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const [
  { getDatabase },
  { authService },
  { default: automationsRouter },
  { default: automationSchedulerService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/automations.js'),
  distModule('services/automationSchedulerService.js'),
]);

const database = getDatabase();
const now = Date.now();
const createUser = id => {
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status, avatar,
          created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
    )
    .run(id, id, now, now);
  return authService.generateToken({
    id,
    username: id,
    email: null,
    role: 'user',
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
};

const ownerToken = createUser('automation-owner');
const strangerToken = createUser('automation-stranger');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/automations', automationsRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/api/automations`;
const headersFor = token => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await jobsModule.closeDurableJobRuntime();
  await coordinationModule.closeCoordinator();
  workPersistenceModule.resetWorkPersistenceForTests();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('automations enforce validation, ownership, and pause semantics', async () => {
  let response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Morning brief',
      instructions: 'Summarize the news for me.',
      triggers: [{ kind: 'daily', hour: 8, minute: 0 }],
      notify: 'app',
    }),
  });
  assert.equal(response.status, 200);
  const created = (await response.json()).data;
  assert.equal(created.status, 'active');
  assert.ok(
    created.nextRunAt > Date.now(),
    'a fresh automation schedules its next run in the future'
  );

  // Malformed triggers and empty names never persist.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Broken',
      instructions: 'x',
      triggers: [{ kind: 'weekly', dayOfWeek: 9, hour: 1, minute: 0 }],
    }),
  });
  assert.equal(response.status, 400);
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: '',
      instructions: 'x',
      triggers: [{ kind: 'daily', hour: 1, minute: 0 }],
    }),
  });
  assert.equal(response.status, 400);

  // Another user cannot see or mutate the automation.
  response = await fetch(baseUrl, { headers: headersFor(strangerToken) });
  assert.deepEqual((await response.json()).data, []);
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'DELETE',
    headers: headersFor(strangerToken),
  });
  assert.equal(response.status, 404);

  // Pause clears the schedule; resume restores it.
  response = await fetch(`${baseUrl}/${created.id}/pause`, {
    method: 'POST',
    headers: headersFor(ownerToken),
  });
  assert.equal(response.status, 200);
  let paused = (await response.json()).data;
  assert.equal(paused.status, 'paused');
  assert.equal(paused.nextRunAt, undefined);
  response = await fetch(`${baseUrl}/${created.id}/resume`, {
    method: 'POST',
    headers: headersFor(ownerToken),
  });
  const resumed = (await response.json()).data;
  assert.equal(resumed.status, 'active');
  assert.ok(resumed.nextRunAt > Date.now());

  // Occurrence projection covers the calendar surface.
  const from = Date.now();
  const to = from + 3 * 24 * 60 * 60 * 1000;
  response = await fetch(`${baseUrl}/occurrences?from=${from}&to=${to}`, {
    headers: headersFor(ownerToken),
  });
  const occurrences = (await response.json()).data;
  assert.equal(occurrences.length, 3);
  assert.ok(occurrences.every(item => item.automationId === created.id));
  assert.ok(occurrences.every(item => item.at >= from && item.at < to));

  // Editing replaces triggers and reschedules.
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PUT',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Morning brief',
      instructions: 'Summarize the news for me.',
      triggers: [{ kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 }],
    }),
  });
  assert.equal(response.status, 200);
  const updated = (await response.json()).data;
  assert.equal(updated.triggers[0].kind, 'weekly');

  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'DELETE',
    headers: headersFor(ownerToken),
  });
  assert.equal(response.status, 200);
});

test('a work-target automation stores its target and validates the policy', async () => {
  // Default target is chat; an explicit work target persists.
  let response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Nightly build check',
      instructions: 'Clone the repo and run the test suite.',
      triggers: [{ kind: 'daily', hour: 2, minute: 0 }],
      target: 'work',
    }),
  });
  assert.equal(response.status, 200);
  const created = (await response.json()).data;
  assert.equal(created.target, 'work');
  assert.equal(created.workPolicyId, undefined);

  // An unknown Work policy is refused at save time.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Bad policy',
      instructions: 'Run something.',
      triggers: [{ kind: 'daily', hour: 3, minute: 0 }],
      target: 'work',
      workPolicyId: 'no-such-policy',
    }),
  });
  assert.equal(response.status, 400);

  // A chat-target automation ignores any stray policy id.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Chat with stray policy',
      instructions: 'Say hi.',
      triggers: [{ kind: 'daily', hour: 4, minute: 0 }],
      target: 'chat',
      workPolicyId: 'no-such-policy',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.target, 'chat');

  // Unknown target values normalize to chat instead of erroring.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Weird target',
      instructions: 'Do a thing.',
      triggers: [{ kind: 'daily', hour: 5, minute: 0 }],
      target: 'teleport',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.target, 'chat');
});

test('a routine binds only to a Work task its owner can use', async () => {
  const taskId = 'agent-task-bind';
  database
    .prepare(
      `INSERT INTO work_tasks (
        id, user_id, title, model, volume_name, container_name,
        created_at, updated_at
      ) VALUES (?, 'automation-owner', 'Chief of Staff', 'test-model',
                'vol-bind', 'ctr-bind', ?, ?)`
    )
    .run(taskId, now, now);

  // A bound routine persists the task and drops any policy binding: the
  // task already carries its own runtime.
  let response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Morning briefing',
      instructions: 'Summarize the inbox into briefing.md.',
      triggers: [{ kind: 'daily', hour: 8, minute: 0 }],
      target: 'work',
      workTaskId: taskId,
      workPolicyId: 'no-such-policy',
    }),
  });
  assert.equal(response.status, 200);
  const bound = (await response.json()).data;
  assert.equal(bound.workTaskId, taskId);
  assert.equal(bound.workPolicyId, undefined);

  // A dangling task is refused at save time.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Dangling task',
      instructions: 'Run something.',
      triggers: [{ kind: 'daily', hour: 9, minute: 0 }],
      target: 'work',
      workTaskId: 'no-such-task',
    }),
  });
  assert.equal(response.status, 400);

  // Another user's task is refused the same way, without existence leaks.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(strangerToken),
    body: JSON.stringify({
      name: 'Foreign task',
      instructions: 'Run something.',
      triggers: [{ kind: 'daily', hour: 10, minute: 0 }],
      target: 'work',
      workTaskId: taskId,
    }),
  });
  assert.equal(response.status, 400);

  // A chat-target automation ignores a stray task binding.
  response = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Chat with stray task',
      instructions: 'Say hi.',
      triggers: [{ kind: 'daily', hour: 11, minute: 0 }],
      target: 'chat',
      workTaskId: taskId,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.workTaskId, undefined);
});

test('the scheduler fires due automations once and settles stalled runs', async () => {
  const createResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Fire drill',
      instructions: 'Run the drill.',
      triggers: [{ kind: 'daily', hour: 6, minute: 30 }],
    }),
  });
  const automation = (await createResponse.json()).data;

  // Force the schedule into the past to simulate a due occurrence.
  const dueAt = Date.now() - 60_000;
  database
    .prepare('UPDATE automations SET next_run_at = ? WHERE id = ?')
    .run(dueAt, automation.id);

  const tickNow = Date.now();
  const first = await automationSchedulerService.tick(tickNow);
  assert.equal(first.fired, 1, 'the due automation fires exactly once');

  const runs = database
    .prepare('SELECT * FROM automation_runs WHERE automation_id = ?')
    .all(automation.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'queued');
  assert.equal(runs[0].scheduled_for, dueAt);

  // The durable run job was enqueued under the occurrence identity.
  const job = await durableRuntime.service.getByIdempotency(
    'automation-owner',
    automationRunIdempotencyScope(automation.id),
    String(dueAt)
  );
  assert.ok(job, 'the automation run job reached the durable queue');

  // The schedule advanced past now: catch-up never replays missed slots.
  const row = database
    .prepare('SELECT next_run_at FROM automations WHERE id = ?')
    .get(automation.id);
  assert.ok(row.next_run_at > tickNow);

  const second = await automationSchedulerService.tick(Date.now());
  assert.equal(second.fired, 0, 'the same occurrence never fires twice');

  // A queued run that never starts is finalized as failed once stale.
  database
    .prepare('UPDATE automation_runs SET created_at = ? WHERE id = ?')
    .run(Date.now() - 31 * 60 * 1000, runs[0].id);
  // Cancel the job so settlement does not treat it as still pending.
  durableRuntime.service.cancel(job.id, 'automation-owner');
  const third = await automationSchedulerService.tick(Date.now());
  assert.ok(third.settled >= 1, 'the stalled run settles as failed');
  const settled = database
    .prepare('SELECT status, error FROM automation_runs WHERE id = ?')
    .get(runs[0].id);
  assert.equal(settled.status, 'failed');

  // Run-now enqueues a manual run immediately.
  const runNowResponse = await fetch(`${baseUrl}/${automation.id}/run`, {
    method: 'POST',
    headers: headersFor(ownerToken),
  });
  assert.equal(runNowResponse.status, 202);
  const { runId } = (await runNowResponse.json()).data;
  const manualRun = database
    .prepare('SELECT status FROM automation_runs WHERE id = ?')
    .get(runId);
  assert.equal(manualRun.status, 'queued');
});

test('webhook secrets gate inbound fires with constant-time checks', async () => {
  // A fresh automation starts with the webhook disabled.
  const createResponse = await fetch(baseUrl, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      name: 'Webhook target',
      instructions: 'Summarize the release.',
      triggers: [{ kind: 'daily', hour: 6, minute: 0 }],
    }),
  });
  assert.equal(createResponse.status, 200);
  const automation = (await createResponse.json()).data;
  assert.equal(automation.webhookEnabled, false);

  // Disabled webhook: any fire attempt is refused without an id oracle.
  const disabledFire = await fetch(`${baseUrl}/${automation.id}/webhook`, {
    method: 'POST',
  });
  assert.equal(disabledFire.status, 401);
  const missingFire = await fetch(`${baseUrl}/never-existed/webhook`, {
    method: 'POST',
    headers: { 'X-Libre-Webhook-Secret': 'lwh_guess' },
  });
  assert.equal(missingFire.status, 401);

  // Only the owner can mint the secret; it is returned exactly once.
  const strangerRotate = await fetch(
    `${baseUrl}/${automation.id}/webhook-secret`,
    { method: 'POST', headers: headersFor(strangerToken) }
  );
  assert.equal(strangerRotate.status, 404);
  const rotateResponse = await fetch(
    `${baseUrl}/${automation.id}/webhook-secret`,
    { method: 'POST', headers: headersFor(ownerToken) }
  );
  assert.equal(rotateResponse.status, 200);
  const { secret, path: hookPath } = (await rotateResponse.json()).data;
  assert.match(secret, /^lwh_[A-Za-z0-9_-]{40,}$/);
  assert.equal(hookPath, `/api/automations/${automation.id}/webhook`);
  const listed = await fetch(baseUrl, { headers: headersFor(ownerToken) });
  assert.equal(
    (await listed.json()).data.find(item => item.id === automation.id)
      .webhookEnabled,
    true
  );

  // A wrong secret is refused; the right one fires a queued run.
  const wrongFire = await fetch(`${baseUrl}/${automation.id}/webhook`, {
    method: 'POST',
    headers: { 'X-Libre-Webhook-Secret': 'lwh_wrong' },
  });
  assert.equal(wrongFire.status, 401);
  const fired = await fetch(`${baseUrl}/${automation.id}/webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(fired.status, 202);
  const { runId } = (await fired.json()).data;
  const queued = database
    .prepare('SELECT status, user_id FROM automation_runs WHERE id = ?')
    .get(runId);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.user_id, 'automation-owner');
  const job = await durableRuntime.service.getByIdempotency(
    'automation-owner',
    automationRunIdempotencyScope(automation.id),
    `manual:${runId}`
  );
  assert.ok(job, 'the webhook fire enqueues the standard manual-run job');

  // A pause means pause for external callers.
  await fetch(`${baseUrl}/${automation.id}/pause`, {
    method: 'POST',
    headers: headersFor(ownerToken),
  });
  const pausedFire = await fetch(`${baseUrl}/${automation.id}/webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(pausedFire.status, 409);
  await fetch(`${baseUrl}/${automation.id}/resume`, {
    method: 'POST',
    headers: headersFor(ownerToken),
  });

  // Rotation invalidates the previous secret; disabling closes the door.
  const rotatedAgain = await fetch(
    `${baseUrl}/${automation.id}/webhook-secret`,
    { method: 'POST', headers: headersFor(ownerToken) }
  );
  const nextSecret = (await rotatedAgain.json()).data.secret;
  assert.notEqual(nextSecret, secret);
  const staleFire = await fetch(`${baseUrl}/${automation.id}/webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}` },
  });
  assert.equal(staleFire.status, 401);
  const disableResponse = await fetch(
    `${baseUrl}/${automation.id}/webhook-secret`,
    { method: 'DELETE', headers: headersFor(ownerToken) }
  );
  assert.equal(disableResponse.status, 200);
  const closedFire = await fetch(`${baseUrl}/${automation.id}/webhook`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nextSecret}` },
  });
  assert.equal(closedFire.status, 401);
});
