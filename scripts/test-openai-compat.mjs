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

/**
 * Wire-compatibility suite for the public OpenAI-compatible API: request
 * validation, the completion and SSE chunk shapes, [DONE] termination,
 * authentication, and API-token scope enforcement.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-openai-compat-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'openai-compat-test-secret';
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
const coordinationModule = await distModule('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();

const [
  { getDatabase, closeDatabase },
  { authService },
  { default: openaiCompatRouter },
  { default: chatGenerationService },
  { default: ollamaService },
  { default: pluginService },
  tokens,
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/openaiCompat.js'),
  distModule('services/chatGenerationService.js'),
  distModule('services/ollamaService.js'),
  distModule('services/pluginService.js'),
  distModule('services/apiTokenService.js'),
]);

const now = Date.now();
getDatabase()
  .prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'unused', 'user', NULL, ?, ?)`
  )
  .run('compat-user', 'compat-user', now, now);

const jwt = authService.generateToken({
  id: 'compat-user',
  username: 'compat-user',
  email: null,
  role: 'user',
  status: 'active',
  avatar: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});

const app = express();
app.use(express.json());
app.use('/v1', openaiCompatRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/v1`;

const originalPrepare = chatGenerationService.prepareGenerationTarget;
const originalExecute = chatGenerationService.executeNonStreaming;
const originalGetModels = ollamaService.getModels;
const originalGetActivePlugins = pluginService.getActivePlugins;
const originalStreamResponse = ollamaService.generateChatStreamResponse;

after(async () => {
  chatGenerationService.prepareGenerationTarget = originalPrepare;
  chatGenerationService.executeNonStreaming = originalExecute;
  ollamaService.getModels = originalGetModels;
  pluginService.getActivePlugins = originalGetActivePlugins;
  ollamaService.generateChatStreamResponse = originalStreamResponse;
  server.close();
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

chatGenerationService.prepareGenerationTarget = async model => {
  if (model === 'missing-model') throw new Error('model is not installed');
  return {
    actualModelName: model,
    mergedOptions: {},
    activePlugin: null,
    pluginVariables: {},
  };
};

const call = (route, options = {}) =>
  fetch(`${baseUrl}${route}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      ...(options.headers ?? {}),
    },
  });

test('requests without credentials are rejected', async () => {
  const response = await fetch(`${baseUrl}/models`);
  assert.equal(response.status, 401);
});

test('GET /v1/models lists models in the OpenAI list shape', async () => {
  ollamaService.getModels = async () => [{ name: 'llama-local' }];
  pluginService.getActivePlugins = async () => [
    { id: 'acme', type: 'chat', model_map: ['acme-large'] },
    { id: 'painter', type: 'image', model_map: ['acme-paint'] },
  ];
  const response = await call('/models');
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.object, 'list');
  assert.deepEqual(
    payload.data.map(entry => [entry.id, entry.object, entry.owned_by]),
    [
      ['llama-local', 'model', 'ollama'],
      ['acme-large', 'model', 'acme'],
    ]
  );
});

test('POST /v1/chat/completions validates its request body', async () => {
  const missingModel = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(missingModel.status, 400);
  assert.equal((await missingModel.json()).error.type, 'invalid_request_error');

  const badRole = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'm',
      messages: [{ role: 'tool', content: 'x' }],
    }),
  });
  assert.equal(badRole.status, 400);

  const badTemperature = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      temperature: 9,
    }),
  });
  assert.equal(badTemperature.status, 400);

  const unknownModel = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'missing-model',
      messages: [{ role: 'user', content: 'x' }],
    }),
  });
  assert.equal(unknownModel.status, 404);
});

test('a non-streaming completion returns the OpenAI response shape with usage', async () => {
  let sawRequest;
  chatGenerationService.executeNonStreaming = async input => {
    sawRequest = input;
    return {
      response: {
        prompt_eval_count: 12,
        eval_count: 7,
        message: { role: 'assistant', content: 'stubbed answer' },
      },
      assistantContent: 'stubbed answer',
      source: 'ollama',
    };
  };
  const response = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'compat-model',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'hello there' }] },
      ],
      max_tokens: 64,
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.id, /^chatcmpl-/);
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.model, 'compat-model');
  assert.deepEqual(payload.choices, [
    {
      index: 0,
      message: { role: 'assistant', content: 'stubbed answer' },
      finish_reason: 'stop',
    },
  ]);
  assert.deepEqual(payload.usage, {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
  });
  // The multimodal text part flattened into plain content for the provider.
  assert.equal(sawRequest.ollamaMessages[1].content, 'hello there');
});

test('a streaming completion emits OpenAI chunk frames and [DONE]', async () => {
  ollamaService.generateChatStreamResponse = async (
    request,
    onChunk,
    _onError,
    onComplete
  ) => {
    onChunk({ message: { role: 'assistant', content: 'Hel' } });
    onChunk({ message: { role: 'assistant', content: 'lo' } });
    onComplete();
  };
  const response = await call('/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'compat-model',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const body = await response.text();
  const frames = body
    .split('\n\n')
    .filter(Boolean)
    .map(frame => frame.replace(/^data: /, ''));
  assert.equal(frames.at(-1), '[DONE]');
  const parsed = frames.slice(0, -1).map(frame => JSON.parse(frame));
  assert.ok(parsed.every(chunk => chunk.object === 'chat.completion.chunk'));
  assert.deepEqual(parsed[0].choices[0].delta, { role: 'assistant' });
  assert.equal(
    parsed
      .map(chunk => chunk.choices[0].delta.content ?? '')
      .join(''),
    'Hello'
  );
  assert.equal(parsed.at(-1).choices[0].finish_reason, 'stop');
});

test('API tokens with the chat scope may call /v1; others may not', async () => {
  const chatToken = await tokens.createApiToken('compat-user', {
    name: 'compat-chat',
    scopes: ['chat'],
  });
  const notesToken = await tokens.createApiToken('compat-user', {
    name: 'compat-notes',
    scopes: ['notes'],
  });
  assert.equal(
    tokens.requiredScopeForPath('/v1/chat/completions'),
    'chat',
    'the /v1 prefix must map to the chat scope'
  );
  assert.equal(tokens.requiredScopeForPath('/v1/models'), 'chat');
  const resolvedChat = await tokens.resolveApiToken(chatToken.token);
  const resolvedNotes = await tokens.resolveApiToken(notesToken.token);
  assert.ok(resolvedChat.scopes.includes('chat'));
  assert.ok(!resolvedNotes.scopes.includes('chat'));
});
