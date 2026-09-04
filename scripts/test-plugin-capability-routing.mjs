import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const [
  { PluginEmbeddingService },
  { PluginImageGenerationService },
  { PluginTTSService },
] = await Promise.all([
  import(
    pathToFileURL(
      path.join(
        repoRoot,
        'backend',
        'dist',
        'services',
        'pluginEmbeddingService.js'
      )
    ).href
  ),
  import(
    pathToFileURL(
      path.join(
        repoRoot,
        'backend',
        'dist',
        'services',
        'pluginImageGenerationService.js'
      )
    ).href
  ),
  import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'pluginTTSService.js')
    ).href
  ),
]);
const coordinationModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'platform',
      'coordination',
      'service.js'
    )
  ).href
);
await coordinationModule.initializeCoordinator();
after(() => coordinationModule.closeCoordinator());

function startServer(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

function readBundledPlugin(name) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', `${name}.json`), 'utf8')
  );
}

/**
 * Outbound provider calls go through providerRequest, which refuses a 3xx by
 * default. A call may say so explicitly, but it must never opt into following
 * one: a redirect would carry the provider credential to another host.
 */
function assertProviderRequestsRefuseRedirects(source, filename) {
  const sourceFile = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const calls = [];
  const visit = node => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'providerRequest' &&
      node.arguments.length > 0 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      calls.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assert.ok(calls.length > 0, `${filename} must make provider requests`);

  for (const options of calls) {
    const redirect = options.properties.find(
      property =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(sourceFile) === 'redirect'
    );
    if (!redirect) continue;
    assert.equal(
      redirect.initializer.getText(sourceFile),
      "'error'",
      `${filename} provider request must not follow redirects`
    );
  }
}

test('bundled capability manifests use current and isolated endpoints', () => {
  const github = readBundledPlugin('github');
  const githubEndpointVariable = github.variables.find(
    variable => variable.name === 'endpoint'
  );
  assert.equal(
    github.endpoint,
    'https://models.github.ai/inference/chat/completions'
  );
  assert.equal(githubEndpointVariable.default, undefined);

  const huggingface = readBundledPlugin('huggingface');
  assert.equal(huggingface.capabilities.embeddings, undefined);
  assert.ok(huggingface.capabilities.embedding);
  assert.equal(
    huggingface.capabilities.embedding.config.endpoint_variable,
    'embedding_endpoint'
  );
  assert.equal(
    huggingface.capabilities.image.config.endpoint_variable,
    'image_endpoint'
  );
  assert.equal(
    huggingface.capabilities.tts.config.endpoint_variable,
    'tts_endpoint'
  );
  for (const capability of ['embedding', 'image', 'tts']) {
    assert.match(
      huggingface.capabilities[capability].endpoint,
      /\/hf-inference\/models\/\{model\}$/
    );
  }
});

test('Hugging Face capabilities ignore the generic Chat endpoint and use task payloads', async () => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body,
    });

    if (req.url?.startsWith('/embedding/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([0.25, 0.75]));
      return;
    }
    if (req.url?.startsWith('/tts/')) {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from('audio-bytes'));
      return;
    }
    if (req.url?.startsWith('/image/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg; charset=binary' });
      res.end(Buffer.from('image-bytes'));
      return;
    }
    res.writeHead(500);
    res.end();
  });
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  const plugin = {
    id: 'huggingface',
    name: 'Hugging Face',
    active: true,
    type: 'completion',
    endpoint: `${origin}/chat/completions`,
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'HF_TOKEN',
    },
    model_map: ['chat-model'],
    capabilities: {
      embedding: {
        endpoint: `${origin}/embedding/{model}`,
        model_map: ['sentence-transformers/all-MiniLM-L6-v2'],
        config: { endpoint_variable: 'embedding_endpoint' },
      },
      tts: {
        endpoint: `${origin}/tts/{model}`,
        model_map: ['facebook/mms-tts-eng'],
        config: {
          endpoint_variable: 'tts_endpoint',
          default_voice: 'default',
          default_format: 'wav',
        },
      },
      image: {
        endpoint: `${origin}/image/{model}`,
        model_map: ['black-forest-labs/FLUX.1-dev'],
        config: {
          endpoint_variable: 'image_endpoint',
          default_size: '768x512',
        },
      },
    },
  };
  const dependencies = {
    usageEvents: [],
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'user-hf-key',
    getPluginVariables: () => ({
      endpoint: `${origin}/must-not-receive-capability-requests`,
    }),
    validateEndpointUrl: endpoint => endpoint,
    recordUsage(usage) {
      this.usageEvents.push(usage);
    },
  };
  const embeddings = new PluginEmbeddingService(dependencies);
  const tts = new PluginTTSService(dependencies);
  const images = new PluginImageGenerationService(dependencies);

  try {
    assert.deepEqual(
      await embeddings.executeEmbeddingRequest(
        'sentence-transformers/all-MiniLM-L6-v2',
        'hello',
        'huggingface',
        'user-42'
      ),
      { embeddings: [[0.25, 0.75]] }
    );
    assert.equal(
      (
        await tts.executeTTSRequest('facebook/mms-tts-eng', 'hello', {
          pluginId: 'huggingface',
          userId: 'user-42',
        })
      ).toString(),
      'audio-bytes'
    );
    assert.deepEqual(
      await images.executeImageGenRequest(
        'black-forest-labs/FLUX.1-dev',
        'a lighthouse',
        {
          size: '768x512',
          pluginId: 'huggingface',
          userId: 'user-42',
        }
      ),
      {
        images: [
          {
            b64_json: Buffer.from('image-bytes').toString('base64'),
            mime_type: 'image/jpeg',
          },
        ],
        model: 'black-forest-labs/FLUX.1-dev',
        pluginId: 'huggingface',
      }
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  assert.deepEqual(
    requests.map(request => request.url),
    [
      '/embedding/sentence-transformers/all-MiniLM-L6-v2',
      '/tts/facebook/mms-tts-eng',
      '/image/black-forest-labs/FLUX.1-dev',
    ]
  );
  assert.ok(
    requests.every(request => request.authorization === 'Bearer user-hf-key')
  );
  assert.deepEqual(JSON.parse(requests[0].body.toString()), {
    inputs: 'hello',
  });
  assert.deepEqual(JSON.parse(requests[1].body.toString()), {
    inputs: 'hello',
  });
  assert.deepEqual(JSON.parse(requests[2].body.toString()), {
    inputs: 'a lighthouse',
    parameters: { width: 768, height: 512 },
  });
  assert.deepEqual(
    dependencies.usageEvents.map(usage => ({
      capability: usage.capability,
      pluginId: usage.pluginId,
      model: usage.model,
      status: usage.status,
      inputUnits: usage.inputUnits,
      outputUnits: usage.outputUnits,
    })),
    [
      {
        capability: 'embedding',
        pluginId: 'huggingface',
        model: 'sentence-transformers/all-MiniLM-L6-v2',
        status: 'success',
        inputUnits: 1,
        outputUnits: undefined,
      },
      {
        capability: 'tts',
        pluginId: 'huggingface',
        model: 'facebook/mms-tts-eng',
        status: 'success',
        inputUnits: 5,
        outputUnits: undefined,
      },
      {
        capability: 'image',
        pluginId: 'huggingface',
        model: 'black-forest-labs/FLUX.1-dev',
        status: 'success',
        inputUnits: undefined,
        outputUnits: 1,
      },
    ]
  );
});

test('capability requests reject redirects without reaching the target', async () => {
  let redirectRequests = 0;
  let targetRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/target')) {
      targetRequests += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }

    redirectRequests += 1;
    res.writeHead(302, { Location: '/target' });
    res.end();
  });
  const port = await startServer(server);
  const origin = `http://127.0.0.1:${port}`;
  const plugin = {
    id: 'redirect-test',
    name: 'Redirect test',
    active: true,
    type: 'completion',
    endpoint: `${origin}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ' },
    model_map: ['chat-model'],
    capabilities: {
      embedding: {
        endpoint: `${origin}/redirect/embedding`,
        model_map: ['embedding-model'],
      },
      tts: {
        endpoint: `${origin}/redirect/tts`,
        model_map: ['tts-model'],
      },
      image: {
        endpoint: `${origin}/redirect/image`,
        model_map: ['image-model'],
      },
    },
  };
  const dependencies = {
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'redirect-test-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  };

  try {
    const results = await Promise.allSettled([
      new PluginEmbeddingService(dependencies).executeEmbeddingRequest(
        'embedding-model',
        'hello',
        plugin.id,
        'user-42'
      ),
      new PluginTTSService(dependencies).executeTTSRequest(
        'tts-model',
        'hello',
        { pluginId: plugin.id, userId: 'user-42' }
      ),
      new PluginImageGenerationService(dependencies).executeImageGenRequest(
        'image-model',
        'hello',
        { pluginId: plugin.id, userId: 'user-42' }
      ),
    ]);
    assert.ok(results.every(result => result.status === 'rejected'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  assert.equal(redirectRequests, 3);
  assert.equal(targetRequests, 0);
});

test('chat, Work, discovery, and generated media clients disable redirects', () => {
  const pluginServiceSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'services', 'pluginService.ts'),
    'utf8'
  );
  const workServiceSource = fs.readFileSync(
    path.join(
      repoRoot,
      'backend',
      'src',
      'services',
      'workModelProviderService.ts'
    ),
    'utf8'
  );
  const imageServiceSource = fs.readFileSync(
    path.join(
      repoRoot,
      'backend',
      'src',
      'services',
      'pluginImageGenerationService.ts'
    ),
    'utf8'
  );
  const videoServiceSource = fs.readFileSync(
    path.join(
      repoRoot,
      'backend',
      'src',
      'services',
      'pluginVideoGenerationService.ts'
    ),
    'utf8'
  );
  const audioServiceSource = fs.readFileSync(
    path.join(
      repoRoot,
      'backend',
      'src',
      'services',
      'pluginAudioGenerationService.ts'
    ),
    'utf8'
  );

  assertProviderRequestsRefuseRedirects(
    pluginServiceSource,
    'pluginService.ts'
  );
  assert.match(
    pluginServiceSource,
    /fetch\(processedEndpoint,[\s\S]*?redirect: 'error'/
  );
  assert.match(
    workServiceSource,
    /const defaultProviderPost[\s\S]*?providerRequest\(\{[\s\S]*?redirect: 'error',/,
    'the Work provider post seam must refuse redirects'
  );
  assert.match(workServiceSource, /fetch\(endpoint,[\s\S]*?redirect: 'error'/);
  assertProviderRequestsRefuseRedirects(
    workServiceSource,
    'workModelProviderService.ts'
  );
  assertProviderRequestsRefuseRedirects(
    imageServiceSource,
    'pluginImageGenerationService.ts'
  );
  assertProviderRequestsRefuseRedirects(
    audioServiceSource,
    'pluginAudioGenerationService.ts'
  );
  assertProviderRequestsRefuseRedirects(
    videoServiceSource,
    'pluginVideoGenerationService.ts'
  );
});
