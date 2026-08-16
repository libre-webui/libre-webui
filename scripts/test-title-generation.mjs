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
