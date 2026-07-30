import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const imageServiceModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'pluginImageGenerationService.js'
    )
  ).href
);
const { PluginImageGenerationService, normalizeImageGenerationResponse } =
  imageServiceModule;
const { normalizeImageGenerationCount } = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'utils',
      'imageGenerationValidation.js'
    )
  ).href
);

function imagePlugin(id, endpoint, config = {}) {
  return {
    id,
    name: id,
    type: 'completion',
    endpoint: `https://example.com/${id}/v1/chat/completions`,
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: `${id.toUpperCase()}_API_KEY`,
    },
    model_map: ['chat-model'],
    capabilities: {
      image: {
        endpoint,
        model_map: ['shared-image-model'],
        config,
      },
    },
  };
}

function startServer(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

test('the bundled OpenAI provider declares GPT Image 2 and legacy compatibility', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'openai.json'), 'utf8')
  );

  assert.equal(
    manifest.capabilities.image.endpoint,
    'https://api.openai.com/v1/images/generations'
  );
  assert.deepEqual(manifest.capabilities.image.model_map, [
    'gpt-image-2',
    'gpt-image-1.5',
    'gpt-image-1',
    'gpt-image-1-mini',
  ]);
  assert.equal(
    manifest.capabilities.image.config.endpoint_variable,
    'image_endpoint'
  );
  assert.equal(
    manifest.capabilities.image.config.supports_response_format,
    false
  );
  assert.equal(
    manifest.variables.find(variable => variable.name === 'image_endpoint')
      ?.default,
    undefined
  );
});

test('image counts accept only JSON integers from 1 through 10', () => {
  assert.equal(normalizeImageGenerationCount(undefined), undefined);
  assert.equal(normalizeImageGenerationCount(1), 1);
  assert.equal(normalizeImageGenerationCount(10), 10);

  for (const invalid of [0, 11, 1.5, '1', '1.5', null, NaN]) {
    assert.throws(
      () => normalizeImageGenerationCount(invalid),
      /n must be an integer between 1 and 10/
    );
  }
});

test('image generation uses the selected provider and user-scoped OpenAI settings', async () => {
  const requests = [];
  const providerServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          {
            b64_json: 'aW1hZ2UtYnl0ZXM=',
            revised_prompt: 'A refined prompt',
          },
        ],
      })
    );
  });
  const providerPort = await startServer(providerServer);
  const imageEndpoint = `http://127.0.0.1:${providerPort}/v1/images/generations`;
  const plugins = [
    imagePlugin('wrong-provider', 'http://127.0.0.1:9/wrong'),
    imagePlugin('openai', 'https://api.openai.com/v1/images/generations', {
      endpoint_variable: 'image_endpoint',
      supports_response_format: false,
      default_size: '1024x1024',
      default_quality: 'auto',
    }),
  ];
  const keyLookups = [];
  const variableLookups = [];
  const service = new PluginImageGenerationService({
    getAllPlugins: () => plugins,
    getPlugin: id => plugins.find(plugin => plugin.id === id) || null,
    getApiKey: (plugin, userId) => {
      keyLookups.push({ pluginId: plugin.id, userId });
      return userId === 'user-42' ? 'user-openai-key' : null;
    },
    getPluginVariables: (plugin, userId) => {
      variableLookups.push({ pluginId: plugin.id, userId });
      return plugin.id === 'openai' ? { image_endpoint: imageEndpoint } : {};
    },
    validateEndpointUrl: endpoint =>
      endpoint === imageEndpoint ? endpoint : null,
  });

  try {
    const models = service.getAvailableImageGenModels('user-42');
    assert.deepEqual(
      models.map(({ model, plugin }) => ({ model, plugin })),
      [
        { model: 'shared-image-model', plugin: 'wrong-provider' },
        { model: 'shared-image-model', plugin: 'openai' },
      ]
    );

    const result = await service.executeImageGenRequest(
      'shared-image-model',
      'Draw a small lighthouse',
      {
        pluginId: 'openai',
        userId: 'user-42',
        size: '1024x1024',
        quality: 'high',
        response_format: 'url',
      }
    );

    assert.equal(result.pluginId, 'openai');
    assert.equal(result.images[0].b64_json, 'aW1hZ2UtYnl0ZXM=');
    assert.equal(result.images[0].revised_prompt, 'A refined prompt');
    assert.deepEqual(variableLookups, [
      { pluginId: 'openai', userId: 'user-42' },
    ]);
    assert.equal(keyLookups.at(-1)?.pluginId, 'openai');
    assert.equal(keyLookups.at(-1)?.userId, 'user-42');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/images/generations');
    assert.equal(requests[0].authorization, 'Bearer user-openai-key');
    assert.deepEqual(JSON.parse(requests[0].body), {
      model: 'shared-image-model',
      prompt: 'Draw a small lighthouse',
      size: '1024x1024',
      quality: 'high',
      n: 1,
    });
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }
});

test('an explicit image provider cannot fall through to a same-named plugin', async () => {
  const plugins = [
    imagePlugin('available-provider', 'https://example.com/images'),
  ];
  const service = new PluginImageGenerationService({
    getAllPlugins: () => plugins,
    getPlugin: id => plugins.find(plugin => plugin.id === id) || null,
    getApiKey: () => 'key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  await assert.rejects(
    service.executeImageGenRequest('shared-image-model', 'Draw a fox', {
      pluginId: 'missing-provider',
      userId: 'user-42',
    }),
    /No image generation plugin found.*missing-provider/
  );
});

test('image capability models take precedence without duplicating legacy image models', () => {
  const config = {
    default_size: '1024x1024',
    default_quality: 'standard',
  };
  const plugin = imagePlugin(
    'dual-image-provider',
    'https://example.com/v1/images/generations',
    config
  );
  plugin.type = 'image';
  plugin.model_map = ['shared-image-model', 'legacy-only-model'];

  const keyLookups = [];
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: (candidate, userId) => {
      keyLookups.push({ pluginId: candidate.id, userId });
      return 'key';
    },
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  assert.deepEqual(service.getAvailableImageGenModels('user-42'), [
    {
      model: 'shared-image-model',
      plugin: 'dual-image-provider',
      config,
    },
  ]);
  assert.deepEqual(keyLookups, [
    { pluginId: 'dual-image-provider', userId: 'user-42' },
  ]);
  assert.equal(
    service.getPluginForImageGen('shared-image-model', 'dual-image-provider'),
    plugin
  );
  assert.equal(
    service.getPluginForImageGen('legacy-only-model', 'dual-image-provider'),
    null
  );
});

test('invalid capability-specific image endpoint overrides fail closed', async () => {
  const plugin = imagePlugin(
    'openai',
    'https://api.openai.com/v1/images/generations',
    {
      endpoint_variable: 'image_endpoint',
      supports_response_format: false,
    }
  );
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => 'key',
    getPluginVariables: () => ({ image_endpoint: 'not a URL' }),
    validateEndpointUrl: () => null,
  });

  await assert.rejects(
    service.executeImageGenRequest('shared-image-model', 'Draw a fox', {
      pluginId: 'openai',
    }),
    /Invalid image endpoint override/
  );
});

test('image responses normalize raw and data-URL base64 payloads', () => {
  const rawBase64 = Buffer.from('raw image bytes').toString('base64');
  const dataUrlBase64 = Buffer.from('data URL image bytes').toString('base64');

  assert.deepEqual(
    normalizeImageGenerationResponse({
      data: [
        {
          b64_json: rawBase64,
          revised_prompt: 'Raw image prompt',
        },
        {
          url: `data:image/webp;base64,${dataUrlBase64}`,
          revised_prompt: 'Data URL image prompt',
        },
      ],
    }),
    [
      {
        b64_json: rawBase64,
        revised_prompt: 'Raw image prompt',
      },
      {
        b64_json: dataUrlBase64,
        revised_prompt: 'Data URL image prompt',
      },
    ]
  );
});

test('image responses accept only HTTP and HTTPS image URLs', () => {
  assert.deepEqual(
    normalizeImageGenerationResponse({
      images: [
        { url: 'https://cdn.example.com/generated/image.png?token=abc' },
        { url: 'http://localhost:8189/view?id=123' },
      ],
    }),
    [
      { url: 'https://cdn.example.com/generated/image.png?token=abc' },
      { url: 'http://localhost:8189/view?id=123' },
    ]
  );

  assert.deepEqual(
    normalizeImageGenerationResponse({
      url: 'https://cdn.example.com/single-image.png',
    }),
    [{ url: 'https://cdn.example.com/single-image.png' }]
  );
});

test('image responses filter unusable entries and reject malformed payloads', () => {
  assert.deepEqual(
    normalizeImageGenerationResponse([
      { b64_json: 'not-canonical-base64!' },
      { url: 'javascript:alert(1)' },
      { message: 'not an image' },
      { url: 'https://cdn.example.com/valid.png' },
    ]),
    [{ url: 'https://cdn.example.com/valid.png' }]
  );

  assert.throws(
    () =>
      normalizeImageGenerationResponse({
        data: [{ b64_json: 'aW1hZ2U' }],
      }),
    /no usable image data/
  );
  assert.throws(
    () =>
      normalizeImageGenerationResponse({
        images: [{ url: 'file:///tmp/generated.png' }],
      }),
    /no usable image data/
  );
  assert.throws(
    () =>
      normalizeImageGenerationResponse({
        result: { url: 'https://example.com/not-at-the-supported-level.png' },
      }),
    /no usable image data/
  );
});
