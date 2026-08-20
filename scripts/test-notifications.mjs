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

/*
 * Notifications (NOTIFY-01): the durable per-user inbox (encrypted,
 * deduplicated, capped), live fan-out on the per-user event stream,
 * producer wiring (DMs, mentions, shares, automation failures), and
 * admin webhook targets with egress guarding, HMAC signatures, redacted
 * envelopes, and retry semantics.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-notify-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'notify-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '6'.repeat(64);
// The webhook test target runs on loopback; production keeps this empty.
process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1';

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
const { initializeCoordinator, getCoordinator } = await distModule(
  'platform/coordination/service.js'
);
await initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
const runtime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const eventsModule = await distModule('platform/events/index.js');
eventsModule.initializeDurableEventGateway(runtime.service, getCoordinator());

const [
  { getDatabase },
  { notificationService },
  { channelService },
  grantService,
  noteService,
  { default: automationService },
  { notificationEventStreamId, WEBHOOK_DELIVER_JOB_TYPE },
  { createDomainDurableJobHandlers },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/notificationService.js'),
  distModule('services/channelService.js'),
  distModule('services/resourceGrantService.js'),
  distModule('services/noteService.js'),
  distModule('services/automationService.js'),
  distModule('platform/jobs/domainJobContracts.js'),
  distModule('platform/jobs/domainJobHandlers.js'),
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
};
const OWNER = 'notify-owner';
const FRIEND = 'notify-friend';
createUser(OWNER);
createUser(FRIEND);

after(async () => {
  await runtime.close?.();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('the inbox is durable, encrypted, deduplicated, and capped', async () => {
  const published = await notificationService.publish({
    userId: OWNER,
    type: 'system',
    title: 'Welcome to the team workspace',
    body: 'Secret details inside',
    sourceKey: 'welcome',
  });
  assert.equal(published, true);
  // Publishing the same source key again collapses into the existing row.
  assert.equal(
    await notificationService.publish({
      userId: OWNER,
      type: 'system',
      title: 'Welcome again',
      sourceKey: 'welcome',
    }),
    false
  );
  const listed = await notificationService.list(OWNER, {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'Welcome to the team workspace');
  assert.equal(listed[0].body, 'Secret details inside');

  // Encrypted at rest.
  const raw = database
    .prepare('SELECT title, body FROM notifications WHERE id = ?')
    .get(listed[0].id);
  assert.ok(!raw.title.includes('Welcome'));
  assert.ok(!raw.body.includes('Secret'));

  // Read state.
  assert.equal(await notificationService.countUnread(OWNER), 1);
  await notificationService.markRead(OWNER, listed[0].id);
  assert.equal(await notificationService.countUnread(OWNER), 0);

  // Another user's inbox is untouched.
  assert.equal((await notificationService.list(FRIEND, {})).length, 0);
});

test('publishing fans out on the per-user durable stream', async () => {
  const received = [];
  const gateway = eventsModule.getDurableEventGateway();
  const subscription = await gateway.subscribe({
    afterCursor: 0,
    streamId: notificationEventStreamId(FRIEND),
    batchSize: 50,
    maxReplayEvents: 500,
    authorize: async () => true,
    onEvent: async event => received.push(event),
    onError: () => undefined,
  });
  try {
    await notificationService.publish({
      userId: FRIEND,
      type: 'system',
      title: 'Live delivery works',
    });
    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(received.length, 1);
    assert.equal(received[0].eventType, 'notify.item.v1');
    assert.equal(
      received[0].payload.notification.title,
      'Live delivery works'
    );
  } finally {
    await subscription.close();
  }
});

test('channel DMs, mentions, and thread replies notify the right members', async () => {
  const dm = await channelService.openDm({ userId: OWNER }, FRIEND);
  await channelService.postUserMessage({ userId: OWNER }, dm.id, {
    content: 'Ping via direct message',
  });
  let friendInbox = await notificationService.list(FRIEND, {});
  const dmNote = friendInbox.find(entry => entry.type === 'channel-dm');
  assert.ok(dmNote);
  assert.match(dmNote.title, /direct message/);
  assert.equal(dmNote.href, `/channels/${dm.id}`);

  const room = await channelService.createChannel(
    { userId: OWNER },
    { type: 'public', name: 'Notify room', memberIds: [FRIEND] }
  );
  const root = await channelService.postUserMessage(
    { userId: FRIEND },
    room.id,
    { content: 'Root message from the friend' }
  );
  await channelService.postUserMessage({ userId: OWNER }, room.id, {
    content: `Hey @${FRIEND}, please review this`,
  });
  friendInbox = await notificationService.list(FRIEND, {});
  assert.ok(
    friendInbox.some(
      entry =>
        entry.type === 'channel-mention' && /mentioned you/.test(entry.title)
    )
  );
  await channelService.postUserMessage({ userId: OWNER }, room.id, {
    content: 'Replying in your thread',
    parentId: root.message.id,
  });
  friendInbox = await notificationService.list(FRIEND, {});
  assert.ok(
    friendInbox.some(entry => /replied to your message/.test(entry.title))
  );
  // The author never notifies themselves.
  const ownInbox = await notificationService.list(OWNER, {});
  assert.ok(!ownInbox.some(entry => entry.type === 'channel-mention'));
});

test('shares and automation failures land in the inbox', async () => {
  const note = await noteService.createNote(
    { userId: OWNER },
    { title: 'Shared later', content: 'body' }
  );
  await grantService.createGrant(
    { userId: OWNER },
    {
      resourceType: 'note',
      resourceId: note.id,
      principalType: 'user',
      principalId: FRIEND,
      permission: 'read',
    }
  );
  const friendInbox = await notificationService.list(FRIEND, {});
  assert.ok(
    friendInbox.some(
      entry => entry.type === 'share' && /shared a note with you/.test(entry.title)
    )
  );

  const automation = await automationService.createAutomation(
    {
      name: 'Nightly digest',
      instructions: 'Summarize the day',
      triggers: [{ kind: 'daily', hour: 6, minute: 0 }],
      notify: 'app',
    },
    OWNER
  );
  const run = await automationService.createRun(
    automation.id,
    OWNER,
    Date.now()
  );
  await automationService.finalizeRun(run.id, 'failed', 'provider exploded', {
    userId: OWNER,
    automationId: automation.id,
  });
  const ownerInbox = await notificationService.list(OWNER, {});
  const failure = ownerInbox.find(
    entry => entry.type === 'automation-failed'
  );
  assert.ok(failure);
  assert.match(failure.title, /Nightly digest/);
  assert.equal(failure.body, 'provider exploded');
});

test('webhook targets are egress-guarded, signed, redacted, and retried', async () => {
  // Private destinations are rejected unless explicitly allowlisted.
  await assert.rejects(
    notificationService.saveWebhookTarget(OWNER, {
      name: 'Internal probe',
      url: 'http://169.254.169.254/latest/meta-data',
      events: ['*'],
    })
  );

  const deliveries = [];
  let respondWith = 200;
  const receiver = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      deliveries.push({ headers: request.headers, body });
      response.statusCode = respondWith;
      response.end('ok');
    });
  });
  await new Promise((resolve, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', resolve);
  });
  after(async () => {
    await new Promise(resolve => receiver.close(resolve));
  });
  const receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;

  const target = await notificationService.saveWebhookTarget(OWNER, {
    name: 'Team feed',
    url: receiverUrl,
    secret: 'webhook-shared-secret',
    events: ['system'],
  });
  assert.equal(target.hasSecret, true);

  await notificationService.publish({
    userId: OWNER,
    type: 'system',
    title: 'Deploy finished',
    body: 'This body must never leave the instance',
    sourceKey: 'deploy-1',
  });
  const job = await runtime.service.getByIdempotency(
    OWNER,
    WEBHOOK_DELIVER_JOB_TYPE,
    `${target.id}:${(await notificationService.list(OWNER, {}))
      .find(entry => entry.title === 'Deploy finished')
      .id.toString()}`
  );
  assert.ok(job, 'a delivery job was enqueued for the subscribed target');

  const handler = createDomainDurableJobHandlers().get(
    WEBHOOK_DELIVER_JOB_TYPE
  );
  const context = payload => ({
    payload,
    actorUserId: OWNER,
    attemptCount: 1,
    signal: new AbortController().signal,
    sideEffectLease: { jobId: job.id, leaseToken: 1, workerId: 'test' },
    reportProgress: async () => undefined,
    assertSideEffectAllowed: async () => undefined,
  });
  const eventPayload = {
    targetId: target.id,
    event: {
      event: 'notification.created',
      notificationType: 'system',
      title: 'Deploy finished',
      userId: OWNER,
      createdAt: Date.now(),
    },
  };
  await handler(context(eventPayload));
  assert.equal(deliveries.length, 1);
  const delivered = deliveries[0];
  // Signed with the shared secret over the exact body.
  const expected =
    'sha256=' +
    createHmac('sha256', 'webhook-shared-secret')
      .update(delivered.body)
      .digest('hex');
  assert.equal(delivered.headers['x-libre-signature'], expected);
  // Redacted: the notification body never leaves the instance.
  assert.ok(!delivered.body.includes('must never leave'));
  assert.ok(delivered.body.includes('Deploy finished'));

  // A 5xx response asks the job system to retry; a 2xx settles.
  respondWith = 503;
  await assert.rejects(handler(context(eventPayload)), /responded 503/);

  // Unsubscribed types never enqueue a delivery.
  await notificationService.publish({
    userId: OWNER,
    type: 'share',
    title: 'Not subscribed',
    sourceKey: 'unsub-1',
  });
  const shareNotification = (await notificationService.list(OWNER, {})).find(
    entry => entry.title === 'Not subscribed'
  );
  assert.equal(
    await runtime.service.getByIdempotency(
      OWNER,
      WEBHOOK_DELIVER_JOB_TYPE,
      `${target.id}:${shareNotification.id}`
    ),
    null
  );

  await notificationService.deleteWebhookTarget(target.id);
  assert.equal((await notificationService.listWebhookTargets()).length, 0);
});
