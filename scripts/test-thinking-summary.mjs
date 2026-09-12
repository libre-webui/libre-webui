/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
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
import { createServer, request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import express from 'express';

const distModule = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const {
  ThinkingSummaryService,
  parseThinkingSummaryRequest,
  buildThinkingSummaryPrompt,
} = await distModule('services/thinkingSummaryService.js');

const session = {
  id: 'summary-session',
  model: 'chat-model',
  title: 'Keep this title',
  messages: [
    {
      id: 'first-message',
      role: 'user',
      content: 'Original message',
      timestamp: 1,
    },
  ],
  createdAt: 1,
  updatedAt: 1,
};
const baseRequest = {
  sessionId: session.id,
  userId: 'summary-owner',
  requestedModel: 'task-model',
  thinking: 'I am checking which settings affect this behavior.',
};
const summaryText = 'Checking the relevant configuration';
const pluginResponse = content => ({
  choices: [{ message: { role: 'assistant', content } }],
});

function fixture(overrides = {}) {
  const calls = {
    session: [],
    targets: [],
    plugin: [],
    ollama: [],
    resolved: [],
  };
  const dependencies = {
    chatService: {
      async getSession(...args) {
        calls.session.push(args);
        return args[0] === session.id && args[1] === 'summary-owner'
          ? structuredClone(session)
          : undefined;
      },
      updateSession() {
        throw new Error('Summaries must not write sessions');
      },
    },
    chatGenerationService: {
      async resolveActualModelName(...args) {
        calls.resolved.push(args);
        return 'resolved-model';
      },
      async prepareGenerationTarget(...args) {
        calls.targets.push(args);
        return {
          actualModelName: args[0],
          mergedOptions: { think: true, num_predict: 4_096, temperature: 0.9 },
          activePlugin:
            args[3]?.providerType === 'plugin'
              ? { id: args[3].providerId }
              : null,
        };
      },
      extractPluginAssistantContent(response) {
        return response.choices[0].message.content;
      },
    },
    pluginService: {
      async executePluginRequest(...args) {
        calls.plugin.push(args);
        return pluginResponse(summaryText);
      },
    },
    ollamaService: {
      async generateChatResponse(...args) {
        calls.ollama.push(args);
        return { message: { content: summaryText } };
      },
    },
    ...overrides,
  };
  return {
    service: new ThinkingSummaryService(dependencies),
    dependencies,
    calls,
  };
}

test('thinking summary input validates types, provider pairs, and hard bounds', () => {
  for (const input of [
    null,
    [],
    'text',
    {},
    { model: 7, thinking: 'text' },
    { model: ' ', thinking: 'text' },
    { model: 'x'.repeat(257), thinking: 'text' },
    { model: 'model', thinking: ['text'] },
    { model: 'model', thinking: ' ' },
    { model: 'model', thinking: 'x'.repeat(4_001) },
    { model: 'model', thinking: 'text', providerType: 7 },
    { model: 'model', thinking: 'text', providerId: {} },
    { model: 'model', thinking: 'text', providerType: 'plugin' },
    {
      model: 'model',
      thinking: 'text',
      providerType: 'agent',
      providerId: 'host-cli',
    },
  ])
    assert.throws(() => parseThinkingSummaryRequest(input));
  assert.deepEqual(
    parseThinkingSummaryRequest({
      model: ' model ',
      thinking: ' text ',
      providerType: 'plugin',
      providerId: ' task-provider ',
    }),
    {
      model: 'model',
      thinking: 'text',
      providerType: 'plugin',
      providerId: 'task-provider',
    }
  );
  assert.equal(
    parseThinkingSummaryRequest({
      model: 'm'.repeat(256),
      thinking: 'x'.repeat(4_000),
    }).thinking.length,
    4_000
  );
});

test('thinking summary prompt uses the latest excerpt and asks only for high-level activity', () => {
  const prompt = buildThinkingSummaryPrompt(
    'OLD-CONTEXT' + 'x'.repeat(3_000) + 'LATEST-ACTIVITY'
  );
  assert.ok(!prompt.includes('OLD-CONTEXT'));
  assert.ok(prompt.includes('LATEST-ACTIVITY'));
  assert.match(prompt, /4-10 words/);
  assert.match(prompt, /Do not disclose detailed reasoning/);
  assert.match(prompt, /untrusted data/);
});

test('thinking summaries require ownership before any provider work', async () => {
  const { service, calls } = fixture();
  assert.equal(
    await service.summarizeForSession({ ...baseRequest, userId: 'other-user' }),
    null
  );
  assert.equal(
    await service.summarizeForSession({ ...baseRequest, sessionId: 'missing' }),
    null
  );
  assert.equal(
    calls.targets.length + calls.plugin.length + calls.ollama.length,
    0
  );
});

test('thinking summaries use the selected provider and never mutate the chat', async () => {
  const before = structuredClone(session);
  const { service, calls } = fixture();
  assert.deepEqual(
    await service.summarizeForSession({
      ...baseRequest,
      providerType: 'plugin',
      providerId: 'task-provider',
    }),
    { summary: summaryText }
  );
  const [model, messages, options, userId, pluginId, signal] = calls.plugin[0];
  assert.equal(model, 'task-model');
  assert.equal(userId, 'summary-owner');
  assert.equal(pluginId, 'task-provider');
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Latest excerpt:/);
  assert.equal(options.think, false);
  assert.equal(options.num_predict, 256);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(calls.targets[0][4], signal);
  assert.equal(calls.ollama.length, 0);
  assert.deepEqual(session, before);
});

test('Ollama summaries disable thinking and propagate cancellation and usage identity', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(
    await service.summarizeForSession({
      ...baseRequest,
      providerType: 'ollama',
    }),
    { summary: summaryText }
  );
  const [request, signal, usage] = calls.ollama[0];
  assert.equal(request.model, 'task-model');
  assert.equal(request.think, false);
  assert.equal(request.options.think, undefined);
  assert.equal(request.options.num_predict, 64);
  assert.equal(request.stream, false);
  assert.ok(signal instanceof AbortSignal);
  assert.deepEqual(usage, { userId: 'summary-owner' });
  assert.equal(calls.plugin.length, 0);
});

test('current-model summaries preserve session binding and resolve persona backing models', async () => {
  const normal = fixture();
  normal.dependencies.chatService.getSession = async () => ({
    ...session,
    providerType: 'plugin',
    providerId: 'chat-provider',
  });
  await normal.service.summarizeForSession({
    ...baseRequest,
    requestedModel: '__current_running_model__',
  });
  assert.deepEqual(normal.calls.resolved, [['chat-model', 'summary-owner']]);
  assert.deepEqual(normal.calls.targets[0][3], {
    providerType: 'plugin',
    providerId: 'chat-provider',
  });
  const persona = fixture();
  persona.dependencies.chatService.getSession = async () => ({
    ...session,
    model: 'persona:personal',
    providerType: 'ollama',
  });
  await persona.service.summarizeForSession({
    ...baseRequest,
    requestedModel: '__current_running_model__',
  });
  assert.deepEqual(persona.calls.resolved, [
    ['persona:personal', 'summary-owner'],
  ]);
  assert.equal(persona.calls.targets[0][0], 'resolved-model');
  assert.equal(persona.calls.targets[0][3], undefined);
});

test('empty output and failed providers never return the raw excerpt as a fallback', async () => {
  for (const output of [
    '',
    '<think>private deliberation</think>',
    'x'.repeat(141),
  ]) {
    const item = fixture();
    item.dependencies.ollamaService.generateChatResponse = async () => ({
      message: { content: output },
    });
    await assert.rejects(
      item.service.summarizeForSession(baseRequest),
      /concise thinking summary/
    );
  }
  const failed = fixture();
  failed.dependencies.pluginService.executePluginRequest = async () => {
    throw new Error('Provider unavailable');
  };
  await assert.rejects(
    failed.service.summarizeForSession({
      ...baseRequest,
      providerType: 'plugin',
      providerId: 'task-provider',
    }),
    /Provider unavailable/
  );
  assert.equal(failed.calls.ollama.length, 0);
  const missing = fixture();
  missing.dependencies.chatGenerationService.prepareGenerationTarget =
    async () => ({
      actualModelName: 'model',
      activePlugin: null,
      mergedOptions: {},
    });
  await assert.rejects(
    missing.service.summarizeForSession({
      ...baseRequest,
      providerType: 'plugin',
      providerId: 'missing',
    }),
    /selected summary provider/
  );
  assert.equal(missing.calls.ollama.length, 0);
});

test('summary cancellation aborts upstream and bounds adapters that ignore abort', async () => {
  const controller = new AbortController();
  const item = fixture();
  let receivedSignal;
  let started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  item.dependencies.pluginService.executePluginRequest = async (...args) => {
    receivedSignal = args[5];
    started();
    return new Promise(() => {});
  };
  const result = item.service.summarizeForSession({
    ...baseRequest,
    providerType: 'plugin',
    providerId: 'task-provider',
    signal: controller.signal,
  });
  await ready;
  const rejected = assert.rejects(result, /Stop summary/);
  controller.abort(new Error('Stop summary'));
  await rejected;
  assert.equal(receivedSignal.aborted, true);

  const timeout = fixture({ timeoutMs: 10 });
  timeout.dependencies.ollamaService.generateChatResponse = async () =>
    new Promise(() => {});
  // Keep the test runner alive while the service's unref'ed timeout fires.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    await assert.rejects(timeout.service.summarizeForSession(baseRequest), {
      name: 'TimeoutError',
    });
  } finally {
    clearTimeout(keepAlive);
  }
  const cancelled = fixture();
  await assert.rejects(
    cancelled.service.summarizeForSession({
      ...baseRequest,
      signal: AbortSignal.abort(new Error('Already stopped')),
    }),
    /Already stopped/
  );
  assert.equal(cancelled.calls.session.length, 0);
});

const dataDir = await mkdtemp(
  path.join(os.tmpdir(), 'libre-thinking-summary-')
);
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'thinking-summary-test-secret';
process.env.ENCRYPTION_KEY ||= '1'.repeat(64);
const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const persistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const storageRuntime = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await storageRuntime.initializePlatformStorageRuntime({
  persistence,
  cipher: encryptionService,
  env: process.env,
});
const coordination = await distModule('platform/coordination/service.js');
await coordination.initializeCoordinator();
const [
  { getDatabase },
  { authService },
  { default: chatRouter },
  { default: chatService },
  { default: chatGenerationService },
  { default: pluginService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/chat.js'),
  distModule('services/chatService.js'),
  distModule('services/chatGenerationService.js'),
  distModule('services/pluginService.js'),
]);
const now = Date.now();
for (const id of ['summary-owner', 'summary-other']) {
  getDatabase()
    .prepare(
      `INSERT INTO users (id, username, email, password_hash, role, avatar, created_at, updated_at) VALUES (?, ?, NULL, 'unused', 'user', NULL, ?, ?)`
    )
    .run(id, id, now, now);
}
const token = authService.generateToken({
  id: 'summary-owner',
  username: 'summary-owner',
  email: null,
  role: 'user',
  status: 'active',
  avatar: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});
const ownSession = await chatService.createSession(
  'chat-model',
  'Unchanged title',
  'summary-owner'
);
await chatService.addMessage(
  ownSession.id,
  { role: 'user', content: 'Original message' },
  'summary-owner'
);
const otherSession = await chatService.createSession(
  'chat-model',
  'Other user',
  'summary-other'
);
const app = express();
app.use(express.json());
app.use('/api/chat', chatRouter);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api/chat`;
const originalPrepare = chatGenerationService.prepareGenerationTarget;
const originalExecute = pluginService.executePluginRequest;
let providerCalls = 0;
chatGenerationService.prepareGenerationTarget = async (
  model,
  _userId,
  _options,
  selection
) => {
  providerCalls += 1;
  return {
    actualModelName: model,
    mergedOptions: {},
    activePlugin: { id: selection?.providerId ?? 'summary-provider' },
  };
};
pluginService.executePluginRequest = async () => pluginResponse(summaryText);
const payload = {
  model: 'task-model',
  thinking: 'Inspecting application settings.',
  providerType: 'plugin',
  providerId: 'summary-provider',
};
const requestSummary = (id, body, authToken = token) =>
  fetch(`${baseUrl}/sessions/${id}/summarize-thinking`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    body: JSON.stringify(body),
  });

after(async () => {
  chatGenerationService.prepareGenerationTarget = originalPrepare;
  pluginService.executePluginRequest = originalExecute;
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await coordination.closeCoordinator();
  await storageRuntime.closePlatformStorageRuntime();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('summary route enforces authentication, ownership, and input bounds', async () => {
  const before = providerCalls;
  assert.equal((await requestSummary(ownSession.id, payload, '')).status, 401);
  for (const id of [otherSession.id, 'missing']) {
    assert.equal((await requestSummary(id, payload)).status, 404);
  }
  for (const body of [
    [],
    {},
    { ...payload, model: 'x'.repeat(257) },
    { ...payload, thinking: 'x'.repeat(4_001) },
    { ...payload, providerType: {} },
    { ...payload, thinking: 7 },
  ]) {
    assert.equal((await requestSummary(ownSession.id, body)).status, 400);
  }
  assert.equal(providerCalls, before);
});

test('summary route returns only a transient summary and hides provider error text', async () => {
  const before = await chatService.getSession(ownSession.id, 'summary-owner');
  const response = await requestSummary(ownSession.id, payload);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    data: { summary: summaryText },
  });
  assert.deepEqual(
    await chatService.getSession(ownSession.id, 'summary-owner'),
    before
  );
  pluginService.executePluginRequest = async () => {
    throw new Error('PRIVATE REASONING EXCERPT');
  };
  try {
    const failed = await requestSummary(ownSession.id, payload);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), {
      success: false,
      error: 'Could not summarize thinking.',
    });
  } finally {
    pluginService.executePluginRequest = async () =>
      pluginResponse(summaryText);
  }
});

test('disconnecting a thinking summary request cancels its provider signal', async () => {
  let started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  let upstreamSignal;
  let aborted;
  const cancellation = new Promise(resolve => {
    aborted = resolve;
  });
  pluginService.executePluginRequest = async (...args) => {
    upstreamSignal = args[5];
    started();
    return new Promise((resolve, reject) => {
      upstreamSignal.addEventListener(
        'abort',
        () => {
          aborted();
          reject(upstreamSignal.reason);
        },
        { once: true }
      );
    });
  };
  const req = httpRequest(
    `${baseUrl}/sessions/${ownSession.id}/summarize-thinking`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    }
  );
  req.on('error', () => {});
  req.end(JSON.stringify(payload));
  try {
    await ready;
    req.destroy();
    await cancellation;
    assert.equal(upstreamSignal.aborted, true);
  } finally {
    req.destroy();
    pluginService.executePluginRequest = async () =>
      pluginResponse(summaryText);
  }
});
