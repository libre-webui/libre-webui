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

/*
 * Model steering: the mix a chat carries, where a server's vector list is
 * looked for (beside the API root, then through llama-swap's passthrough),
 * the access mode that decides who may steer, and the plugin service rule
 * that a mix reaches only a llama.cpp-type server that listed its names.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-steering-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'steering-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '5'.repeat(64);
delete process.env.STEERING_ACCESS_MODE;

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

const [steering, authorization, chatAdapter, ollama, database, plugins] =
  await Promise.all([
    distModule('services/steeringService.js'),
    distModule('services/authorizationService.js'),
    distModule('utils/pluginChatAdapter.js'),
    distModule('services/ollamaService.js'),
    distModule('db.js'),
    distModule('services/pluginService.js'),
  ]);
const pluginService = plugins.default;

const db = database.getDatabase();
const now = Date.now();
const createUser = (id, role) => {
  db.prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', ?, 'active', NULL, ?, ?)`
  ).run(id, id, role, now, now);
  return { userId: id, role, status: 'active' };
};
const admin = createUser('steer-admin', 'admin');
const bob = createUser('steer-bob', 'user');

// === A llama-swap stand-in: no list at the root, one model that lists ===

const LIST = {
  vectors: [
    {
      name: 'tsundere',
      label: 'Tsundere',
      description: 'Prickly on the outside',
      group: 'anime',
      default: 0.4,
    },
    { name: 'friendly', label: 'Friendly', group: 'companion', default: 0.3 },
    { name: 'bad name with spaces', label: 'Dropped' },
    { name: 'friendly', label: 'Duplicate' },
  ],
};
const requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/upstream/glimmer-studio/steering') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(LIST));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const endpoint = `${base}/v1/chat/completions`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

test('a mix keeps valid names and finite, clamped, non-zero strengths', () => {
  assert.deepEqual(
    steering.normalizeSteeringMix({
      tsundere: 0.4,
      friendly: 0.25,
      'not ok': 0.5,
      zero: 0,
      huge: 9,
      nan: Number.NaN,
      text: '0.3',
    }),
    { tsundere: 0.4, friendly: 0.25, huge: 2 }
  );
  assert.deepEqual(
    steering.normalizeSteeringMix([
      { name: 'godfather', strength: 0.45 },
      { name: 'british', strength: -0.2 },
    ]),
    { godfather: 0.45, british: -0.2 }
  );
  assert.equal(steering.normalizeSteeringMix({ off: 0 }), undefined);
  assert.equal(steering.normalizeSteeringMix('tsundere'), undefined);
  assert.equal(steering.normalizeSteeringMix(null), undefined);
});

test("a server's list is validated, deduplicated, and trimmed", () => {
  const parsed = steering.parseSteeringList(LIST);
  assert.deepEqual(
    parsed.map(vector => vector.name),
    ['tsundere', 'friendly']
  );
  assert.equal(parsed[0].default, 0.4);
  assert.equal(parsed[0].group, 'anime');
  assert.equal(steering.parseSteeringList({ data: [] }), null);
  assert.equal(steering.parseSteeringList('nope'), null);
  const long = steering.parseSteeringList({
    vectors: [{ name: 'x', description: 'd'.repeat(5000), default: 7 }],
  });
  assert.equal(long[0].description.length, 400);
  assert.equal(long[0].default, steering.STEERING_STRENGTH_LIMIT);
});

test('the list is looked for beside the API root, then through llama-swap', () => {
  assert.deepEqual(
    steering.steeringListUrls(
      'http://stargate.local:8080/v1/chat/completions',
      'glimmer-studio'
    ),
    [
      'http://stargate.local:8080/steering',
      'http://stargate.local:8080/upstream/glimmer-studio/steering',
    ]
  );
  assert.deepEqual(
    steering.steeringListUrls(
      'https://example.test/llm/v1/chat/completions',
      'org/model name'
    ),
    [
      'https://example.test/llm/steering',
      'https://example.test/llm/upstream/org/model%20name/steering',
    ]
  );
  assert.deepEqual(steering.steeringListUrls('not a url', 'm'), []);
});

test('a found list is cached and concurrent asks share one request', async () => {
  steering.clearSteeringCache();
  requests.length = 0;
  const [first, second] = await Promise.all([
    steering.getSteeringList('k', endpoint, 'glimmer-studio', {}),
    steering.getSteeringList('k', endpoint, 'glimmer-studio', {}),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.deepEqual(requests, [
    '/steering',
    '/upstream/glimmer-studio/steering',
  ]);
  await steering.getSteeringList('k', endpoint, 'glimmer-studio', {});
  assert.equal(requests.length, 2, 'the second ask is answered from cache');

  const missing = await steering.getSteeringList('other', endpoint, 'qwen', {});
  assert.equal(missing, null);
  assert.equal(steering.cachedSteeringList('other'), null);
});

test('only names the server listed survive', () => {
  const vectors = steering.parseSteeringList(LIST);
  assert.deepEqual(
    steering.restrictSteeringMix({ tsundere: 0.4, pirate: 0.5 }, vectors),
    { tsundere: 0.4 }
  );
  assert.equal(
    steering.restrictSteeringMix({ pirate: 0.5 }, vectors),
    undefined
  );
  assert.equal(
    steering.restrictSteeringMix({ tsundere: 0.4 }, null),
    undefined
  );
});

test('steering is admins-only until an administrator opens it', async () => {
  const actor = { userId: bob.userId, role: 'user', status: 'active' };
  assert.equal(await steering.getSteeringAccessMode(), 'admins');
  assert.equal(
    (
      await authorization.authorize(actor, 'use', {
        type: 'feature',
        id: 'steering',
      })
    ).allowed,
    false
  );
  assert.equal(await steering.userCanSteer(admin.userId), true);
  assert.equal(await steering.userCanSteer(bob.userId), false);
  assert.equal(await steering.userCanSteer(undefined), false);
  assert.equal(await steering.userCanSteer('nobody'), false);

  await steering.setSteeringAccessMode('all-users');
  assert.equal(await steering.userCanSteer(bob.userId), true);
  await steering.setSteeringAccessMode('admins');

  process.env.STEERING_ACCESS_MODE = 'all-users';
  try {
    assert.equal(steering.steeringAccessModeLockedByEnv(), true);
    assert.equal(await steering.userCanSteer(bob.userId), true);
  } finally {
    delete process.env.STEERING_ACCESS_MODE;
  }

  const view = await authorization.explainEffectiveAccess({
    id: bob.userId,
    role: 'user',
    status: 'active',
  });
  assert.equal(view.features.steering, false);
});

const llamaCpp = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'llama-cpp.json'), 'utf8')
);
const openai = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'openai.json'), 'utf8')
);
const applySteering = (plugin, model, options, userId) =>
  pluginService.applySteering(
    plugin,
    model,
    options,
    'chat_completions',
    endpoint,
    { 'Content-Type': 'application/json' },
    userId
  );

test('a mix reaches only a llama.cpp server that listed it, for users who may steer', async () => {
  steering.clearSteeringCache();
  const mix = { steering: { tsundere: 0.4, pirate: 0.5 }, temperature: 0.7 };

  assert.deepEqual(
    await applySteering(llamaCpp, 'glimmer-studio', mix, admin.userId),
    { steering: { tsundere: 0.4 }, temperature: 0.7 }
  );
  // Not allowed to steer: the field is gone, the rest of the request stays.
  assert.deepEqual(
    await applySteering(llamaCpp, 'glimmer-studio', mix, bob.userId),
    { temperature: 0.7 }
  );
  // A model whose server lists nothing.
  assert.deepEqual(await applySteering(llamaCpp, 'qwen', mix, admin.userId), {
    temperature: 0.7,
  });
  // A hosted provider is never probed and never sent the field.
  requests.length = 0;
  assert.deepEqual(await applySteering(openai, 'gpt-6', mix, admin.userId), {
    temperature: 0.7,
  });
  assert.deepEqual(requests, []);
  // Options without a mix pass through untouched.
  const plain = { temperature: 0.2 };
  assert.equal(
    await applySteering(llamaCpp, 'glimmer-studio', plain, admin.userId),
    plain
  );
});

test('the OpenAI-compatible payload carries the mix; Ollama options never do', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    llamaCpp,
    'glimmer-studio',
    [{ id: 'u', role: 'user', content: 'hi', timestamp: 0 }],
    { steering: { tsundere: 0.4 } },
    {},
    true
  );
  assert.deepEqual(payload.steering, { tsundere: 0.4 });

  const plain = chatAdapter.buildPluginChatPayload(
    llamaCpp,
    'glimmer-studio',
    [{ id: 'u', role: 'user', content: 'hi', timestamp: 0 }],
    {},
    {},
    true
  );
  assert.equal('steering' in plain.payload, false);

  assert.deepEqual(
    ollama.sanitizeOptionsForModel('llama3.2', {
      temperature: 0.5,
      steering: { tsundere: 0.4 },
      think: true,
    }),
    { temperature: 0.5 }
  );
});
