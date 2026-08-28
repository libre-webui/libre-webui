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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-model-catalog-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'model-catalog-test-secret';
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

const catalog = await distModule('services/modelVisibilityService.js');

// Every await has to happen before the first test() call: the runner tears the
// file down once the tests it knows about have settled, so a test registered
// after a top-level await would run against a closed server.
const coordinationModule = await distModule('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();
const [{ getDatabase }, { authService }, { default: ollamaRouter }] =
  await Promise.all([
    distModule('db.js'),
    distModule('services/authService.js'),
    distModule('routes/ollama.js'),
  ]);

const now = Date.now();
const insertUser = getDatabase().prepare(
  `INSERT INTO users (
    id, username, email, password_hash, role, avatar, created_at, updated_at
  ) VALUES (?, ?, NULL, 'unused', ?, NULL, ?, ?)`
);
insertUser.run('catalog-admin', 'catalog-admin', 'admin', now, now);
insertUser.run('catalog-member', 'catalog-member', 'user', now, now);
const tokenFor = (id, role) =>
  authService.generateToken({
    id,
    username: id,
    email: null,
    role,
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
const adminToken = tokenFor('catalog-admin', 'admin');
const memberToken = tokenFor('catalog-member', 'user');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/ollama', ollamaRouter);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/api/ollama`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await platformStorageModule.closePlatformStorageRuntime();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const asJson = { 'Content-Type': 'application/json' };

test('the catalog starts empty and every read fails open', async () => {
  assert.deepEqual(await catalog.getHiddenModels(), []);
  assert.deepEqual(await catalog.getModelOrder(), []);
  assert.deepEqual(await catalog.getStarredModels(), []);
  assert.deepEqual(await catalog.getModelMetadata(), {});
});

test('model order is stored, deduped, and returned in sequence', async () => {
  const saved = await catalog.setModelOrder([
    'qwen3:8b',
    'openai/gpt-test',
    'qwen3:8b',
    '  llama3.2:3b  ',
  ]);
  assert.deepEqual(saved, ['qwen3:8b', 'openai/gpt-test', 'llama3.2:3b']);
  assert.deepEqual(await catalog.getModelOrder(), saved);
  assert.throws(() => catalog.normalizeModelOrder('nope'));
  assert.throws(() => catalog.normalizeModelOrder([42]));
  assert.throws(() => catalog.normalizeModelOrder(['']));
});

test('starred models are stored, deduped, and returned in priority order', async () => {
  const saved = await catalog.setStarredModels([
    'openai/gpt-test',
    'qwen3:8b',
    'openai/gpt-test',
    '  llama3.2:3b  ',
  ]);
  assert.deepEqual(saved, ['openai/gpt-test', 'qwen3:8b', 'llama3.2:3b']);
  assert.deepEqual(await catalog.getStarredModels(), saved);
  assert.throws(() => catalog.normalizeStarredModels('nope'));
  assert.throws(() => catalog.normalizeStarredModels([42]));
  assert.throws(() => catalog.normalizeStarredModels(['']));
});

test('a model can carry an administrator label and picture', async () => {
  const saved = await catalog.setModelMetadata({
    'qwen3:8b': { label: 'House model', avatar: PNG },
    'openai/gpt-test': { label: 'Cloud fallback' },
  });
  assert.equal(saved['qwen3:8b'].label, 'House model');
  assert.equal(saved['qwen3:8b'].avatar, PNG);
  assert.equal(saved['openai/gpt-test'].label, 'Cloud fallback');
  assert.equal(saved['openai/gpt-test'].avatar, undefined);

  const read = await catalog.getModelMetadata();
  assert.deepEqual(read, saved, 'metadata survives a round trip');
});

test('clearing a label and picture removes the entry entirely', async () => {
  const saved = await catalog.setModelMetadata({
    'qwen3:8b': { label: '', avatar: '' },
    'openai/gpt-test': { label: 'Still here' },
  });
  assert.ok(!('qwen3:8b' in saved), 'an emptied model stops carrying metadata');
  assert.equal(saved['openai/gpt-test'].label, 'Still here');
});

test('pictures must be image data URLs within the size ceiling', () => {
  assert.throws(
    () =>
      catalog.normalizeModelMetadata({ m: { avatar: 'https://host/x.png' } }),
    /data URL/,
    'a remote URL is refused'
  );
  assert.throws(
    () =>
      catalog.normalizeModelMetadata({
        m: { avatar: 'data:text/html;base64,PHNjcmlwdD4=' },
      }),
    /data URL/,
    'a non-image data URL is refused'
  );
  assert.throws(
    () =>
      catalog.normalizeModelMetadata({
        m: { avatar: `data:image/png;base64,${'A'.repeat(300_000)}` },
      }),
    /KB/,
    'an oversized picture is refused'
  );
  assert.throws(
    () => catalog.normalizeModelMetadata({ m: { label: 'x'.repeat(200) } }),
    /128 characters/
  );
  assert.throws(() => catalog.normalizeModelMetadata([]));
  assert.throws(() => catalog.normalizeModelMetadata({ m: 'string' }));
});

test('hidden models, order, stars, and metadata are stored independently', async () => {
  await catalog.setHiddenModels(['openai/gpt-test']);
  assert.deepEqual(await catalog.getHiddenModels(), ['openai/gpt-test']);
  // Changing visibility must not disturb the other catalog settings.
  assert.deepEqual(await catalog.getModelOrder(), [
    'qwen3:8b',
    'openai/gpt-test',
    'llama3.2:3b',
  ]);
  assert.deepEqual(await catalog.getStarredModels(), [
    'openai/gpt-test',
    'qwen3:8b',
    'llama3.2:3b',
  ]);
  assert.equal(
    (await catalog.getModelMetadata())['openai/gpt-test'].label,
    'Still here'
  );
});

// --- The HTTP path the catalog screen actually uses ------------------------

test('a reorder survives the round trip the UI makes', async () => {
  const wanted = ['gemma3:12b', 'qwen3:8b', 'llama3.2:3b'];
  const put = await fetch(`${baseUrl}/models/visibility`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, ...asJson },
    body: JSON.stringify({ order: wanted }),
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.deepEqual(saved.data.order, wanted, 'the PUT echoes the new order');

  const get = await fetch(`${baseUrl}/models/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const read = await get.json();
  assert.deepEqual(read.data.order, wanted, 'a fresh read returns it');
});

test('star priority survives the round trip the UI makes', async () => {
  const wanted = ['gemma3:12b', 'openai/gpt-test'];
  const put = await fetch(`${baseUrl}/models/visibility`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, ...asJson },
    body: JSON.stringify({ starred: wanted }),
  });
  assert.equal(put.status, 200);
  const saved = await put.json();
  assert.deepEqual(saved.data.starred, wanted, 'the PUT echoes star priority');

  const get = await fetch(`${baseUrl}/models/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const read = await get.json();
  assert.deepEqual(read.data.starred, wanted, 'a fresh read returns it');
});

test('sending only one field leaves the others untouched', async () => {
  await fetch(`${baseUrl}/models/visibility`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, ...asJson },
    body: JSON.stringify({ metadata: { 'qwen3:8b': { label: 'House' } } }),
  });
  const get = await fetch(`${baseUrl}/models/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const read = await get.json();
  assert.deepEqual(
    read.data.order,
    ['gemma3:12b', 'qwen3:8b', 'llama3.2:3b'],
    'the order set earlier is still there'
  );
  assert.deepEqual(
    read.data.starred,
    ['gemma3:12b', 'openai/gpt-test'],
    'the stars set earlier are still there'
  );
  assert.equal(read.data.metadata['qwen3:8b'].label, 'House');
});

test('invalid star settings are rejected without changing saved priority', async () => {
  const bad = await fetch(`${baseUrl}/models/visibility`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, ...asJson },
    body: JSON.stringify({ starred: 'gemma3:12b' }),
  });
  assert.equal(bad.status, 400);

  const get = await fetch(`${baseUrl}/models/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const read = await get.json();
  assert.deepEqual(read.data.starred, ['gemma3:12b', 'openai/gpt-test']);
});

test('only administrators can change the catalog', async () => {
  const forbidden = await fetch(`${baseUrl}/models/visibility`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${memberToken}`, ...asJson },
    body: JSON.stringify({ order: [] }),
  });
  assert.equal(forbidden.status, 403);

  const readable = await fetch(`${baseUrl}/models/visibility`, {
    headers: { Authorization: `Bearer ${memberToken}` },
  });
  assert.equal(readable.status, 200, 'but anyone may read it');
});

test('a bad picture is rejected with a 400, not stored', async () => {
  const bad = await fetch(`${baseUrl}/models/visibility`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}`, ...asJson },
    body: JSON.stringify({
      metadata: { 'qwen3:8b': { avatar: 'https://example.com/x.png' } },
    }),
  });
  assert.equal(bad.status, 400);
  const get = await fetch(`${baseUrl}/models/visibility`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const read = await get.json();
  assert.equal(read.data.metadata['qwen3:8b'].label, 'House', 'unchanged');
});
