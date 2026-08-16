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
  { getDatabase },
  { authService },
  apiTokens,
  { default: openaiCompatRouter },
  { default: chatGenerationService },
  { default: ollamaService },
  { default: pluginService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('services/apiTokenService.js'),
  distModule('routes/openaiCompat.js'),
  distModule('services/chatGenerationService.js'),
  distModule('services/ollamaService.js'),
  distModule('services/pluginService.js'),
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
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

const originalGetModels = ollamaService.getModels;
const originalGetActivePlugins = pluginService.getActivePlugins;
const originalPrepareGenerationTarget =
  chatGenerationService.prepareGenerationTarget;
const originalExecuteNonStreaming = chatGenerationService.executeNonStreaming;
const originalGenerateChatStreamResponse =
  ollamaService.generateChatStreamResponse;

after(async () => {
  ollamaService.getModels = originalGetModels;
  pluginService.getActivePlugins = originalGetActivePlugins;
  chatGenerationService.prepareGenerationTarget =
    originalPrepareGenerationTarget;
  chatGenerationService.executeNonStreaming = originalExecuteNonStreaming;
  ollamaService.generateChatStreamResponse = originalGenerateChatStreamResponse;
  await new Promise(resolve => server.close(resolve));
  await coordinationModule.closeCoordinator();
  await platformStorageModule.closePlatformStorageRuntime();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

const authed = { Authorization: `Bearer ${jwt}` };
const json = { 'Content-Type': 'application/json' };

test('scoped token paths map /v1 routes and fail closed elsewhere', () => {
  assert.equal(apiTokens.requiredScopeForPath('/v1/chat/completions'), 'chat');
  assert.equal(apiTokens.requiredScopeForPath('/v1/models'), 'models');
  assert.equal(apiTokens.requiredScopeForPath('/v1/anything-else'), 'admin');
});

test('GET /v1/models lists chat-capable models in the OpenAI shape', async () => {
  ollamaService.getModels = async () => [
    { name: 'llama3.2:3b' },
    { name: 'nomic-embed-text' },
  ];
  pluginService.getActivePlugins = async () => [
    { id: 'openai', type: 'completion', model_map: ['gpt-test', 'tts-1'] },
  ];

  const response = await fetch(`${baseUrl}/v1/models`, { headers: authed });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'list');
  const ids = body.data.map(model => model.id);
  assert.ok(ids.includes('llama3.2:3b'), 'ollama model listed');
  assert.ok(ids.includes('gpt-test'), 'plugin model listed');
  assert.ok(!ids.includes('nomic-embed-text'), 'embedding model filtered');
  assert.ok(!ids.includes('tts-1'), 'speech model filtered');
  for (const model of body.data) {
    assert.equal(model.object, 'model');
    assert.equal(typeof model.owned_by, 'string');
  }
});

test('non-streaming completion returns an OpenAI chat.completion with usage', async () => {
  chatGenerationService.prepareGenerationTarget = async modelName => ({
    actualModelName: modelName,
    mergedOptions: {},
    activePlugin: null,
    providerType: 'ollama',
  });
  chatGenerationService.executeNonStreaming = async ({ ollamaMessages }) => {
    assert.equal(ollamaMessages.at(-1).content, 'Say hi');
    return {
      response: { prompt_eval_count: 7, eval_count: 3 },
      assistantContent: 'hi there',
      source: 'ollama',
    };
  };

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, ...json },
    body: JSON.stringify({
      model: 'llama3.2:3b',
      messages: [{ role: 'user', content: 'Say hi' }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, 'chat.completion');
  assert.match(body.id, /^chatcmpl-/);
  assert.equal(body.choices[0].message.content, 'hi there');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.deepEqual(body.usage, {
    prompt_tokens: 7,
    completion_tokens: 3,
    total_tokens: 10,
  });
});

test('streaming completion emits chunk frames and ends with [DONE]', async () => {
  chatGenerationService.prepareGenerationTarget = async modelName => ({
    actualModelName: modelName,
    mergedOptions: {},
    activePlugin: null,
    providerType: 'ollama',
  });
  ollamaService.generateChatStreamResponse = async (
    _request,
    onChunk,
    _onError,
    onComplete
  ) => {
    onChunk({ message: { role: 'assistant', content: 'Hel' }, done: false });
    onChunk({ message: { role: 'assistant', content: 'lo' }, done: false });
    onChunk({
      message: { role: 'assistant', content: '' },
      done: true,
      prompt_eval_count: 5,
      eval_count: 2,
    });
    onComplete();
  };

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, ...json },
    body: JSON.stringify({
      model: 'llama3.2:3b',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Say hello' }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/
  );
  const raw = await response.text();
  const frames = raw
    .split('\n\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice('data: '.length));
  assert.equal(frames.at(-1), '[DONE]');
  const chunks = frames.slice(0, -1).map(frame => JSON.parse(frame));
  const text = chunks
    .map(chunk => chunk.choices[0].delta.content ?? '')
    .join('');
  assert.equal(text, 'Hello');
  const final = chunks.at(-1);
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.deepEqual(final.usage, {
    prompt_tokens: 5,
    completion_tokens: 2,
    total_tokens: 7,
  });
});

test('lwk_ tokens are scope-checked: chat passes, notes is rejected', async () => {
  chatGenerationService.prepareGenerationTarget = async modelName => ({
    actualModelName: modelName,
    mergedOptions: {},
    activePlugin: null,
    providerType: 'ollama',
  });
  chatGenerationService.executeNonStreaming = async () => ({
    response: {},
    assistantContent: 'scoped ok',
    source: 'ollama',
  });

  const chatToken = await apiTokens.createApiToken('compat-user', {
    name: 'compat chat',
    scopes: ['chat'],
  });
  const notesToken = await apiTokens.createApiToken('compat-user', {
    name: 'compat notes',
    scopes: ['notes'],
  });
  const body = JSON.stringify({
    model: 'llama3.2:3b',
    messages: [{ role: 'user', content: 'scope check' }],
  });

  const allowed = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${chatToken.token}`, ...json },
    body,
  });
  assert.equal(allowed.status, 200);
  const allowedBody = await allowed.json();
  assert.equal(allowedBody.choices[0].message.content, 'scoped ok');

  const rejected = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${notesToken.token}`, ...json },
    body,
  });
  assert.equal(rejected.status, 403);
});

test('invalid requests get OpenAI-style error bodies', async () => {
  const missingModel = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, ...json },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(missingModel.status, 400);
  const missingBody = await missingModel.json();
  assert.equal(typeof missingBody.error.message, 'string');
  assert.equal(missingBody.error.type, 'invalid_request_error');

  const imagePart = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { ...authed, ...json },
    body: JSON.stringify({
      model: 'llama3.2:3b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    }),
  });
  assert.equal(imagePart.status, 400);
  const imageBody = await imagePart.json();
  assert.match(imageBody.error.message, /text content/i);

  const unauthenticated = await fetch(`${baseUrl}/v1/models`);
  assert.equal(unauthenticated.status, 401);
});
