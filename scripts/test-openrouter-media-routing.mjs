import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'openrouter-media-routing-test-secret';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-media-routing-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.PLUGINS_DIR = path.join(testRoot, 'plugins');
fs.mkdirSync(process.env.PLUGINS_DIR, { recursive: true });

const { PluginImageGenerationService } = await import(
  pathToFileURL(
    path.join(distRoot, 'services', 'pluginImageGenerationService.js')
  ).href
);
const { PluginAudioGenerationService } = await import(
  pathToFileURL(
    path.join(distRoot, 'services', 'pluginAudioGenerationService.js')
  ).href
);
const { PluginTTSService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'pluginTTSService.js')).href
);
const { PluginVideoGenerationService } = await import(
  pathToFileURL(
    path.join(distRoot, 'services', 'pluginVideoGenerationService.js')
  ).href
);
const { PluginService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
);
const galleryService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'galleryService.js')).href
  )
).default;
const databaseModule = await import(
  pathToFileURL(path.join(distRoot, 'db.js')).href
);

after(() => {
  databaseModule.closeDatabase();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

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

function dependencies(plugin) {
  return {
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'test-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
    recordUsage: () => {},
  };
}

test('bundled OpenRouter manifest maps all generated media APIs', () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'openrouter.json'), 'utf8')
  );
  assert.equal(
    plugin.capabilities.image.endpoint,
    'https://openrouter.ai/api/v1/images'
  );
  assert.equal(
    plugin.capabilities.image.models_endpoint,
    'https://openrouter.ai/api/v1/images/models'
  );
  assert.equal(plugin.capabilities.image.config.size_parameter, 'aspect_ratio');
  assert.equal(
    plugin.capabilities.image.config.supports_response_format,
    false
  );
  assert.equal(
    plugin.capabilities.tts.endpoint,
    'https://openrouter.ai/api/v1/audio/speech'
  );
  assert.match(
    plugin.capabilities.tts.models_endpoint,
    /output_modalities=speech/
  );
  assert.equal(
    plugin.capabilities.audio.endpoint,
    'https://openrouter.ai/api/v1/chat/completions'
  );
  assert.match(
    plugin.capabilities.audio.models_endpoint,
    /output_modalities=audio/
  );
  assert.equal(
    plugin.capabilities.video.endpoint,
    'https://openrouter.ai/api/v1/videos'
  );
  assert.equal(
    plugin.capabilities.video.models_endpoint,
    'https://openrouter.ai/api/v1/videos/models'
  );
});

test('OpenRouter audio-output models stream generated sound bytes', async () => {
  const app = express();
  app.use(express.json());
  let received;
  const encoded = Buffer.from('sound-bytes').toString('base64');
  app.post('/chat/completions', (req, res) => {
    received = req.body;
    res.set('Content-Type', 'text/event-stream');
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: encoded.slice(0, 8), transcript: 'A ' } } }] })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: encoded.slice(8), transcript: 'sound' } } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`
    );
    res.end('data: [DONE]\n\n');
  });
  const server = await listen(app);
  const plugin = {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      audio: {
        endpoint: `${server.baseUrl}/chat/completions`,
        model_map: ['audio-model'],
        config: {
          default_voice: 'alloy',
          formats: ['wav'],
          default_format: 'wav',
        },
      },
    },
  };
  try {
    const service = new PluginAudioGenerationService(dependencies(plugin));
    const result = await service.generate('audio-model', 'A warm synth chord', {
      pluginId: 'openrouter',
      userId: 'user',
    });
    assert.deepEqual(received, {
      model: 'audio-model',
      messages: [{ role: 'user', content: 'A warm synth chord' }],
      modalities: ['text', 'audio'],
      audio: { voice: 'alloy', format: 'wav' },
      stream: true,
    });
    assert.equal(result.audio.toString(), 'sound-bytes');
    assert.equal(result.mimeType, 'audio/wav');
    assert.equal(result.transcript, 'A sound');
  } finally {
    await server.close();
  }
});

test('image generation maps the UI size to OpenRouter aspect_ratio and normalizes media_type', async () => {
  const app = express();
  app.use(express.json());
  let received;
  app.post('/images', (req, res) => {
    received = req.body;
    res.json({ data: [{ b64_json: 'aGVsbG8=', media_type: 'image/webp' }] });
  });
  const server = await listen(app);
  const plugin = {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      image: {
        endpoint: `${server.baseUrl}/images`,
        model_map: ['image-model'],
        config: {
          sizes: ['1:1', '16:9'],
          default_size: '1:1',
          size_parameter: 'aspect_ratio',
          supports_n: false,
          supports_response_format: false,
          omit_quality_when_empty: true,
        },
      },
    },
  };
  try {
    const service = new PluginImageGenerationService(dependencies(plugin));
    const result = await service.executeImageGenRequest(
      'image-model',
      'hello',
      {
        pluginId: 'openrouter',
        size: '16:9',
        quality: 'standard',
        response_format: 'url',
        userId: 'user',
      }
    );
    assert.equal(received.aspect_ratio, '16:9');
    assert.equal(received.size, undefined);
    assert.equal(received.quality, undefined);
    assert.equal(received.response_format, undefined);
    assert.equal(received.n, undefined);
    assert.deepEqual(result.images, [
      { b64_json: 'aGVsbG8=', mime_type: 'image/webp' },
    ]);
  } finally {
    await server.close();
  }
});

test('OpenRouter-compatible speech returns raw audio bytes', async () => {
  const app = express();
  app.use(express.json());
  let received;
  app.post('/audio/speech', (req, res) => {
    received = req.body;
    res.type('audio/mpeg').send(Buffer.from('audio-bytes'));
  });
  const server = await listen(app);
  const plugin = {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      tts: {
        endpoint: `${server.baseUrl}/audio/speech`,
        model_map: ['speech-model'],
        config: { default_voice: 'alloy', default_format: 'mp3' },
      },
    },
  };
  try {
    const service = new PluginTTSService(dependencies(plugin));
    const audio = await service.executeTTSRequest('speech-model', 'Speak', {
      pluginId: 'openrouter',
      userId: 'user',
    });
    assert.equal(audio.toString(), 'audio-bytes');
    assert.deepEqual(received, {
      model: 'speech-model',
      input: 'Speak',
      voice: 'alloy',
      response_format: 'mp3',
      speed: 1,
    });
  } finally {
    await server.close();
  }
});

test('video generation submits, polls, and downloads through the provider endpoint', async () => {
  const app = express();
  app.use(express.json());
  app.post('/videos', (_req, res) =>
    res.status(202).json({ id: 'job-1', status: 'pending' })
  );
  app.get('/videos/job-1', (_req, res) =>
    res.json({ id: 'job-1', status: 'completed', usage: { cost: 0.5 } })
  );
  app.get('/videos/job-1/content', (_req, res) =>
    res.type('video/mp4').send(Buffer.from('video-bytes'))
  );
  const server = await listen(app);
  const plugin = {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      video: {
        endpoint: `${server.baseUrl}/videos`,
        model_map: ['video-model'],
        config: {},
      },
    },
  };
  try {
    const service = new PluginVideoGenerationService(dependencies(plugin));
    const submitted = await service.submit('video-model', 'A moving scene', {
      pluginId: 'openrouter',
      userId: 'user',
    });
    assert.equal(submitted.providerJobId, 'job-1');
    const status = await service.poll(
      'video-model',
      'job-1',
      'openrouter',
      'user'
    );
    assert.equal(status.status, 'completed');
    assert.equal(status.usage.cost, 0.5);
    const downloaded = await service.download(
      'video-model',
      'job-1',
      'openrouter',
      'user'
    );
    assert.equal(downloaded.mimeType, 'video/mp4');
    assert.equal(downloaded.video.toString(), 'video-bytes');
  } finally {
    await server.close();
  }
});

test('capability discovery keeps live image, speech, sound, and video catalogs separate', async () => {
  databaseModule.getDatabase();
  const app = express();
  const catalogs = {
    '/v1/models': ['chat-live'],
    '/images/models': ['image-live-a', 'image-live-b'],
    '/speech/models': ['speech-live'],
    '/audio/models': ['audio-live'],
    '/videos/models': ['video-live'],
  };
  for (const [route, models] of Object.entries(catalogs)) {
    app.get(route, (_req, res) =>
      res.json({ data: models.map(id => ({ id })) })
    );
  }
  const server = await listen(app);
  const service = new PluginService();
  const pluginId = 'media-discovery-test';
  try {
    service.installPlugin(
      {
        id: pluginId,
        name: 'Media discovery test',
        type: 'completion',
        endpoint: `${server.baseUrl}/v1/chat/completions`,
        auth: { header: '', key_env: '' },
        model_map: ['chat-stale'],
        capabilities: {
          image: {
            endpoint: `${server.baseUrl}/images`,
            models_endpoint: `${server.baseUrl}/images/models`,
            model_map: ['image-stale'],
          },
          tts: {
            endpoint: `${server.baseUrl}/speech`,
            models_endpoint: `${server.baseUrl}/speech/models`,
            model_map: ['speech-stale'],
          },
          audio: {
            endpoint: `${server.baseUrl}/chat/completions`,
            models_endpoint: `${server.baseUrl}/audio/models`,
            model_map: ['audio-stale'],
          },
          video: {
            endpoint: `${server.baseUrl}/videos`,
            models_endpoint: `${server.baseUrl}/videos/models`,
            model_map: ['video-stale'],
          },
        },
      },
      'default'
    );
    await service.activatePlugin(pluginId, 'default');
    const plugin = service.getPlugin(pluginId, 'default');
    assert.deepEqual(plugin.model_map, ['chat-live']);
    assert.deepEqual(plugin.capabilities.image.model_map, [
      'image-live-a',
      'image-live-b',
    ]);
    assert.deepEqual(plugin.capabilities.tts.model_map, ['speech-live']);
    assert.deepEqual(plugin.capabilities.audio.model_map, ['audio-live']);
    assert.deepEqual(plugin.capabilities.video.model_map, ['video-live']);
  } finally {
    service.deletePlugin(pluginId);
    await server.close();
  }
});

test('Imagine gallery isolates media by user and kind', () => {
  databaseModule.getDatabase();
  const first = galleryService.saveMedia('default', {
    kind: 'audio',
    prompt: 'hello',
    model: 'speech-model',
    pluginId: 'openrouter',
    mediaData: 'data:audio/mpeg;base64,YXVkaW8=',
    mimeType: 'audio/mpeg',
  });
  const second = galleryService.saveMedia('default', {
    kind: 'video',
    prompt: 'scene',
    model: 'video-model',
    pluginId: 'openrouter',
    mediaData: 'data:video/mp4;base64,dmlkZW8=',
    mimeType: 'video/mp4',
  });
  assert.ok(first && second);
  assert.equal(galleryService.getMedia('default').total, 2);
  assert.deepEqual(
    galleryService
      .getMedia('default', { kind: 'audio' })
      .media.map(item => item.id),
    [first.id]
  );
  assert.equal(galleryService.getMedia('another-user').total, 0);
});
