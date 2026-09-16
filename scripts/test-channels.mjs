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
 * Channels (CHANNEL-01/02/03): membership-gated timelines with idempotent
 * posts, one-level threads, reactions, pins, unread cursors, encrypted
 * content at rest, durable-event fan-out, attachments with permission
 * checks at upload and download, and @model mentions that run strictly
 * under the invoking member's identity.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-channels-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'channels-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '5'.repeat(64);
process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1,localhost';

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
const { initializeCoordinator } = await distModule(
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
const { getCoordinator } = await distModule('platform/coordination/service.js');
eventsModule.initializeDurableEventGateway(runtime.service, getCoordinator());

const [
  { getDatabase },
  { authService },
  { default: channelsRouter },
  { channelService },
  { getDurableEventGateway },
  { channelEventStreamId, CHANNEL_MENTION_JOB_TYPE },
  { createDomainDurableJobHandlers },
  toolServers,
  toolAccess,
  { default: ollamaService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/channels.js'),
  distModule('services/channelService.js'),
  distModule('platform/events/index.js'),
  distModule('platform/jobs/domainJobContracts.js'),
  distModule('platform/jobs/domainJobHandlers.js'),
  distModule('services/toolServerService.js'),
  distModule('services/toolAccessService.js'),
  distModule('services/ollamaService.js'),
]);

const database = getDatabase();
const now = Date.now();
const tokens = new Map();
const createUser = id => {
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status, avatar,
          created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
    )
    .run(id, id, now, now);
  tokens.set(
    id,
    authService.generateToken({
      id,
      username: id,
      email: null,
      role: 'user',
      status: 'active',
      avatar: null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    })
  );
};

const ALICE = 'channel-alice';
const BOB = 'channel-bob';
const CAROL = 'channel-carol';
for (const id of [ALICE, BOB, CAROL]) createUser(id);
const alice = { userId: ALICE };
const bob = { userId: BOB };
const carol = { userId: CAROL };

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/api/channels', channelsRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const base = `http://127.0.0.1:${port}/api/channels`;
const headersFor = user => ({
  Authorization: `Bearer ${tokens.get(user)}`,
  'Content-Type': 'application/json',
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await runtime.close?.();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('channel lifecycle: types, membership rules, and encrypted names', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'private',
    name: 'Launch planning',
    description: 'Coordinating the spring launch',
    memberIds: [BOB],
  });
  assert.equal(channel.type, 'private');
  assert.equal(channel.name, 'Launch planning');

  // Channel names are encrypted at rest.
  const raw = database
    .prepare('SELECT name FROM channels WHERE id = ?')
    .get(channel.id);
  assert.ok(!raw.name.includes('Launch planning'));

  // Members see it; outsiders get a non-enumerating 404.
  const members = await channelService.listMembers(bob, channel.id);
  assert.deepEqual(
    members.map(member => member.userId).sort(),
    [ALICE, BOB].sort()
  );
  await assert.rejects(channelService.listMembers(carol, channel.id), {
    statusCode: 404,
  });

  // Only the owner invites into a private channel.
  await assert.rejects(channelService.addMember(bob, channel.id, CAROL), {
    statusCode: 404,
  });
  await channelService.addMember(alice, channel.id, CAROL);
  assert.equal((await channelService.listMembers(carol, channel.id)).length, 3);

  // Owner removes a member; the removed member loses access immediately.
  await channelService.removeMember(alice, channel.id, CAROL);
  await assert.rejects(channelService.listMembers(carol, channel.id), {
    statusCode: 404,
  });

  // The owner cannot leave; deletion is the owner's exit.
  await assert.rejects(
    channelService.removeMember(alice, channel.id, ALICE),
    /delete the channel/
  );

  // Public channels are browseable and joinable.
  const town = await channelService.createChannel(alice, {
    type: 'public',
    name: 'Town square',
  });
  const browsable = await channelService.listPublic(carol);
  assert.ok(browsable.some(entry => entry.id === town.id && !entry.isMember));
  await channelService.join(carol, town.id);
  assert.ok(
    (await channelService.listMine(carol)).some(entry => entry.id === town.id)
  );
  // Private channels never appear in the public listing.
  assert.ok(!browsable.some(entry => entry.id === channel.id));
});

test('direct messages deduplicate per pair and stay two-person', async () => {
  const first = await channelService.openDm(alice, BOB);
  const second = await channelService.openDm(bob, ALICE);
  assert.equal(first.id, second.id);
  assert.equal(first.type, 'dm');
  await assert.rejects(channelService.addMember(alice, first.id, CAROL), {
    statusCode: 400,
  });
  const mine = await channelService.listMine(alice);
  const dm = mine.find(entry => entry.id === first.id);
  assert.equal(dm.dmPeer.userId, BOB);
});

test('timeline: idempotent posts, ordering, threads, edit and tombstone rules', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'public',
    name: 'Timeline',
    memberIds: [BOB],
  });
  await channelService.join(bob, channel.id);

  const clientId = randomUUID();
  const first = await channelService.postUserMessage(alice, channel.id, {
    id: clientId,
    content: 'First message',
  });
  assert.equal(first.created, true);
  const replay = await channelService.postUserMessage(alice, channel.id, {
    id: clientId,
    content: 'Different content that must not apply',
  });
  assert.equal(replay.created, false);
  assert.equal(replay.message.content, 'First message');

  await channelService.postUserMessage(bob, channel.id, {
    content: 'Second message',
  });
  const timeline = await channelService.listTimeline(bob, channel.id, {});
  assert.deepEqual(
    timeline.map(message => message.content),
    ['First message', 'Second message']
  );
  assert.equal(timeline[0].author.username, ALICE);

  // Message content is encrypted at rest.
  const rawMessage = database
    .prepare('SELECT content FROM channel_messages WHERE id = ?')
    .get(clientId);
  assert.ok(!rawMessage.content.includes('First message'));

  // One-level threads with reply counts.
  const reply = await channelService.postUserMessage(bob, channel.id, {
    content: 'A threaded reply',
    parentId: clientId,
  });
  await assert.rejects(
    channelService.postUserMessage(alice, channel.id, {
      content: 'Too deep',
      parentId: reply.message.id,
    }),
    /one level deep/
  );
  const thread = await channelService.listThread(alice, clientId);
  assert.deepEqual(
    thread.map(message => message.content),
    ['First message', 'A threaded reply']
  );
  const rootPage = await channelService.listTimeline(alice, channel.id, {});
  assert.equal(rootPage.find(message => message.id === clientId).replyCount, 1);
  // Thread replies stay out of the root timeline.
  assert.ok(!rootPage.some(message => message.id === reply.message.id));

  // Edits are author-only.
  await assert.rejects(channelService.editMessage(bob, clientId, 'Hijacked'), {
    statusCode: 404,
  });
  const edited = await channelService.editMessage(
    alice,
    clientId,
    'First message (edited)'
  );
  assert.ok(edited.editedAt);

  // Deleting the thread root tombstones it without orphaning the reply.
  await channelService.deleteMessage(alice, clientId);
  const afterDelete = await channelService.listThread(alice, clientId);
  assert.equal(afterDelete[0].deleted, true);
  assert.equal(afterDelete[0].content, '');
  assert.equal(afterDelete[1].content, 'A threaded reply');

  // Channel owners may delete other members' messages; strangers may not.
  const bobMessage = await channelService.postUserMessage(bob, channel.id, {
    content: 'To be moderated',
  });
  await assert.rejects(
    channelService.deleteMessage(carol, bobMessage.message.id),
    { statusCode: 404 }
  );
  await channelService.deleteMessage(alice, bobMessage.message.id);
});

test('cursor paging walks the timeline in both directions', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'public',
    name: 'Paging',
  });
  const ids = [];
  for (let index = 0; index < 7; index += 1) {
    const posted = await channelService.postUserMessage(alice, channel.id, {
      content: `message ${index}`,
    });
    ids.push(posted.message.id);
    // Distinct timestamps keep the keyset cursor unambiguous in this test.
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const lastPage = await channelService.listTimeline(alice, channel.id, {
    limit: 3,
  });
  assert.deepEqual(
    lastPage.map(message => message.content),
    ['message 4', 'message 5', 'message 6']
  );
  const older = await channelService.listTimeline(alice, channel.id, {
    limit: 3,
    before: { created_at: lastPage[0].createdAt, id: lastPage[0].id },
  });
  assert.deepEqual(
    older.map(message => message.content),
    ['message 1', 'message 2', 'message 3']
  );
  const catchUp = await channelService.listTimeline(alice, channel.id, {
    limit: 10,
    after: {
      created_at: older[older.length - 1].createdAt,
      id: older[older.length - 1].id,
    },
  });
  assert.deepEqual(
    catchUp.map(message => message.content),
    ['message 4', 'message 5', 'message 6']
  );
});

test('reactions and pins update with stable counters', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'public',
    name: 'Reactions',
    memberIds: [BOB],
  });
  await channelService.join(bob, channel.id);
  const posted = await channelService.postUserMessage(alice, channel.id, {
    content: 'React to me',
  });
  const messageId = posted.message.id;
  await channelService.react(alice, messageId, '🎉', true);
  await channelService.react(bob, messageId, '🎉', true);
  // Re-adding the same reaction is a no-op, not a double count.
  await channelService.react(bob, messageId, '🎉', true);
  let [message] = await channelService.listTimeline(bob, channel.id, {});
  assert.deepEqual(message.reactions, [{ emoji: '🎉', count: 2, mine: true }]);
  await channelService.react(bob, messageId, '🎉', false);
  [message] = await channelService.listTimeline(bob, channel.id, {});
  assert.deepEqual(message.reactions, [
    { emoji: '🎉', count: 2 - 1, mine: false },
  ]);

  await channelService.setPinned(bob, messageId, true);
  const pinned = await channelService.listPinned(alice, channel.id);
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].id, messageId);
  await channelService.setPinned(alice, messageId, false);
  assert.equal((await channelService.listPinned(alice, channel.id)).length, 0);
});

test('unread counters follow the monotonic read cursor', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'public',
    name: 'Unread',
    memberIds: [BOB],
  });
  await channelService.postUserMessage(alice, channel.id, {
    content: 'one',
  });
  await channelService.postUserMessage(alice, channel.id, {
    content: 'two',
  });
  let summaries = await channelService.listMine(bob);
  let entry = summaries.find(candidate => candidate.id === channel.id);
  assert.equal(entry.unreadCount, 2);
  // The author's own messages are already read.
  summaries = await channelService.listMine(alice);
  assert.equal(
    summaries.find(candidate => candidate.id === channel.id).unreadCount,
    0
  );
  await channelService.markRead(bob, channel.id);
  summaries = await channelService.listMine(bob);
  entry = summaries.find(candidate => candidate.id === channel.id);
  assert.equal(entry.unreadCount, 0);
  // The cursor never moves backwards.
  await channelService.markRead(bob, channel.id, 1);
  summaries = await channelService.listMine(bob);
  assert.equal(
    summaries.find(candidate => candidate.id === channel.id).unreadCount,
    0
  );
});

test('timeline mutations fan out on the durable channel stream', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'public',
    name: 'Events',
  });
  const received = [];
  const gateway = getDurableEventGateway();
  const subscription = await gateway.subscribe({
    afterCursor: 0,
    streamId: channelEventStreamId(channel.id),
    batchSize: 50,
    maxReplayEvents: 1000,
    authorize: async () => true,
    onEvent: async event => {
      received.push({ type: event.eventType, payload: event.payload });
    },
    onError: () => undefined,
  });
  try {
    const posted = await channelService.postUserMessage(alice, channel.id, {
      content: 'Live message',
    });
    await channelService.react(alice, posted.message.id, '👍', true);
    const deadline = Date.now() + 3000;
    while (received.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(received.some(event => event.type === 'channel.message.v1'));
    assert.ok(received.some(event => event.type === 'channel.reaction.v1'));
    const messageEvent = received.find(
      event => event.type === 'channel.message.v1'
    );
    assert.equal(messageEvent.payload.message.content, 'Live message');
  } finally {
    await subscription.close();
  }
});

test('attachments are claimed once and permission-checked on download', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'private',
    name: 'Files',
    memberIds: [BOB],
  });
  const body = new FormData();
  body.append(
    'attachment',
    new Blob([Buffer.from('attachment-bytes')], { type: 'text/plain' }),
    'notes.txt'
  );
  const uploadResponse = await fetch(`${base}/${channel.id}/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.get(ALICE)}` },
    body,
  });
  assert.equal(uploadResponse.status, 201);
  const uploaded = (await uploadResponse.json()).data;
  assert.equal(uploaded.filename, 'notes.txt');

  const posted = await fetch(`${base}/${channel.id}/messages`, {
    method: 'POST',
    headers: headersFor(ALICE),
    body: JSON.stringify({
      content: 'See the attached notes',
      attachmentIds: [uploaded.id],
    }),
  });
  assert.equal(posted.status, 201);
  const message = (await posted.json()).data;
  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].filename, 'notes.txt');

  // A second claim of the same upload fails: the token was consumed.
  const reclaim = await fetch(`${base}/${channel.id}/messages`, {
    method: 'POST',
    headers: headersFor(ALICE),
    body: JSON.stringify({
      content: 'Trying to reuse the upload',
      attachmentIds: [uploaded.id],
    }),
  });
  assert.equal(reclaim.status, 400);

  // Members download; outsiders get a non-enumerating 404.
  const download = await fetch(
    `${base}/attachments/${message.attachments[0].id}`,
    { headers: { Authorization: `Bearer ${tokens.get(BOB)}` } }
  );
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'attachment-bytes');
  const denied = await fetch(
    `${base}/attachments/${message.attachments[0].id}`,
    { headers: { Authorization: `Bearer ${tokens.get(CAROL)}` } }
  );
  assert.equal(denied.status, 404);
});

test('@model mentions run under the invoking member and fail safely', async () => {
  const channel = await channelService.createChannel(alice, {
    type: 'private',
    name: 'Model room',
    memberIds: [BOB],
  });
  const posted = await channelService.postUserMessage(bob, channel.id, {
    content: 'Summarize the plan please',
    mentionModel: 'nonexistent-model:latest',
  });
  const replyId = `${posted.message.id}-model`;

  // The pending reply is on the timeline with the model identity.
  const timeline = await channelService.listTimeline(alice, channel.id, {});
  const pending = timeline.find(message => message.id === replyId);
  assert.equal(pending.authorKind, 'model');
  assert.equal(pending.pending, true);

  // The durable job carries the invoking member's identity — Bob's, not
  // the channel owner's.
  const job = await runtime.service.getByIdempotency(
    BOB,
    CHANNEL_MENTION_JOB_TYPE,
    replyId
  );
  assert.ok(job);
  assert.equal(job.actorUserId, BOB);

  const handler = createDomainDurableJobHandlers().get(
    CHANNEL_MENTION_JOB_TYPE
  );
  const context = {
    payload: {
      channelId: channel.id,
      promptMessageId: posted.message.id,
      replyMessageId: replyId,
      model: 'nonexistent-model:latest',
    },
    actorUserId: BOB,
    attemptCount: 1,
    signal: new AbortController().signal,
    sideEffectLease: { jobId: job.id, leaseToken: 1, workerId: 'test' },
    reportProgress: async () => undefined,
    assertSideEffectAllowed: async () => undefined,
  };

  // Without a reachable provider the reply records the failure visibly.
  await assert.rejects(handler(context));
  const afterFailure = await channelService.listTimeline(alice, channel.id, {});
  const failed = afterFailure.find(message => message.id === replyId);
  assert.ok(failed.error);

  // A member who was removed cannot keep a queued mention alive.
  await channelService.removeMember(alice, channel.id, BOB);
  await handler(context);
  const afterRemoval = await channelService.listTimeline(alice, channel.id, {});
  assert.match(
    afterRemoval.find(message => message.id === replyId).error,
    /no longer a member/
  );
});

/*
 * Mentions and the native tool loop: a mock OpenAPI server gives the
 * mention catalog one read-only GET and one side-effecting POST, and the
 * provider is scripted at the Ollama seam so each round's tool calls are
 * chosen by the test rather than by a model.
 */

const toolSpecDocument = {
  openapi: '3.1.0',
  info: { title: 'Channel Store', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'getPets',
        summary: 'List pets',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            schema: { type: 'integer' },
          },
        ],
      },
      post: {
        operationId: 'addPet',
        summary: 'Add a pet',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            },
          },
        },
      },
    },
  },
};

const toolHttpLog = [];
const toolHttpMock = createServer((request, response) => {
  const url = new URL(request.url, 'http://mock.invalid');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    if (url.pathname === '/openapi.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(toolSpecDocument));
      return;
    }
    toolHttpLog.push({ method: request.method, pathname: url.pathname, body });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ pets: ['ada'], echoed: request.method }));
  });
});
const toolHttpPort = await new Promise((resolve, reject) => {
  toolHttpMock.once('error', reject);
  toolHttpMock.listen(0, '127.0.0.1', () =>
    resolve(toolHttpMock.address().port)
  );
});
after(async () => {
  await new Promise(resolve => toolHttpMock.close(resolve));
});

const toolServer = await toolServers.registerToolServer(ALICE, {
  name: 'Channel Store',
  kind: 'openapi',
  baseUrl: `http://127.0.0.1:${toolHttpPort}`,
  specUrl: `http://127.0.0.1:${toolHttpPort}/openapi.json`,
  authMode: 'none',
  accessMode: 'all-users',
});
assert.ok(toolServer.id);
const toolNs = toolServers.serverNamespace('Channel Store');
const GET_PETS = `${toolNs}__getPets`;
const ADD_PET = `${toolNs}__addPet`;

// The provider seam: every round the loop opens lands here, and the test
// decides what the "model" says. The stub only answers once a test arms it,
// so the earlier "no reachable provider" assertions still see the real one.
const providerRounds = [];
const providerRequests = [];
const oneShotRequests = [];
let providerStubbed = false;
const realChatStream =
  ollamaService.generateChatStreamResponse.bind(ollamaService);
const realChatResponse = ollamaService.generateChatResponse.bind(ollamaService);
ollamaService.generateChatStreamResponse = async (...args) => {
  if (!providerStubbed) return realChatStream(...args);
  const [request, onChunk, , onDone] = args;
  providerRequests.push(request);
  const scripted = providerRounds[providerRequests.length - 1] ?? [
    { message: { content: 'done' }, done: true },
  ];
  for (const chunk of scripted) onChunk(chunk);
  onDone?.();
};
ollamaService.generateChatResponse = async (...args) => {
  if (!providerStubbed) return realChatResponse(...args);
  const [request] = args;
  oneShotRequests.push(request);
  return {
    model: request.model,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content: 'plain one-shot reply' },
    done: true,
  };
};

const toolCallChunk = (name, args) => ({
  message: {
    content: '',
    tool_calls: [{ function: { name, arguments: args } }],
  },
  done: false,
});
const finalChunk = content => ({ message: { content }, done: true });

const MENTION_MODEL = 'nonexistent-model:latest';

/** Post an @model mention and run its durable job to completion. */
const runMention = async (user, channelId, content) => {
  const posted = await channelService.postUserMessage(user, channelId, {
    content,
    mentionModel: MENTION_MODEL,
  });
  const replyMessageId = `${posted.message.id}-model`;
  const handler = createDomainDurableJobHandlers().get(
    CHANNEL_MENTION_JOB_TYPE
  );
  await handler({
    payload: {
      channelId,
      promptMessageId: posted.message.id,
      replyMessageId,
      model: MENTION_MODEL,
    },
    actorUserId: user.userId,
    attemptCount: 1,
    signal: new AbortController().signal,
    sideEffectLease: { jobId: 'tool-test', leaseToken: 1, workerId: 'test' },
    reportProgress: async () => undefined,
    assertSideEffectAllowed: async () => undefined,
  });
  const timeline = await channelService.listTimeline(user, channelId, {});
  return timeline.find(message => message.id === replyMessageId);
};

const resetProvider = () => {
  providerStubbed = true;
  providerRounds.length = 0;
  providerRequests.length = 0;
  oneShotRequests.length = 0;
  toolHttpLog.length = 0;
};

test('a mention runs read-only tools and records them on the reply', async () => {
  await toolAccess.setToolAccessMode('all-users');
  const channel = await channelService.createChannel(alice, {
    type: 'private',
    name: 'Tooling',
    memberIds: [BOB],
  });
  resetProvider();
  providerRounds.push(
    [toolCallChunk(GET_PETS, { limit: 1 }), finalChunk('')],
    [finalChunk('There is one pet, ada.')]
  );

  const reply = await runMention(bob, channel.id, 'How many pets are there?');

  // Two provider rounds: the tool request, then the answer that used it.
  assert.equal(providerRequests.length, 2);
  assert.ok(
    providerRequests[0].tools.some(tool => tool.function.name === GET_PETS),
    'the catalog reached the provider'
  );
  assert.equal(reply.content, 'There is one pet, ada.');
  assert.equal(reply.pending, undefined);

  // The call really hit the mock server and its summary is on the view.
  assert.equal(toolHttpLog.filter(entry => entry.method === 'GET').length, 1);
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].name, GET_PETS);
  assert.equal(reply.toolCalls[0].status, 'succeeded');
  assert.equal(reply.toolCalls[0].sideEffect, false);
  assert.match(reply.toolCalls[0].resultPreview, /ada/);

  // The summary is persisted, encrypted, on the reply row itself.
  const stored = database
    .prepare('SELECT metadata FROM channel_messages WHERE id = ?')
    .get(reply.id);
  assert.ok(stored.metadata);
  assert.ok(!stored.metadata.includes(GET_PETS), 'metadata is encrypted');
  const decoded = JSON.parse(encryptionService.decrypt(stored.metadata));
  assert.equal(decoded.toolCalls[0].name, GET_PETS);

  // The tool result is fed back to the second round as a tool message.
  const secondRound = providerRequests[1].messages;
  assert.ok(secondRound.some(message => message.role === 'tool'));
});

test('a mention declines a side-effecting tool instead of waiting for approval', async () => {
  await toolAccess.setToolAccessMode('all-users');
  const channel = await channelService.createChannel(alice, {
    type: 'private',
    name: 'Side effects',
    memberIds: [BOB],
  });
  resetProvider();
  providerRounds.push(
    [toolCallChunk(ADD_PET, { name: 'ada' }), finalChunk('')],
    [finalChunk('I cannot add a pet from a channel.')]
  );

  const reply = await runMention(bob, channel.id, 'Add a pet named ada');

  assert.equal(reply.content, 'I cannot add a pet from a channel.');
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].name, ADD_PET);
  assert.equal(reply.toolCalls[0].status, 'denied');
  assert.equal(reply.toolCalls[0].isError, true);
  assert.match(reply.toolCalls[0].resultPreview, /Run it from a chat instead/);

  // Nothing reached the server, and no approval row was left pending.
  assert.equal(toolHttpLog.filter(entry => entry.method === 'POST').length, 0);
  const pending = database
    .prepare(
      "SELECT COUNT(*) AS total FROM tool_approvals WHERE status = 'pending'"
    )
    .get();
  assert.equal(pending.total, 0);

  // The model is told why, so it can answer instead of retrying blindly.
  const secondRound = providerRequests[1].messages;
  const toolMessage = secondRound.find(message => message.role === 'tool');
  assert.match(toolMessage.content, /cannot ask for/);
});

test('a member without tool access gets the plain one-shot reply', async () => {
  await toolAccess.setToolAccessMode('admins');
  const channel = await channelService.createChannel(alice, {
    type: 'private',
    name: 'No tools',
    memberIds: [BOB],
  });
  resetProvider();

  const reply = await runMention(bob, channel.id, 'Summarize this please');

  assert.equal(reply.content, 'plain one-shot reply');
  assert.equal(reply.toolCalls, undefined);
  assert.equal(oneShotRequests.length, 1);
  assert.equal(providerRequests.length, 0, 'the tool loop never opened');
  await toolAccess.setToolAccessMode('all-users');
});
