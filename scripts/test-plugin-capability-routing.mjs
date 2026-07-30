import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
      res.writeHead(200, { 'Content-Type': 'image/png' });
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
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'user-hf-key',
    getPluginVariables: () => ({
      endpoint: `${origin}/must-not-receive-capability-requests`,
    }),
    validateEndpointUrl: endpoint => endpoint,
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
        { size: '768x512', userId: 'user-42' }
      ),
      {
        images: [{ b64_json: Buffer.from('image-bytes').toString('base64') }],
        model: 'black-forest-labs/FLUX.1-dev',
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
});
