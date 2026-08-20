import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

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
const mediaGenerationJobService = (
  await import(
    pathToFileURL(
      path.join(distRoot, 'services', 'mediaGenerationJobService.js')
    ).href
  )
).default;
const databaseModule = await import(
  pathToFileURL(path.join(distRoot, 'db.js')).href
);
const closePlatformStorageFixture =
  await initializeSQLitePlatformStorageFixture(distRoot);
const { getPlatformStorageRuntime } = await import(
  pathToFileURL(
    path.join(distRoot, 'platform', 'storage', 'platformStorageRuntime.js')
  ).href
);
const { createDomainDurableJobHandlers } = await import(
  pathToFileURL(
    path.join(distRoot, 'platform', 'jobs', 'domainJobHandlers.js')
  ).href
);
const { getDurableJobRuntime } = await import(
  pathToFileURL(
    path.join(distRoot, 'platform', 'jobs', 'durableJobRuntime.js')
  ).href
);
const { getCoordinator } = await import(
  pathToFileURL(
    path.join(distRoot, 'platform', 'coordination', 'service.js')
  ).href
);
const { encryptionService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'encryptionService.js')).href
);

const resourceDeleteHandler = createDomainDurableJobHandlers().get(
  'resource.delete.v1'
);
assert.ok(resourceDeleteHandler);

const resourceDeleteContext = (ownerUserId, payload, attemptCount = 1) => ({
  signal: new AbortController().signal,
  payload,
  actorUserId: ownerUserId,
  attemptCount,
  reportProgress: async () => undefined,
  assertSideEffectAllowed: async () => undefined,
});

after(async () => {
  await closePlatformStorageFixture();
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

function dependencies(plugin, recordUsage = () => {}) {
  return {
    getAllPlugins: () => [plugin],
    getPlugin: id => (id === plugin.id ? plugin : null),
    getApiKey: () => 'test-key',
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
    recordUsage,
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

test('generated sound aborts its provider stream and records cancelled usage', async () => {
  const app = express();
  app.use(express.json());
  let providerStarted;
  const providerStartedPromise = new Promise(resolve => {
    providerStarted = resolve;
  });
  let providerSawClose = false;
  app.post('/chat/completions', (_req, res) => {
    providerStarted();
    res.set('Content-Type', 'text/event-stream');
    res.flushHeaders();
    res.once('close', () => {
      if (!res.writableEnded) providerSawClose = true;
    });
  });
  const server = await listen(app);
  const plugin = {
    id: 'abortable-audio',
    name: 'Abortable audio',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      audio: {
        endpoint: `${server.baseUrl}/chat/completions`,
        model_map: ['audio-model'],
        config: { formats: ['wav'], default_format: 'wav' },
      },
    },
  };
  const usages = [];
  const controller = new AbortController();
  const service = new PluginAudioGenerationService(
    dependencies(plugin, usage => usages.push(usage))
  );
  const request = service.generate('audio-model', 'Stop this sound', {
    pluginId: plugin.id,
    userId: 'user',
    signal: controller.signal,
  });

  try {
    await providerStartedPromise;
    controller.abort(new Error('sound client disconnected'));
    await assert.rejects(request, /sound client disconnected/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(providerSawClose, true);
    assert.equal(usages.at(-1)?.status, 'cancelled');
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

test('image generation aborts its provider request and records cancelled usage', async () => {
  const app = express();
  app.use(express.json());
  let providerStarted;
  const providerStartedPromise = new Promise(resolve => {
    providerStarted = resolve;
  });
  let providerSawClose = false;
  app.post('/images', (_req, res) => {
    providerStarted();
    res.once('close', () => {
      if (!res.writableEnded) providerSawClose = true;
    });
  });
  const server = await listen(app);
  const plugin = {
    id: 'abortable-image',
    name: 'Abortable image',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      image: {
        endpoint: `${server.baseUrl}/images`,
        model_map: ['image-model'],
        config: { supports_response_format: false },
      },
    },
  };
  const usages = [];
  const controller = new AbortController();
  const service = new PluginImageGenerationService(
    dependencies(plugin, usage => usages.push(usage))
  );
  const request = service.executeImageGenRequest(
    'image-model',
    'Stop this image',
    {
      pluginId: plugin.id,
      userId: 'user',
      signal: controller.signal,
    }
  );

  try {
    await providerStartedPromise;
    controller.abort(new Error('image client disconnected'));
    await assert.rejects(request, /image client disconnected/);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(providerSawClose, true);
    assert.equal(usages.at(-1)?.status, 'cancelled');
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

test('video transport abort does not pretend to cancel an accepted durable provider job', async () => {
  const app = express();
  app.use(express.json());
  const methods = [];
  const durableJobs = new Set();
  const started = new Map();
  const waitFor = key =>
    new Promise(resolve => {
      started.set(key, resolve);
    });
  const submitStarted = waitFor('submit');
  const pollStarted = waitFor('poll');
  const downloadStarted = waitFor('download');
  app.use((req, _res, next) => {
    methods.push(req.method);
    next();
  });
  app.post('/videos', (_req, _res) => {
    durableJobs.add('job-accepted');
    started.get('submit')();
  });
  app.get('/videos/job-accepted', (_req, _res) => {
    started.get('poll')();
  });
  app.get('/videos/job-accepted/content', (_req, _res) => {
    started.get('download')();
  });
  const server = await listen(app);
  const plugin = {
    id: 'abortable-video',
    name: 'Abortable video',
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
  const usages = [];
  const service = new PluginVideoGenerationService(
    dependencies(plugin, usage => usages.push(usage))
  );

  try {
    const submitController = new AbortController();
    const submit = service.submit('video-model', 'A durable scene', {
      pluginId: plugin.id,
      userId: 'user',
      signal: submitController.signal,
    });
    await submitStarted;
    submitController.abort(new Error('submission transport disconnected'));
    await assert.rejects(submit, /submission transport disconnected/);
    assert.equal(usages.at(-1)?.status, 'cancelled');

    const pollController = new AbortController();
    const poll = service.poll(
      'video-model',
      'job-accepted',
      plugin.id,
      'user',
      pollController.signal
    );
    await pollStarted;
    pollController.abort(new Error('poll transport disconnected'));
    await assert.rejects(poll, /poll transport disconnected/);

    const downloadController = new AbortController();
    const download = service.download(
      'video-model',
      'job-accepted',
      plugin.id,
      'user',
      downloadController.signal
    );
    await downloadStarted;
    downloadController.abort(new Error('download transport disconnected'));
    await assert.rejects(download, /download transport disconnected/);

    assert.deepEqual([...durableJobs], ['job-accepted']);
    assert.equal(
      methods.includes('DELETE'),
      false,
      'transport cancellation must not claim provider-job cancellation'
    );
  } finally {
    await server.close();
  }
});

test('video cancellation uses only a declared provider job endpoint', async () => {
  const app = express();
  app.use(express.json());
  const requests = [];
  app.delete('/videos/job-to-cancel/cancel', (req, res) => {
    requests.push({ method: req.method, path: req.path });
    res.status(204).end();
  });
  const server = await listen(app);
  const plugin = {
    id: 'cancellable-video',
    name: 'Cancellable video',
    type: 'completion',
    endpoint: `${server.baseUrl}/chat/completions`,
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST' },
    model_map: ['chat-model'],
    active: true,
    capabilities: {
      video: {
        endpoint: `${server.baseUrl}/videos`,
        model_map: ['video-model'],
        config: {
          cancel_endpoint: '/videos/{job_id}/cancel',
          cancel_method: 'DELETE',
        },
      },
    },
  };
  try {
    const service = new PluginVideoGenerationService(dependencies(plugin));
    assert.equal(
      await service.supportsCancellation(
        'video-model',
        plugin.id,
        'video-owner'
      ),
      true
    );
    await service.cancel(
      'video-model',
      'job-to-cancel',
      plugin.id,
      'video-owner'
    );
  } finally {
    await server.close();
  }
  assert.deepEqual(requests, [
    { method: 'DELETE', path: '/videos/job-to-cancel/cancel' },
  ]);

  const unsupportedPlugin = {
    ...plugin,
    id: 'non-cancellable-video',
    capabilities: {
      video: {
        ...plugin.capabilities.video,
        config: {},
      },
    },
  };
  const unsupported = new PluginVideoGenerationService(
    dependencies(unsupportedPlugin)
  );
  assert.equal(
    await unsupported.supportsCancellation(
      'video-model',
      unsupportedPlugin.id,
      'video-owner'
    ),
    false
  );
  await assert.rejects(
    unsupported.cancel(
      'video-model',
      'job-to-cancel',
      unsupportedPlugin.id,
      'video-owner'
    ),
    /does not declare job cancellation/
  );
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
  const pluginId = `media-discovery-test-${process.pid}-${Date.now()}`;
  try {
    await service.installPlugin(
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
    const plugin = await service.getPlugin(pluginId, 'default');
    assert.deepEqual(plugin.model_map, ['chat-live']);
    assert.deepEqual(plugin.capabilities.image.model_map, [
      'image-live-a',
      'image-live-b',
    ]);
    assert.deepEqual(plugin.capabilities.tts.model_map, ['speech-live']);
    assert.deepEqual(plugin.capabilities.audio.model_map, ['audio-live']);
    assert.deepEqual(plugin.capabilities.video.model_map, ['video-live']);
  } finally {
    await service.deletePlugin(pluginId);
    await server.close();
  }
});

test('Imagine gallery isolates media by user and kind', async () => {
  databaseModule.getDatabase();
  const first = await galleryService.saveMedia('default', {
    kind: 'audio',
    prompt: 'hello',
    model: 'speech-model',
    pluginId: 'openrouter',
    mediaData: 'data:audio/mpeg;base64,YXVkaW8=',
    mimeType: 'audio/mpeg',
  });
  const second = await galleryService.saveMedia('default', {
    kind: 'video',
    prompt: 'scene',
    model: 'video-model',
    pluginId: 'openrouter',
    mediaData: 'data:video/mp4;base64,dmlkZW8=',
    mimeType: 'video/mp4',
  });
  assert.ok(first && second);
  assert.equal((await galleryService.getMedia('default')).total, 2);
  assert.deepEqual(
    (await galleryService.getMedia('default', { kind: 'audio' })).media.map(
      item => item.id
    ),
    [first.id]
  );
  assert.equal((await galleryService.getMedia('another-user')).total, 0);
});

test('deterministic media resolves a committed insert whose acknowledgement is lost', async () => {
  const runtime = getPlatformStorageRuntime();
  const repository = runtime.domains.gallery;
  const originalInsert = repository.insert.bind(repository);
  repository.insert = async (...args) => {
    await originalInsert(...args);
    throw new Error('injected post-commit acknowledgement loss');
  };
  try {
    const media = await galleryService.saveMedia('default', {
      id: 'deterministic-video-ack-loss',
      createdAt: 1_700_000_000_000,
      kind: 'video',
      prompt: 'deterministic video',
      model: 'video-model',
      pluginId: 'openrouter',
      mediaData: 'data:video/mp4;base64,YWNrLWxvc3M=',
      mimeType: 'video/mp4',
    });
    assert.equal(media?.id, 'deterministic-video-ack-loss');
    const reference = await runtime.blobReferences.find(
      'generated-media',
      'deterministic-video-ack-loss',
      'gallery.media'
    );
    assert.ok(reference);
    const descriptor = await runtime.blobStore.stat(
      reference.blobId,
      'default'
    );
    assert.equal(descriptor.size, 8);
  } finally {
    repository.insert = originalInsert;
  }
});

test('prepared video and resume publications resolve lost commit acknowledgements', async () => {
  const runtime = getPlatformStorageRuntime();
  const repository = runtime.domains.mediaJobs;
  const originalCreate =
    repository.createPreparedAndEnqueue.bind(repository);
  repository.createPreparedAndEnqueue = async (...args) => {
    await originalCreate(...args);
    throw new Error('injected prepared-video commit acknowledgement loss');
  };
  let job;
  try {
    job = await mediaGenerationJobService.queueVideoSubmission('default', {
      pluginId: 'openrouter',
      model: 'video-model',
      prompt: 'prepared publication acknowledgement loss',
      options: { duration: 5 },
    });
  } finally {
    repository.createPreparedAndEnqueue = originalCreate;
  }
  assert.equal(job.providerJobId, 'libre:prepared');
  const submitJob = await getDurableJobRuntime().service.getByIdempotency(
    'default',
    'media.video.submit.v1',
    job.id
  );
  assert.equal(submitJob?.jobType, 'media.video.submit.v1');

  const originalAccept =
    repository.acceptProviderAndEnqueueResume.bind(repository);
  repository.acceptProviderAndEnqueueResume = async (...args) => {
    await originalAccept(...args);
    throw new Error('injected video-resume commit acknowledgement loss');
  };
  try {
    await mediaGenerationJobService.acceptSubmittedProviderJob(
      job.id,
      'default',
      'provider-job-acknowledged'
    );
  } finally {
    repository.acceptProviderAndEnqueueResume = originalAccept;
  }
  assert.equal(
    (await mediaGenerationJobService.get(job.id, 'default'))?.providerJobId,
    'provider-job-acknowledged'
  );
  const resumeJob = await getDurableJobRuntime().service.getByIdempotency(
    'default',
    'media.video.resume.v1',
    job.id
  );
  assert.equal(resumeJob?.jobType, 'media.video.resume.v1');
});

test('ordinary generated media resolves a committed insert whose acknowledgement is lost', async () => {
  const runtime = getPlatformStorageRuntime();
  const repository = runtime.domains.gallery;
  const originalInsert = repository.insert.bind(repository);
  repository.insert = async (...args) => {
    await originalInsert(...args);
    throw new Error('injected post-commit acknowledgement loss');
  };
  try {
    const media = await galleryService.saveMedia('default', {
      kind: 'image',
      prompt: 'ordinary generated image',
      model: 'image-model',
      mediaData: 'data:image/png;base64,b3JkaW5hcnk=',
      mimeType: 'image/png',
    });
    assert.ok(media?.id);
    const reference = await runtime.blobReferences.find(
      'generated-media',
      media.id,
      'gallery.media'
    );
    assert.ok(reference);
    const descriptor = await runtime.blobStore.stat(
      reference.blobId,
      'default'
    );
    assert.equal(descriptor.size, 8);
  } finally {
    repository.insert = originalInsert;
  }
});

test('a failed cleanup retry cannot resurrect or delete a replacement deterministic media ID', async () => {
  const runtime = getPlatformStorageRuntime();
  const mediaId = 'deterministic-video-deletion-occurrence';
  const initial = await galleryService.saveMedia('default', {
    id: mediaId,
    createdAt: 1_700_000_000_100,
    kind: 'video',
    prompt: 'first durable occurrence',
    model: 'video-model',
    pluginId: 'openrouter',
    mediaData: 'data:video/mp4;base64,Zmlyc3Q=',
    mimeType: 'video/mp4',
  });
  assert.equal(initial?.id, mediaId);
  const initialReference = await runtime.blobReferences.find(
    'generated-media',
    mediaId,
    'gallery.media'
  );
  assert.ok(initialReference);
  assert.equal(await galleryService.deleteMedia(mediaId, 'default'), true);
  const deletion = databaseModule
    .getDatabase()
    .prepare(
      `SELECT deletion_token, deletion_incarnation
         FROM platform_resource_deletion_tombstones
        WHERE resource_type = 'generated-media' AND resource_id = ?`
    )
    .get(mediaId);
  assert.match(deletion.deletion_token, /^[0-9a-f]{64}$/);

  const coordinator = getCoordinator();
  const originalDeleteCache = coordinator.deleteCache.bind(coordinator);
  coordinator.deleteCache = async () => {
    throw new Error('injected cache failure after physical cleanup');
  };
  try {
    await assert.rejects(
      resourceDeleteHandler(
        resourceDeleteContext('default', {
          resourceType: 'generated-media',
          resourceId: mediaId,
          deletionIncarnation: deletion.deletion_incarnation,
          deletionToken: deletion.deletion_token,
        })
      ),
      error => error?.safeCode === 'cache-invalidation-failed'
    );
  } finally {
    coordinator.deleteCache = originalDeleteCache;
  }
  assert.equal(
    await runtime.blobReferences.find(
      'generated-media',
      mediaId,
      'gallery.media'
    ),
    undefined
  );
  await assert.rejects(
    runtime.blobStore.stat(initialReference.blobId, 'default')
  );

  const staleCompletion = await galleryService.saveMedia('default', {
    id: mediaId,
    createdAt: 1_700_000_000_100,
    kind: 'video',
    prompt: 'stale retry must not publish',
    model: 'video-model',
    pluginId: 'openrouter',
    mediaData: 'data:video/mp4;base64,cmVwbGFjZW1lbnQ=',
    mimeType: 'video/mp4',
  });
  assert.equal(staleCompletion, null);
  assert.equal(await galleryService.getMediaItem(mediaId, 'default'), null);
  assert.equal(
    await runtime.blobReferences.find(
      'generated-media',
      mediaId,
      'gallery.media'
    ),
    undefined
  );

  await resourceDeleteHandler(
    resourceDeleteContext(
      'default',
      {
        resourceType: 'generated-media',
        resourceId: mediaId,
        deletionIncarnation: deletion.deletion_incarnation,
        deletionToken: deletion.deletion_token,
      },
      2
    )
  );
  const completed = databaseModule
    .getDatabase()
    .prepare(
      `SELECT completed_at FROM platform_resource_deletion_tombstones
        WHERE resource_type = 'generated-media' AND resource_id = ?`
    )
    .get(mediaId);
  assert.ok(completed.completed_at);
});

test('paused legacy inline migration cannot attach a blob after deletion', async () => {
  const runtime = getPlatformStorageRuntime();
  const mediaId = 'legacy-inline-adoption-delete-race';
  const legacyData = 'data:image/png;base64,bGVnYWN5LWltYWdl';
  const seeded = await galleryService.saveMedia('default', {
    id: mediaId,
    createdAt: 1_700_000_000_200,
    kind: 'image',
    prompt: 'legacy inline record',
    model: 'legacy-model',
    mediaData: legacyData,
    mimeType: 'image/png',
  });
  assert.equal(seeded?.id, mediaId);
  const originalReference = await runtime.blobReferences.find(
    'generated-media',
    mediaId,
    'gallery.media'
  );
  assert.ok(originalReference);
  await runtime.blobStore.delete({
    id: originalReference.blobId,
    ownerUserId: 'default',
  });
  await runtime.blobReferences.detach(
    'generated-media',
    mediaId,
    'gallery.media'
  );
  databaseModule
    .getDatabase()
    .prepare('UPDATE generated_images SET image_data = ? WHERE id = ?')
    .run(encryptionService.encrypt(legacyData), mediaId);

  const originalPut = runtime.blobStore.put.bind(runtime.blobStore);
  let releasePut;
  const putRelease = new Promise(resolve => {
    releasePut = resolve;
  });
  let publishedBlob;
  let putReachedResolve;
  const putReached = new Promise(resolve => {
    putReachedResolve = resolve;
  });
  runtime.blobStore.put = async input => {
    const descriptor = await originalPut(input);
    publishedBlob = descriptor;
    putReachedResolve();
    await putRelease;
    return descriptor;
  };
  const openPromise = galleryService.openMediaContent(mediaId, 'default');
  try {
    await putReached;
    assert.equal(await galleryService.deleteMedia(mediaId, 'default'), true);
    releasePut();
    await assert.rejects(
      openPromise,
      /(deleted during legacy adoption|permanently reserved by deletion)/
    );
  } finally {
    runtime.blobStore.put = originalPut;
    releasePut?.();
    await openPromise.catch(() => undefined);
  }
  assert.ok(publishedBlob);
  assert.equal(await galleryService.getMediaItem(mediaId, 'default'), null);
  assert.equal(
    await runtime.blobReferences.find(
      'generated-media',
      mediaId,
      'gallery.media'
    ),
    undefined
  );
  await assert.rejects(runtime.blobStore.stat(publishedBlob.id, 'default'));
});

test('gallery retention sweep deletes only expired media when configured', async () => {
  delete process.env.GALLERY_RETENTION_DAYS;
  const kept = await galleryService.saveMedia('default', {
    kind: 'image',
    prompt: 'retention keep',
    model: 'img-model',
    pluginId: 'openrouter',
    mediaData: `data:image/png;base64,${Buffer.from('keep').toString('base64')}`,
    mimeType: 'image/png',
  });
  const expired = await galleryService.saveMedia('default', {
    kind: 'image',
    prompt: 'retention expire',
    model: 'img-model',
    pluginId: 'openrouter',
    mediaData: `data:image/png;base64,${Buffer.from('old').toString('base64')}`,
    mimeType: 'image/png',
  });
  assert.ok(kept && expired);
  const now = Date.now();
  databaseModule
    .getDatabase()
    .prepare('UPDATE generated_images SET created_at = ? WHERE id = ?')
    .run(now - 40 * 24 * 60 * 60 * 1000, expired.id);

  // Unset means keep forever.
  assert.equal(await galleryService.sweepRetention(now), 0);
  assert.ok(await galleryService.getMediaItem(expired.id, 'default'));

  process.env.GALLERY_RETENTION_DAYS = '30';
  try {
    // Earlier tests may have left other stale rows; the invariant is that
    // the expired item goes and in-window items stay.
    assert.ok((await galleryService.sweepRetention(now)) >= 1);
    assert.equal(await galleryService.getMediaItem(expired.id, 'default'), null);
    assert.ok(
      await galleryService.getMediaItem(kept.id, 'default'),
      'items inside the retention window survive'
    );
    // Idempotent: nothing left to remove.
    assert.equal(await galleryService.sweepRetention(now), 0);
  } finally {
    delete process.env.GALLERY_RETENTION_DAYS;
  }
});
