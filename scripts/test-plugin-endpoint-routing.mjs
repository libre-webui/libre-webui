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
process.env.DATA_DIR = path.join(testDataDir, 'data');

const axios = (await import('axios')).default;
const pluginValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginValidation.js')).href
);
const pluginVariableValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginVariableValidation.js'))
    .href
);
const pluginServiceModule = await import(
  pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
);
const { default: pluginService, PluginService } = pluginServiceModule;
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
const imageGenRoutes = (
  await import(pathToFileURL(path.join(distRoot, 'routes', 'imageGen.js')).href)
).default;
const { WorkModelProviderService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'workModelProviderService.js'))
    .href
);

after(() => {
  databaseModule.closeDatabase();
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
  assert.ok(
    requests.every(request => request.config.maxRedirects === 0),
    'Chat and Work must not follow redirects to unvalidated destinations'
  );
});

test('Chat and Work streaming fail closed on redirects', async () => {
  const plugin = createPlugin({
    id: 'stream-redirect-provider',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'STREAM_REDIRECT_API_KEY',
    },
  });
  const endpoint = 'https://gateway.example.test/openai/v1/chat/completions';
  const requests = [];
  const streamResponse = () =>
    new Response(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: 'Streamed' } }],
      })}\n\ndata: [DONE]\n\n`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }
    );

  await withPatchedProperties(
    pluginService,
    {
      getActivePluginForModel: () => plugin,
      getPluginVariables: () => ({ endpoint }),
      getApiKey: () => 'stream-secret',
    },
    async () =>
      withPatchedProperties(
        globalThis,
        {
          fetch: async (requestEndpoint, config) => {
            requests.push({
              source: 'chat',
              endpoint: requestEndpoint,
              config,
            });
            return streamResponse();
          },
        },
        async () => {
          const chunks = [];
          for await (const chunk of pluginService.executePluginStreamRequest(
            'chat-model',
            [{ role: 'user', content: 'Hello' }],
            {},
            'user-42',
            plugin.id
          )) {
            chunks.push(chunk);
          }
          assert.ok(chunks.some(chunk => chunk.type === 'content'));
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
      getApiKey: () => 'stream-secret',
      getPluginVariables: () => ({ endpoint }),
    },
    post: async () => {
      throw new Error('Unexpected non-streaming Work request');
    },
  });

  await withPatchedProperties(
    globalThis,
    {
      fetch: async (requestEndpoint, config) => {
        requests.push({
          source: 'work',
          endpoint: requestEndpoint,
          config,
        });
        return streamResponse();
      },
    },
    async () => {
      const response = await workService.generateChatStreamResponse(
        {
          model: 'chat-model',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        },
        { providerType: 'plugin', providerId: plugin.id },
        'user-42',
        {}
      );
      assert.equal(response.message.content, 'Streamed');
    }
  );

  assert.deepEqual(
    requests.map(request => ({
      source: request.source,
      endpoint: request.endpoint,
      redirect: request.config.redirect,
      authorization: request.config.headers.Authorization,
    })),
    [
      {
        source: 'chat',
        endpoint,
        redirect: 'error',
        authorization: 'Bearer stream-secret',
      },
      {
        source: 'work',
        endpoint,
        redirect: 'error',
        authorization: 'Bearer stream-secret',
      },
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
          assert.equal(
            requests[0].config.maxRedirects,
            0,
            'discovery must not forward provider credentials across redirects'
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
    })
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
    /not supported/
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
});

test('embedding and TTS requests reject redirects before a credential-bearing hop', async () => {
  const plugin = createPlugin({ id: 'capability-redirect-provider' });
  plugin.capabilities.embedding.endpoint =
    'https://gateway.example.test/v1/embeddings';
  plugin.capabilities.tts.endpoint =
    'https://gateway.example.test/v1/audio/speech';
  const requests = [];

  await withPatchedProperties(
    pluginService,
    {
      getAllPlugins: () => [plugin],
      getPlugin: id => (id === plugin.id ? plugin : null),
      getPluginVariables: () => ({}),
      getApiKey: () => null,
    },
    async () =>
      withPatchedProperties(
        axios,
        {
          post: async (endpoint, payload, config) => {
            requests.push({ endpoint, payload, config });
            if (endpoint.endsWith('/embeddings')) {
              return { data: { data: [{ embedding: [0.1, 0.2] }] } };
            }
            if (endpoint.endsWith('/audio/speech')) {
              return { data: Buffer.from('RIFFtest-audio') };
            }
            throw new Error(`Unexpected capability endpoint: ${endpoint}`);
          },
        },
        async () => {
          assert.deepEqual(
            await pluginService.executeEmbeddingRequest(
              'embedding-model',
              'Hello',
              plugin.id,
              'user-42'
            ),
            { embeddings: [[0.1, 0.2]] }
          );
          const audio = await pluginService.executeTTSRequest(
            'tts-model',
            'Hello',
            {
              pluginId: plugin.id,
              userId: 'user-42',
            }
          );
          assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
        }
      )
  );

  assert.equal(requests.length, 2);
  assert.ok(
    requests.every(request => request.config.maxRedirects === 0),
    'embedding and TTS credentials must never be forwarded through redirects'
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
  assert.equal(request.config.maxRedirects, 0);
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
