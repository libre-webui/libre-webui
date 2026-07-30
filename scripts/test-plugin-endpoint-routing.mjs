import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-plugin-endpoint-routing-')
);
process.env.PLUGINS_DIR = path.join(testDataDir, 'plugins');

const axios = (await import('axios')).default;
const pluginValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginValidation.js')).href
);
const pluginVariableValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginVariableValidation.js'))
    .href
);
const pluginService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
  )
).default;
const pluginRoutes = (
  await import(pathToFileURL(path.join(distRoot, 'routes', 'plugins.js')).href)
).default;
const { WorkModelProviderService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'workModelProviderService.js'))
    .href
);

after(() => {
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
      getPlugin: id => (id === plugin.id ? plugin : null),
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
            pluginService.executeImageGenRequest('image-model', 'A test image'),
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
      getPlugin: id => (id === plugin.id ? plugin : null),
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

test('activation preserves user context for background model discovery', async () => {
  const plugin = createPlugin({ id: 'activation-provider' });
  const discoveryCalls = [];

  await withPatchedProperties(
    pluginService,
    {
      getPlugin: id => (id === plugin.id ? plugin : null),
      discoverModels: async (id, userId) => {
        discoveryCalls.push({ id, userId });
        return plugin.model_map;
      },
    },
    async () => {
      assert.equal(pluginService.activatePlugin(plugin.id, 'user-42'), true);
      await Promise.resolve();
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
      activatePlugin: (id, userId) => {
        calls.push({ operation: 'activate', id, userId });
        return true;
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
      operation: 'discover',
      id: 'custom-provider',
      userId: 'route-user-42',
    },
  ]);
});
