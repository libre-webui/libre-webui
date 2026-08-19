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
 * The native multi-round tool loop (CHAT-03) against a real catalog and a
 * scripted provider: chunk pass-through, the read-only round trip and the
 * wire messages it feeds back, approval approve/deny/standing, unknown
 * tools, the round cap, cancellation mid-approval, and the Ollama bridge.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-chat-tool-loop-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'chat-tool-loop-test-secret-that-is-long-enough';
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

const [toolServers, gateway, runtime, approvals, toolAccess, database] =
  await Promise.all([
    distModule('services/toolServerService.js'),
    distModule('services/toolGatewayService.js'),
    distModule('services/chatToolRuntimeService.js'),
    distModule('services/toolApprovalService.js'),
    distModule('services/toolAccessService.js'),
    distModule('db.js'),
  ]);

const {
  runPluginToolLoop,
  ollamaStreamAsPluginChunks,
  toOllamaExtensionMessages,
  providerToolSpecs,
  MAX_TOOL_ROUNDS,
} = runtime;

const db = database.getDatabase();
const now = Date.now();

const createUser = (id, role) => {
  db.prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', ?, 'active', NULL, ?, ?)`
  ).run(id, id, role, now, now);
  return { userId: id, role, status: 'active' };
};

const createSession = (id, userId) => {
  db.prepare(
    `INSERT INTO sessions (id, user_id, title, model, created_at, updated_at)
     VALUES (?, ?, ?, 'mock-model', ?, ?)`
  ).run(id, userId, `chat ${id}`, now, now);
  return id;
};

const actor = createUser('loop-user', 'admin');
const SESSION_ID = createSession('loop-session-a', actor.userId);
await toolAccess.setToolAccessMode('all-users');

// === Mock OpenAPI server: one read-only GET and one side-effecting POST ===

const specDocument = {
  openapi: '3.1.0',
  info: { title: 'Loop Store', version: '1.0.0' },
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

const httpLog = [];

const httpMock = createServer((request, response) => {
  const url = new URL(request.url, 'http://mock.invalid');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf-8');
    if (url.pathname === '/openapi.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(specDocument));
      return;
    }
    httpLog.push({
      method: request.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        echoed: request.method,
        query: Object.fromEntries(url.searchParams.entries()),
        ...(body ? { body: JSON.parse(body) } : {}),
      })
    );
  });
});

const httpPort = await new Promise((resolve, reject) => {
  httpMock.once('error', reject);
  httpMock.listen(0, '127.0.0.1', () => resolve(httpMock.address().port));
});
const httpBase = `http://127.0.0.1:${httpPort}`;

after(async () => {
  await new Promise(resolve => httpMock.close(resolve));
  database.closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

const petServer = await toolServers.registerToolServer(actor.userId, {
  name: 'Loop Store',
  kind: 'openapi',
  baseUrl: httpBase,
  specUrl: `${httpBase}/openapi.json`,
  authMode: 'none',
  accessMode: 'all-users',
});
const ns = toolServers.serverNamespace('Loop Store');
const GET_PETS = `${ns}__getPets`;
const ADD_PET = `${ns}__addPet`;

const catalog = await gateway.buildToolCatalog(
  actor,
  { sessionId: SESSION_ID },
  { builtinTools: [], serverIds: [petServer.id] }
);
assert.equal(catalog.byName.has(GET_PETS), true, 'the GET tool is catalogued');
assert.equal(catalog.byName.get(ADD_PET).sideEffect, true);

// === Harness: a scripted provider, an event sink, and a chunk drain ===

const clone = value => JSON.parse(JSON.stringify(value));

/**
 * `script` is either an array of per-round chunk arrays or a function of the
 * 1-based round number. Every call records the arguments it was handed.
 */
const scriptedProvider = script => {
  const calls = [];
  const startRound = (extension, tools) => {
    const round = calls.length + 1;
    calls.push({ round, extension: clone(extension), tools: clone(tools) });
    const chunks =
      typeof script === 'function' ? script(round) : script[round - 1];
    if (!chunks)
      throw new Error(`the provider has no script for round ${round}`);
    return (async function* emit() {
      for (const chunk of chunks) yield chunk;
    })();
  };
  return { startRound, calls };
};

const makeSink = () => {
  const events = [];
  return { events, toolEvent: event => void events.push(event) };
};

const drain = async chunks => {
  const seen = [];
  for await (const chunk of chunks) seen.push(chunk);
  return seen;
};

const awaitEvent = async (sink, type) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const found = sink.events.find(event => event.type === type);
    if (found) return found;
    await delay(10);
  }
  throw new Error(`no ${type} event was emitted`);
};

const postCount = () => httpLog.filter(entry => entry.method === 'POST').length;

let loopCounter = 0;
const runLoop = (script, options = {}) => {
  const provider = scriptedProvider(script);
  const sink = makeSink();
  const { chunks, state } = runPluginToolLoop({
    actor,
    sessionId: SESSION_ID,
    assistantMessageId: `assistant-${++loopCounter}`,
    catalog,
    startRound: provider.startRound,
    sink,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { provider, sink, chunks, state };
};

const contentChunk = content => ({ type: 'content', content });
const usageChunk = (promptTokens, completionTokens) => ({
  type: 'usage',
  usage: { promptTokens, completionTokens },
});
const doneChunk = { type: 'done' };
const toolCallChunk = (id, name, args) => ({
  type: 'tool_call',
  toolCall: { id, name, arguments: JSON.stringify(args) },
});

// === 1. No tools requested ===

test('a round with no tool calls passes its chunks straight through', async () => {
  const loop = runLoop([
    [
      contentChunk('Hello '),
      contentChunk('there'),
      usageChunk(11, 7),
      doneChunk,
    ],
  ]);
  const seen = await drain(loop.chunks);

  assert.deepEqual(
    seen.filter(chunk => chunk.type === 'content').map(chunk => chunk.content),
    ['Hello ', 'there']
  );
  const usage = seen.filter(chunk => chunk.type === 'usage');
  assert.equal(usage.length, 1, 'exactly one usage chunk');
  assert.deepEqual(usage[0].usage, {
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
  });
  assert.equal(seen.filter(chunk => chunk.type === 'done').length, 1);
  assert.equal(seen.at(-1).type, 'done');

  assert.deepEqual(loop.state.toolCalls, []);
  assert.equal(loop.state.rounds, 1);
  assert.equal(loop.provider.calls.length, 1);
  assert.deepEqual(loop.provider.calls[0].extension, []);
  assert.deepEqual(loop.provider.calls[0].tools.map(tool => tool.name).sort(), [
    ADD_PET,
    GET_PETS,
  ]);
  assert.deepEqual(
    providerToolSpecs(catalog)
      .map(tool => tool.name)
      .sort(),
    [ADD_PET, GET_PETS]
  );
});

// === 2. Read-only round trip ===

test('a read-only call runs between rounds and its result extends the turn', async () => {
  const before = httpLog.length;
  const loop = runLoop([
    [
      contentChunk('Let me check'),
      toolCallChunk('c1', GET_PETS, { limit: 2 }),
      usageChunk(20, 5),
      doneChunk,
    ],
    [contentChunk('answer'), usageChunk(30, 9), doneChunk],
  ]);
  const seen = await drain(loop.chunks);

  assert.deepEqual(
    seen.filter(chunk => chunk.type === 'content').map(chunk => chunk.content),
    ['Let me check', 'answer'],
    'both rounds stream into one continuous turn'
  );
  assert.equal(
    seen.some(chunk => chunk.type === 'tool_call'),
    false,
    'tool_call chunks never reach the consumer'
  );
  const usage = seen.filter(chunk => chunk.type === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].usage, {
    promptTokens: 50,
    completionTokens: 14,
    totalTokens: 64,
  });
  assert.equal(seen.at(-1).type, 'done');

  // The second round is handed the assistant turn and the tool result.
  assert.equal(loop.provider.calls.length, 2);
  const extension = loop.provider.calls[1].extension;
  assert.equal(extension.length, 2);
  assert.equal(extension[0].role, 'assistant');
  assert.equal(extension[0].content, 'Let me check');
  assert.deepEqual(extension[0].tool_calls, [
    {
      id: 'c1',
      type: 'function',
      function: { name: GET_PETS, arguments: JSON.stringify({ limit: 2 }) },
    },
  ]);
  assert.equal(extension[1].role, 'tool');
  assert.equal(extension[1].tool_call_id, 'c1');
  assert.deepEqual(JSON.parse(extension[1].content), {
    echoed: 'GET',
    query: { limit: '2' },
  });

  assert.equal(loop.state.rounds, 2);
  assert.equal(loop.state.toolCalls.length, 1);
  const record = loop.state.toolCalls[0];
  assert.equal(record.id, 'c1');
  assert.equal(record.name, GET_PETS);
  assert.equal(record.status, 'succeeded');
  assert.equal(record.source, 'openapi');
  assert.equal(record.serverId, petServer.id);
  assert.equal(record.sideEffect, false);
  assert.equal(record.isError, false);
  assert.ok(record.resultPreview, 'a bounded result preview is recorded');
  assert.deepEqual(JSON.parse(record.resultPreview), {
    echoed: 'GET',
    query: { limit: '2' },
  });

  // The mock really served the GET with the model's argument.
  const requests = httpLog.slice(before);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].pathname, '/pets');
  assert.deepEqual(requests[0].query, { limit: '2' });

  const emitted = loop.sink.events;
  assert.deepEqual(
    emitted.map(event => event.type),
    ['chat.tool-call.v1', 'chat.tool-result.v1']
  );
  assert.equal(emitted[0].messageId, emitted[1].messageId);
  assert.equal(emitted[0].toolCall.id, 'c1');
  assert.equal(emitted[1].toolCallId, 'c1');
  assert.equal(emitted[1].status, 'succeeded');
  assert.equal(emitted[1].isError, false);
});

// === 3. Approval: approved ===

test('a side-effecting call waits for approval and then executes', async () => {
  const before = postCount();
  const loop = runLoop([
    [toolCallChunk('c2', ADD_PET, { body: { name: 'Rex' } }), doneChunk],
    [contentChunk('added'), doneChunk],
  ]);
  const consuming = drain(loop.chunks);

  const approval = await awaitEvent(loop.sink, 'chat.approval.v1');
  assert.equal(approval.toolCall.id, 'c2');
  assert.equal(approval.toolCall.status, 'awaiting_approval');
  assert.ok(approval.expiresAt > Date.now());
  assert.equal(postCount(), before, 'nothing runs before the decision');

  const decided = await approvals.decideApproval(
    actor.userId,
    approval.approvalId,
    {
      approve: true,
      scope: 'once',
    }
  );
  assert.equal(decided.status, 'approved');

  const seen = await consuming;
  assert.equal(seen.at(-1).type, 'done');
  assert.equal(postCount(), before + 1, 'the POST reached the mock');
  assert.deepEqual(JSON.parse(httpLog.at(-1).body), { name: 'Rex' });

  const record = loop.state.toolCalls[0];
  assert.equal(record.status, 'succeeded');
  assert.equal(record.sideEffect, true);
  assert.equal(record.isError, false);

  // 'once' leaves nothing standing: an identical call asks again.
  const second = runLoop([
    [toolCallChunk('c3', ADD_PET, { body: { name: 'Rex' } }), doneChunk],
    [contentChunk('done'), doneChunk],
  ]);
  const secondConsuming = drain(second.chunks);
  const again = await awaitEvent(second.sink, 'chat.approval.v1');
  assert.notEqual(again.approvalId, approval.approvalId);
  await approvals.decideApproval(actor.userId, again.approvalId, {
    approve: false,
    scope: 'once',
  });
  await secondConsuming;
  assert.equal(second.state.toolCalls[0].status, 'denied');
});

// === 4. Approval: denied ===

test('a denied call never executes but the model still sees the refusal', async () => {
  const before = postCount();
  const loop = runLoop([
    [toolCallChunk('c4', ADD_PET, { body: { name: 'Nope' } }), doneChunk],
    [contentChunk('understood'), doneChunk],
  ]);
  const consuming = drain(loop.chunks);

  const approval = await awaitEvent(loop.sink, 'chat.approval.v1');
  await approvals.decideApproval(actor.userId, approval.approvalId, {
    approve: false,
    scope: 'once',
  });
  const seen = await consuming;

  assert.equal(postCount(), before, 'no request left the process');
  const record = loop.state.toolCalls[0];
  assert.equal(record.status, 'denied');
  assert.equal(record.isError, true);
  assert.match(record.resultPreview, /denied/i);

  // The model still gets a second round carrying the denial as the result.
  assert.equal(loop.provider.calls.length, 2);
  const extension = loop.provider.calls[1].extension;
  assert.equal(extension[1].role, 'tool');
  assert.equal(extension[1].tool_call_id, 'c4');
  assert.match(extension[1].content, /denied this tool call/i);
  assert.deepEqual(
    seen.filter(chunk => chunk.type === 'content').map(chunk => chunk.content),
    ['understood']
  );

  const result = loop.sink.events.find(
    event => event.type === 'chat.tool-result.v1'
  );
  assert.equal(result.status, 'denied');
  assert.equal(result.isError, true);
});

// === 5. Standing approval ===

test("an 'always' decision lets later turns run the tool unprompted", async () => {
  const first = runLoop([
    [toolCallChunk('c5', ADD_PET, { body: { name: 'Standing' } }), doneChunk],
    [contentChunk('ok'), doneChunk],
  ]);
  const consuming = drain(first.chunks);
  const approval = await awaitEvent(first.sink, 'chat.approval.v1');
  await approvals.decideApproval(actor.userId, approval.approvalId, {
    approve: true,
    scope: 'always',
  });
  await consuming;
  assert.equal(first.state.toolCalls[0].status, 'succeeded');

  const before = postCount();
  const second = runLoop([
    [toolCallChunk('c6', ADD_PET, { body: { name: 'NoAsk' } }), doneChunk],
    [contentChunk('ok'), doneChunk],
  ]);
  await drain(second.chunks);
  assert.equal(
    second.sink.events.some(event => event.type === 'chat.approval.v1'),
    false,
    'the standing decision skips the prompt entirely'
  );
  assert.equal(second.state.toolCalls[0].status, 'succeeded');
  assert.equal(postCount(), before + 1);
  assert.deepEqual(JSON.parse(httpLog.at(-1).body), { name: 'NoAsk' });

  // Revoke it so the later tests exercise the prompting path again.
  const standing = await approvals.findStandingApproval(
    actor.userId,
    petServer.id,
    'addPet',
    SESSION_ID
  );
  assert.ok(standing, 'the standing approval is discoverable');
  assert.equal(await approvals.revokeApproval(actor.userId, standing.id), true);
});

// === 6. Unknown tool ===

test('a call naming an uncatalogued tool fails without stopping the turn', async () => {
  const loop = runLoop([
    [toolCallChunk('c7', 'nope', { any: 1 }), doneChunk],
    [contentChunk('recovered'), doneChunk],
  ]);
  const seen = await drain(loop.chunks);

  const record = loop.state.toolCalls[0];
  assert.equal(record.status, 'failed');
  assert.equal(record.isError, true);
  assert.equal(record.source, 'builtin');
  assert.equal(record.error, 'Unknown tool: nope');

  assert.equal(loop.provider.calls.length, 2);
  const extension = loop.provider.calls[1].extension;
  assert.equal(extension[1].role, 'tool');
  assert.equal(extension[1].content, 'Unknown tool: nope');
  assert.deepEqual(
    seen.filter(chunk => chunk.type === 'content').map(chunk => chunk.content),
    ['recovered']
  );
  assert.equal(seen.at(-1).type, 'done');
});

// === 7. Round cap ===

test('the round cap stops the loop and strips tools from the final round', async () => {
  let call = 0;
  const loop = runLoop(round => {
    call = round;
    return [
      contentChunk(`round ${round}`),
      toolCallChunk(`cap-${round}`, GET_PETS, { limit: round }),
      usageChunk(1, 1),
      doneChunk,
    ];
  });
  const seen = await drain(loop.chunks);

  assert.equal(MAX_TOOL_ROUNDS, 8);
  assert.ok(
    loop.provider.calls.length <= MAX_TOOL_ROUNDS,
    `the provider ran ${loop.provider.calls.length} rounds`
  );
  assert.equal(loop.provider.calls.length, MAX_TOOL_ROUNDS);
  assert.equal(call, MAX_TOOL_ROUNDS);
  assert.equal(loop.state.rounds, MAX_TOOL_ROUNDS);

  for (const entry of loop.provider.calls.slice(0, -1)) {
    assert.equal(entry.tools.length, 2, 'earlier rounds are offered the tools');
  }
  assert.deepEqual(
    loop.provider.calls.at(-1).tools,
    [],
    'the last round is offered no tools'
  );

  assert.equal(seen.at(-1).type, 'done', 'the stream still terminates');
  assert.equal(seen.filter(chunk => chunk.type === 'done').length, 1);
  assert.equal(loop.state.toolCalls.length, MAX_TOOL_ROUNDS);
});

// === 8. Cancellation while waiting for approval ===

test('aborting mid-approval rejects the stream and executes nothing', async () => {
  const before = postCount();
  const controller = new AbortController();
  const loop = runLoop(
    [
      [
        toolCallChunk('c8', ADD_PET, { body: { name: 'Cancelled' } }),
        doneChunk,
      ],
      [contentChunk('never'), doneChunk],
    ],
    { signal: controller.signal }
  );
  const consuming = drain(loop.chunks);
  const rejected = assert.rejects(() => consuming, /cancelled mid-approval/);

  const approval = await awaitEvent(loop.sink, 'chat.approval.v1');
  controller.abort(new Error('cancelled mid-approval'));
  await rejected;

  assert.equal(postCount(), before, 'the abort beat the execution');
  assert.equal(loop.provider.calls.length, 1, 'no further round was started');
  const pending = await approvals.listPendingApprovals(actor.userId);
  const stillOpen = pending.some(entry => entry.id === approval.approvalId);
  const row = db
    .prepare('SELECT status FROM tool_approvals WHERE id = ?')
    .get(approval.approvalId);
  assert.ok(
    stillOpen || row.status === 'expired',
    `the abandoned request stays pending or expires, saw ${row.status}`
  );
  assert.notEqual(row.status, 'approved');
});

// === 9. Ollama bridge ===

const fakeOllamaSource = script => {
  const requests = [];
  return {
    requests,
    generateChatStreamResponse: async (
      request,
      onChunk,
      _onError,
      onComplete
    ) => {
      requests.push(clone(request));
      for (const chunk of script(requests.length)) onChunk(chunk);
      onComplete();
    },
  };
};

test('the Ollama bridge maps thinking, content, tool calls, and counts', async () => {
  const source = fakeOllamaSource(() => [
    { message: { thinking: 'hmm' } },
    { message: { content: 'partial' } },
    {
      message: {
        tool_calls: [{ function: { name: GET_PETS, arguments: { limit: 1 } } }],
      },
    },
    { done: true, prompt_eval_count: 12, eval_count: 4 },
  ]);
  const state = {};
  const seen = await drain(
    ollamaStreamAsPluginChunks(
      { model: 'mock-model', messages: [] },
      source,
      state
    )
  );

  assert.deepEqual(
    seen.map(chunk => chunk.type),
    ['reasoning', 'content', 'tool_call', 'usage', 'done']
  );
  assert.equal(seen[0].content, 'hmm');
  assert.equal(seen[1].content, 'partial');
  assert.equal(seen[2].toolCall.name, GET_PETS);
  assert.match(seen[2].toolCall.id, /^ollama-call-/);
  assert.equal(
    seen[2].toolCall.arguments,
    JSON.stringify({ limit: 1 }),
    'the bridge stringifies Ollama object arguments'
  );
  assert.deepEqual(seen[3].usage, { promptTokens: 12, completionTokens: 4 });
  assert.equal(state.finalChunk.done, true);
  assert.equal(state.finalChunk.prompt_eval_count, 12);
});

test('a full loop over the Ollama bridge feeds native tool messages back', async () => {
  const before = httpLog.length;
  const source = fakeOllamaSource(round =>
    round === 1
      ? [
          { message: { content: 'checking' } },
          {
            message: {
              tool_calls: [
                { function: { name: GET_PETS, arguments: { limit: 3 } } },
              ],
            },
          },
          { done: true, prompt_eval_count: 5, eval_count: 2 },
        ]
      : [
          { message: { content: 'three pets' } },
          { done: true, prompt_eval_count: 6, eval_count: 3 },
        ]
  );

  const baseMessages = [{ role: 'user', content: 'how many pets?' }];
  const sink = makeSink();
  const bridgeState = {};
  const { chunks, state } = runPluginToolLoop({
    actor,
    sessionId: SESSION_ID,
    assistantMessageId: 'assistant-ollama',
    catalog,
    sink,
    startRound: (extension, tools) =>
      ollamaStreamAsPluginChunks(
        {
          model: 'mock-model',
          messages: [...baseMessages, ...toOllamaExtensionMessages(extension)],
          ...(tools.length ? { tools } : {}),
        },
        source,
        bridgeState
      ),
  });
  const seen = await drain(chunks);

  assert.deepEqual(
    seen.filter(chunk => chunk.type === 'content').map(chunk => chunk.content),
    ['checking', 'three pets']
  );
  assert.deepEqual(seen.filter(chunk => chunk.type === 'usage')[0].usage, {
    promptTokens: 11,
    completionTokens: 5,
    totalTokens: 16,
  });
  assert.equal(seen.at(-1).type, 'done');
  assert.equal(state.rounds, 2);
  assert.equal(state.toolCalls[0].status, 'succeeded');

  const requests = httpLog.slice(before);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].query, { limit: '3' });

  // The second Ollama request carries the native tool-message shapes.
  assert.equal(source.requests.length, 2);
  const messages = source.requests[1].messages;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages[0], { role: 'user', content: 'how many pets?' });
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'checking');
  assert.deepEqual(messages[1].tool_calls, [
    { function: { name: GET_PETS, arguments: JSON.stringify({ limit: 3 }) } },
  ]);
  assert.equal(messages[2].role, 'tool');
  assert.equal(messages[2].tool_call_id, state.toolCalls[0].id);
  assert.deepEqual(JSON.parse(messages[2].content), {
    echoed: 'GET',
    query: { limit: '3' },
  });
});
