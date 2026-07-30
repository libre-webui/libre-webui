import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'plugin-routing-test-jwt-secret';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const originalWorkingDirectory = process.cwd();
const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-plugin-endpoint-routing-')
);
process.env.PLUGINS_DIR = path.join(testDataDir, 'plugins');
process.env.DATA_DIR = path.join(testDataDir, 'data');
fs.mkdirSync(process.env.PLUGINS_DIR, { recursive: true });
fs.writeFileSync(
  path.join(process.env.PLUGINS_DIR, 'legacy-quarantined-provider.json'),
  JSON.stringify(
    {
      ...createLegacyQuarantinedDefinition(),
    },
    null,
    2
  )
);
fs.writeFileSync(
  path.join(process.env.PLUGINS_DIR, '.status.json'),
  JSON.stringify(
    {
      activePlugins: ['openai', 'legacy-quarantined-provider'],
    },
    null,
    2
  )
);
process.chdir(testDataDir);

const axios = (await import('axios')).default;
const pluginValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginValidation.js')).href
);
const pluginVariableValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginVariableValidation.js'))
    .href
);
const pluginConnectionVariables = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginConnectionVariables.js'))
    .href
);
const pluginDefinitionTrust = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginDefinitionTrust.js')).href
);
const pluginServiceModule = await import(
  pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
);
const { default: pluginService, PluginService } = pluginServiceModule;
const pluginVariablesService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'pluginVariablesService.js'))
      .href
  )
).default;
const pluginCredentialsService = (
  await import(
    pathToFileURL(
      path.join(distRoot, 'services', 'pluginCredentialsService.js')
    ).href
  )
).default;
const databaseModule = await import(
  pathToFileURL(path.join(distRoot, 'db.js')).href
);
const { PluginImageGenerationService } = await import(
  pathToFileURL(
    path.join(distRoot, 'services', 'pluginImageGenerationService.js')
  ).href
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
const imageGenRoutes = (
  await import(pathToFileURL(path.join(distRoot, 'routes', 'imageGen.js')).href)
).default;
const { WorkModelProviderService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'workModelProviderService.js'))
    .href
);

after(() => {
  databaseModule.closeDatabase();
  process.chdir(originalWorkingDirectory);
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function createPlugin({
  id = 'custom-provider',
  endpoint = 'https://api.openai.com/v1/chat/completions',
  auth = { header: '', prefix: '', key_env: '' },
} = {}) {
  return {
    id,
    name: 'Custom provider',
    type: 'completion',
    active: true,
    endpoint,
    auth,
    model_map: ['chat-model'],
    capabilities: {
      embedding: {
        endpoint: 'https://api.openai.com/v1/embeddings',
        model_map: ['embedding-model'],
        config: { no_auth_required: true },
      },
      tts: {
        endpoint: 'https://api.openai.com/v1/audio/speech',
        model_map: ['tts-model'],
        config: {
          voices: ['alloy'],
          default_voice: 'alloy',
          formats: ['mp3'],
          default_format: 'mp3',
          no_auth_required: true,
        },
      },
      image: {
        endpoint: 'https://api.openai.com/v1/images/generations',
        model_map: ['image-model'],
        config: { no_auth_required: true },
      },
    },
  };
}

function createLegacyQuarantinedDefinition({
  id = 'legacy-quarantined-provider',
  endpoint = 'https://attacker.example.test/v1/chat/completions',
} = {}) {
  return {
    ...createPlugin({
      id,
      endpoint,
      auth: { header: '', prefix: '', key_env: '' },
    }),
    capabilities: {
      embedding: {
        endpoint: endpoint.replace('/chat/completions', '/embeddings'),
        model_map: ['embedding-model'],
        config: { no_auth_required: true },
      },
      tts: {
        endpoint: endpoint.replace('/chat/completions', '/audio/speech'),
        model_map: ['tts-model'],
        config: {
          voices: ['alloy'],
          default_voice: 'alloy',
          formats: ['mp3'],
          default_format: 'mp3',
          no_auth_required: true,
        },
      },
      image: {
        endpoint: endpoint.replace('/chat/completions', '/images/generations'),
        model_map: ['image-model'],
        config: { no_auth_required: true },
      },
    },
  };
}

async function withPatchedProperties(target, replacements, run) {
  const originals = new Map();
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, target[key]);
    target[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of originals) {
      target[key] = value;
    }
  }
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
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

test('connection-routing variable policy uses one canonical name set', () => {
  assert.deepEqual(
    [...pluginConnectionVariables.PLUGIN_CONNECTION_VARIABLE_NAMES],
    [
      'endpoint',
      'base_url',
      'api_path',
      'models_endpoint',
      'api_url',
      'image_endpoint',
      'embedding_endpoint',
      'tts_endpoint',
      'api_mode',
      'model',
      'model_id',
    ]
  );
});

test('every bundled manifest exactly matches the compiled trust anchor', () => {
  const manifests = fs
    .readdirSync(path.join(repoRoot, 'plugins'))
    .filter(file => file.endsWith('.json'))
    .map(file =>
      JSON.parse(fs.readFileSync(path.join(repoRoot, 'plugins', file), 'utf8'))
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const anchoredIds = Object.keys(
    pluginDefinitionTrust.BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS
  ).sort();
  assert.deepEqual(
    manifests.map(plugin => plugin.id).sort(),
    anchoredIds,
    'adding or removing a bundled manifest requires an intentional trust-anchor update'
  );
  for (const plugin of manifests) {
    assert.equal(
      pluginDefinitionTrust.matchesBundledPluginTrustAnchor(plugin),
      true,
      `${plugin.id} changed without updating its compiled trust anchor`
    );
  }
});

test('non-admin runtime retains manifest routing defaults while ignoring stored overrides', () => {
  const service = new PluginService();
  const pluginId = 'manifest-default-routing-provider';
  const manifestEndpoint =
    'https://manifest-default.example.test/v1/chat/completions';
  const schema = [
    {
      name: 'endpoint',
      type: 'string',
      label: 'Endpoint',
      default: manifestEndpoint,
    },
    {
      name: 'temperature',
      type: 'number',
      label: 'Temperature',
      default: 0.7,
    },
  ];
  const normalUser = upsertTestUser('manifest-default-routing-user', 'user');
  const installer = upsertTestUser(
    'manifest-default-routing-installer',
    'admin'
  );
  service.installPlugin(
    {
      ...createPlugin({
        id: pluginId,
        endpoint: 'https://top-level.example.test/v1/chat/completions',
      }),
      capabilities: undefined,
      variables: schema,
    },
    installer.id
  );

  try {
    assert.equal(
      pluginVariablesService.setVariables(
        pluginId,
        {
          endpoint: 'https://legacy-stored.example.test/v1/chat/completions',
          temperature: 0.2,
        },
        schema,
        normalUser.id
      ),
      true
    );
    const plugin = service.getPlugin(pluginId, normalUser.id);
    assert.ok(plugin);
    assert.deepEqual(
      service.getPluginVariables(plugin, normalUser.id),
      {
        endpoint: manifestEndpoint,
        temperature: 0.2,
      },
      'only stored routing is ignored; safe generation settings remain user-scoped'
    );
  } finally {
    service.deletePlugin(pluginId);
  }
});

test('legacy global activation migrates once into durable per-user state', () => {
  const pluginId = 'openai';
  const quarantinedPluginId = 'legacy-quarantined-provider';
  const database = databaseModule.getDatabase();
  assert.equal(pluginService.getPlugin(pluginId, 'default').active, true);
  assert.equal(pluginService.getPlugin(quarantinedPluginId, 'default'), null);
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM plugin_activations
         WHERE plugin_id = ?`
      )
      .get(quarantinedPluginId).count,
    0,
    'legacy custom definitions must not inherit activation before approval'
  );

  const laterUser = upsertTestUser('post-migration-plugin-user', 'user');
  assert.equal(pluginService.getPlugin(pluginId, laterUser.id).active, false);
  assert.equal(pluginService.deactivatePlugin(pluginId, 'default'), true);

  const reloadedService = new PluginService();
  assert.equal(reloadedService.getPlugin(pluginId, 'default').active, false);
  assert.equal(
    database
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get('plugin_activations_legacy_migrated_v1').value,
    'true'
  );
});

test('pre-upgrade writable definitions stay quarantined across every execution path', async () => {
  const service = new PluginService();
  const user = upsertTestUser('quarantined-definition-user', 'user');
  const admin = upsertTestUser('quarantined-definition-admin', 'admin');
  const definitions = [
    createLegacyQuarantinedDefinition({
      id: 'quarantined-https-provider',
      endpoint: 'https://attacker.example.test/v1/chat/completions',
    }),
    createLegacyQuarantinedDefinition({
      id: 'quarantined-private-provider',
      endpoint: 'http://127.0.0.1:9/v1/chat/completions',
    }),
  ];
  const database = databaseModule.getDatabase();
  const networkRequests = [];

  for (const definition of definitions) {
    fs.writeFileSync(
      path.join(process.env.PLUGINS_DIR, `${definition.id}.json`),
      JSON.stringify(definition, null, 2)
    );
    database
      .prepare(
        `INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
         VALUES (?, ?, ?)`
      )
      .run(user.id, definition.id, Date.now());
  }

  const workService = new WorkModelProviderService({
    ollama: {
      isHealthy: async () => false,
      generateChatResponse: async () => {
        throw new Error('Ollama must not be selected');
      },
    },
    plugins: service,
    post: async (...args) => {
      networkRequests.push({ operation: 'work', args });
      throw new Error('quarantined Work request reached the network');
    },
  });
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', authenticate, pluginRoutes);
  const server = await listen(app);
  const userHeaders = {
    Authorization: `Bearer ${authService.generateToken(user)}`,
    'Content-Type': 'application/json',
  };

  try {
    await withPatchedProperties(
      axios,
      {
        get: async (...args) => {
          networkRequests.push({ operation: 'discover', args });
          throw new Error('quarantined discovery reached the network');
        },
        post: async (...args) => {
          networkRequests.push({ operation: 'capability', args });
          throw new Error('quarantined capability reached the network');
        },
      },
      async () => {
        for (const definition of definitions) {
          assert.equal(service.getPlugin(definition.id, user.id), null);
          assert.equal(
            service
              .getAllPlugins(user.id)
              .some(plugin => plugin.id === definition.id),
            false
          );
          assert.equal(
            service
              .getActivePlugins(user.id)
              .some(plugin => plugin.id === definition.id),
            false
          );
          assert.deepEqual(
            await service.discoverModels(definition.id, user.id),
            []
          );
          await assert.rejects(
            service.activatePlugin(definition.id, user.id),
            /Plugin not found/
          );
          await assert.rejects(
            service.executePluginRequest(
              'chat-model',
              [{ role: 'user', content: 'Do not route this prompt.' }],
              {},
              user.id,
              definition.id
            ),
            /Plugin not found/
          );
          await assert.rejects(
            service.executeEmbeddingRequest(
              'embedding-model',
              'Do not embed this.',
              definition.id,
              user.id
            ),
            /No embedding plugin found/
          );
          await assert.rejects(
            service.executeTTSRequest('tts-model', 'Do not speak this.', {
              pluginId: definition.id,
              userId: user.id,
            }),
            /No TTS plugin found/
          );
          await assert.rejects(
            service.executeImageGenRequest(
              'image-model',
              'Do not render this.',
              { userId: user.id }
            ),
            /No image generation plugin found/
          );
          await assert.rejects(
            workService.generateChatResponse(
              {
                model: 'chat-model',
                messages: [{ role: 'user', content: 'Do not send this.' }],
              },
              { providerType: 'plugin', providerId: definition.id },
              user.id
            ),
            /is not active/
          );
          assert.equal(service.getTTSConfig(definition.id), null);
          assert.equal(
            service.getImageGenConfig(definition.id, user.id),
            null
          );
          assert.equal(
            service
              .getPluginsByCapability('embedding', user.id)
              .some(plugin => plugin.id === definition.id),
            false
          );
          assert.equal(
            service
              .getAvailableEmbeddingModels(user.id)
              .some(model => model.plugin === definition.id),
            false
          );
          assert.equal(
            service
              .getAvailableTTSModels(user.id)
              .some(model => model.plugin === definition.id),
            false
          );
          assert.equal(
            service
              .getAvailableImageGenModels(user.id)
              .some(model => model.plugin === definition.id),
            false
          );

          const credentialCheck = await fetch(
            `${server.baseUrl}/api/plugins/${definition.id}/credentials/check`,
            { headers: userHeaders }
          );
          assert.equal(credentialCheck.status, 404);
          const credentialSave = await fetch(
            `${server.baseUrl}/api/plugins/${definition.id}/credentials`,
            {
              method: 'POST',
              headers: userHeaders,
              body: JSON.stringify({ api_key: 'must-not-bind' }),
            }
          );
          assert.equal(credentialSave.status, 404);
        }

        assert.deepEqual(await workService.availability(user.id), {
          ollamaAvailable: false,
          pluginAvailable: false,
        });
        assert.equal(networkRequests.length, 0);
      }
    );

    const approved = service.importPlugin(definitions[0], admin.id);
    assert.equal(approved.id, definitions[0].id);
    assert.ok(service.getPlugin(approved.id, user.id));
    assert.equal(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM plugin_activations
           WHERE plugin_id = ?`
        )
        .get(approved.id).count,
      0,
      'approval must clear every legacy activation before the definition becomes visible'
    );
    assert.equal(service.getPlugin(approved.id, user.id).active, false);
    assert.equal(
      service
        .getAvailableEmbeddingModels(user.id)
        .some(model => model.plugin === approved.id),
      false
    );
    assert.equal(
      service
        .getAvailableTTSModels(user.id)
        .some(model => model.plugin === approved.id),
      false
    );
    assert.equal(
      service
        .getAvailableImageGenModels(user.id)
        .some(model => model.plugin === approved.id),
      false
    );
    assert.equal(service.getTTSConfig(approved.id, user.id), null);
    assert.equal(service.getImageGenConfig(approved.id, user.id), null);

    const approvedPath = path.join(
      process.env.PLUGINS_DIR,
      `${approved.id}.json`
    );
    const tampered = JSON.parse(fs.readFileSync(approvedPath, 'utf8'));
    tampered.name = 'Tampered after approval';
    fs.writeFileSync(approvedPath, JSON.stringify(tampered, null, 2));
    assert.equal(
      service.getPlugin(approved.id, user.id),
      null,
      'any post-approval byte-level definition change must re-quarantine it'
    );
  } finally {
    await server.close();
    for (const definition of definitions) {
      const filePath = path.join(
        process.env.PLUGINS_DIR,
        `${definition.id}.json`
      );
      if (fs.existsSync(filePath)) {
        assert.equal(service.deletePlugin(definition.id), true);
      }
    }
  }
});

test('plugin routes require authentication and preserve non-admin generation settings', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/plugins', authenticate, pluginRoutes);
  const server = await listen(app);
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'route-environment-secret';

  try {
    const unauthenticatedRoutes = [
      ['GET', '/'],
      ['GET', '/active'],
      ['GET', '/active/current'],
      ['GET', '/status/all'],
      ['GET', '/openai'],
      ['POST', '/upload'],
      ['POST', '/install'],
      ['PUT', '/openai'],
      ['DELETE', '/openai'],
      ['POST', '/activate/openai'],
      ['POST', '/discover/openai'],
      ['POST', '/deactivate/openai'],
      ['POST', '/deactivate'],
      ['GET', '/openai/export'],
      ['GET', '/credentials/all'],
      ['POST', '/openai/credentials'],
      ['DELETE', '/openai/credentials'],
      ['GET', '/openai/credentials/check'],
      ['GET', '/openai/variables'],
      ['PUT', '/openai/variables'],
      ['DELETE', '/openai/variables'],
    ];
    for (const [method, routePath] of unauthenticatedRoutes) {
      const response = await fetch(
        `${server.baseUrl}/api/plugins${routePath}`,
        {
          method,
        }
      );
      assert.equal(
        response.status,
        401,
        `${method} ${routePath} must require authentication`
      );
    }

    const normalUser = upsertTestUser('plugin-route-normal-user', 'user');
    const normalToken = authService.generateToken(normalUser);
    const normalHeaders = {
      Authorization: `Bearer ${normalToken}`,
      'Content-Type': 'application/json',
    };

    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/plugins`, {
          headers: normalHeaders,
        })
      ).status,
      200
    );
    for (const [method, routePath, body] of [
      ['POST', '/upload', undefined],
      ['POST', '/install', {}],
      ['PUT', '/openai', {}],
      ['DELETE', '/openai', undefined],
    ]) {
      const response = await fetch(
        `${server.baseUrl}/api/plugins${routePath}`,
        {
          method,
          headers: normalHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
      );
      assert.equal(
        response.status,
        403,
        `${method} ${routePath} must be administrator-only`
      );
    }

    const openAIPlugin = pluginService.getPlugin('openai', normalUser.id);
    assert.ok(openAIPlugin?.variables);
    const generationSave = await fetch(
      `${server.baseUrl}/api/plugins/openai/variables`,
      {
        method: 'PUT',
        headers: normalHeaders,
        body: JSON.stringify({
          variables: {
            endpoint: openAIPlugin.endpoint,
            temperature: 0.25,
            stream: false,
          },
        }),
      }
    );
    assert.equal(generationSave.status, 200);

    const routingSave = await fetch(
      `${server.baseUrl}/api/plugins/openai/variables`,
      {
        method: 'PUT',
        headers: normalHeaders,
        body: JSON.stringify({
          variables: {
            endpoint: 'https://untrusted.example.test/v1/chat/completions',
          },
        }),
      }
    );
    assert.equal(routingSave.status, 403);
    for (const [name, value] of [
      ['api_mode', 'responses'],
      ['model', 'attacker-model'],
      ['model_id', 'attacker-model-id'],
    ]) {
      const connectionSave = await fetch(
        `${server.baseUrl}/api/plugins/openai/variables`,
        {
          method: 'PUT',
          headers: normalHeaders,
          body: JSON.stringify({ variables: { [name]: value } }),
        }
      );
      assert.equal(
        connectionSave.status,
        403,
        `${name} must be treated as administrator-owned connection routing`
      );
    }

    assert.equal(
      pluginVariablesService.setVariables(
        'openai',
        {
          endpoint: 'https://legacy.example.test/v1/chat/completions',
        },
        openAIPlugin.variables,
        normalUser.id
      ),
      true
    );
    databaseModule
      .getDatabase()
      .prepare(
        `INSERT INTO plugin_discovered_models
           (user_id, plugin_id, models_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        normalUser.id,
        'openai',
        JSON.stringify(['stale-legacy-route-model']),
        Date.now()
      );
    assert.equal(
      pluginService
        .getPlugin('openai', normalUser.id)
        .model_map.includes('stale-legacy-route-model'),
      false,
      'ignored legacy routing must also suppress its discovered catalog'
    );
    const displayedVariables = await (
      await fetch(`${server.baseUrl}/api/plugins/openai/variables`, {
        headers: normalHeaders,
      })
    ).json();
    assert.equal(displayedVariables.data.endpoint.has_value, false);
    assert.equal(displayedVariables.data.endpoint.value, openAIPlugin.endpoint);
    assert.equal(
      pluginService.getPluginVariables(openAIPlugin, normalUser.id).endpoint,
      openAIPlugin.endpoint
    );

    const resetResponse = await fetch(
      `${server.baseUrl}/api/plugins/openai/variables`,
      {
        method: 'DELETE',
        headers: normalHeaders,
      }
    );
    assert.equal(resetResponse.status, 200);
    const rawVariables = pluginVariablesService.getVariables(
      'openai',
      openAIPlugin.variables,
      normalUser.id
    );
    assert.equal(rawVariables.temperature.has_value, false);
    assert.equal(rawVariables.endpoint.value, openAIPlugin.endpoint);
    assert.equal(rawVariables.endpoint.has_value, false);
    assert.equal(
      databaseModule
        .getDatabase()
        .prepare(
          `SELECT COUNT(*) AS count
           FROM plugin_discovered_models
           WHERE user_id = ? AND plugin_id = ?`
        )
        .get(normalUser.id, 'openai').count,
      0,
      'reset must purge the discovered catalog tied to legacy routing'
    );

    upsertTestUser(normalUser.id, 'admin');
    assert.equal(
      pluginService.getPluginVariables(openAIPlugin, normalUser.id).endpoint,
      openAIPlugin.endpoint,
      'account reset must purge dormant routing before a role promotion'
    );

    const adminUser = upsertTestUser('plugin-route-admin-user', 'admin');
    const adminToken = authService.generateToken(adminUser);
    const adminHeaders = {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    };
    databaseModule
      .getDatabase()
      .prepare(
        `INSERT INTO plugin_discovered_models
           (user_id, plugin_id, models_json, updated_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(
        adminUser.id,
        'openai',
        JSON.stringify(['stale-trusted-route-model']),
        Date.now()
      );
    const adminRoutingSave = await fetch(
      `${server.baseUrl}/api/plugins/openai/variables`,
      {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          variables: {
            endpoint: 'https://custom.example.test/v1/chat/completions',
          },
        }),
      }
    );
    assert.equal(adminRoutingSave.status, 200);
    assert.equal(
      databaseModule
        .getDatabase()
        .prepare(
          `SELECT COUNT(*) AS count
           FROM plugin_discovered_models
           WHERE user_id = ? AND plugin_id = ?`
        )
        .get(adminUser.id, 'openai').count,
      0,
      'changing a trusted route must invalidate its discovered catalog'
    );
    const customAdminPlugin = pluginService.getPlugin('openai', adminUser.id);
    assert.equal(
      customAdminPlugin.model_map.includes('stale-trusted-route-model'),
      false
    );
    assert.equal(
      pluginService.getApiKey(customAdminPlugin, adminUser.id),
      null,
      'a user-stored route cannot inherit the deployment environment key'
    );
    const adminRoutingReset = await fetch(
      `${server.baseUrl}/api/plugins/openai/variables`,
      {
        method: 'DELETE',
        headers: adminHeaders,
      }
    );
    assert.equal(adminRoutingReset.status, 200);
    assert.equal(
      pluginService.getApiKey(
        pluginService.getPlugin('openai', adminUser.id),
        adminUser.id
      ),
      'route-environment-secret',
      'resetting to the trusted bundled route may restore environment fallback'
    );

    const bundledCredentialSave = await fetch(
      `${server.baseUrl}/api/plugins/openai/credentials`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ api_key: 'route-bound-user-secret' }),
      }
    );
    assert.equal(bundledCredentialSave.status, 200);
    const bundledBinding = databaseModule
      .getDatabase()
      .prepare(
        `SELECT routing_auth_fingerprint
         FROM plugin_credentials
         WHERE user_id = ? AND plugin_id = ?`
      )
      .get(adminUser.id, 'openai').routing_auth_fingerprint;
    const boundRouteChange = await fetch(
      `${server.baseUrl}/api/plugins/openai/variables`,
      {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({
          variables: {
            endpoint: 'https://new-bound-route.example.test/v1/chat/completions',
          },
        }),
      }
    );
    assert.equal(boundRouteChange.status, 200);
    const changedRoutePlugin = pluginService.getPlugin(
      'openai',
      adminUser.id
    );
    assert.equal(
      pluginService.getApiKey(changedRoutePlugin, adminUser.id),
      null,
      'a credential saved for the bundled route cannot follow a later custom route'
    );
    assert.equal(
      await pluginService.activatePlugin('openai', adminUser.id),
      true
    );
    let changedRouteNetworkRequests = 0;
    await withPatchedProperties(
      axios,
      {
        post: async () => {
          changedRouteNetworkRequests += 1;
          throw new Error('stale route-bound key reached the network');
        },
      },
      async () => {
        await assert.rejects(
          pluginService.executePluginRequest(
            changedRoutePlugin.model_map[0],
            [{ role: 'user', content: 'Do not send this credential.' }],
            {},
            adminUser.id,
            'openai'
          ),
          /API key not found/
        );
      }
    );
    assert.equal(changedRouteNetworkRequests, 0);
    const customCredentialSave = await fetch(
      `${server.baseUrl}/api/plugins/openai/credentials`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ api_key: 'route-bound-user-secret' }),
      }
    );
    assert.equal(customCredentialSave.status, 200);
    const customBinding = databaseModule
      .getDatabase()
      .prepare(
        `SELECT routing_auth_fingerprint
         FROM plugin_credentials
         WHERE user_id = ? AND plugin_id = ?`
      )
      .get(adminUser.id, 'openai').routing_auth_fingerprint;
    assert.notEqual(customBinding, bundledBinding);
    assert.equal(
      pluginService.getApiKey(changedRoutePlugin, adminUser.id),
      'route-bound-user-secret'
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/plugins/openai/variables`, {
          method: 'DELETE',
          headers: adminHeaders,
        })
      ).status,
      200
    );
    assert.equal(
      pluginService.getApiKey(
        pluginService.getPlugin('openai', adminUser.id),
        adminUser.id
      ),
      'route-environment-secret',
      'a custom-route credential cannot follow a reset to another route'
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/plugins/openai/credentials`, {
          method: 'DELETE',
          headers: adminHeaders,
        })
      ).status,
      200
    );
    assert.equal(
      pluginService.deactivatePlugin('openai', adminUser.id),
      true
    );

    const selectorPlugin = {
      ...createPlugin({
        id: 'dynamic-selector-provider',
        endpoint: 'https://selector.example.test/v1/chat/completions',
        auth: { header: '', prefix: '', key_env: '' },
      }),
      variables: [
        {
          name: 'temperature',
          type: 'string',
          label: 'Capability endpoint',
          default: 'https://selector.example.test/v1/embeddings',
        },
      ],
      capabilities: {
        embedding: {
          endpoint: 'https://selector.example.test/v1/embeddings',
          model_map: ['selector-embedding-model'],
          config: {
            no_auth_required: true,
            endpoint_variable: 'temperature',
          },
        },
      },
    };
    const selectorInstall = await fetch(
      `${server.baseUrl}/api/plugins/install`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify(selectorPlugin),
      }
    );
    assert.equal(selectorInstall.status, 200);
    const selectorUser = upsertTestUser(
      'dynamic-selector-normal-user',
      'user'
    );
    const selectorUserHeaders = {
      Authorization: `Bearer ${authService.generateToken(selectorUser)}`,
      'Content-Type': 'application/json',
    };
    const selectorDisplay = await (
      await fetch(
        `${server.baseUrl}/api/plugins/${selectorPlugin.id}/variables`,
        { headers: selectorUserHeaders }
      )
    ).json();
    assert.equal(selectorDisplay.data.temperature.has_value, false);
    const selectorChange = await fetch(
      `${server.baseUrl}/api/plugins/${selectorPlugin.id}/variables`,
      {
        method: 'PUT',
        headers: selectorUserHeaders,
        body: JSON.stringify({
          variables: {
            temperature:
              'https://attacker-selector.example.test/v1/embeddings',
          },
        }),
      }
    );
    assert.equal(
      selectorChange.status,
      403,
      'manifest-declared endpoint selectors must be administrator-only'
    );
    assert.equal(
      (
        await fetch(`${server.baseUrl}/api/plugins/${selectorPlugin.id}`, {
          method: 'DELETE',
          headers: adminHeaders,
        })
      ).status,
      200
    );

    const invalidInstall = await fetch(
      `${server.baseUrl}/api/plugins/install`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      }
    );
    assert.equal(invalidInstall.status, 400);

    upsertTestUser(adminUser.id, 'user');
    const demotedInstall = await fetch(
      `${server.baseUrl}/api/plugins/install`,
      {
        method: 'POST',
        headers: adminHeaders,
        body: '{}',
      }
    );
    assert.equal(demotedInstall.status, 403);
  } finally {
    if (previousOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAIKey;
    }
    await server.close();
  }
});

test('custom endpoint resolution is full-URL based and fails closed', () => {
  const bundledEndpoint =
    'https://api.openai.com/v1/chat/completions?bundled=true';
  const customEndpoint =
    'https://gateway.example.test/openai/v1/chat/completions?preview=true';

  assert.equal(
    pluginValidation.resolvePluginEndpoint(bundledEndpoint),
    bundledEndpoint
  );
  assert.equal(
    pluginValidation.resolvePluginEndpoint(bundledEndpoint, '   '),
    bundledEndpoint
  );
  assert.equal(
    pluginValidation.resolvePluginEndpoint(
      bundledEndpoint,
      `  ${customEndpoint}  `
    ),
    customEndpoint
  );
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(customEndpoint),
    'https://gateway.example.test/openai/v1/models'
  );
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(
      'https://gateway.example.test/openai/v1/chat/completions/'
    ),
    'https://gateway.example.test/openai/v1/models'
  );
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(
      'https://gateway.example.test/openai/v1/#ignored'
    ),
    'https://gateway.example.test/openai/v1/models'
  );

  for (const unsafeEndpoint of [
    'http://api.openai.com/v1/chat/completions',
    'ftp://localhost/v1/chat/completions',
    'http://10.example.test/v1/chat/completions',
    'not a URL',
  ]) {
    assert.throws(
      () =>
        pluginValidation.resolvePluginEndpoint(bundledEndpoint, unsafeEndpoint),
      /Invalid or unsafe plugin endpoint override/
    );
  }

  for (const localEndpoint of [
    'http://localhost:8080/v1/chat/completions',
    'http://127.0.0.1:8080/v1/chat/completions',
    'http://[::1]:8080/v1/chat/completions',
    'http://10.0.0.8:8080/v1/chat/completions',
    'http://172.16.0.8:8080/v1/chat/completions',
    'http://192.168.0.8:8080/v1/chat/completions',
  ]) {
    assert.equal(
      pluginValidation.resolvePluginEndpoint(bundledEndpoint, localEndpoint),
      localEndpoint
    );
  }
});

test('Chat and Work requests use a valid custom endpoint instead of the bundled endpoint', async () => {
  const plugin = createPlugin();
  const customEndpoint =
    'https://gateway.example.test/openai/v1/chat/completions';
  const requests = [];

  await withPatchedProperties(
    pluginService,
    {
      getActivePluginForModel: () => plugin,
      getPluginVariables: (_plugin, userId) => {
        assert.equal(userId, 'user-42');
        return { endpoint: customEndpoint };
      },
      getApiKey: () => null,
    },
    async () =>
      withPatchedProperties(
        axios,
        {
          post: async (endpoint, payload, config) => {
            requests.push({ source: 'chat', endpoint, payload, config });
            return {
              data: {
                choices: [
                  {
                    message: {
                      role: 'assistant',
                      content: 'Custom endpoint response',
                    },
                  },
                ],
              },
            };
          },
        },
        async () => {
          const response = await pluginService.executePluginRequest(
            'chat-model',
            [{ role: 'user', content: 'Hello' }],
            {},
            'user-42'
          );
          assert.equal(
            response.choices[0].message.content,
            'Custom endpoint response'
          );
        }
      )
  );

  const workService = new WorkModelProviderService({
    ollama: {
      isHealthy: async () => false,
      showModel: async () => ({ capabilities: [] }),
      generateChatResponse: async () => {
        throw new Error('Unexpected Ollama request');
      },
    },
    plugins: {
      getActivePlugins: () => [plugin],
      getPlugin: (id, userId) => {
        assert.equal(userId, 'user-42');
        return id === plugin.id ? plugin : null;
      },
      getApiKey: () => null,
      getPluginVariables: (_plugin, userId) => {
        assert.equal(userId, 'user-42');
        return { endpoint: customEndpoint };
      },
    },
    post: async (endpoint, payload, config) => {
      requests.push({ source: 'work', endpoint, payload, config });
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Custom Work endpoint response',
              },
            },
          ],
        },
      };
    },
  });

  const workResponse = await workService.generateChatResponse(
    {
      model: 'chat-model',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    },
    { providerType: 'plugin', providerId: plugin.id },
    'user-42'
  );

  assert.equal(workResponse.message.content, 'Custom Work endpoint response');
  assert.deepEqual(
    requests.map(request => ({
      source: request.source,
      endpoint: request.endpoint,
    })),
    [
      { source: 'chat', endpoint: customEndpoint },
      { source: 'work', endpoint: customEndpoint },
    ]
  );
});

test('environment credentials never reach imported or user-stored routes', async () => {
  const service = new PluginService();
  const pluginId = 'credential-boundary-provider';
  const keyEnv = 'CREDENTIAL_BOUNDARY_ENV_KEY';
  const importedEndpoint = 'https://imported.example.test/v1/chat/completions';
  const customEndpoint = 'https://custom.example.test/v1/chat/completions';
  const schema = [
    {
      name: 'endpoint',
      type: 'string',
      label: 'Endpoint',
      default: importedEndpoint,
    },
    {
      name: 'temperature',
      type: 'number',
      label: 'Temperature',
      default: 0.7,
    },
  ];
  const adminUser = upsertTestUser('credential-boundary-admin-user', 'admin');
  service.installPlugin(
    {
      ...createPlugin({
        id: pluginId,
        endpoint: importedEndpoint,
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: keyEnv,
        },
      }),
      capabilities: undefined,
      variables: schema,
    },
    adminUser.id
  );
  const previousEnvironmentKey = process.env[keyEnv];
  process.env[keyEnv] = 'deployment-environment-secret';
  const requests = [];

  try {
    const importedPlugin = service.getPlugin(pluginId, adminUser.id);
    assert.ok(importedPlugin);
    assert.equal(
      service.getApiKey(importedPlugin, adminUser.id),
      null,
      'an imported definition cannot name a deployment environment key'
    );
    assert.equal(
      pluginVariablesService.setVariables(
        pluginId,
        { endpoint: customEndpoint },
        schema,
        adminUser.id
      ),
      true
    );
    const adminPlugin = service.getPlugin(pluginId, adminUser.id);
    assert.ok(adminPlugin);
    assert.equal(
      service.getPluginVariables(adminPlugin, adminUser.id).endpoint,
      customEndpoint
    );
    assert.equal(service.getApiKey(adminPlugin, adminUser.id), null);

    await withPatchedProperties(
      axios,
      {
        get: async (endpoint, config) => {
          requests.push({ operation: 'discover', endpoint, config });
          return { data: { data: [{ id: 'chat-model' }] } };
        },
        post: async (endpoint, payload, config) => {
          requests.push({ operation: 'chat', endpoint, payload, config });
          return {
            data: {
              id: 'credential-boundary-response',
              object: 'chat.completion',
              created: 0,
              model: 'chat-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
            },
          };
        },
      },
      async () => {
        assert.deepEqual(await service.discoverModels(pluginId, adminUser.id), [
          'chat-model',
        ]);
        assert.equal(
          await service.activatePlugin(pluginId, adminUser.id),
          true
        );
        assert.equal(
          service
            .getPluginStatus(adminUser.id)
            .find(status => status.id === pluginId)?.available,
          false
        );
        assert.equal(
          service
            .getAvailableEmbeddingModels(adminUser.id)
            .some(model => model.plugin === pluginId),
          false
        );
        assert.equal(
          service
            .getPluginsByCapability('completion', adminUser.id)
            .some(plugin => plugin.id === pluginId),
          false
        );
        const workAvailability = new WorkModelProviderService({
          ollama: { isHealthy: async () => false },
          plugins: service,
          post: async () => {
            throw new Error('availability must not make a request');
          },
        });
        assert.deepEqual(await workAvailability.availability(adminUser.id), {
          ollamaAvailable: false,
          pluginAvailable: false,
        });
        await assert.rejects(
          service.executePluginRequest(
            'chat-model',
            [{ role: 'user', content: 'Do not leak the environment key.' }],
            {},
            adminUser.id,
            pluginId
          ),
          /API key not found/
        );
        assert.equal(requests.length, 0);

        assert.equal(
          pluginCredentialsService.setApiKey(
            pluginId,
            'admin-stored-secret',
            adminUser.id,
            service.getCredentialRoutingAuthFingerprint(
              adminPlugin,
              adminUser.id
            )
          ),
          true
        );
        assert.equal(
          service
            .getPluginStatus(adminUser.id)
            .find(status => status.id === pluginId)?.available,
          true
        );
        assert.equal(
          service
            .getAvailableEmbeddingModels(adminUser.id)
            .some(model => model.plugin === pluginId),
          true
        );
        assert.equal(
          service
            .getPluginsByCapability('completion', adminUser.id)
            .some(plugin => plugin.id === pluginId),
          true
        );
        assert.deepEqual(await workAvailability.availability(adminUser.id), {
          ollamaAvailable: false,
          pluginAvailable: true,
        });
        assert.deepEqual(await service.discoverModels(pluginId, adminUser.id), [
          'chat-model',
        ]);
        await service.executePluginRequest(
          'chat-model',
          [{ role: 'user', content: 'Use the stored key.' }],
          {},
          adminUser.id,
          pluginId
        );
        assert.deepEqual(
          requests.map(request => ({
            operation: request.operation,
            endpoint: request.endpoint,
            authorization: request.config.headers.Authorization,
          })),
          [
            {
              operation: 'discover',
              endpoint: 'https://custom.example.test/v1/models',
              authorization: 'Bearer admin-stored-secret',
            },
            {
              operation: 'chat',
              endpoint: customEndpoint,
              authorization: 'Bearer admin-stored-secret',
            },
          ]
        );

        assert.equal(
          pluginCredentialsService.deleteApiKey(pluginId, adminUser.id),
          true
        );
        assert.equal(
          pluginVariablesService.setVariables(
            pluginId,
            { endpoint: '' },
            schema,
            adminUser.id
          ),
          true
        );
        requests.length = 0;
        assert.equal(service.getApiKey(adminPlugin, adminUser.id), null);
        await assert.rejects(
          service.executePluginRequest(
            'chat-model',
            [
              {
                role: 'user',
                content: 'Do not trust the imported manifest route.',
              },
            ],
            {},
            adminUser.id,
            pluginId
          ),
          /API key not found/
        );
        assert.equal(requests.length, 0);
      }
    );
  } finally {
    service.deletePlugin(pluginId);
    if (previousEnvironmentKey === undefined) {
      delete process.env[keyEnv];
    } else {
      process.env[keyEnv] = previousEnvironmentKey;
    }
  }
});

test('administrator definition retargeting revokes activation and cannot carry another user credential', async () => {
  const service = new PluginService();
  const pluginId = 'definition-retarget-provider';
  const admin = upsertTestUser('definition-retarget-admin', 'admin');
  const user = upsertTestUser('definition-retarget-user', 'user');
  const definitionA = {
    ...createPlugin({
      id: pluginId,
      endpoint: 'https://provider-a.example.test/v1/chat/completions',
      auth: {
        header: 'Authorization',
        prefix: 'Bearer ',
        key_env: 'DEFINITION_RETARGET_KEY',
      },
    }),
    capabilities: undefined,
  };
  service.installPlugin(definitionA, admin.id);
  const pluginA = service.getPlugin(pluginId, user.id);
  assert.ok(pluginA);
  assert.equal(
    pluginCredentialsService.setApiKey(
      pluginId,
      'user-bound-provider-secret',
      user.id,
      service.getCredentialRoutingAuthFingerprint(pluginA, user.id)
    ),
    true
  );

  const networkRequests = [];
  try {
    await withPatchedProperties(
      axios,
      {
        get: async (...args) => {
          networkRequests.push({ operation: 'discover-a', args });
          return { data: { data: [{ id: 'chat-model' }] } };
        },
        post: async (...args) => {
          networkRequests.push({ operation: 'chat-b', args });
          throw new Error('retargeted definition reached the network');
        },
      },
      async () => {
        assert.equal(await service.activatePlugin(pluginId, user.id), true);
        assert.equal(networkRequests.length, 1);
        networkRequests.length = 0;

        service.installPlugin(
          {
            ...definitionA,
            endpoint: 'https://provider-b.example.test/v1/chat/completions',
            auth: {
              ...definitionA.auth,
              prefix: 'Token ',
            },
          },
          admin.id
        );
        const pluginB = service.getPlugin(pluginId, user.id);
        assert.ok(pluginB);
        assert.equal(pluginB.active, false);
        assert.equal(
          databaseModule
            .getDatabase()
            .prepare(
              `SELECT COUNT(*) AS count
               FROM plugin_activations
               WHERE plugin_id = ?`
            )
            .get(pluginId).count,
          0
        );
        assert.equal(
          service.getApiKey(pluginB, user.id),
          null,
          'a shared definition update cannot carry another user credential'
        );
        assert.equal(await service.activatePlugin(pluginId, user.id), true);
        await assert.rejects(
          service.executePluginRequest(
            'chat-model',
            [{ role: 'user', content: 'Do not send the prior key.' }],
            {},
            user.id,
            pluginId
          ),
          /API key not found/
        );
        assert.equal(networkRequests.length, 0);

        assert.equal(
          pluginCredentialsService.setApiKey(
            pluginId,
            'user-bound-provider-secret',
            user.id,
            service.getCredentialRoutingAuthFingerprint(pluginB, user.id)
          ),
          true
        );
        assert.equal(
          service.getApiKey(pluginB, user.id),
          'user-bound-provider-secret',
          'the user can explicitly re-bind their credential after reviewing the new route'
        );
      }
    );
  } finally {
    if (
      fs.existsSync(
        path.join(process.env.PLUGINS_DIR, `${pluginId}.json`)
      )
    ) {
      assert.equal(service.deletePlugin(pluginId), true);
    }
  }
});

test('trusted bundled routing may use an environment credential', async () => {
  const service = new PluginService();
  const pluginId = 'openai';
  const keyEnv = 'OPENAI_API_KEY';
  const environmentKey = 'trusted-bundled-environment-secret';
  const customEndpoint =
    'https://ignored-legacy.example.test/v1/chat/completions';
  const adminUser = upsertTestUser('trusted-bundled-admin-user', 'admin');
  const normalUser = upsertTestUser('trusted-bundled-normal-user', 'user');
  const legacyCredentialUser = upsertTestUser(
    'trusted-bundled-legacy-credential-user',
    'user'
  );
  const previousEnvironmentKey = process.env[keyEnv];
  const requests = [];
  process.env[keyEnv] = environmentKey;

  try {
    const adminPlugin = service.getPlugin(pluginId, adminUser.id);
    assert.ok(adminPlugin?.variables);
    const model = adminPlugin.model_map[0];
    assert.ok(model);
    assert.equal(service.getApiKey(adminPlugin, adminUser.id), environmentKey);
    const legacyCredentialPlugin = service.getPlugin(
      pluginId,
      legacyCredentialUser.id
    );
    assert.ok(legacyCredentialPlugin);
    const legacyBinding = service.getCredentialRoutingAuthFingerprint(
      legacyCredentialPlugin,
      legacyCredentialUser.id
    );
    assert.equal(
      pluginCredentialsService.setApiKey(
        pluginId,
        'legacy-user-stored-secret',
        legacyCredentialUser.id,
        legacyBinding
      ),
      true
    );
    databaseModule
      .getDatabase()
      .prepare(
        `UPDATE plugin_credentials
         SET routing_auth_fingerprint = NULL
         WHERE user_id = ? AND plugin_id = ?`
      )
      .run(legacyCredentialUser.id, pluginId);
    assert.equal(
      service.getApiKey(legacyCredentialPlugin, legacyCredentialUser.id),
      'legacy-user-stored-secret',
      'an unbound pre-upgrade credential remains usable only on the anchored route'
    );
    assert.equal(
      databaseModule
        .getDatabase()
        .prepare(
          `SELECT routing_auth_fingerprint
           FROM plugin_credentials
           WHERE user_id = ? AND plugin_id = ?`
        )
        .get(legacyCredentialUser.id, pluginId).routing_auth_fingerprint,
      legacyBinding,
      'first trusted use must bind a legacy credential before returning it'
    );

    await withPatchedProperties(
      axios,
      {
        get: async (endpoint, config) => {
          requests.push({ operation: 'discover', endpoint, config });
          return { data: { data: [{ id: model }] } };
        },
        post: async (endpoint, payload, config) => {
          requests.push({ operation: 'chat', endpoint, payload, config });
          return {
            data: {
              id: 'trusted-bundled-response',
              object: 'chat.completion',
              created: 0,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
            },
          };
        },
      },
      async () => {
        assert.equal(
          await service.activatePlugin(pluginId, adminUser.id),
          true
        );
        await service.executePluginRequest(
          model,
          [{ role: 'user', content: 'Use the bundled route.' }],
          {},
          adminUser.id,
          pluginId
        );

        assert.equal(
          pluginVariablesService.setVariables(
            pluginId,
            { endpoint: customEndpoint },
            adminPlugin.variables,
            normalUser.id
          ),
          true
        );
        databaseModule
          .getDatabase()
          .prepare(
            `INSERT INTO plugin_discovered_models
               (user_id, plugin_id, models_json, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, plugin_id) DO UPDATE SET
               models_json = excluded.models_json,
               updated_at = excluded.updated_at`
          )
          .run(
            normalUser.id,
            pluginId,
            JSON.stringify(['stale-custom-model']),
            Date.now()
          );
        const normalPlugin = service.getPlugin(pluginId, normalUser.id);
        assert.ok(normalPlugin);
        assert.equal(
          service.getPluginVariables(normalPlugin, normalUser.id).endpoint,
          adminPlugin.endpoint
        );
        assert.deepEqual(normalPlugin.model_map, adminPlugin.model_map);
        assert.equal(
          service.getApiKey(normalPlugin, normalUser.id),
          environmentKey
        );
        assert.equal(
          await service.activatePlugin(pluginId, normalUser.id),
          true
        );
        await service.executePluginRequest(
          model,
          [{ role: 'user', content: 'Ignore the legacy custom route.' }],
          {},
          normalUser.id,
          pluginId
        );
      }
    );

    assert.equal(
      requests.some(request => request.endpoint === customEndpoint),
      false
    );
    assert.ok(
      requests.some(
        request =>
          request.operation === 'discover' &&
          request.endpoint === 'https://api.openai.com/v1/models'
      )
    );
    assert.ok(
      requests.some(
        request =>
          request.operation === 'chat' &&
          request.endpoint === adminPlugin.endpoint
      )
    );
    assert.ok(
      requests.every(
        request =>
          request.config.headers.Authorization === `Bearer ${environmentKey}`
      )
    );
  } finally {
    service.deactivatePlugin(pluginId, adminUser.id);
    service.deactivatePlugin(pluginId, normalUser.id);
    service.clearDiscoveredModels(pluginId, adminUser.id);
    service.clearDiscoveredModels(pluginId, normalUser.id);
    pluginVariablesService.deletePluginVariables(pluginId, adminUser.id);
    pluginVariablesService.deletePluginVariables(pluginId, normalUser.id);
    pluginCredentialsService.deleteApiKey(
      pluginId,
      legacyCredentialUser.id
    );
    if (previousEnvironmentKey === undefined) {
      delete process.env[keyEnv];
    } else {
      process.env[keyEnv] = previousEnvironmentKey;
    }
  }
});

test('Docker-style bundled and legacy directory alias preserves anchored environment fallback', () => {
  const service = new PluginService();
  const user = upsertTestUser('docker-layout-environment-user', 'user');
  const previousEnvironmentKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'docker-layout-environment-secret';
  service.legacyPluginsDir = service.bundledPluginsDir;
  service.pluginReadDirs = [
    service.bundledPluginsDir,
    service.pluginsDir,
  ];

  try {
    const plugin = service.getPlugin('openai', user.id);
    assert.ok(plugin);
    assert.equal(
      service.getApiKey(plugin, user.id),
      'docker-layout-environment-secret'
    );
  } finally {
    if (previousEnvironmentKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousEnvironmentKey;
    }
  }
});

test('mismatched filenames and duplicate variable names cannot confuse trust resolution', () => {
  const service = new PluginService();
  const normalUser = upsertTestUser('manifest-ambiguity-normal-user', 'user');
  const adminUser = upsertTestUser('manifest-ambiguity-admin-user', 'admin');
  const bundledDefinition = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'openai.json'), 'utf8')
  );
  const endpointDefinition = bundledDefinition.variables.find(
    definition => definition.name === 'endpoint'
  );
  assert.ok(endpointDefinition);
  const attackerEndpoint =
    'https://filename-confusion.example.test/v1/chat/completions';
  const mismatchedPath = path.join(
    process.env.PLUGINS_DIR,
    'different-filename.json'
  );
  const exactIdPath = path.join(process.env.PLUGINS_DIR, 'openai.json');
  const previousEnvironmentKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'manifest-ambiguity-environment-secret';

  try {
    fs.writeFileSync(
      mismatchedPath,
      JSON.stringify(
        {
          ...bundledDefinition,
          variables: [
            { ...endpointDefinition, default: attackerEndpoint },
            ...bundledDefinition.variables,
          ],
        },
        null,
        2
      )
    );
    const safePlugin = service
      .getAllPlugins(normalUser.id)
      .find(plugin => plugin.id === 'openai');
    assert.ok(safePlugin);
    assert.equal(
      service.getPluginVariables(safePlugin, normalUser.id).endpoint,
      bundledDefinition.endpoint
    );
    assert.equal(
      service.getApiKey(safePlugin, normalUser.id),
      'manifest-ambiguity-environment-secret'
    );

    assert.throws(
      () =>
        service.installPlugin(
          {
            ...bundledDefinition,
            id: 'duplicate-variable-provider',
            variables: [
              { ...endpointDefinition, default: attackerEndpoint },
              ...bundledDefinition.variables,
            ],
          },
          adminUser.id
        ),
      /Invalid plugin structure/
    );

    fs.writeFileSync(
      exactIdPath,
      fs.readFileSync(mismatchedPath, 'utf8')
    );
    assert.equal(service.getPlugin('openai', normalUser.id), null);
    assert.equal(
      service
        .getAllPlugins(normalUser.id)
        .some(plugin => plugin.id === 'openai'),
      false,
      'an invalid effective same-ID shadow must hide the earlier bundled definition'
    );
  } finally {
    for (const filePath of [mismatchedPath, exactIdPath]) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    if (previousEnvironmentKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousEnvironmentKey;
    }
  }
});

test('a pre-upgrade same-ID shadow cannot consume a legacy unbound credential', async () => {
  const service = new PluginService();
  const user = upsertTestUser('legacy-shadow-credential-user', 'user');
  const bundledDefinition = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'openai.json'), 'utf8')
  );
  const bundledPlugin = service.getPlugin('openai', user.id);
  assert.ok(bundledPlugin);
  const binding = service.getCredentialRoutingAuthFingerprint(
    bundledPlugin,
    user.id
  );
  assert.equal(
    pluginCredentialsService.setApiKey(
      'openai',
      'legacy-shadow-secret',
      user.id,
      binding
    ),
    true
  );
  databaseModule
    .getDatabase()
    .prepare(
      `UPDATE plugin_credentials
       SET routing_auth_fingerprint = NULL
       WHERE user_id = ? AND plugin_id = ?`
    )
    .run(user.id, 'openai');
  databaseModule
    .getDatabase()
    .prepare(
      `INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
       VALUES (?, ?, ?)`
    )
    .run(user.id, 'openai', Date.now());
  const shadowPath = path.join(process.env.PLUGINS_DIR, 'openai.json');
  fs.writeFileSync(
    shadowPath,
    JSON.stringify(
      {
        ...bundledDefinition,
        endpoint: 'https://legacy-shadow.example.test/v1/chat/completions',
      },
      null,
      2
    )
  );
  const networkRequests = [];

  try {
    await withPatchedProperties(
      axios,
      {
        get: async (...args) => {
          networkRequests.push({ operation: 'discover', args });
          throw new Error('legacy shadow discovery reached the network');
        },
        post: async (...args) => {
          networkRequests.push({ operation: 'chat', args });
          throw new Error('legacy shadow request reached the network');
        },
      },
      async () => {
        assert.equal(service.getPlugin('openai', user.id), null);
        assert.equal(
          service
            .getAllPlugins(user.id)
            .some(plugin => plugin.id === 'openai'),
          false
        );
        assert.deepEqual(await service.discoverModels('openai', user.id), []);
        await assert.rejects(
          service.executePluginRequest(
            bundledDefinition.model_map[0],
            [{ role: 'user', content: 'Do not leak the legacy key.' }],
            {},
            user.id,
            'openai'
          ),
          /Plugin not found/
        );
        assert.equal(networkRequests.length, 0);
        assert.equal(
          databaseModule
            .getDatabase()
            .prepare(
              `SELECT routing_auth_fingerprint
               FROM plugin_credentials
               WHERE user_id = ? AND plugin_id = ?`
            )
            .get(user.id, 'openai').routing_auth_fingerprint,
          null,
          'an untrusted shadow must not lazily bind a legacy credential'
        );
      }
    );
  } finally {
    if (fs.existsSync(shadowPath)) fs.unlinkSync(shadowPath);
    pluginCredentialsService.deleteApiKey('openai', user.id);
    service.deactivatePlugin('openai', user.id);
  }
});

test('bundled-ID shadows cannot consume environment credentials', async () => {
  const service = new PluginService();
  const pluginId = 'openai';
  const keyEnv = 'OPENAI_API_KEY';
  const attackerEndpoint = 'https://attacker.example.test/v1/chat/completions';
  const attackerCapabilityEndpoint =
    'https://attacker.example.test/v1/audio/speech';
  const adminUser = upsertTestUser('bundled-shadow-admin-user', 'admin');
  const bundledDefinition = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'openai.json'), 'utf8')
  );
  const previousEnvironmentKey = process.env[keyEnv];
  const networkRequests = [];
  process.env[keyEnv] = 'deployment-environment-secret';

  const assertShadowIsBlocked = async () => {
    const shadow = service.getPlugin(pluginId, adminUser.id);
    assert.ok(shadow);
    assert.equal(service.getApiKey(shadow, adminUser.id), null);
    assert.equal(
      service
        .getPluginStatus(adminUser.id)
        .find(status => status.id === pluginId)?.available,
      false
    );
    assert.equal(await service.activatePlugin(pluginId, adminUser.id), true);
    await assert.rejects(
      service.executePluginRequest(
        shadow.model_map[0],
        [{ role: 'user', content: 'Do not leak the environment key.' }],
        {},
        adminUser.id,
        pluginId
      ),
      /API key not found/
    );
    assert.equal(networkRequests.length, 0);
  };

  try {
    await withPatchedProperties(
      axios,
      {
        get: async (...args) => {
          networkRequests.push({ operation: 'discover', args });
          return { data: { data: [] } };
        },
        post: async (...args) => {
          networkRequests.push({ operation: 'chat', args });
          throw new Error('shadow request must not reach the network');
        },
      },
      async () => {
        service.installPlugin(
          {
            ...bundledDefinition,
            endpoint: attackerEndpoint,
          },
          adminUser.id
        );
        await assertShadowIsBlocked();
        assert.equal(service.deletePlugin(pluginId), true);

        service.installPlugin(
          {
            ...bundledDefinition,
            variables: bundledDefinition.variables.map(definition =>
              definition.name === 'endpoint'
                ? { ...definition, default: attackerEndpoint }
                : definition
            ),
          },
          adminUser.id
        );
        await assertShadowIsBlocked();
        assert.equal(service.deletePlugin(pluginId), true);

        service.installPlugin(
          {
            ...bundledDefinition,
            capabilities: {
              ...bundledDefinition.capabilities,
              tts: {
                ...bundledDefinition.capabilities.tts,
                endpoint: attackerCapabilityEndpoint,
                config: {
                  ...bundledDefinition.capabilities.tts.config,
                  endpoint_variable: 'temperature',
                },
              },
            },
          },
          adminUser.id
        );
        const capabilityShadow = service.getPlugin(pluginId, adminUser.id);
        assert.ok(capabilityShadow);
        assert.equal(service.getApiKey(capabilityShadow, adminUser.id), null);
        assert.equal(
          service
            .getAvailableTTSModels(adminUser.id)
            .some(model => model.plugin === pluginId),
          false
        );
        await assertShadowIsBlocked();
      }
    );
  } finally {
    const customPath = path.join(process.env.PLUGINS_DIR, `${pluginId}.json`);
    if (fs.existsSync(customPath)) {
      assert.equal(service.deletePlugin(pluginId), true);
    }
    service.deactivatePlugin(pluginId, adminUser.id);
    if (previousEnvironmentKey === undefined) {
      delete process.env[keyEnv];
    } else {
      process.env[keyEnv] = previousEnvironmentKey;
    }
  }
});

test('environment fallback fails closed when bundled and writable directories alias', async () => {
  const service = new PluginService();
  const pluginId = 'same-directory-provider';
  const keyEnv = 'SAME_DIRECTORY_PROVIDER_KEY';
  const aliasDirectory = path.join(testDataDir, 'same-directory-plugins');
  const adminUser = upsertTestUser('same-directory-admin-user', 'admin');
  const previousEnvironmentKey = process.env[keyEnv];
  const networkRequests = [];
  fs.mkdirSync(aliasDirectory, { recursive: true });
  process.env[keyEnv] = 'deployment-environment-secret';

  service.bundledPluginsDir = aliasDirectory;
  service.legacyPluginsDir = aliasDirectory;
  service.pluginsDir = aliasDirectory;
  service.pluginReadDirs = [aliasDirectory];
  service.installPlugin(
    {
      ...createPlugin({
        id: pluginId,
        endpoint: 'https://attacker.example.test/v1/chat/completions',
        auth: {
          header: 'Authorization',
          prefix: 'Bearer ',
          key_env: keyEnv,
        },
      }),
      capabilities: undefined,
    },
    adminUser.id
  );

  try {
    await withPatchedProperties(
      axios,
      {
        get: async (...args) => {
          networkRequests.push({ operation: 'discover', args });
          return { data: { data: [] } };
        },
        post: async (...args) => {
          networkRequests.push({ operation: 'chat', args });
          throw new Error('same-directory request must not reach the network');
        },
      },
      async () => {
        const plugin = service.getPlugin(pluginId, adminUser.id);
        assert.ok(plugin);
        assert.equal(service.getApiKey(plugin, adminUser.id), null);
        assert.equal(
          await service.activatePlugin(pluginId, adminUser.id),
          true
        );
        await assert.rejects(
          service.executePluginRequest(
            plugin.model_map[0],
            [{ role: 'user', content: 'Do not leak the environment key.' }],
            {},
            adminUser.id,
            pluginId
          ),
          /API key not found/
        );
        assert.equal(networkRequests.length, 0);
      }
    );
  } finally {
    service.deactivatePlugin(pluginId, adminUser.id);
    fs.rmSync(aliasDirectory, { recursive: true, force: true });
    if (previousEnvironmentKey === undefined) {
      delete process.env[keyEnv];
    } else {
      process.env[keyEnv] = previousEnvironmentKey;
    }
  }
});

test('endpoint variables reject unsafe URLs when saved and preserve blank fallback', () => {
  const definitions = [{ name: 'endpoint', type: 'string' }];

  assert.deepEqual(
    pluginVariableValidation.validatePluginVariables(definitions, {
      endpoint: '   ',
    }),
    { success: true, variables: { endpoint: '' } }
  );
  assert.deepEqual(
    pluginVariableValidation.validatePluginVariables(definitions, {
      endpoint: '  https://gateway.example.test/v1/chat/completions  ',
    }),
    {
      success: true,
      variables: {
        endpoint: 'https://gateway.example.test/v1/chat/completions',
      },
    }
  );

  for (const endpoint of [
    'http://api.openai.com/v1/chat/completions',
    'ftp://localhost/v1/chat/completions',
    'http://10.example.test/v1/chat/completions',
  ]) {
    const result = pluginVariableValidation.validatePluginVariables(
      definitions,
      { endpoint }
    );
    assert.equal(result.success, false);
    assert.match(result.error, /must use HTTPS for remote URLs/);
  }

  const malformed = pluginVariableValidation.validatePluginVariables(
    definitions,
    { endpoint: 'not a URL' }
  );
  assert.equal(malformed.success, false);
  assert.match(malformed.error, /must be a valid URL/);
});

test('model discovery uses the user endpoint and credentials without default fallback', async () => {
  const plugin = createPlugin({
    id: 'openai',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'OPENAI_API_KEY',
    },
  });
  const customEndpoint =
    'https://gateway.example.test/openai/v1/chat/completions';
  const requests = [];
  let currentEndpoint = customEndpoint;

  await withPatchedProperties(
    pluginService,
    {
      getPlugin: id => (id === plugin.id ? plugin : null),
      getPluginVariables: (_plugin, userId) => {
        assert.equal(userId, 'user-42');
        return { endpoint: currentEndpoint };
      },
      getApiKey: (_plugin, userId) => {
        assert.equal(userId, 'user-42');
        return 'user-42-key';
      },
    },
    async () =>
      withPatchedProperties(
        axios,
        {
          get: async (endpoint, config) => {
            requests.push({ endpoint, config });
            return { data: { data: [] } };
          },
        },
        async () => {
          assert.deepEqual(
            await pluginService.discoverModels(plugin.id, 'user-42'),
            ['chat-model']
          );
          assert.equal(requests.length, 1);
          assert.equal(
            requests[0].endpoint,
            'https://gateway.example.test/openai/v1/models'
          );
          assert.equal(
            requests[0].config.headers.Authorization,
            'Bearer user-42-key'
          );

          currentEndpoint = 'http://api.openai.com/v1/chat/completions';
          await assert.rejects(
            pluginService.discoverModels(plugin.id, 'user-42'),
            /Invalid or unsafe plugin endpoint override/
          );
          assert.equal(
            requests.length,
            1,
            'invalid overrides must not request the bundled endpoint'
          );
        }
      )
  );
});

test('discovered models persist per user without mutating the shared plugin manifest', async () => {
  const database = databaseModule.getDatabase();
  const now = Date.now();
  const insertUser = database.prepare(`
    INSERT OR IGNORE INTO users
      (id, username, email, password_hash, role, created_at, updated_at)
    VALUES (?, ?, NULL, ?, 'user', ?, ?)
  `);
  insertUser.run('catalog-user-one', 'catalog-user-one', 'test', now, now);
  insertUser.run('catalog-user-two', 'catalog-user-two', 'test', now, now);
  const installer = upsertTestUser('catalog-plugin-installer', 'admin');

  const service = new PluginService();
  const providerId = 'model-isolation-provider';
  service.installPlugin(
    createPlugin({
      id: providerId,
      auth: {
        header: 'Authorization',
        prefix: 'Bearer ',
        key_env: 'MODEL_ISOLATION_API_KEY',
      },
    }),
    installer.id
  );

  service.getPluginVariables = (_plugin, userId) => ({
    endpoint: `https://${userId}.example.test/v1/chat/completions`,
  });
  service.getApiKey = (_plugin, userId) => `key-${userId}`;

  await withPatchedProperties(
    axios,
    {
      get: async endpoint => {
        const user = new URL(endpoint).hostname.split('.')[0];
        return { data: { data: [{ id: `model-${user}` }] } };
      },
    },
    async () => {
      assert.deepEqual(
        await service.discoverModels(providerId, 'catalog-user-one'),
        ['model-catalog-user-one']
      );
      assert.deepEqual(
        await service.discoverModels(providerId, 'catalog-user-two'),
        ['model-catalog-user-two']
      );
      assert.equal(
        await service.activatePlugin(providerId, 'catalog-user-one'),
        true
      );
    }
  );

  assert.deepEqual(
    service.getPlugin(providerId, 'catalog-user-one').model_map,
    ['model-catalog-user-one']
  );
  assert.deepEqual(
    service.getPlugin(providerId, 'catalog-user-two').model_map,
    ['model-catalog-user-two']
  );
  assert.equal(service.getPlugin(providerId, 'catalog-user-one').active, true);
  assert.equal(service.getPlugin(providerId, 'catalog-user-two').active, false);
  assert.deepEqual(service.getPlugin(providerId, 'default').model_map, [
    'chat-model',
  ]);
  assert.equal(
    service.getActivePluginForModel(
      'model-catalog-user-one',
      'catalog-user-one',
      providerId
    )?.id,
    providerId
  );
  assert.throws(
    () =>
      service.getActivePluginForModel(
        'model-catalog-user-one',
        'catalog-user-two',
        providerId
      ),
    /not active/
  );

  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.env.PLUGINS_DIR, `${providerId}.json`),
      'utf8'
    )
  );
  assert.deepEqual(manifest.model_map, ['chat-model']);

  const reloadedService = new PluginService();
  assert.deepEqual(
    reloadedService.getPlugin(providerId, 'catalog-user-one').model_map,
    ['model-catalog-user-one']
  );
  assert.deepEqual(
    reloadedService.getPlugin(providerId, 'catalog-user-two').model_map,
    ['model-catalog-user-two']
  );
  assert.equal(
    reloadedService.getPlugin(providerId, 'catalog-user-one').active,
    true
  );
  assert.equal(
    reloadedService.getPlugin(providerId, 'catalog-user-two').active,
    false
  );

  assert.equal(
    await reloadedService.activatePlugin(providerId, 'catalog-user-two'),
    true
  );
  assert.equal(
    reloadedService.deactivatePlugin(providerId, 'catalog-user-one'),
    true
  );
  const twiceReloadedService = new PluginService();
  assert.equal(
    twiceReloadedService.getPlugin(providerId, 'catalog-user-one').active,
    false
  );
  assert.equal(
    twiceReloadedService.getPlugin(providerId, 'catalog-user-two').active,
    true
  );
});

test('Chat, Work, embedding, TTS, and image overrides fail before network access', async () => {
  const plugin = createPlugin();
  const unsafeEndpoint = 'http://api.openai.com/v1/chat/completions';
  let networkRequests = 0;

  await withPatchedProperties(
    pluginService,
    {
      getActivePluginForModel: () => plugin,
      getAllPlugins: () => [plugin],
      getPlugin: id => (id === plugin.id ? plugin : null),
      getPluginVariables: () => ({ endpoint: unsafeEndpoint }),
      getApiKey: () => null,
    },
    async () =>
      withPatchedProperties(
        axios,
        {
          post: async () => {
            networkRequests += 1;
            throw new Error('Unexpected network request');
          },
        },
        async () => {
          await assert.rejects(
            pluginService.executePluginRequest(
              'chat-model',
              [{ role: 'user', content: 'Hello' }],
              {},
              'user-42'
            ),
            /Invalid or unsafe plugin endpoint override/
          );
          await assert.rejects(
            pluginService.executeEmbeddingRequest(
              'embedding-model',
              'Hello',
              plugin.id,
              'user-42'
            ),
            /Invalid or unsafe plugin endpoint override/
          );
          await assert.rejects(
            pluginService.executeTTSRequest('tts-model', 'Hello', {
              pluginId: plugin.id,
              userId: 'user-42',
            }),
            /Invalid or unsafe plugin endpoint override/
          );
          await assert.rejects(
            pluginService.executeImageGenRequest(
              'image-model',
              'A test image',
              {
                userId: 'user-42',
              }
            ),
            /Invalid or unsafe plugin endpoint override/
          );
        }
      )
  );

  const workService = new WorkModelProviderService({
    ollama: {
      isHealthy: async () => false,
      showModel: async () => ({ capabilities: [] }),
      generateChatResponse: async () => {
        throw new Error('Unexpected Ollama request');
      },
    },
    plugins: {
      getActivePlugins: () => [plugin],
      getPlugin: (id, userId) => {
        assert.equal(userId, 'user-42');
        return id === plugin.id ? plugin : null;
      },
      getApiKey: () => null,
      getPluginVariables: () => ({ endpoint: unsafeEndpoint }),
    },
    post: async () => {
      networkRequests += 1;
      throw new Error('Unexpected network request');
    },
  });

  await assert.rejects(
    workService.generateChatResponse(
      {
        model: 'chat-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
      { providerType: 'plugin', providerId: plugin.id },
      'user-42'
    ),
    /Invalid or unsafe plugin endpoint override/
  );
  assert.equal(networkRequests, 0);
});

test('image discovery and requests use the current user endpoint and credentials', async () => {
  const plugin = createPlugin({
    id: 'user-image-provider',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'IMAGE_API_KEY',
    },
  });
  const userContexts = [];
  const imageService = new PluginImageGenerationService({
    getAllPlugins: userId => {
      userContexts.push({ operation: 'plugins', userId });
      return [plugin];
    },
    getPlugin: (id, userId) => {
      userContexts.push({ operation: 'plugin', userId });
      return id === plugin.id ? plugin : null;
    },
    getApiKey: (_plugin, userId) => {
      userContexts.push({ operation: 'credential', userId });
      return `key-${userId}`;
    },
    getPluginVariables: (_plugin, userId) => {
      userContexts.push({ operation: 'variables', userId });
      return {
        endpoint:
          'https://image-user.example.test/v1/images/generations?custom=true',
      };
    },
    validateEndpointUrl: endpoint =>
      pluginValidation.resolvePluginEndpoint(plugin.endpoint, endpoint),
  });

  assert.deepEqual(imageService.getAvailableImageGenModels('image-user'), [
    {
      model: 'image-model',
      plugin: plugin.id,
      config: { no_auth_required: true },
    },
  ]);

  let request;
  await withPatchedProperties(
    axios,
    {
      post: async (endpoint, payload, config) => {
        request = { endpoint, payload, config };
        return { data: { data: [{ b64_json: 'image-data' }] } };
      },
    },
    async () => {
      assert.deepEqual(
        await imageService.executeImageGenRequest(
          'image-model',
          'A user-scoped image',
          { userId: 'image-user' }
        ),
        {
          images: [
            {
              url: undefined,
              b64_json: 'image-data',
              revised_prompt: undefined,
            },
          ],
          model: 'image-model',
        }
      );
    }
  );

  assert.equal(
    request.endpoint,
    'https://image-user.example.test/v1/images/generations?custom=true'
  );
  assert.equal(request.config.headers.Authorization, 'Bearer key-image-user');
  assert.ok(
    userContexts.length >= 4 &&
      userContexts.every(({ userId }) => userId === 'image-user')
  );
});

test('image routes forward the authenticated user to catalog and generation services', async () => {
  const calls = [];
  const getRouteHandler = routePath => {
    const layer = imageGenRoutes.stack.find(
      candidate => candidate.route?.path === routePath
    );
    assert.ok(layer, `Expected image route ${routePath}`);
    return layer.route.stack.at(-1).handle;
  };
  const invokeRoute = async (routePath, body = {}) => {
    let responseBody;
    const response = {
      status() {
        return this;
      },
      json(value) {
        responseBody = value;
        return this;
      },
    };
    await getRouteHandler(routePath)(
      {
        body,
        params: {},
        user: { userId: 'image-route-user' },
      },
      response
    );
    return responseBody;
  };

  await withPatchedProperties(
    pluginService,
    {
      getAvailableImageGenModels: userId => {
        calls.push({ operation: 'models', userId });
        return [];
      },
      getPluginsByCapability: (capability, userId) => {
        calls.push({ operation: capability, userId });
        return [];
      },
      executeImageGenRequest: async (_model, _prompt, options) => {
        calls.push({ operation: 'generate', userId: options.userId });
        return { images: [], model: 'image-model' };
      },
    },
    async () => {
      assert.deepEqual(await invokeRoute('/models'), {
        success: true,
        data: [],
      });
      assert.deepEqual(await invokeRoute('/plugins'), {
        success: true,
        data: [],
      });
      assert.deepEqual(
        await invokeRoute('/generate', {
          model: 'image-model',
          prompt: 'A route test',
        }),
        {
          success: true,
          data: {
            images: [],
            model: 'image-model',
            savedToGallery: [],
          },
        }
      );
    }
  );

  assert.deepEqual(calls, [
    { operation: 'models', userId: 'image-route-user' },
    { operation: 'image', userId: 'image-route-user' },
    { operation: 'generate', userId: 'image-route-user' },
  ]);
});

test('activation waits for user-scoped model discovery before resolving', async () => {
  upsertTestUser('user-42', 'user');
  const plugin = createPlugin({ id: 'activation-provider' });
  const discoveryCalls = [];
  let finishDiscovery;
  let activationResolved = false;

  await withPatchedProperties(
    pluginService,
    {
      getPlugin: id => (id === plugin.id ? plugin : null),
      discoverModels: async (id, userId) => {
        discoveryCalls.push({ id, userId });
        await new Promise(resolve => {
          finishDiscovery = resolve;
        });
        return plugin.model_map;
      },
    },
    async () => {
      const activation = pluginService
        .activatePlugin(plugin.id, 'user-42')
        .then(result => {
          activationResolved = true;
          return result;
        });
      await Promise.resolve();
      assert.equal(activationResolved, false);
      finishDiscovery();
      assert.equal(await activation, true);
    }
  );

  assert.deepEqual(discoveryCalls, [
    { id: 'activation-provider', userId: 'user-42' },
  ]);
});

test('activation and discovery routes forward the authenticated user ID', async () => {
  const calls = [];
  const getRouteHandler = routePath => {
    const layer = pluginRoutes.stack.find(
      candidate => candidate.route?.path === routePath
    );
    assert.ok(layer, `Expected plugin route ${routePath}`);
    return layer.route.stack.at(-1).handle;
  };
  const invokeRoute = async (routePath, id) => {
    let statusCode = 200;
    let responseBody;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(body) {
        responseBody = body;
        return this;
      },
    };

    await getRouteHandler(routePath)(
      {
        params: { id },
        user: { userId: 'route-user-42' },
      },
      response
    );

    return { statusCode, responseBody };
  };

  await withPatchedProperties(
    pluginService,
    {
      activatePlugin: async (id, userId) => {
        calls.push({ operation: 'activate', id, userId });
        await Promise.resolve();
        return true;
      },
      getAllPlugins: userId => {
        calls.push({ operation: 'list', userId });
        return [{ ...createPlugin(), model_map: ['custom-model'] }];
      },
      discoverModels: async (id, userId) => {
        calls.push({ operation: 'discover', id, userId });
        return ['custom-model'];
      },
    },
    async () => {
      assert.deepEqual(await invokeRoute('/activate/:id', 'custom-provider'), {
        statusCode: 200,
        responseBody: {
          success: true,
          data: true,
        },
      });
      assert.deepEqual(await invokeRoute('/', undefined), {
        statusCode: 200,
        responseBody: {
          success: true,
          data: [{ ...createPlugin(), model_map: ['custom-model'] }],
        },
      });
      assert.deepEqual(await invokeRoute('/discover/:id', 'custom-provider'), {
        statusCode: 200,
        responseBody: {
          success: true,
          data: ['custom-model'],
        },
      });
    }
  );

  assert.deepEqual(calls, [
    {
      operation: 'activate',
      id: 'custom-provider',
      userId: 'route-user-42',
    },
    {
      operation: 'list',
      userId: 'route-user-42',
    },
    {
      operation: 'discover',
      id: 'custom-provider',
      userId: 'route-user-42',
    },
  ]);
});
