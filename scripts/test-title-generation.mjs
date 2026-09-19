import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-title-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'title-test-secret';
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
  { TitleGenerationService },
  { default: chatService },
  { default: chatGenerationService },
  { default: pluginService },
  { default: ollamaService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/titleGenerationService.js'),
  distModule('services/chatService.js'),
  distModule('services/chatGenerationService.js'),
  distModule('services/pluginService.js'),
  distModule('services/ollamaService.js'),
]);

// Constructed the same way the chat route builds it.
const titleGenerationService = new TitleGenerationService({
  chatService,
  chatGenerationService,
  pluginService,
  ollamaService,
});

const originalPrepareGenerationTarget =
  chatGenerationService.prepareGenerationTarget;
const originalExecutePluginRequest = pluginService.executePluginRequest;

after(async () => {
  chatGenerationService.prepareGenerationTarget =
    originalPrepareGenerationTarget;
  pluginService.executePluginRequest = originalExecutePluginRequest;
  await coordinationModule.closeCoordinator();
  await platformStorageModule.closePlatformStorageRuntime();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

const userId = 'title-user';
const now = Date.now();
getDatabase()
  .prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, avatar, created_at, updated_at
    ) VALUES (?, ?, NULL, 'unused', 'user', NULL, ?, ?)`
  )
  .run(userId, userId, now, now);

test('a reasoning provider gets room to think and still name the chat', async () => {
  const session = await chatService.createSession(
    'New Chat',
    'qwen38-27b',
    userId
  );
  chatGenerationService.prepareGenerationTarget = async modelName => ({
    actualModelName: modelName,
    mergedOptions: { temperature: 0.7, num_predict: 20 },
    activePlugin: { id: 'llama-cpp', model_map: [modelName] },
    providerType: 'plugin',
  });

  let seenMaxTokens;
  pluginService.executePluginRequest = async (_model, _messages, options) => {
    seenMaxTokens = options.num_predict;
    // A thinking model answers nothing at all when the budget is tiny.
    if ((options.num_predict ?? 0) < 100) {
      return {
        choices: [
          { message: { role: 'assistant', content: '', reasoning: 'hmm...' } },
        ],
      };
    }
    return {
      choices: [
        { message: { role: 'assistant', content: 'Greeting the assistant' } },
      ],
    };
  };

  const result = await titleGenerationService.generateTitleForSession({
    sessionId: session.id,
    requestedModel: 'qwen38-27b',
    message: 'hello there',
    userId,
  });

  assert.ok(
    seenMaxTokens >= 100,
    `the plugin path asks for a workable budget (saw ${seenMaxTokens})`
  );
  assert.equal(result.source, 'plugin', 'the model named it, not the fallback');
  assert.equal(result.title, 'Greeting the assistant');
});

test('an empty answer still falls back rather than failing', async () => {
  const session = await chatService.createSession(
    'New Chat',
    'qwen38-27b',
    userId
  );
  pluginService.executePluginRequest = async () => ({
    choices: [{ message: { role: 'assistant', content: '' } }],
  });

  const result = await titleGenerationService.generateTitleForSession({
    sessionId: session.id,
    requestedModel: 'qwen38-27b',
    message: 'a message worth summarising',
    userId,
  });
  assert.equal(result.source, 'fallback');
  assert.ok(result.title.length > 0, 'the chat still gets a name');
});

function dshTitleFixture(overrides = {}) {
  const calls = {
    ownership: [],
    resolved: [],
    prepared: [],
    plugin: [],
    ollama: [],
    updates: [],
  };
  const owned = {
    id: 'dsh-title-session',
    model: 'dsh',
    providerType: 'agent',
    providerId: 'dsh',
    title: 'New Chat',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const dependencies = {
    chatService: {
      async getSession(id, actor) {
        calls.ownership.push([id, actor]);
        return id === owned.id && actor === 'dsh-admin'
          ? structuredClone(owned)
          : undefined;
      },
      async updateSession(id, updates, actor) {
        calls.updates.push([id, updates, actor]);
        return { ...owned, ...updates };
      },
    },
    async resolveDshProviderTarget(model, actor) {
      calls.resolved.push([model, actor]);
      return {
        model: 'shared-model',
        providerType: 'plugin',
        providerId: 'exact-provider',
      };
    },
    chatGenerationService: {
      async resolveActualModelName(model) {
        return model;
      },
      async prepareGenerationTarget(model, actor, options, provider) {
        calls.prepared.push([model, actor, options, provider]);
        return {
          actualModelName: model,
          providerType: provider?.providerType,
          providerId: provider?.providerId,
          activePlugin:
            provider?.providerType === 'plugin'
              ? { id: provider.providerId }
              : null,
          mergedOptions: {
            ...options,
            think: true,
            tools: [{ name: 'forbidden_tool' }],
          },
        };
      },
      extractPluginAssistantContent: response =>
        response.choices[0].message.content,
    },
    pluginService: {
      async executePluginRequest(...args) {
        calls.plugin.push(args);
        return {
          choices: [
            {
              message: {
                content:
                  '<think>private title reasoning</think> Focused title.',
              },
            },
          ],
        };
      },
    },
    ollamaService: {
      async generateResponse(...args) {
        calls.ollama.push(args);
        return { response: 'Focused local title' };
      },
    },
    logger: { error() {} },
    ...overrides,
  };
  return {
    calls,
    owned,
    dependencies,
    service: new TitleGenerationService(dependencies),
  };
}

const dshTitleRequest = {
  sessionId: 'dsh-title-session',
  requestedModel: 'dsh',
  message: 'Explain the project configuration',
  userId: 'dsh-admin',
  providerType: 'agent',
  providerId: 'dsh',
};

test('native DSH titles use the selected native provider without an LWUI provider or agent turn', async () => {
  const calls = [];
  const fixture = dshTitleFixture({
    async resolveDshProviderTarget() {
      return {
        providerType: 'dsh',
        providerId: 'deepseek-official',
        model: 'deepseek-flash',
      };
    },
    async generateDshText(input) {
      calls.push(input);
      return 'Native provider title';
    },
  });
  const result = await fixture.service.generateTitleForSession({
    ...dshTitleRequest,
    requestedModel: 'dsh:native:deepseek-official:deepseek-flash',
  });
  assert.equal(result.title, 'Native provider title');
  assert.equal(result.source, 'dsh');
  assert.equal(calls[0].providerId, 'deepseek-official');
  assert.equal(calls[0].model, 'deepseek-flash');
  assert.equal(calls[0].purpose, 'session-title');
  assert.equal('tools' in calls[0], false);
  assert.equal(
    fixture.calls.prepared.length +
      fixture.calls.plugin.length +
      fixture.calls.ollama.length,
    0
  );
});

test('a disconnected native DSH title never switches to an LWUI provider', async () => {
  const fixture = dshTitleFixture({
    async resolveDshProviderTarget() {
      return {
        providerType: 'dsh',
        providerId: 'deepseek-official',
        model: 'deepseek-flash',
      };
    },
    async generateDshText() {
      throw new Error('Native DSH disconnected');
    },
  });
  const result = await fixture.service.generateTitleForSession(dshTitleRequest);
  assert.equal(result.source, 'fallback');
  assert.equal(
    fixture.calls.prepared.length +
      fixture.calls.plugin.length +
      fixture.calls.ollama.length,
    0
  );
});

test('DSH base and qualified titles resolve to exact direct providers without tools', async () => {
  for (const selector of [
    'dsh',
    'dsh:lwui:plugin:exact-provider:shared-model',
    'dsh:lwui:ollama:shared-model',
  ]) {
    const local = selector.includes(':ollama:');
    const fixture = dshTitleFixture();
    if (local)
      fixture.service = new TitleGenerationService({
        ...fixture.dependencies,
        resolveDshProviderTarget: async (model, actor) => {
          fixture.calls.resolved.push([model, actor]);
          return {
            model: 'shared-model',
            providerType: 'ollama',
            providerId: null,
          };
        },
      });
    const result = await fixture.service.generateTitleForSession({
      ...dshTitleRequest,
      requestedModel: selector,
    });
    assert.deepEqual(fixture.calls.resolved, [[selector, 'dsh-admin']]);
    assert.equal(result.model, 'shared-model');
    assert.equal(result.source, local ? 'ollama' : 'plugin');
    assert.equal(result.title, local ? 'Focused local title' : 'Focused title');
    assert.deepEqual(
      fixture.calls.prepared[0][3],
      local
        ? { providerType: 'ollama' }
        : { providerType: 'plugin', providerId: 'exact-provider' }
    );
    if (local) {
      assert.equal(fixture.calls.plugin.length, 0);
      assert.equal(fixture.calls.ollama[0][0].model, 'shared-model');
      assert.equal(fixture.calls.ollama[0][0].think, false);
      assert.equal(fixture.calls.ollama[0][0].options.tools, undefined);
    } else {
      assert.equal(fixture.calls.ollama.length, 0);
      assert.equal(fixture.calls.plugin[0][4], 'exact-provider');
      assert.equal(fixture.calls.plugin[0][2].think, false);
      assert.equal(fixture.calls.plugin[0][2].tools, undefined);
    }
    assert.equal(fixture.calls.updates[0][2], 'dsh-admin');
  }
});

test('current-running DSH titles use persisted provider identity despite conflicting request metadata', async () => {
  const fixture = dshTitleFixture();
  fixture.owned.model = 'dsh:lwui:plugin:exact-provider:shared-model';
  const result = await fixture.service.generateTitleForSession({
    ...dshTitleRequest,
    requestedModel: '__current_running_model__',
    providerType: 'ollama',
    providerId: null,
  });
  assert.equal(result.source, 'plugin');
  assert.deepEqual(fixture.calls.resolved, [
    [fixture.owned.model, 'dsh-admin'],
  ]);
  assert.equal(fixture.calls.plugin[0][4], 'exact-provider');
  assert.equal(fixture.calls.ollama.length, 0);
});

test('a real Ollama model named dsh does not invoke the harness resolver', async () => {
  const fixture = dshTitleFixture();
  const result = await fixture.service.generateTitleForSession({
    ...dshTitleRequest,
    providerType: 'ollama',
    providerId: null,
  });
  assert.equal(result.source, 'ollama');
  assert.equal(fixture.calls.ollama[0][0].model, 'dsh');
  assert.deepEqual(fixture.calls.resolved, []);
});

test('title ownership and unsupported agents are checked before DSH/provider work', async () => {
  const fixture = dshTitleFixture();
  assert.equal(
    await fixture.service.generateTitleForSession({
      ...dshTitleRequest,
      userId: 'other-user',
    }),
    null
  );
  assert.equal(
    fixture.calls.resolved.length + fixture.calls.prepared.length,
    0
  );
  await assert.rejects(
    fixture.service.generateTitleForSession({
      ...dshTitleRequest,
      requestedModel: 'codex',
      providerId: 'codex',
    }),
    { name: 'ChatProviderSelectionError' }
  );
  assert.equal(
    fixture.calls.resolved.length +
      fixture.calls.prepared.length +
      fixture.calls.updates.length,
    0
  );
});

test('DSH title resolution failures and missing exact providers use only the local title fallback', async () => {
  for (const failure of [
    'disabled',
    'not an administrator',
    'custom route unsupported',
  ]) {
    const fixture = dshTitleFixture({
      resolveDshProviderTarget: async () => {
        throw new Error(failure);
      },
    });
    const result =
      await fixture.service.generateTitleForSession(dshTitleRequest);
    assert.equal(result.source, 'fallback');
    assert.equal(
      fixture.calls.prepared.length +
        fixture.calls.plugin.length +
        fixture.calls.ollama.length,
      0
    );
  }
  const collision = dshTitleFixture();
  collision.dependencies.chatGenerationService.prepareGenerationTarget =
    async () => ({
      actualModelName: 'shared-model',
      mergedOptions: {},
      activePlugin: null,
    });
  const missing =
    await collision.service.generateTitleForSession(dshTitleRequest);
  assert.equal(missing.source, 'fallback');
  assert.equal(
    collision.calls.plugin.length + collision.calls.ollama.length,
    0
  );
  const providerError = dshTitleFixture();
  providerError.dependencies.pluginService.executePluginRequest = async () => {
    throw new Error('Exact provider unavailable');
  };
  assert.equal(
    (await providerError.service.generateTitleForSession(dshTitleRequest))
      .source,
    'fallback'
  );
  assert.equal(providerError.calls.ollama.length, 0);
});

test('an explicitly selected task persona can use its backing plugin for a title', async () => {
  const fixture = dshTitleFixture();
  fixture.dependencies.chatGenerationService.prepareGenerationTarget = async (
    ...args
  ) => {
    fixture.calls.prepared.push(args);
    return {
      actualModelName: 'persona-backing-model',
      providerType: 'plugin',
      activePlugin: { id: 'persona-provider' },
      mergedOptions: { think: true },
    };
  };
  const result = await fixture.service.generateTitleForSession({
    ...dshTitleRequest,
    requestedModel: 'persona:task-persona',
    providerType: 'ollama',
    providerId: null,
  });
  assert.equal(result.source, 'plugin');
  assert.equal(fixture.calls.prepared[0][0], 'persona:task-persona');
  assert.equal(fixture.calls.prepared[0][3], undefined);
  assert.equal(fixture.calls.plugin[0][0], 'persona-backing-model');
  assert.equal(fixture.calls.plugin[0][4], 'persona-provider');
  assert.equal(fixture.calls.ollama.length + fixture.calls.resolved.length, 0);
});

test('a persona title selection cannot bypass an explicit DSH binding', async () => {
  for (const current of [false, true]) {
    const attempted = [];
    const fixture = dshTitleFixture({
      resolveDshProviderTarget: async (...args) => {
        attempted.push(args);
        throw new Error('Invalid DSH selector');
      },
    });
    if (current) fixture.owned.model = 'persona:task-persona';
    const result = await fixture.service.generateTitleForSession({
      ...dshTitleRequest,
      requestedModel: current
        ? '__current_running_model__'
        : 'persona:task-persona',
    });
    assert.deepEqual(attempted, [['persona:task-persona', 'dsh-admin']]);
    assert.equal(result.source, 'fallback');
    assert.equal(
      fixture.calls.prepared.length +
        fixture.calls.plugin.length +
        fixture.calls.ollama.length,
      0
    );
  }
});
