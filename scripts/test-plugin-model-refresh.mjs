import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'plugin-model-refresh-test-jwt-secret';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const originalWorkingDirectory = process.cwd();
const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-plugin-model-refresh-')
);
process.env.PLUGINS_DIR = path.join(testDataDir, 'plugins');
process.env.DATA_DIR = path.join(testDataDir, 'data');
fs.mkdirSync(process.env.PLUGINS_DIR, { recursive: true });
process.chdir(testDataDir);

const pluginServiceModule = await import(
  pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
);
const { PluginService } = pluginServiceModule;
const databaseModule = await import(
  pathToFileURL(path.join(distRoot, 'db.js')).href
);
const pluginRoutes = (
  await import(pathToFileURL(path.join(distRoot, 'routes', 'plugins.js')).href)
).default;
const { authenticate } = await import(
  pathToFileURL(path.join(distRoot, 'middleware', 'auth.js')).href
);
const { authService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'authService.js')).href
);

after(() => {
  databaseModule.closeDatabase();
  process.chdir(originalWorkingDirectory);
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function upsertTestUser(userId, role) {
  const database = databaseModule.getDatabase();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, avatar, created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`
    )
    .run(userId, userId, role, now, now);
  return {
    id: userId,
    username: userId,
    email: null,
    role,
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * Stand-in provider whose catalog can change between requests, the way a real
 * provider adds and retires models over time.
 */
async function startProvider() {
  const state = { models: ['model-a'], requests: 0, delayMs: 0 };
  const app = express();
  app.get('/v1/models', async (_req, res) => {
    state.requests += 1;
    if (state.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, state.delayMs));
    }
    res.json({ data: state.models.map(id => ({ id })) });
  });
  const server = await listen(app);
  return { ...server, state };
}

function installProvider(service, id, providerBaseUrl, adminId) {
  return service.installPlugin(
    {
      id,
      name: `Provider ${id}`,
      type: 'completion',
      endpoint: `${providerBaseUrl}/v1/chat/completions`,
      auth: { header: '', prefix: '', key_env: '' },
      model_map: ['bundled-stale-model'],
    },
    adminId
  );
}

function modelsFor(service, pluginId, userId) {
  const plugin = service
    .getAllPlugins(userId)
    .find(candidate => candidate.id === pluginId);
  assert.ok(plugin, `expected plugin ${pluginId} to be listed`);
  return plugin.model_map;
}

async function withEnv(values, run) {
  const originals = new Map();
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a stale catalog is re-discovered when the plugin list is read', async () => {
  const provider = await startProvider();
  const service = new PluginService();
  const admin = upsertTestUser('model-refresh-admin', 'admin');
  const user = upsertTestUser('model-refresh-user', 'user');
  const pluginId = 'refresh-provider';
  installProvider(service, pluginId, provider.baseUrl, admin.id);

  try {
    await service.activatePlugin(pluginId, user.id);
    assert.deepEqual(
      modelsFor(service, pluginId, user.id),
      ['model-a'],
      'activation should replace the bundled catalog with the live one'
    );

    // The provider retires a model and ships a new one.
    provider.state.models = ['model-b', 'model-c'];

    // Within the backoff window the stored catalog is reused.
    const requestsBeforeBackoffCheck = provider.state.requests;
    await service.refreshStaleModels(user.id);
    assert.equal(provider.state.requests, requestsBeforeBackoffCheck);
    assert.deepEqual(modelsFor(service, pluginId, user.id), ['model-a']);

    // Once the entry ages past the TTL, the next read picks up the new catalog.
    await withEnv(
      {
        PLUGIN_MODEL_DISCOVERY_TTL_MS: '1',
        PLUGIN_MODEL_DISCOVERY_RETRY_MS: '1',
      },
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        await service.refreshStaleModels(user.id);
      }
    );
    assert.deepEqual(modelsFor(service, pluginId, user.id), [
      'model-b',
      'model-c',
    ]);
  } finally {
    service.deletePlugin(pluginId);
    await provider.close();
  }
});

test('GET /api/plugins returns the refreshed catalog after a reload', async () => {
  const provider = await startProvider();
  const service = new PluginService();
  const admin = upsertTestUser('model-refresh-route-admin', 'admin');
  const user = upsertTestUser('model-refresh-route-user', 'user');
  const pluginId = 'refresh-route-provider';
  installProvider(service, pluginId, provider.baseUrl, admin.id);

  const app = express();
  app.use(express.json());
  app.use('/api/plugins', authenticate, pluginRoutes);
  const server = await listen(app);
  const headers = {
    Authorization: `Bearer ${authService.generateToken(user)}`,
    'Content-Type': 'application/json',
  };

  const listPlugins = async () => {
    const response = await fetch(`${server.baseUrl}/api/plugins`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    const plugin = body.data.find(candidate => candidate.id === pluginId);
    assert.ok(plugin);
    return plugin.model_map;
  };

  try {
    await service.activatePlugin(pluginId, user.id);
    provider.state.models = ['reloaded-model'];

    await withEnv(
      {
        PLUGIN_MODEL_DISCOVERY_TTL_MS: '1',
        PLUGIN_MODEL_DISCOVERY_RETRY_MS: '1',
      },
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        assert.deepEqual(await listPlugins(), ['reloaded-model']);
      }
    );
  } finally {
    service.deletePlugin(pluginId);
    await server.close();
    await provider.close();
  }
});

test('an unreachable provider keeps the last known catalog and backs off', async () => {
  const provider = await startProvider();
  const service = new PluginService();
  const admin = upsertTestUser('model-refresh-offline-admin', 'admin');
  const user = upsertTestUser('model-refresh-offline-user', 'user');
  const pluginId = 'refresh-offline-provider';
  installProvider(service, pluginId, provider.baseUrl, admin.id);

  try {
    await service.activatePlugin(pluginId, user.id);
    assert.deepEqual(modelsFor(service, pluginId, user.id), ['model-a']);

    await provider.close();

    await withEnv(
      {
        PLUGIN_MODEL_DISCOVERY_TTL_MS: '1',
        PLUGIN_MODEL_DISCOVERY_RETRY_MS: '1',
      },
      async () => {
        await service.refreshStaleModels(user.id);
      }
    );
    assert.deepEqual(
      modelsFor(service, pluginId, user.id),
      ['model-a'],
      'a failed refresh must not wipe the working catalog'
    );

    // With the default backoff restored, a failing provider is not re-probed.
    const failedAttempt = service.refreshStaleModels(user.id);
    await failedAttempt;
    assert.deepEqual(modelsFor(service, pluginId, user.id), ['model-a']);
  } finally {
    service.deletePlugin(pluginId);
  }
});

test('a refresh reports what actually happened instead of a bare success', async () => {
  const provider = await startProvider();
  const service = new PluginService();
  const admin = upsertTestUser('model-refresh-outcome-admin', 'admin');
  const user = upsertTestUser('model-refresh-outcome-user', 'user');
  const openId = 'refresh-outcome-open-provider';
  const keyedId = 'refresh-outcome-keyed-provider';
  installProvider(service, openId, provider.baseUrl, admin.id);
  service.installPlugin(
    {
      id: keyedId,
      name: 'Keyed provider',
      type: 'completion',
      endpoint: `${provider.baseUrl}/v1/chat/completions`,
      auth: {
        header: 'Authorization',
        prefix: 'Bearer ',
        key_env: 'REFRESH_OUTCOME_MISSING_KEY',
      },
      model_map: ['bundled-stale-model'],
    },
    admin.id
  );

  try {
    // A provider that needs a key it does not have never reaches the network,
    // so the returned catalog is the bundled one.
    const keyless = await service.discoverModelsResult(keyedId, user.id);
    assert.equal(keyless.outcome, 'missing_credentials');
    assert.deepEqual(keyless.models, ['bundled-stale-model']);

    const firstRefresh = await service.discoverModelsResult(openId, user.id);
    assert.equal(firstRefresh.outcome, 'updated');
    assert.deepEqual(firstRefresh.models, ['model-a']);

    const repeatRefresh = await service.discoverModelsResult(openId, user.id);
    assert.equal(repeatRefresh.outcome, 'unchanged');

    await provider.close();
    const offlineRefresh = await service.discoverModelsResult(openId, user.id);
    assert.equal(offlineRefresh.outcome, 'unavailable');
    assert.match(offlineRefresh.reason, /provider/i);
    assert.deepEqual(
      offlineRefresh.models,
      ['model-a'],
      'the last known catalog is still returned'
    );
  } finally {
    service.deletePlugin(openId);
    service.deletePlugin(keyedId);
  }
});

test('a slow provider cannot stall the plugin list past the refresh deadline', async () => {
  const provider = await startProvider();
  const service = new PluginService();
  const admin = upsertTestUser('model-refresh-slow-admin', 'admin');
  const user = upsertTestUser('model-refresh-slow-user', 'user');
  const pluginId = 'refresh-slow-provider';
  installProvider(service, pluginId, provider.baseUrl, admin.id);

  try {
    await service.activatePlugin(pluginId, user.id);
    provider.state.delayMs = 1500;
    provider.state.models = ['slow-model'];

    const startedAt = Date.now();
    await withEnv(
      {
        PLUGIN_MODEL_DISCOVERY_TTL_MS: '1',
        PLUGIN_MODEL_DISCOVERY_RETRY_MS: '1',
        PLUGIN_MODEL_DISCOVERY_REFRESH_DEADLINE_MS: '100',
      },
      async () => {
        await service.refreshStaleModels(user.id);
      }
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 1000,
      `plugin list waited ${elapsed}ms on a slow provider`
    );
    assert.deepEqual(
      modelsFor(service, pluginId, user.id),
      ['model-a'],
      'the previous catalog is served while the slow refresh completes'
    );

    // The refresh that outran the deadline still lands for the next read.
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.deepEqual(modelsFor(service, pluginId, user.id), ['slow-model']);
  } finally {
    service.deletePlugin(pluginId);
    provider.state.delayMs = 0;
    await provider.close();
  }
});
