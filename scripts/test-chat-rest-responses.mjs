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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-chat-rest-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'chat-rest-test-secret';
process.env.ENCRYPTION_KEY ||= '1'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );
const [
  { closeDatabase, getDatabase },
  { authService },
  { default: chatRouter },
  { default: chatService },
  { default: chatGenerationService },
  { default: pluginService },
  { default: storageService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/chat.js'),
  distModule('services/chatService.js'),
  distModule('services/chatGenerationService.js'),
  distModule('services/pluginService.js'),
  distModule('storage.js'),
]);

const now = Date.now();
getDatabase()
  .prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'unused', 'user', NULL, ?, ?)`
  )
  .run('chat-rest-user', 'chat-rest-user', now, now);

const token = authService.generateToken({
  id: 'chat-rest-user',
  username: 'chat-rest-user',
  email: null,
  role: 'user',
  status: 'active',
  avatar: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});

const app = express();
app.use(express.json());
app.use('/api/chat', chatRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Chat REST test server did not expose a TCP port.');
}
const baseUrl = `http://127.0.0.1:${address.port}/api/chat`;

const originalPrepareGenerationTarget =
  chatGenerationService.prepareGenerationTarget;
const originalExecuteNonStreaming = chatGenerationService.executeNonStreaming;
const originalExecutePluginStreamRequest =
  pluginService.executePluginStreamRequest;

after(async () => {
  chatGenerationService.prepareGenerationTarget =
    originalPrepareGenerationTarget;
  chatGenerationService.executeNonStreaming = originalExecuteNonStreaming;
  pluginService.executePluginStreamRequest = originalExecutePluginStreamRequest;
  await new Promise(resolve => server.close(resolve));
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

const clone = value => JSON.parse(JSON.stringify(value));

async function createPluginSession(label) {
  return chatService.createSession(
    `model-${label}`,
    `Session ${label}`,
    'chat-rest-user',
    undefined,
    {
      providerType: 'plugin',
      providerId: 'responses-plugin',
    }
  );
}

function configurePluginTarget(stream) {
  chatGenerationService.prepareGenerationTarget = async (
    model,
    _userId,
    options
  ) => ({
    actualModelName: model,
    mergedOptions: options,
    activePlugin: { id: 'responses-plugin' },
    pluginVariables: { stream },
    providerType: 'plugin',
    providerId: 'responses-plugin',
  });
}

async function postGeneration(sessionId, route, message) {
  return fetch(`${baseUrl}/sessions/${sessionId}/${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  });
}

function parseSse(body) {
  return body
    .split('\n\n')
    .map(block => block.trim())
    .filter(block => block.startsWith('data:'))
    .map(block => JSON.parse(block.slice('data:'.length).trim()));
}

function responseMetadata(label) {
  return {
    openAIResponsesOutputItems: [
      {
        id: `message-${label}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `Answer ${label}` }],
      },
    ],
    openAIResponsesStateScope: 'chat-rest-scope',
  };
}

function nonStreamingResult(model, content, providerMetadata) {
  return {
    response: {
      model,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content,
        providerMetadata,
      },
      done: true,
    },
    assistantContent: content,
    source: 'plugin',
  };
}

test('Chat REST non-streaming persists Responses state and replays it on the next turn', async () => {
  const session = await createPluginSession('nonstream');
  const calls = [];
  let callNumber = 0;
  configurePluginTarget(false);
  chatGenerationService.executeNonStreaming = async request => {
    calls.push(clone(request.pluginMessages));
    callNumber += 1;
    return nonStreamingResult(
      session.model,
      `Answer ${callNumber}`,
      responseMetadata(`nonstream-${callNumber}`)
    );
  };

  const first = await postGeneration(session.id, 'generate', 'First prompt');
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.deepEqual(
    firstBody.data.providerMetadata,
    responseMetadata('nonstream-1')
  );

  const second = await postGeneration(session.id, 'generate', 'Second prompt');
  assert.equal(second.status, 200);
  assert.equal(calls.length, 2);
  const replayedAssistant = calls[1].find(
    message => message.role === 'assistant'
  );
  assert.ok(replayedAssistant);
  assert.deepEqual(
    replayedAssistant.providerMetadata,
    responseMetadata('nonstream-1')
  );

  const persisted = storageService.getSession(session.id, 'chat-rest-user');
  assert.ok(persisted);
  assert.deepEqual(
    persisted.messages.at(-1).providerMetadata,
    responseMetadata('nonstream-2')
  );
});

test('Chat REST streaming persists done metadata and replays it on the next turn', async () => {
  const session = await createPluginSession('stream');
  const calls = [];
  let callNumber = 0;
  configurePluginTarget(true);
  pluginService.executePluginStreamRequest = async function* (
    _model,
    messages
  ) {
    calls.push(clone(messages));
    callNumber += 1;
    yield { type: 'content', content: `Stream ${callNumber}` };
    yield {
      type: 'done',
      providerMetadata: responseMetadata(`stream-${callNumber}`),
    };
  };

  const first = await postGeneration(
    session.id,
    'generate/stream',
    'First stream prompt'
  );
  assert.equal(first.status, 200);
  assert.deepEqual(
    parseSse(await first.text()).map(event => event.type),
    ['chunk', 'done']
  );

  const second = await postGeneration(
    session.id,
    'generate/stream',
    'Second stream prompt'
  );
  assert.equal(second.status, 200);
  assert.deepEqual(
    parseSse(await second.text()).map(event => event.type),
    ['chunk', 'done']
  );
  assert.equal(calls.length, 2);
  const replayedAssistant = calls[1].find(
    message => message.role === 'assistant'
  );
  assert.ok(replayedAssistant);
  assert.deepEqual(
    replayedAssistant.providerMetadata,
    responseMetadata('stream-1')
  );

  const persisted = storageService.getSession(session.id, 'chat-rest-user');
  assert.ok(persisted);
  assert.deepEqual(
    persisted.messages.at(-1).providerMetadata,
    responseMetadata('stream-2')
  );
});

test('Chat REST streaming reports incomplete Responses output and does not persist it', async () => {
  const session = await createPluginSession('incomplete');
  configurePluginTarget(true);
  pluginService.executePluginStreamRequest = async function* () {
    yield { type: 'content', content: 'Partial answer' };
    yield {
      type: 'done',
      doneReason: 'incomplete:max_output_tokens',
      providerMetadata: responseMetadata('incomplete'),
    };
  };

  const response = await postGeneration(
    session.id,
    'generate/stream',
    'Incomplete prompt'
  );
  assert.equal(response.status, 200);
  const events = parseSse(await response.text());
  assert.deepEqual(
    events.map(event => event.type),
    ['chunk', 'error']
  );
  assert.equal(
    events[1].error,
    'Provider returned an incomplete response (max_output_tokens)'
  );

  const persisted = storageService.getSession(session.id, 'chat-rest-user');
  assert.ok(persisted);
  assert.equal(
    persisted.messages.filter(message => message.role === 'user').length,
    1
  );
  assert.equal(
    persisted.messages.some(message => message.role === 'assistant'),
    false
  );
});

test('Chat REST keeps function-call output visible without persisting or replaying raw call state', async () => {
  const session = await createPluginSession('function-call');
  const calls = [];
  let callNumber = 0;
  configurePluginTarget(false);
  chatGenerationService.executeNonStreaming = async request => {
    calls.push(clone(request.pluginMessages));
    callNumber += 1;
    const metadata =
      callNumber === 1
        ? {
            openAIResponsesOutputItems: [
              {
                id: 'message-before-call',
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'I requested a scan.' }],
              },
              {
                id: 'call-scan',
                type: 'function_call',
                call_id: 'call-scan',
                name: 'scan_project',
                arguments: '{}',
              },
            ],
            openAIResponsesStateScope: 'chat-rest-scope',
          }
        : responseMetadata('after-call');
    return nonStreamingResult(
      session.model,
      callNumber === 1
        ? 'I requested a scan.\n\n---\n**🔧 Tool Calls:** scan_project'
        : 'No tool result was recorded.',
      metadata
    );
  };

  const first = await postGeneration(
    session.id,
    'generate',
    'Scan the project'
  );
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.match(firstBody.data.content, /scan_project/);
  assert.equal(firstBody.data.providerMetadata, undefined);
  const persistedAfterFirst = storageService.getSession(
    session.id,
    'chat-rest-user'
  );
  assert.ok(persistedAfterFirst);
  const persistedAssistant = persistedAfterFirst.messages.find(
    message => message.role === 'assistant'
  );
  assert.ok(persistedAssistant);
  assert.match(persistedAssistant.content, /scan_project/);
  assert.equal(persistedAssistant.providerMetadata, undefined);

  const second = await postGeneration(session.id, 'generate', 'What happened?');
  assert.equal(second.status, 200);
  const replayedAssistant = calls[1].find(
    message => message.role === 'assistant'
  );
  assert.ok(replayedAssistant);
  assert.match(replayedAssistant.content, /scan_project/);
  assert.equal(replayedAssistant.providerMetadata, undefined);
});
