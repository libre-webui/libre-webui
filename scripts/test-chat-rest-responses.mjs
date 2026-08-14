import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
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
const { durableEventId } = await distModule(
  'platform/jobs/durableEventIdentity.js'
);
const durableRuntime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const eventModule = await distModule('platform/events/index.js');
eventModule.initializeDurableEventGateway(durableRuntime.service, coordinator);
const { sharedRateLimit } = await distModule('middleware/sharedRateLimit.js');
const { isChatCancellationSafetyRequest } = await distModule(
  'middleware/chatCancellationAdmission.js'
);
const [
  { getDatabase },
  { authService },
  { default: chatRouter },
  { default: chatService },
  { default: chatGenerationService },
  { default: durableChatGenerationService },
  { default: pluginService },
  { default: storageService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/chat.js'),
  distModule('services/chatService.js'),
  distModule('services/chatGenerationService.js'),
  distModule('services/durableChatGenerationService.js'),
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
const outerChatRateLimiter = sharedRateLimit({
  coordinator,
  keyPrefix: 'api-chat',
  windowMs: 15 * 60 * 1_000,
  max: 1_000,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isChatCancellationSafetyRequest,
  operationTimeoutMs: 25,
});
app.use('/api/chat', outerChatRateLimiter, chatRouter);
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
const originalSaveSession = storageService.saveSession;
const originalSaveSessionAndEnqueueGeneration =
  storageService.saveSessionAndEnqueueGeneration;

after(async () => {
  chatGenerationService.prepareGenerationTarget =
    originalPrepareGenerationTarget;
  chatGenerationService.executeNonStreaming = originalExecuteNonStreaming;
  pluginService.executePluginStreamRequest = originalExecutePluginStreamRequest;
  storageService.saveSession = originalSaveSession;
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

const chatCancellationEventId = (sessionId, assistantMessageId) =>
  durableEventId(
    'chat',
    sessionId,
    assistantMessageId,
    'cancel-requested',
    'chat-rest-user'
  );

const chatDoneEventId = (sessionId, assistantMessageId) =>
  durableEventId('chat', sessionId, assistantMessageId, 'done');

const enqueueCompletionLease = async (sessionId, assistantMessageId, label) => {
  const job = await durableRuntime.service.enqueue({
    jobType: CHAT_GENERATE_JOB_TYPE,
    actorUserId: 'chat-rest-user',
    idempotencyScope: chatGenerationIdempotencyScope(sessionId),
    idempotencyKey: assistantMessageId,
    payload: {
      mode: 'encrypted',
      value: { sessionId, assistantMessageId },
    },
    priority: 100,
  });
  const lease = await durableRuntime.service.claim(
    `chat-completion-${label}`,
    30_000
  );
  assert.ok(lease);
  assert.equal(lease.id, job.id);
  return lease;
};

const completionPublication = (
  sessionId,
  assistantMessageId,
  lease,
  overrides = {}
) => {
  const content = overrides.content ?? `Answer ${assistantMessageId}`;
  return {
    sessionId,
    userId: 'chat-rest-user',
    message: {
      id: assistantMessageId,
      role: 'assistant',
      content,
      timestamp: Date.now(),
      ...overrides,
    },
    lease: {
      jobId: lease.id,
      workerId: lease.workerId,
      leaseToken: lease.leaseToken,
    },
    expectedJobType: CHAT_GENERATE_JOB_TYPE,
    event: {
      eventId: chatDoneEventId(sessionId, assistantMessageId),
      streamId: `chat:${sessionId}`,
      eventType: 'chat.done.v1',
      subjectId: assistantMessageId,
      actorUserId: 'chat-rest-user',
      payload: {
        mode: 'encrypted',
        value: { type: 'done', messageId: assistantMessageId, content },
      },
    },
  };
};

const publishCompletion = (...args) =>
  chatService.publishDurableChatCompletion(completionPublication(...args));

const publishCompletionWithoutChatLease = (...args) =>
  storageService.publishDurableChatCompletion(completionPublication(...args));

const waitFor = async (predicate, description) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
};

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

test('Stop removes only its assistant and preserves a newer concurrent chat write', async () => {
  const session = await createPluginSession('cancel-save-race');
  await chatService.addMessage(
    session.id,
    {
      id: 'cancel-save-parent',
      role: 'assistant',
      content: 'Original branch',
    },
    'chat-rest-user'
  );
  const before = await storageService.getSession(session.id, 'chat-rest-user');
  assert.ok(before);

  const controller = new AbortController();
  const cancellation = new Error('Stop won the persistence race');
  let releaseAcknowledgement;
  const acknowledgementBlocked = new Promise(resolve => {
    releaseAcknowledgement = resolve;
  });
  let observeCommit;
  const committed = new Promise(resolve => {
    observeCommit = resolve;
  });
  let blocked = false;
  storageService.saveSession = async (...args) => {
    await originalSaveSession.apply(storageService, args);
    const persistedSession = args[0];
    if (
      !blocked &&
      persistedSession.messages.some(
        message => message.id === 'cancel-save-assistant'
      )
    ) {
      blocked = true;
      observeCommit();
      await acknowledgementBlocked;
    }
  };

  try {
    const persistence = chatService.addMessage(
      session.id,
      {
        id: 'cancel-save-assistant',
        role: 'assistant',
        content: 'Must not survive Stop',
        parentId: 'cancel-save-parent',
        isActive: true,
      },
      'chat-rest-user',
      {
        assertPersistenceAllowed: () => {
          if (controller.signal.aborted) throw controller.signal.reason;
        },
      }
    );
    await committed;

    // The first save has committed, but its acknowledgement is deliberately
    // held. Simulate a newer replica mutation before Stop compensates; the
    // exact-row delete must preserve it and must not roll back its timestamp.
    const concurrent = await storageService.getSession(
      session.id,
      'chat-rest-user'
    );
    assert.ok(concurrent);
    const concurrentUpdatedAt = concurrent.updatedAt + 1000;
    concurrent.messages.push({
      id: 'concurrent-after-cancelled-save',
      role: 'user',
      content: 'A newer replica write',
      timestamp: concurrentUpdatedAt,
    });
    concurrent.updatedAt = concurrentUpdatedAt;
    await originalSaveSession.call(
      storageService,
      concurrent,
      'chat-rest-user'
    );
    controller.abort(cancellation);
    releaseAcknowledgement();

    await assert.rejects(persistence, error => error === cancellation);
    const restored = await storageService.getSession(
      session.id,
      'chat-rest-user'
    );
    assert.ok(restored);
    assert.equal(restored.updatedAt, concurrentUpdatedAt);
    assert.equal(
      restored.messages.some(message => message.id === 'cancel-save-assistant'),
      false
    );
    assert.equal(
      restored.messages.some(
        message => message.id === 'concurrent-after-cancelled-save'
      ),
      true
    );
    assert.equal(
      restored.messages.find(message => message.id === 'cancel-save-parent')
        ?.isActive,
      true
    );
    assert.deepEqual(
      restored.messages
        .filter(message =>
          before.messages.some(previous => previous.id === message.id)
        )
        .map(message => message.id),
      before.messages.map(message => message.id)
    );
  } finally {
    releaseAcknowledgement?.();
    storageService.saveSession = originalSaveSession;
  }
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
  const assistantMessageId = 'assistant-ack-loss';
  let calls = 0;
  storageService.saveSessionAndEnqueueGeneration = async (...args) => {
    calls += 1;
    await originalSaveSessionAndEnqueueGeneration.apply(storageService, args);
    if (calls === 1) {
      // Model a replica that acquires the chat lease after this request's
      // coordinator lease expires while only the COMMIT acknowledgement is
      // lost. The retry must detect the existing exact job and skip its stale
      // aggregate replacement, or it would erase this assistant but not done.
      const job = await durableRuntime.service.getByIdempotency(
        'chat-rest-user',
        chatGenerationIdempotencyScope(session.id),
        assistantMessageId
      );
      assert.ok(job);
      const lease = await durableRuntime.service.claim(
        'enqueue-ack-loss-worker',
        30_000
      );
      assert.ok(lease);
      assert.equal(lease.id, job.id);
      await publishCompletionWithoutChatLease(
        session.id,
        assistantMessageId,
        lease
      );
      throw new Error('connection lost after COMMIT');
    }
  };
  try {
    const result = await chatService.queueDurableGeneration({
      sessionId: session.id,
      userId: 'chat-rest-user',
      userMessageId: 'user-ack-loss',
      assistantMessageId,
      message: 'Commit this once',
    });
    assert.ok(result);
    assert.equal(
      calls,
      1,
      'the committed exact job must skip stale aggregate replacement'
    );
    const job = await durableRuntime.service.getByIdempotency(
      'chat-rest-user',
      chatGenerationIdempotencyScope(session.id),
      assistantMessageId
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
    assert.equal(
      persisted.messages.filter(message => message.id === assistantMessageId)
        .length,
      1
    );
    assert.equal(job.state, 'succeeded');
    assert.ok(
      await durableRuntime.service.getEvent(
        chatDoneEventId(session.id, assistantMessageId)
      )
    );
  } finally {
    storageService.saveSessionAndEnqueueGeneration =
      originalSaveSessionAndEnqueueGeneration;
  }
});

test('Stop before enqueue publication records intent and creates no claimable job', async () => {
  const session = await createPluginSession('cancel-before-enqueue');
  const assistantMessageId = 'assistant-cancel-before-enqueue';
  let releaseEnqueue;
  let observeEnqueue;
  const enqueueRelease = new Promise(resolve => {
    releaseEnqueue = resolve;
  });
  const enqueueEntered = new Promise(resolve => {
    observeEnqueue = resolve;
  });
  storageService.saveSessionAndEnqueueGeneration = async (...args) => {
    if (args[3]?.assistantMessageId === assistantMessageId) {
      observeEnqueue();
      await enqueueRelease;
    }
    return originalSaveSessionAndEnqueueGeneration.apply(storageService, args);
  };

  try {
    const enqueueResponse = fetch(
      `${baseUrl}/sessions/${session.id}/generations`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Do not run this provider request',
          userMessageId: 'user-cancel-before-enqueue',
          assistantMessageId,
        }),
      }
    );
    await enqueueEntered;

    const cancellation = await fetch(
      `${baseUrl}/sessions/${session.id}/generations/${assistantMessageId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(cancellation.status, 202);
    assert.deepEqual((await cancellation.json()).data, { pending: true });
    assert.ok(
      await durableRuntime.service.getEvent(
        chatCancellationEventId(session.id, assistantMessageId)
      )
    );

    releaseEnqueue();
    const queued = await enqueueResponse;
    assert.equal(queued.status, 202);
    const jobId = (await queued.json()).data.jobId;
    const metadata = await durableRuntime.service.getMetadata(jobId);
    assert.equal(metadata.state, 'cancelled');
    assert.equal(metadata.attemptCount, 0);
    assert.equal(metadata.maxAttempts, 2);
    assert.equal(
      await durableRuntime.service.getEvent(
        chatDoneEventId(session.id, assistantMessageId)
      ),
      null
    );
  } finally {
    releaseEnqueue?.();
    storageService.saveSessionAndEnqueueGeneration =
      originalSaveSessionAndEnqueueGeneration;
  }
});

test('Stop after enqueue COMMIT cancels the natural-key job before a lost 202', async () => {
  const session = await createPluginSession('disconnect-before-202');
  const assistantMessageId = 'assistant-disconnect-before-202';
  let releaseAcknowledgement;
  let observeCommit;
  const acknowledgementRelease = new Promise(resolve => {
    releaseAcknowledgement = resolve;
  });
  const committed = new Promise(resolve => {
    observeCommit = resolve;
  });
  storageService.saveSessionAndEnqueueGeneration = async (...args) => {
    await originalSaveSessionAndEnqueueGeneration.apply(storageService, args);
    if (args[3]?.assistantMessageId === assistantMessageId) {
      observeCommit();
      await acknowledgementRelease;
    }
  };

  let request;
  let responseStatus;
  const disconnected = new Promise(resolve => {
    const target = new URL(`${baseUrl}/sessions/${session.id}/generations`);
    request = httpRequest(
      target,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Connection: 'close',
        },
      },
      response => {
        responseStatus = response.statusCode;
        response.resume();
        response.once('end', resolve);
      }
    );
    request.once('error', resolve);
    request.end(
      JSON.stringify({
        message: 'The socket will close before acknowledgement',
        userMessageId: 'user-disconnect-before-202',
        assistantMessageId,
      })
    );
  });

  try {
    await committed;
    const cancellation = await fetch(
      `${baseUrl}/sessions/${session.id}/generations/${assistantMessageId}/cancel`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    assert.equal(cancellation.status, 202);
    const cancellationData = (await cancellation.json()).data;
    assert.equal(cancellationData.state, 'cancelled');
    request.socket?.destroy(new Error('test socket closed before 202'));
    await disconnected;
    releaseAcknowledgement();

    const job = await waitFor(async () => {
      const candidate = await durableRuntime.service.getByIdempotency(
        'chat-rest-user',
        chatGenerationIdempotencyScope(session.id),
        assistantMessageId
      );
      return candidate?.state === 'cancelled' ? candidate : null;
    }, 'disconnect cancellation');
    assert.equal(responseStatus, undefined);
    assert.equal(job.attemptCount, 0);
    assert.ok(
      await durableRuntime.service.getEvent(
        chatCancellationEventId(session.id, assistantMessageId)
      )
    );
    assert.equal(
      await durableRuntime.service.getEvent(
        chatDoneEventId(session.id, assistantMessageId)
      ),
      null
    );
  } finally {
    request?.destroy();
    releaseAcknowledgement?.();
    storageService.saveSessionAndEnqueueGeneration =
      originalSaveSessionAndEnqueueGeneration;
  }
});

test('ordinary chat mutation and durable completion share one write lease', async () => {
  const session = await createPluginSession('completion-write-lease');
  const assistantMessageId = 'assistant-write-lease';
  const lease = await enqueueCompletionLease(
    session.id,
    assistantMessageId,
    'write-lease'
  );
  let releaseSave;
  let observeSave;
  const saveRelease = new Promise(resolve => {
    releaseSave = resolve;
  });
  const saveEntered = new Promise(resolve => {
    observeSave = resolve;
  });
  storageService.saveSession = async (...args) => {
    if (
      args[0]?.messages.some(message => message.id === 'ordinary-write-barrier')
    ) {
      observeSave();
      await saveRelease;
    }
    return originalSaveSession.apply(storageService, args);
  };

  try {
    const ordinaryWrite = chatService.addMessage(
      session.id,
      {
        id: 'ordinary-write-barrier',
        role: 'user',
        content: 'Committed immediately before completion',
      },
      'chat-rest-user'
    );
    await saveEntered;
    let completionSettled = false;
    const completion = publishCompletion(
      session.id,
      assistantMessageId,
      lease
    ).finally(() => {
      completionSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completionSettled, false);
    releaseSave();
    await ordinaryWrite;
    await completion;

    const persisted = await storageService.getSession(
      session.id,
      'chat-rest-user'
    );
    assert.ok(persisted);
    assert.deepEqual(
      persisted.messages
        .filter(message =>
          ['ordinary-write-barrier', assistantMessageId].includes(message.id)
        )
        .map(message => message.id)
        .sort(),
      ['assistant-write-lease', 'ordinary-write-barrier']
    );
    const metadata = await durableRuntime.service.getMetadata(lease.id);
    assert.equal(metadata.state, 'succeeded');
    assert.equal(
      metadata.resultReference,
      `chat-message:${assistantMessageId}`
    );
    assert.equal(metadata.progressCurrent, metadata.progressTotal);
  } finally {
    releaseSave?.();
    storageService.saveSession = originalSaveSession;
  }
});

test('durable streamed plugin completion persists JSON-safe statistics and done', async () => {
  const session = await createPluginSession('durable-plugin-statistics');
  const userMessageId = 'user-durable-plugin-statistics';
  const assistantMessageId = 'assistant-durable-plugin-statistics';
  const content = 'Mocked local plugin response';
  configurePluginTarget(true);
  pluginService.executePluginStreamRequest = async function* () {
    yield { type: 'content', content: 'Mocked local ' };
    yield { type: 'content', content: 'plugin response' };
    yield { type: 'done' };
  };

  try {
    const queued = await chatService.queueDurableGeneration({
      sessionId: session.id,
      userId: 'chat-rest-user',
      userMessageId,
      assistantMessageId,
      message: 'Exercise the durable plugin completion path',
    });
    assert.ok(queued);
    const lease = await durableRuntime.service.claim(
      'durable-plugin-statistics-worker',
      30_000
    );
    assert.ok(lease);
    assert.equal(lease.id, queued.jobId);
    const payload = durableRuntime.service.readPayload(lease);
    const assertSideEffectAllowed = async () => {
      const heartbeat = durableRuntime.service.heartbeat(lease, 30_000);
      assert.equal(heartbeat.owned, true);
      assert.equal(heartbeat.cancellationRequested, false);
    };

    await durableChatGenerationService.execute(payload, {
      signal: new AbortController().signal,
      attemptCount: lease.attemptCount,
      sideEffectLease: {
        jobId: lease.id,
        workerId: lease.workerId,
        leaseToken: lease.leaseToken,
      },
      assertSideEffectAllowed,
    });

    const persisted = await storageService.getSession(
      session.id,
      'chat-rest-user'
    );
    const assistant = persisted?.messages.find(
      message => message.id === assistantMessageId
    );
    assert.ok(assistant);
    assert.equal(assistant.content, content);
    assert.deepEqual(assistant.statistics, {
      created_at: assistant.statistics.created_at,
      model: session.model,
    });
    assert.equal(typeof assistant.statistics.created_at, 'string');

    const done = await durableRuntime.service.getEvent(
      chatDoneEventId(session.id, assistantMessageId)
    );
    assert.ok(done);
    assert.equal(done.eventType, 'chat.done.v1');
    assert.equal(done.payload.content, content);
    assert.deepEqual(done.payload.statistics, assistant.statistics);
    assert.doesNotThrow(() => JSON.stringify(done.payload));
    assert.equal(
      (await durableRuntime.service.getMetadata(lease.id)).state,
      'succeeded'
    );
  } finally {
    chatGenerationService.prepareGenerationTarget =
      originalPrepareGenerationTarget;
    pluginService.executePluginStreamRequest =
      originalExecutePluginStreamRequest;
  }
});

test('cancellation intent wins a blocked completion without a ghost or done event', async () => {
  const session = await createPluginSession('cancel-publish-barrier');
  const assistantMessageId = 'assistant-cancel-publish-barrier';
  const lease = await enqueueCompletionLease(
    session.id,
    assistantMessageId,
    'cancel-publish'
  );
  const barrier = await coordinator.acquireLease(
    `chat-write:chat-rest-user:${session.id}`,
    30_000
  );
  assert.ok(barrier);
  const completion = publishCompletion(session.id, assistantMessageId, lease);
  const decision = await durableRuntime.service.requestChatCancellation({
    actorUserId: 'chat-rest-user',
    sessionId: session.id,
    assistantMessageId,
  });
  assert.equal(decision.outcome, 'cancellation-recorded');
  assert.equal(decision.job?.cancellationRequestedAt !== null, true);
  await barrier.release();

  await assert.rejects(completion, error => error?.code === 'cancelled');
  assert.equal(
    await durableRuntime.service.getEvent(
      chatDoneEventId(session.id, assistantMessageId)
    ),
    null
  );
  assert.ok(
    await durableRuntime.service.getEvent(
      chatCancellationEventId(session.id, assistantMessageId)
    )
  );
  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
  assert.equal(
    persisted.messages.some(message => message.id === assistantMessageId),
    false
  );
  await durableRuntime.service.fail(lease, {
    retryable: false,
    errorCode: 'cancelled-at-publish',
    errorSummary: 'Cancellation won the completion decision',
    backoffMs: 0,
  });
  assert.equal(
    (await durableRuntime.service.getMetadata(lease.id)).state,
    'cancelled'
  );
});

test('committed completion wins a later Stop without recording cancel intent', async () => {
  const session = await createPluginSession('publish-before-cancel');
  const assistantMessageId = 'assistant-publish-before-cancel';
  const lease = await enqueueCompletionLease(
    session.id,
    assistantMessageId,
    'publish-first'
  );
  await publishCompletion(session.id, assistantMessageId, lease);
  const decision = await durableRuntime.service.requestChatCancellation({
    actorUserId: 'chat-rest-user',
    sessionId: session.id,
    assistantMessageId,
  });
  assert.equal(decision.outcome, 'completion-won');
  assert.ok(
    await durableRuntime.service.getEvent(
      chatDoneEventId(session.id, assistantMessageId)
    )
  );
  assert.equal(
    await durableRuntime.service.getEvent(
      chatCancellationEventId(session.id, assistantMessageId)
    ),
    null
  );
});

test('a stale completion lease cannot publish and the reclaimed lease can', async () => {
  const session = await createPluginSession('stale-completion-lease');
  const assistantMessageId = 'assistant-stale-completion-lease';
  const stale = await enqueueCompletionLease(
    session.id,
    assistantMessageId,
    'stale'
  );
  assert.equal(await durableRuntime.service.abandon(stale), 'queued');
  const current = await durableRuntime.service.claim(
    'chat-completion-current',
    30_000
  );
  assert.ok(current);
  assert.equal(current.id, stale.id);
  assert.notEqual(current.leaseToken, stale.leaseToken);

  await assert.rejects(
    publishCompletion(session.id, assistantMessageId, stale),
    error => error?.code === 'lease-lost'
  );
  assert.equal(
    await durableRuntime.service.getEvent(
      chatDoneEventId(session.id, assistantMessageId)
    ),
    null
  );
  await publishCompletion(session.id, assistantMessageId, current);
  assert.equal(
    (await durableRuntime.service.getMetadata(current.id)).state,
    'succeeded'
  );
});

test('durable regeneration requires a same-session assistant branch root', async () => {
  const session = await createPluginSession('completion-branch-root');
  await chatService.addMessage(
    session.id,
    {
      id: 'completion-branch-root',
      role: 'assistant',
      content: 'Original answer',
      isActive: true,
    },
    'chat-rest-user'
  );
  const invalidId = 'assistant-invalid-branch';
  const invalidLease = await enqueueCompletionLease(
    session.id,
    invalidId,
    'invalid-branch'
  );
  await assert.rejects(
    publishCompletion(session.id, invalidId, invalidLease, {
      parentId: 'missing-branch-root',
      isActive: true,
    }),
    /branch root is unavailable/
  );
  assert.equal(
    await durableRuntime.service.getEvent(
      chatDoneEventId(session.id, invalidId)
    ),
    null
  );
  await durableRuntime.service.cancel(
    invalidLease.id,
    'chat-rest-user',
    'user-requested'
  );

  const branchId = 'assistant-valid-branch';
  const branchLease = await enqueueCompletionLease(
    session.id,
    branchId,
    'valid-branch'
  );
  await publishCompletion(session.id, branchId, branchLease, {
    parentId: 'completion-branch-root',
    isActive: true,
  });
  const persisted = await storageService.getSession(
    session.id,
    'chat-rest-user'
  );
  assert.equal(
    persisted.messages.find(message => message.id === 'completion-branch-root')
      .isActive,
    false
  );
  assert.equal(
    persisted.messages.find(message => message.id === branchId).isActive,
    true
  );
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

test('natural-key Stop bypasses only ordinary chat admission and still reaches SQL', async () => {
  const session = await createPluginSession('stop-admission-safety');
  const originalConsumeRateLimit = coordinator.consumeRateLimit;
  let coordinatorCalls = [];

  const rateDecision = allowed => ({
    allowed,
    remaining: allowed ? 1 : 0,
    resetAt: Date.now() + 60_000,
    windowToken: `stop-admission-${allowed ? 'allowed' : 'denied'}`,
  });
  const installCoordinatorBehavior = behavior => {
    coordinatorCalls = [];
    coordinator.consumeRateLimit = (key, limit, windowMs) => {
      coordinatorCalls.push(key);
      return behavior(key, limit, windowMs);
    };
  };
  const stop = (assistantMessageId, authorization = `Bearer ${token}`) => {
    const headers = authorization ? { Authorization: authorization } : {};
    return fetch(
      `${baseUrl}/sessions/${session.id}/generations/${assistantMessageId}/cancel`,
      { method: 'POST', headers }
    );
  };
  const listSessions = () =>
    fetch(`${baseUrl}/sessions`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  const assertSqlCancellation = async assistantMessageId => {
    const response = await stop(assistantMessageId);
    assert.equal(response.status, 202);
    assert.deepEqual((await response.json()).data, { pending: true });
    assert.ok(
      await durableRuntime.service.getEvent(
        chatCancellationEventId(session.id, assistantMessageId)
      )
    );
    assert.deepEqual(coordinatorCalls, []);
  };

  try {
    // Both the outer and inner policies would reject if consulted. The exact
    // Stop path reaches the durable SQL decision without consulting either.
    installCoordinatorBehavior(() => Promise.resolve(rateDecision(false)));
    const unauthenticated = await stop('stop-admission-unauthenticated', null);
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(coordinatorCalls, []);
    await assertSqlCancellation('stop-admission-both-exhausted');

    const outerLimited = await listSessions();
    assert.equal(outerLimited.status, 429);
    assert.equal(coordinatorCalls.length, 1);
    assert.match(coordinatorCalls[0], /^http-rate:api-chat:/);

    // Let the outer policy pass and prove the neighboring route still fails
    // when the inner chat-routes bucket is exhausted.
    installCoordinatorBehavior(key =>
      Promise.resolve(rateDecision(!key.startsWith('http-rate:chat-routes:')))
    );
    const innerLimited = await listSessions();
    assert.equal(innerLimited.status, 429);
    assert.equal(coordinatorCalls.length, 2);
    assert.match(coordinatorCalls[0], /^http-rate:api-chat:/);
    assert.match(coordinatorCalls[1], /^http-rate:chat-routes:/);

    installCoordinatorBehavior(() =>
      Promise.reject(new Error('coordinator rejected the command'))
    );
    await assertSqlCancellation('stop-admission-coordinator-rejected');
    assert.equal((await listSessions()).status, 503);
    assert.equal(coordinatorCalls.length, 1);

    installCoordinatorBehavior(() => new Promise(() => {}));
    const stalledStopStartedAt = Date.now();
    await assertSqlCancellation('stop-admission-coordinator-stalled');
    assert.ok(Date.now() - stalledStopStartedAt < 200);
    const stalledOrdinaryStartedAt = Date.now();
    assert.equal((await listSessions()).status, 503);
    assert.ok(Date.now() - stalledOrdinaryStartedAt < 200);
    assert.equal(coordinatorCalls.length, 1);
  } finally {
    coordinator.consumeRateLimit = originalConsumeRateLimit;
  }
});
