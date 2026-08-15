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
const { normalizeImageGenerationCount, normalizeImageMediaType } = await import(
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
    active: true,
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

test('image media types preserve safe raster formats and reject active content', () => {
  assert.equal(
    normalizeImageMediaType(' IMAGE/WEBP; charset=binary '),
    'image/webp'
  );
  assert.equal(normalizeImageMediaType('image/jpg'), 'image/jpeg');
  assert.equal(normalizeImageMediaType('image/x-png'), 'image/png');
  assert.equal(normalizeImageMediaType('image/svg+xml'), undefined);
  assert.equal(normalizeImageMediaType('text/html'), undefined);
});

test('image counts respect each provider capability', async () => {
  const createService = config => {
    const plugin = imagePlugin(
      'count-provider',
      'https://example.com/images',
      config
    );
    return new PluginImageGenerationService({
      getAllPlugins: () => [plugin],
      getPlugin: () => plugin,
      getApiKey: () => 'key',
      getPluginVariables: () => ({}),
      validateEndpointUrl: endpoint => endpoint,
    });
  };

  await assert.rejects(
    createService({ supports_n: false }).executeImageGenRequest(
      'shared-image-model',
      'Draw two images',
      { pluginId: 'count-provider', n: 2 }
    ),
    /supports only one image/
  );
  await assert.rejects(
    createService({ supports_n: true, max_n: 2 }).executeImageGenRequest(
      'shared-image-model',
      'Draw three images',
      { pluginId: 'count-provider', n: 3 }
    ),
    /exceeds maximum of 2/
  );
});

test('inactive image providers are excluded from selection and generation', async () => {
  const inactive = {
    ...imagePlugin('inactive-provider', 'https://example.com/images'),
    active: false,
  };
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [inactive],
    getPlugin: () => inactive,
    getApiKey: () => 'unused-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  assert.deepEqual(await service.getAvailableImageGenModels('user-42'), []);
  await assert.rejects(
    service.executeImageGenRequest(
      'shared-image-model',
      'Do not generate this image',
      { pluginId: inactive.id, userId: 'user-42' }
    ),
    /No image generation plugin found/
  );
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
    const models = await service.getAvailableImageGenModels('user-42');
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

test('third-party multi-capability plugins default to the image_endpoint selector', async () => {
  const requests = [];
  const providerServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { b64_json: Buffer.from('third-party-image').toString('base64') },
        ],
      })
    );
  });
  const providerPort = await startServer(providerServer);
  const origin = `http://127.0.0.1:${providerPort}`;
  const plugin = imagePlugin(
    'third-party-provider',
    `${origin}/manifest-images`,
    { supports_response_format: false }
  );
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'third-party-key',
    getPluginVariables: () => ({
      endpoint: `${origin}/must-not-receive-images`,
      image_endpoint: `${origin}/custom-images`,
    }),
    validateEndpointUrl: endpoint => endpoint,
  });

  try {
    const result = await service.executeImageGenRequest(
      'shared-image-model',
      'Draw a third-party image',
      { pluginId: plugin.id, userId: 'third-party-user' }
    );

    assert.equal(result.pluginId, plugin.id);
    assert.equal(
      result.images[0].b64_json,
      Buffer.from('third-party-image').toString('base64')
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/custom-images');
    assert.equal(JSON.parse(requests[0].body).model, 'shared-image-model');
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }
});

test('generic image endpoints containing /prompt keep OpenAI-compatible routing', async () => {
  const requests = [];
  const providerServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      authorization: req.headers.authorization,
      method: req.method,
      url: req.url,
      body: JSON.parse(body),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          {
            b64_json: Buffer.from('generic-prompt-image').toString('base64'),
          },
        ],
      })
    );
  });
  const providerPort = await startServer(providerServer);
  const origin = `http://127.0.0.1:${providerPort}`;
  const plugin = imagePlugin('generic-prompt-provider', `${origin}/v1/prompt`, {
    supports_response_format: false,
  });
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'generic-prompt-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  try {
    const result = await service.executeImageGenRequest(
      'shared-image-model',
      'Draw through a generic prompt endpoint',
      { pluginId: plugin.id, userId: 'generic-prompt-user' }
    );

    assert.equal(
      result.images[0].b64_json,
      Buffer.from('generic-prompt-image').toString('base64')
    );
    assert.equal(result.pluginId, plugin.id);
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].url, '/v1/prompt');
  assert.equal(requests[0].authorization, 'Bearer generic-prompt-key');
  assert.equal(requests[0].body.model, 'shared-image-model');
  assert.equal(
    requests[0].body.prompt,
    'Draw through a generic prompt endpoint'
  );
  assert.equal(
    typeof requests[0].body.prompt,
    'string',
    'generic /prompt endpoints must not receive a ComfyUI workflow'
  );
});

test('ComfyUI preserves endpoint prefixes and authenticates every request', async () => {
  const requests = [];
  const imageBytes = Buffer.from('authenticated-comfy-image');
  const providerServer = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    }
    requests.push({
      authorization: req.headers.authorization,
      method: req.method,
      pathname: requestUrl.pathname,
      searchParams: Object.fromEntries(requestUrl.searchParams),
      body,
    });

    if (
      req.method === 'POST' &&
      requestUrl.pathname === '/tenant/comfy/prompt'
    ) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: body.prompt_id }));
      return;
    }

    if (
      req.method === 'GET' &&
      requestUrl.pathname.startsWith('/tenant/comfy/history/')
    ) {
      const promptId = decodeURIComponent(
        requestUrl.pathname.slice('/tenant/comfy/history/'.length)
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          [promptId]: {
            outputs: {
              9: {
                images: [
                  {
                    filename: 'result image.png',
                    subfolder: 'nested outputs',
                    type: 'output',
                  },
                ],
              },
            },
          },
        })
      );
      return;
    }

    if (req.method === 'GET' && requestUrl.pathname === '/tenant/comfy/view') {
      res.writeHead(200, { 'Content-Type': 'image/webp; charset=binary' });
      res.end(imageBytes);
      return;
    }

    res.writeHead(404);
    res.end();
  });
  const providerPort = await startServer(providerServer);
  const origin = `http://127.0.0.1:${providerPort}`;
  const plugin = imagePlugin('comfyui', `${origin}/tenant/comfy/prompt`, {
    supports_response_format: false,
  });
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'comfy-proxy-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  try {
    const result = await service.executeImageGenRequest(
      'shared-image-model',
      'Draw behind an authenticated ComfyUI proxy',
      { pluginId: plugin.id, userId: 'comfy-user' }
    );

    assert.equal(result.images[0].b64_json, imageBytes.toString('base64'));
    assert.equal(result.images[0].mime_type, 'image/webp');
    assert.equal(result.pluginId, plugin.id);
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }

  assert.deepEqual(
    requests.map(request => [
      request.method,
      request.pathname.replace(/\/history\/[^/]+$/, '/history/:promptId'),
    ]),
    [
      ['POST', '/tenant/comfy/prompt'],
      ['GET', '/tenant/comfy/history/:promptId'],
      ['GET', '/tenant/comfy/view'],
    ]
  );
  assert.match(requests[0].body.prompt_id, /^[0-9a-f-]{36}$/);
  assert.ok(
    requests.every(
      request => request.authorization === 'Bearer comfy-proxy-key'
    ),
    'ComfyUI auth must be sent to prompt, history, and image endpoints'
  );
  assert.deepEqual(requests[2].searchParams, {
    filename: 'result image.png',
    subfolder: 'nested outputs',
    type: 'output',
  });
});

test('ComfyUI abort cancels only its accepted prompt and awaits teardown', async () => {
  const requests = [];
  const accepted = Promise.withResolvers();
  let promptId;
  let jobCancellationFinished = false;
  let queueDeletionFinished = false;
  const providerServer = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : undefined;
    requests.push({ method: req.method, pathname: requestUrl.pathname, body });

    if (req.method === 'POST' && requestUrl.pathname === '/comfy/prompt') {
      promptId = body.prompt_id;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: promptId }));
      accepted.resolve();
      return;
    }
    if (
      req.method === 'POST' &&
      requestUrl.pathname ===
        `/comfy/api/jobs/${encodeURIComponent(promptId)}/cancel`
    ) {
      await new Promise(resolve => setTimeout(resolve, 80));
      jobCancellationFinished = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cancelled: true }));
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/comfy/queue') {
      await new Promise(resolve => setTimeout(resolve, 120));
      queueDeletionFinished = true;
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const providerPort = await startServer(providerServer);
  const plugin = imagePlugin(
    'comfyui',
    `http://127.0.0.1:${providerPort}/comfy/prompt`,
    { supports_response_format: false }
  );
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });
  const controller = new AbortController();

  try {
    const generation = service.executeImageGenRequest(
      'shared-image-model',
      'Cancel this exact workflow',
      {
        pluginId: plugin.id,
        userId: 'comfy-user',
        signal: controller.signal,
      }
    );
    await accepted.promise;
    controller.abort(new Error('client stopped image generation'));
    await assert.rejects(generation, /client stopped image generation/);
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }

  assert.equal(jobCancellationFinished, true);
  assert.equal(queueDeletionFinished, true);
  assert.deepEqual(
    requests.find(request => request.pathname === '/comfy/queue').body,
    { delete: [promptId] }
  );
  assert.equal(
    requests.some(request => request.pathname === '/comfy/interrupt'),
    false,
    'cancellation must never use the unrelated-job global interrupt path'
  );
});

test('ComfyUI cancels an accepted prompt before its submit response arrives', async () => {
  const requests = [];
  const accepted = Promise.withResolvers();
  const releaseResponse = Promise.withResolvers();
  let promptId;
  const providerServer = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : undefined;
    requests.push({ pathname: requestUrl.pathname, body });
    if (requestUrl.pathname === '/comfy/prompt') {
      promptId = body.prompt_id;
      accepted.resolve();
      await releaseResponse.promise;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: promptId }));
      return;
    }
    if (requestUrl.pathname === `/comfy/api/jobs/${promptId}/cancel`) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cancelled: true }));
      return;
    }
    if (requestUrl.pathname === '/comfy/queue') {
      res.writeHead(200);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const providerPort = await startServer(providerServer);
  const plugin = imagePlugin(
    'comfyui',
    `http://127.0.0.1:${providerPort}/comfy/prompt`,
    { supports_response_format: false }
  );
  const service = new PluginImageGenerationService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => 'key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });
  const controller = new AbortController();

  try {
    const generation = service.executeImageGenRequest(
      'shared-image-model',
      'Abort between acceptance and acknowledgement',
      { pluginId: plugin.id, userId: 'user', signal: controller.signal }
    );
    await accepted.promise;
    controller.abort(new Error('client disconnected before acknowledgement'));
    await assert.rejects(
      generation,
      /client disconnected before acknowledgement/
    );
  } finally {
    releaseResponse.resolve();
    await new Promise(resolve => providerServer.close(resolve));
  }

  assert.ok(promptId);
  assert.ok(
    requests.some(
      request => request.pathname === `/comfy/api/jobs/${promptId}/cancel`
    )
  );
  assert.deepEqual(
    requests.find(request => request.pathname === '/comfy/queue').body,
    { delete: [promptId] }
  );
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

test('image capability models take precedence without duplicating legacy image models', async () => {
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

  assert.deepEqual(await service.getAvailableImageGenModels('user-42'), [
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
    await service.getPluginForImageGen(
      'shared-image-model',
      'dual-image-provider'
    ),
    plugin
  );
  assert.equal(
    await service.getPluginForImageGen(
      'legacy-only-model',
      'dual-image-provider'
    ),
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
  const typedBase64 = Buffer.from('typed image bytes').toString('base64');
  const unsafeBase64 = Buffer.from('unsafe image bytes').toString('base64');

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
        {
          b64_json: typedBase64,
          mime_type: 'IMAGE/JPEG; charset=binary',
          revised_prompt: 'Typed image prompt',
        },
        {
          b64_json: unsafeBase64,
          mime_type: 'image/svg+xml',
          revised_prompt: 'Unsafe image prompt',
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
        mime_type: 'image/webp',
        revised_prompt: 'Data URL image prompt',
      },
      {
        b64_json: typedBase64,
        mime_type: 'image/jpeg',
        revised_prompt: 'Typed image prompt',
      },
      {
        b64_json: unsafeBase64,
        revised_prompt: 'Unsafe image prompt',
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
