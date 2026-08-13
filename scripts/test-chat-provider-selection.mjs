import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const sharedModel = 'chat-provider-collision-model';
const userId = 'chat-provider-user';
const pluginAId = 'chat-provider-a';
const pluginBId = 'chat-provider-b';
const inactivePluginId = 'chat-provider-inactive';
const missingCredentialPluginId = 'chat-provider-no-key';
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-chat-provider-selection-')
);
const dataDir = path.join(tempRoot, 'data');
const pluginsDir = path.join(tempRoot, 'plugins');
const requests = [];
const previousEnv = {
  DATA_DIR: process.env.DATA_DIR,
  PLUGINS_DIR: process.env.PLUGINS_DIR,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  CHAT_PROVIDER_A_TEST_KEY: process.env.CHAT_PROVIDER_A_TEST_KEY,
  CHAT_PROVIDER_B_TEST_KEY: process.env.CHAT_PROVIDER_B_TEST_KEY,
  CHAT_PROVIDER_INACTIVE_TEST_KEY: process.env.CHAT_PROVIDER_INACTIVE_TEST_KEY,
  CHAT_PROVIDER_NO_KEY_TEST_KEY: process.env.CHAT_PROVIDER_NO_KEY_TEST_KEY,
};

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(pluginsDir, { recursive: true });

const providerServer = http.createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', chunk => {
    body += chunk;
  });
  request.on('end', () => {
    const parsedBody = body ? JSON.parse(body) : {};
    const providerId = request.url?.includes(`/${pluginBId}/`)
      ? pluginBId
      : pluginAId;
    requests.push({
      providerId,
      url: request.url,
      authorization: request.headers.authorization,
      body: parsedBody,
    });

    if (parsedBody.stream) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: providerId } }],
        })}\n\n`
      );
      response.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        })}\n\n`
      );
      response.end('data: [DONE]\n\n');
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        id: `response-${providerId}`,
        object: 'chat.completion',
        created: 1,
        model: sharedModel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: providerId },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
        },
      })
    );
  });
});

await new Promise((resolve, reject) => {
  providerServer.once('error', reject);
  providerServer.listen(0, '127.0.0.1', resolve);
});

const address = providerServer.address();
if (!address || typeof address === 'string') {
  throw new Error('Provider test server did not expose a TCP port.');
}

const pluginDefinition = (id, keyEnv) => ({
  id,
  name: id,
  type: 'completion',
  endpoint: `http://127.0.0.1:${address.port}/${id}/v1/chat/completions`,
  auth: {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: keyEnv,
  },
  model_map: [sharedModel],
});

const pluginDefinitions = [
  pluginDefinition(pluginAId, 'CHAT_PROVIDER_A_TEST_KEY'),
  pluginDefinition(pluginBId, 'CHAT_PROVIDER_B_TEST_KEY'),
  pluginDefinition(inactivePluginId, 'CHAT_PROVIDER_INACTIVE_TEST_KEY'),
  pluginDefinition(missingCredentialPluginId, 'CHAT_PROVIDER_NO_KEY_TEST_KEY'),
];
for (const plugin of pluginDefinitions) {
  fs.writeFileSync(
    path.join(pluginsDir, `${plugin.id}.json`),
    JSON.stringify(plugin, null, 2)
  );
}
fs.writeFileSync(
  path.join(pluginsDir, '.status.json'),
  JSON.stringify({
    activePlugins: [pluginAId, pluginBId, missingCredentialPluginId],
  })
);

// Start from the pre-provider Chat schema so database initialization exercises
// the additive migration rather than only the fresh-schema path.
const legacyDatabase = new Database(path.join(dataDir, 'data.sqlite'));
legacyDatabase.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT DEFAULT 'default',
    title TEXT NOT NULL,
    model TEXT NOT NULL,
    persona_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
  )
`);
legacyDatabase.close();

process.env.DATA_DIR = dataDir;
process.env.PLUGINS_DIR = pluginsDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
delete process.env.CHAT_PROVIDER_A_TEST_KEY;
delete process.env.CHAT_PROVIDER_B_TEST_KEY;
delete process.env.CHAT_PROVIDER_INACTIVE_TEST_KEY;
delete process.env.CHAT_PROVIDER_NO_KEY_TEST_KEY;

const dbModule = await import(pathToFileURL(path.join(distRoot, 'db.js')).href);
const storageService = (
  await import(pathToFileURL(path.join(distRoot, 'storage.js')).href)
).default;
const chatService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'chatService.js')).href
  )
).default;
const preferencesService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'preferencesService.js')).href
  )
).default;
const pluginService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
  )
).default;
const credentialsService = (
  await import(
    pathToFileURL(
      path.join(distRoot, 'services', 'pluginCredentialsService.js')
    ).href
  )
).default;
const chatGenerationService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'chatGenerationService.js'))
      .href
  )
).default;
const ollamaService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'ollamaService.js')).href
  )
).default;
const { ChatRequestService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'chatRequestService.js')).href
);
const { AUTO_TITLE_CURRENT_MODEL, TitleGenerationService, buildFallbackTitle } =
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'titleGenerationService.js'))
      .href
  );
const { normalizeChatProviderSelection } = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'chatProviderSelection.js')).href
);

const db = dbModule.getDatabase();
const now = Date.now();
db.prepare(
  `INSERT INTO users
     (id, username, password_hash, role, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(userId, userId, 'test-password-hash', 'user', now, now);
db.prepare(
  `INSERT INTO users
     (id, username, password_hash, role, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?)`
).run(
  'chat-provider-fixture-admin',
  'chat-provider-fixture-admin',
  'test-password-hash',
  'admin',
  now,
  now
);
for (const plugin of pluginDefinitions) {
  pluginService.installPlugin(plugin, 'chat-provider-fixture-admin');
}
const activatePlugin = db.prepare(
  `INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
   VALUES (?, ?, ?)`
);
for (const pluginId of [pluginAId, pluginBId, missingCredentialPluginId]) {
  activatePlugin.run(userId, pluginId, now);
}
assert.equal(
  credentialsService.setApiKey(
    pluginAId,
    'provider-a-key',
    userId,
    pluginService.getCredentialRoutingAuthFingerprint(
      await pluginService.getPlugin(pluginAId, userId),
      userId
    )
  ),
  true
);
assert.equal(
  credentialsService.setApiKey(
    pluginBId,
    'provider-b-key',
    userId,
    pluginService.getCredentialRoutingAuthFingerprint(
      await pluginService.getPlugin(pluginBId, userId),
      userId
    )
  ),
  true
);

after(async () => {
  dbModule.closeDatabase();
  await new Promise(resolve => providerServer.close(resolve));
  fs.rmSync(tempRoot, { recursive: true, force: true });

  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

test('Chat session provider columns migrate additively and round-trip nullable selections', () => {
  const columns = db.prepare('PRAGMA table_info(sessions)').all();
  const columnNames = columns.map(column => column.name);
  assert.ok(columnNames.includes('provider_type'));
  assert.ok(columnNames.includes('provider_id'));

  const legacySession = {
    id: 'legacy-chat-session',
    title: 'Legacy session',
    model: sharedModel,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  storageService.saveSession(legacySession, userId);

  assert.deepEqual(
    db
      .prepare(
        `SELECT provider_type, provider_id
         FROM sessions
         WHERE id = ?`
      )
      .get(legacySession.id),
    { provider_type: null, provider_id: null }
  );
  const loadedLegacy = storageService.getSession(legacySession.id, userId);
  assert.equal(loadedLegacy.providerType, undefined);
  assert.equal(loadedLegacy.providerId, undefined);

  const qualifiedSession = {
    ...legacySession,
    id: 'qualified-chat-session',
    title: 'Qualified session',
    providerType: 'plugin',
    providerId: pluginBId,
  };
  storageService.saveSession(qualifiedSession, userId);

  assert.deepEqual(
    db
      .prepare(
        `SELECT provider_type, provider_id
         FROM sessions
         WHERE id = ?`
      )
      .get(qualifiedSession.id),
    { provider_type: 'plugin', provider_id: pluginBId }
  );
  const loadedQualified = storageService.getSession(
    qualifiedSession.id,
    userId
  );
  assert.equal(loadedQualified.providerType, 'plugin');
  assert.equal(loadedQualified.providerId, pluginBId);
});

test('Responses provider state is encrypted and round-trips with Chat messages', () => {
  const providerMetadata = {
    openAIResponsesOutputItems: [
      {
        id: 'reasoning-persisted',
        type: 'reasoning',
        encrypted_content: 'opaque-provider-reasoning',
        summary: [],
      },
      {
        id: 'message-persisted',
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'Persisted answer' }],
      },
    ],
    openAIResponsesStateScope: 'persisted-state-scope',
  };
  const session = {
    id: 'responses-state-session',
    title: 'Responses state',
    model: sharedModel,
    providerType: 'plugin',
    providerId: pluginBId,
    messages: [
      {
        id: 'assistant-responses-state',
        role: 'assistant',
        content: 'Persisted answer',
        thinking: 'Private reasoning summary',
        timestamp: now,
        model: sharedModel,
        providerMetadata,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };

  storageService.saveSession(session, userId);

  const columns = db.prepare('PRAGMA table_info(session_messages)').all();
  assert.ok(columns.some(column => column.name === 'provider_metadata'));
  assert.ok(columns.some(column => column.name === 'thinking'));
  const stored = db
    .prepare(
      `SELECT provider_metadata, thinking
       FROM session_messages
       WHERE session_id = ?`
    )
    .get(session.id);
  assert.equal(typeof stored.provider_metadata, 'string');
  assert.equal(
    stored.provider_metadata.includes('opaque-provider-reasoning'),
    false
  );
  assert.equal(stored.thinking.includes('Private reasoning summary'), false);
  const loadedMessage = storageService.getSession(session.id, userId)
    .messages[0];
  assert.deepEqual(loadedMessage.providerMetadata, providerMetadata);
  assert.equal(loadedMessage.thinking, 'Private reasoning summary');
});

test('session updates preserve provider metadata until an unqualified model change', async () => {
  const session = await chatService.createSession(
    sharedModel,
    'Provider update semantics',
    userId,
    undefined,
    { providerType: 'plugin', providerId: pluginBId }
  );
  assert.equal(session.providerType, 'plugin');
  assert.equal(session.providerId, pluginBId);

  const titleOnly = await chatService.updateSession(
    session.id,
    { title: 'Renamed provider session' },
    userId
  );
  assert.equal(titleOnly.providerType, 'plugin');
  assert.equal(titleOnly.providerId, pluginBId);

  const modelChanged = await chatService.updateSession(
    session.id,
    { model: 'chat-provider-new-model' },
    userId
  );
  assert.equal(modelChanged.providerType, undefined);
  assert.equal(modelChanged.providerId, undefined);

  assert.deepEqual(
    db
      .prepare(
        `SELECT provider_type, provider_id
         FROM sessions
         WHERE id = ?`
      )
      .get(session.id),
    { provider_type: null, provider_id: null }
  );
});

test('default, vision, and title model preferences round-trip and clear provider identity', () => {
  preferencesService.setDefaultModel(sharedModel, userId, {
    providerType: 'plugin',
    providerId: pluginBId,
  });
  let preferences = preferencesService.getPreferences(userId);
  assert.equal(preferences.defaultModel, sharedModel);
  assert.equal(preferences.defaultProviderType, 'plugin');
  assert.equal(preferences.defaultProviderId, pluginBId);

  preferences = preferencesService.updatePreferences(
    {
      visionModel: sharedModel,
      visionProviderType: 'plugin',
      visionProviderId: pluginBId,
    },
    userId
  );
  assert.equal(preferences.visionModel, sharedModel);
  assert.equal(preferences.visionProviderType, 'plugin');
  assert.equal(preferences.visionProviderId, pluginBId);

  preferences = preferencesService.updatePreferences(
    { showUsername: true },
    userId
  );
  assert.equal(preferences.defaultProviderType, 'plugin');
  assert.equal(preferences.defaultProviderId, pluginBId);
  assert.equal(preferences.visionProviderType, 'plugin');
  assert.equal(preferences.visionProviderId, pluginBId);

  preferences = preferencesService.updatePreferences(
    {
      titleSettings: {
        autoTitle: true,
        taskModel: sharedModel,
        taskProviderType: 'plugin',
        taskProviderId: pluginBId,
      },
    },
    userId
  );
  assert.equal(preferences.titleSettings.taskProviderType, 'plugin');
  assert.equal(preferences.titleSettings.taskProviderId, pluginBId);

  preferences = preferencesService.getPreferences(userId);
  assert.equal(preferences.titleSettings.taskProviderType, 'plugin');
  assert.equal(preferences.titleSettings.taskProviderId, pluginBId);

  preferences = preferencesService.setDefaultModel(
    'chat-provider-default-changed',
    userId
  );
  assert.equal(preferences.defaultProviderType, undefined);
  assert.equal(preferences.defaultProviderId, undefined);

  preferences = preferencesService.updatePreferences(
    {
      titleSettings: {
        taskModel: 'chat-provider-title-changed',
      },
    },
    userId
  );
  assert.equal(preferences.titleSettings.taskProviderType, undefined);
  assert.equal(preferences.titleSettings.taskProviderId, undefined);

  preferences = preferencesService.updatePreferences(
    { visionModel: 'chat-provider-vision-changed' },
    userId
  );
  assert.equal(preferences.visionProviderType, undefined);
  assert.equal(preferences.visionProviderId, undefined);
});

test('provider-qualified image preferences persist across unrelated updates', () => {
  const imageSettings = {
    enabled: true,
    model: sharedModel,
    pluginId: pluginBId,
    size: '1024x1024',
    quality: 'high',
    style: 'vivid',
  };

  let preferences = preferencesService.updatePreferences(
    { imageGenSettings: imageSettings },
    userId
  );
  assert.deepEqual(preferences.imageGenSettings, imageSettings);

  preferences = preferencesService.updatePreferences(
    { showUsername: !preferences.showUsername },
    userId
  );
  assert.deepEqual(preferences.imageGenSettings, imageSettings);
  assert.deepEqual(
    preferencesService.getPreferences(userId).imageGenSettings,
    imageSettings
  );
});

test('malformed provider selections are rejected consistently', () => {
  for (const [selection, expectedError] of [
    [{ providerId: pluginBId }, /requires providerType/i],
    [{ providerType: 'plugin' }, /providerId is required/i],
    [
      { providerType: 'ollama', providerId: pluginBId },
      /only valid when providerType is "plugin" or "agent"/i,
    ],
    [{ providerType: 'agent' }, /providerId is required/i],
    [{ providerType: 'unknown' }, /must be "ollama", "plugin", or "agent"/i],
  ]) {
    assert.throws(
      () => normalizeChatProviderSelection(selection),
      expectedError
    );
  }

  assert.deepEqual(
    normalizeChatProviderSelection({
      providerType: 'plugin',
      providerId: `  ${pluginBId}  `,
    }),
    { providerType: 'plugin', providerId: pluginBId }
  );

  assert.deepEqual(
    normalizeChatProviderSelection({
      providerType: 'agent',
      providerId: '  claude-code  ',
    }),
    { providerType: 'agent', providerId: 'claude-code' }
  );
});

test('provider-qualified targets distinguish Ollama and colliding plugins', async () => {
  const ollamaTarget = await chatGenerationService.prepareGenerationTarget(
    sharedModel,
    userId,
    {},
    { providerType: 'ollama' }
  );
  assert.equal(ollamaTarget.activePlugin, null);
  assert.equal(ollamaTarget.providerType, 'ollama');
  assert.equal(ollamaTarget.providerId, undefined);

  const pluginBTarget = await chatGenerationService.prepareGenerationTarget(
    sharedModel,
    userId,
    {},
    { providerType: 'plugin', providerId: pluginBId }
  );
  assert.equal(pluginBTarget.activePlugin?.id, pluginBId);
  assert.equal(pluginBTarget.providerType, 'plugin');
  assert.equal(pluginBTarget.providerId, pluginBId);

  const legacyTarget = await chatGenerationService.prepareGenerationTarget(
    sharedModel,
    userId
  );
  assert.equal(legacyTarget.activePlugin?.id, pluginAId);
  assert.equal(legacyTarget.providerType, undefined);
  assert.equal(legacyTarget.providerId, undefined);
});

test('plugin, agent, and legacy plugin targets do not probe Ollama defaults', async () => {
  const originalGetModelDefaults = ollamaService.getModelDefaults;
  const globalNumCtx = preferencesService.getGenerationOptions(userId).num_ctx;
  const probedModels = [];
  ollamaService.getModelDefaults = async model => {
    probedModels.push(model);
    return { options: { num_ctx: 12345 }, contextCapped: false };
  };

  try {
    const pluginTarget = await chatGenerationService.prepareGenerationTarget(
      sharedModel,
      userId,
      { temperature: 0.25 },
      { providerType: 'plugin', providerId: pluginBId }
    );
    const agentTarget = await chatGenerationService.prepareGenerationTarget(
      sharedModel,
      userId,
      {},
      { providerType: 'agent', providerId: 'test-agent' }
    );
    const legacyPluginTarget =
      await chatGenerationService.prepareGenerationTarget(sharedModel, userId);

    assert.equal(pluginTarget.activePlugin?.id, pluginBId);
    assert.equal(pluginTarget.mergedOptions.temperature, 0.25);
    assert.equal(pluginTarget.mergedOptions.num_ctx, globalNumCtx);
    assert.equal(agentTarget.activePlugin, null);
    assert.equal(agentTarget.mergedOptions.num_ctx, globalNumCtx);
    assert.equal(legacyPluginTarget.activePlugin?.id, pluginAId);
    assert.equal(legacyPluginTarget.mergedOptions.num_ctx, globalNumCtx);
    assert.deepEqual(probedModels, []);
  } finally {
    ollamaService.getModelDefaults = originalGetModelDefaults;
  }
});

test('explicit Ollama and unclaimed legacy targets retain Ollama defaults', async () => {
  const originalGetModelDefaults = ollamaService.getModelDefaults;
  const ollamaOnlyModel = 'chat-provider-ollama-only-model';
  const probedModels = [];
  ollamaService.getModelDefaults = async model => {
    probedModels.push(model);
    return { options: { num_ctx: 12345 }, contextCapped: false };
  };

  try {
    const explicitOllamaTarget =
      await chatGenerationService.prepareGenerationTarget(
        sharedModel,
        userId,
        {},
        { providerType: 'ollama' }
      );
    const legacyOllamaTarget =
      await chatGenerationService.prepareGenerationTarget(
        ollamaOnlyModel,
        userId
      );

    assert.equal(explicitOllamaTarget.activePlugin, null);
    assert.equal(explicitOllamaTarget.mergedOptions.num_ctx, 12345);
    assert.equal(legacyOllamaTarget.activePlugin, null);
    assert.equal(legacyOllamaTarget.mergedOptions.num_ctx, 12345);
    assert.deepEqual(probedModels, [sharedModel, ollamaOnlyModel]);
  } finally {
    ollamaService.getModelDefaults = originalGetModelDefaults;
  }
});

test('persisted legacy sessions ignore unpersisted request provider identity', async () => {
  const requestService = new ChatRequestService({
    chatGenerationService,
  });
  const legacySession = {
    model: sharedModel,
  };

  const ollamaRequest = await requestService.prepareGenerationRequest({
    session: legacySession,
    userId,
    providerType: 'ollama',
    persistedMessages: [],
    content: 'Use the exact Ollama provider',
  });
  assert.equal(ollamaRequest.providerType, undefined);
  assert.equal(ollamaRequest.providerId, undefined);
  assert.equal(ollamaRequest.activePlugin?.id, pluginAId);

  const pluginRequest = await requestService.prepareGenerationRequest({
    session: legacySession,
    userId,
    providerType: 'plugin',
    providerId: pluginBId,
    persistedMessages: [],
    content: 'Use the exact named plugin provider',
  });
  assert.equal(pluginRequest.providerType, undefined);
  assert.equal(pluginRequest.providerId, undefined);
  assert.equal(pluginRequest.activePlugin?.id, pluginAId);
});

test('exact plugin routing reaches the selected provider for regular and streaming requests', async () => {
  requests.length = 0;
  const messages = [
    {
      id: 'provider-routing-message',
      role: 'user',
      content: 'Which provider handles this?',
      timestamp: now,
    },
  ];

  const exactResponse = await pluginService.executePluginRequest(
    sharedModel,
    messages,
    {},
    userId,
    pluginBId
  );
  assert.equal(exactResponse.choices[0].message.content, pluginBId);
  assert.deepEqual(
    requests.map(request => request.providerId),
    [pluginBId]
  );
  assert.equal(requests[0].authorization, 'Bearer provider-b-key');

  requests.length = 0;
  const streamedChunks = [];
  for await (const chunk of pluginService.executePluginStreamRequest(
    sharedModel,
    messages,
    {},
    userId,
    pluginBId
  )) {
    streamedChunks.push(chunk);
  }
  assert.equal(
    streamedChunks
      .filter(chunk => chunk.type === 'content')
      .map(chunk => chunk.content)
      .join(''),
    pluginBId
  );
  assert.deepEqual(
    requests.map(request => request.providerId),
    [pluginBId]
  );

  requests.length = 0;
  const legacyResponse = await pluginService.executePluginRequest(
    sharedModel,
    messages,
    {},
    userId
  );
  assert.equal(legacyResponse.choices[0].message.content, pluginAId);
  assert.deepEqual(
    requests.map(request => request.providerId),
    [pluginAId]
  );

  const usageRows = dbModule
    .getDatabase()
    .prepare(
      `SELECT plugin_id, status, total_tokens
       FROM plugin_usage_events
       ORDER BY created_at ASC`
    )
    .all();
  assert.deepEqual(usageRows, [
    { plugin_id: pluginBId, status: 'success', total_tokens: 15 },
    { plugin_id: pluginBId, status: 'success', total_tokens: 15 },
    { plugin_id: pluginAId, status: 'success', total_tokens: 15 },
  ]);
});

test('exact plugin selection rejects unavailable providers before any request', async () => {
  for (const [providerId, expectedError] of [
    ['chat-provider-missing', /not found|unavailable/i],
    [inactivePluginId, /not active|unavailable/i],
    [missingCredentialPluginId, /API key|credential/i],
  ]) {
    requests.length = 0;
    await assert.rejects(
      chatGenerationService.prepareGenerationTarget(
        sharedModel,
        userId,
        {},
        { providerType: 'plugin', providerId }
      ),
      expectedError
    );
    assert.equal(requests.length, 0);
  }
});

test('an exact plugin failure cannot fall back to Ollama, while legacy routing remains compatible', async () => {
  const exactTarget = await chatGenerationService.prepareGenerationTarget(
    sharedModel,
    userId,
    {},
    { providerType: 'plugin', providerId: pluginBId }
  );
  const legacyTarget = await chatGenerationService.prepareGenerationTarget(
    sharedModel,
    userId
  );
  const originalExecutePluginRequest = pluginService.executePluginRequest;
  const originalGenerateChatResponse = ollamaService.generateChatResponse;
  const exactPluginIds = [];
  let ollamaCalls = 0;

  pluginService.executePluginRequest = async (
    _model,
    _messages,
    _options,
    _userId,
    pluginId
  ) => {
    exactPluginIds.push(pluginId);
    throw new Error('Selected provider failed');
  };
  ollamaService.generateChatResponse = async request => {
    ollamaCalls += 1;
    return {
      model: request.model,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content: 'legacy Ollama fallback' },
      done: true,
    };
  };

  try {
    const executionOptions = target => ({
      target,
      ollamaMessages: [{ role: 'user', content: 'test' }],
      pluginMessages: [
        {
          id: 'fallback-message',
          role: 'user',
          content: 'test',
          timestamp: now,
        },
      ],
      userId,
      pluginFallbackPolicy: 'allow',
    });

    await assert.rejects(
      chatGenerationService.executeNonStreaming(executionOptions(exactTarget)),
      /Selected provider failed/
    );
    assert.equal(ollamaCalls, 0);
    assert.deepEqual(exactPluginIds, [pluginBId]);

    const legacyResult = await chatGenerationService.executeNonStreaming(
      executionOptions(legacyTarget)
    );
    assert.equal(legacyResult.source, 'ollama');
    assert.equal(legacyResult.assistantContent, 'legacy Ollama fallback');
    assert.equal(ollamaCalls, 1);
    assert.deepEqual(exactPluginIds, [pluginBId, pluginAId]);
  } finally {
    pluginService.executePluginRequest = originalExecutePluginRequest;
    ollamaService.generateChatResponse = originalGenerateChatResponse;
  }
});

test('ChatRequestService prioritizes persisted identity over request identity', async () => {
  const prepareCalls = [];
  const requestService = new ChatRequestService({
    chatGenerationService: {
      async prepareGenerationTarget(model, targetUserId, options, provider) {
        prepareCalls.push({ model, userId: targetUserId, options, provider });
        return {
          actualModelName: model,
          mergedOptions: options,
          activePlugin: { id: pluginBId },
          pluginVariables: {},
          providerType: provider?.providerType,
          providerId: provider?.providerId,
        };
      },
    },
  });
  const session = {
    model: sharedModel,
    providerType: 'plugin',
    providerId: pluginBId,
  };

  await requestService.prepareGenerationRequest({
    session,
    userId,
    providerType: 'ollama',
    persistedMessages: [],
    content: 'persisted request',
  });
  await requestService.prepareGenerationRequest({
    session,
    userId,
    isPrivate: true,
    providerType: 'ollama',
    persistedMessages: [],
    messageHistory: [{ role: 'user', content: 'private history' }],
    content: 'private request',
  });

  assert.deepEqual(prepareCalls, [
    {
      model: sharedModel,
      userId,
      options: {},
      provider: { providerType: 'plugin', providerId: pluginBId },
    },
    {
      model: sharedModel,
      userId,
      options: {},
      provider: { providerType: 'plugin', providerId: pluginBId },
    },
  ]);
});

test('ChatRequestService routes every image-bearing context through the configured vision provider', async () => {
  const visionModel = 'chat-provider-vision-model';
  const prepareCalls = [];
  const requestService = new ChatRequestService({
    chatGenerationService: {
      async prepareGenerationTarget(model, targetUserId, options, provider) {
        prepareCalls.push({ model, userId: targetUserId, options, provider });
        return {
          actualModelName: model,
          mergedOptions: options,
          activePlugin: null,
          pluginVariables: {},
          providerType: provider?.providerType,
          providerId: provider?.providerId,
        };
      },
    },
    preferencesService: {
      getPreferences() {
        return {
          visionModel,
          visionProviderType: 'plugin',
          visionProviderId: pluginBId,
        };
      },
    },
  });
  const session = {
    model: sharedModel,
    providerType: 'ollama',
  };

  await requestService.prepareGenerationRequest({
    session,
    userId,
    persistedMessages: [],
    content: 'Text only',
  });
  await requestService.prepareGenerationRequest({
    session,
    userId,
    persistedMessages: [],
    content: 'Inspect this image',
    images: ['data:image/png;base64,current'],
  });
  await requestService.prepareGenerationRequest({
    session,
    userId,
    persistedMessages: [
      {
        id: 'historic-image',
        role: 'user',
        content: 'Earlier image',
        images: ['data:image/png;base64,history'],
        timestamp: now,
      },
    ],
    content: 'Follow-up without a new attachment',
  });
  await requestService.prepareGenerationRequest({
    session,
    userId,
    isPrivate: true,
    persistedMessages: [],
    messageHistory: [
      {
        role: 'user',
        content: 'Private image',
        images: ['data:image/png;base64,private'],
      },
    ],
    content: 'Private follow-up',
  });

  assert.deepEqual(prepareCalls, [
    {
      model: sharedModel,
      userId,
      options: {},
      provider: { providerType: 'ollama' },
    },
    ...Array.from({ length: 3 }, () => ({
      model: visionModel,
      userId,
      options: {},
      provider: { providerType: 'plugin', providerId: pluginBId },
    })),
  ]);
});

test('ChatRequestService rejects an unqualified configured vision model', async () => {
  let targetCalls = 0;
  const requestService = new ChatRequestService({
    chatGenerationService: {
      async prepareGenerationTarget() {
        targetCalls += 1;
        throw new Error('generation target must not be prepared');
      },
    },
    preferencesService: {
      getPreferences() {
        return { visionModel: 'legacy-unqualified-vision-model' };
      },
    },
  });

  await assert.rejects(
    requestService.prepareGenerationRequest({
      session: { model: sharedModel, providerType: 'ollama' },
      userId,
      persistedMessages: [],
      content: 'Inspect',
      images: ['data:image/png;base64,invalid'],
    }),
    /vision model has no provider identity/i
  );
  assert.equal(targetCalls, 0);
});

test('current-model title generation ignores conflicting request provider metadata', async () => {
  const session = {
    id: 'title-provider-session',
    title: 'New Chat',
    model: sharedModel,
    providerType: 'plugin',
    providerId: pluginBId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const prepareCalls = [];
  const pluginCalls = [];
  const service = new TitleGenerationService({
    chatService: {
      getSession: () => session,
      updateSession: async (_sessionId, updates) => ({
        ...session,
        ...updates,
        updatedAt: now + 1,
      }),
    },
    chatGenerationService: {
      async resolveActualModelName(model) {
        return model;
      },
      async prepareGenerationTarget(model, targetUserId, options, provider) {
        prepareCalls.push({ model, userId: targetUserId, options, provider });
        return {
          actualModelName: model,
          mergedOptions: options,
          activePlugin: { id: pluginBId },
          pluginVariables: {},
          providerType: provider?.providerType,
          providerId: provider?.providerId,
        };
      },
      extractPluginAssistantContent: response =>
        response.choices[0].message.content,
    },
    pluginService: {
      async executePluginRequest(
        model,
        messages,
        options,
        targetUserId,
        pluginId
      ) {
        pluginCalls.push({
          model,
          messages,
          options,
          userId: targetUserId,
          pluginId,
        });
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Provider-qualified title',
              },
            },
          ],
        };
      },
    },
    ollamaService: {
      async generateResponse() {
        throw new Error('Exact plugin title generation used Ollama');
      },
    },
    now: () => now,
    logger: { error() {} },
  });

  const result = await service.generateTitleForSession({
    sessionId: session.id,
    requestedModel: AUTO_TITLE_CURRENT_MODEL,
    message: 'Explain provider-qualified Chat routing',
    userId,
    providerType: 'ollama',
  });

  assert.equal(result.source, 'plugin');
  assert.equal(result.title, 'Provider-qualified title');
  assert.deepEqual(prepareCalls, [
    {
      model: sharedModel,
      userId,
      options: { temperature: 0.3, num_predict: 20 },
      provider: { providerType: 'plugin', providerId: pluginBId },
    },
  ]);
  assert.equal(pluginCalls.length, 1);
  assert.equal(pluginCalls[0].pluginId, pluginBId);
});

test('an exact title provider failure uses only the local title fallback', async () => {
  const message =
    'Explain why exact title providers must never silently switch providers';
  const session = {
    id: 'title-provider-failure-session',
    title: 'New Chat',
    model: sharedModel,
    providerType: 'plugin',
    providerId: pluginBId,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const pluginIds = [];
  let ollamaCalls = 0;
  const service = new TitleGenerationService({
    chatService: {
      getSession: () => session,
      updateSession: async (_sessionId, updates) => ({
        ...session,
        ...updates,
        updatedAt: now + 1,
      }),
    },
    chatGenerationService: {
      async resolveActualModelName(model) {
        return model;
      },
      async prepareGenerationTarget(model, _targetUserId, options, provider) {
        return {
          actualModelName: model,
          mergedOptions: options,
          activePlugin: { id: pluginBId },
          pluginVariables: {},
          providerType: provider?.providerType,
          providerId: provider?.providerId,
        };
      },
      extractPluginAssistantContent: () => {
        throw new Error('No plugin response was expected');
      },
    },
    pluginService: {
      async executePluginRequest(
        _model,
        _messages,
        _options,
        _targetUserId,
        pluginId
      ) {
        pluginIds.push(pluginId);
        throw new Error('Selected title provider failed');
      },
    },
    ollamaService: {
      async generateResponse() {
        ollamaCalls += 1;
        throw new Error('Exact title provider failure used Ollama');
      },
    },
    now: () => now,
    logger: { error() {} },
  });

  const result = await service.generateTitleForSession({
    sessionId: session.id,
    requestedModel: AUTO_TITLE_CURRENT_MODEL,
    message,
    userId,
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.title, buildFallbackTitle(message));
  assert.deepEqual(pluginIds, [pluginBId]);
  assert.equal(ollamaCalls, 0);
});
