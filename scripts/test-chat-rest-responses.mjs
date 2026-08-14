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
const coordinator = await coordinationModule.initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
const { CHAT_GENERATE_JOB_TYPE, chatGenerationIdempotencyScope } =
  await distModule('platform/jobs/domainJobContracts.js');
const durableRuntime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const eventModule = await distModule('platform/events/index.js');
eventModule.initializeDurableEventGateway(durableRuntime.service, coordinator);
const [
  { getDatabase },
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
const originalSaveSessionAndEnqueueGeneration =
  storageService.saveSessionAndEnqueueGeneration;

after(async () => {
  chatGenerationService.prepareGenerationTarget =
    originalPrepareGenerationTarget;
  chatGenerationService.executeNonStreaming = originalExecuteNonStreaming;
  pluginService.executePluginStreamRequest = originalExecutePluginStreamRequest;
  storageService.saveSessionAndEnqueueGeneration =
    originalSaveSessionAndEnqueueGeneration;
  await new Promise(resolve => server.close(resolve));
  await eventModule.closeDurableEventGateway();
  await jobsModule.closeDurableJobRuntime();
  await coordinationModule.closeCoordinator();
  await platformStorageModule.closePlatformStorageRuntime();
  await persistenceModule.closePersistence();
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
    .map(block =>
      block
        .split('\n')
        .find(line => line.startsWith('data:'))
        ?.slice('data:'.length)
        .trim()
    )
    .filter(Boolean)
    .map(payload => JSON.parse(payload));
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

test('chat write lease preserves two concurrent message mutations', async () => {
  const session = await createPluginSession('concurrent-write');
  await Promise.all([
    chatService.addMessage(
      session.id,
      { id: 'concurrent-a', role: 'user', content: 'First concurrent write' },
      'chat-rest-user'
    ),
    chatService.addMessage(
      session.id,
      { id: 'concurrent-b', role: 'user', content: 'Second concurrent write' },
      'chat-rest-user'
    ),
  ]);
  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
  assert.ok(persisted);
  assert.deepEqual(
    persisted.messages
      .filter(message => message.id.startsWith('concurrent-'))
      .map(message => message.id)
      .sort(),
    ['concurrent-a', 'concurrent-b']
  );
});

test('stale chat metadata update cannot erase a completed assistant message', async () => {
  const session = await createPluginSession('stale-metadata');
  await chatService.addMessage(
    session.id,
    { id: 'assistant-authoritative', role: 'assistant', content: 'Completed' },
    'chat-rest-user'
  );
  await chatService.updateSession(
    session.id,
    {
      id: 'attacker-controlled-id',
      title: 'Renamed safely',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    },
    'chat-rest-user'
  );
  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
  assert.ok(persisted);
  assert.equal(persisted.id, session.id);
  assert.equal(persisted.title, 'Renamed safely');
  assert.ok(
    persisted.messages.some(message => message.id === 'assistant-authoritative')
  );
});

test('chat generation transaction resolves a lost COMMIT acknowledgement', async () => {
  const session = await createPluginSession('enqueue-ack-loss');
  let calls = 0;
  storageService.saveSessionAndEnqueueGeneration = async (...args) => {
    calls += 1;
    await originalSaveSessionAndEnqueueGeneration.apply(storageService, args);
    if (calls === 1) {
      throw new Error('connection lost after COMMIT');
    }
  };
  try {
    const result = await chatService.queueDurableGeneration({
      sessionId: session.id,
      userId: 'chat-rest-user',
      userMessageId: 'user-ack-loss',
      assistantMessageId: 'assistant-ack-loss',
      message: 'Commit this once',
    });
    assert.ok(result);
    assert.equal(calls, 2);
    const job = await durableRuntime.service.getByIdempotency(
      'chat-rest-user',
      chatGenerationIdempotencyScope(session.id),
      'assistant-ack-loss'
    );
    assert.ok(job);
    assert.equal(job.id, result.jobId);
    const persisted = await storageService.getSession(
      session.id,
      'chat-rest-user'
    );
    assert.equal(
      persisted.messages.filter(message => message.id === 'user-ack-loss')
        .length,
      1
    );
  } finally {
    storageService.saveSessionAndEnqueueGeneration =
      originalSaveSessionAndEnqueueGeneration;
  }
});

test('clear-all cancels a generation queued after its initial actor-wide pass', async () => {
  const session = await createPluginSession('clear-race');
  const originalCancelAll = durableRuntime.service.cancelAllForActor.bind(
    durableRuntime.service
  );
  let injectedJob;
  let calls = 0;
  durableRuntime.service.cancelAllForActor = async (...args) => {
    const result = await originalCancelAll(...args);
    calls += 1;
    if (calls === 1) {
      injectedJob = await durableRuntime.service.enqueue({
        jobType: CHAT_GENERATE_JOB_TYPE,
        actorUserId: 'chat-rest-user',
        payload: { mode: 'reference', referenceId: 'chat-clear-race' },
        idempotencyScope: chatGenerationIdempotencyScope(session.id),
        idempotencyKey: 'assistant-clear-race',
      });
    }
    return result;
  };
  try {
    await chatService.clearAllSessions('chat-rest-user');
    assert.ok(injectedJob);
    assert.equal(
      (await durableRuntime.service.getMetadata(injectedJob.id)).state,
      'cancelled'
    );
    assert.equal(
      await chatService.getSession(session.id, 'chat-rest-user'),
      undefined
    );
  } finally {
    durableRuntime.service.cancelAllForActor = originalCancelAll;
  }
});

test('deleting one chat cancels only that session generation', async () => {
  const first = await createPluginSession('delete-a');
  const second = await createPluginSession('delete-b');
  const firstJob = await durableRuntime.service.enqueue({
    jobType: CHAT_GENERATE_JOB_TYPE,
    actorUserId: 'chat-rest-user',
    payload: { mode: 'reference', referenceId: 'chat-delete-a' },
    idempotencyScope: chatGenerationIdempotencyScope(first.id),
    idempotencyKey: 'assistant-delete-a',
  });
  const firstLease = await durableRuntime.service.claim(
    'chat-delete-test-worker',
    30_000
  );
  assert.ok(firstLease);
  assert.equal(firstLease.id, firstJob.id);
  const secondJob = await durableRuntime.service.enqueue({
    jobType: CHAT_GENERATE_JOB_TYPE,
    actorUserId: 'chat-rest-user',
    payload: { mode: 'reference', referenceId: 'chat-delete-b' },
    idempotencyScope: chatGenerationIdempotencyScope(second.id),
    idempotencyKey: 'assistant-delete-b',
  });

  assert.equal(
    await chatService.deleteSession(first.id, 'chat-rest-user'),
    true
  );
  assert.equal(
    (await durableRuntime.service.getMetadata(firstJob.id)).state,
    'running'
  );
  assert.equal(
    (await durableRuntime.service.getMetadata(firstJob.id))
      .cancellationRequestedAt !== null,
    true
  );
  assert.equal(
    (await durableRuntime.service.getMetadata(secondJob.id)).state,
    'queued'
  );
  assert.ok(await chatService.getSession(second.id, 'chat-rest-user'));
  await durableRuntime.service.complete(firstLease, 'must-not-survive');
  assert.equal(
    (await durableRuntime.service.getMetadata(firstJob.id)).state,
    'cancelled'
  );
  assert.equal(
    await chatService.addMessage(
      first.id,
      { id: 'late-assistant', role: 'assistant', content: 'Late response' },
      'chat-rest-user'
    ),
    undefined
  );
});

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

  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
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

  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
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

  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
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
  const persistedAfterFirst = await storageService.getSession(
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
