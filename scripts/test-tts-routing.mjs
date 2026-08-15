import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pluginTTSModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'pluginTTSService.js')
  ).href
);
const { PluginTTSService } = pluginTTSModule;
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
const voiceCloneUploadModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'ttsVoiceCloneUpload.js')
  ).href
);
const {
  TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES,
  TTSVoiceCloneConcurrencyError,
  TTSVoiceCloneUploadError,
  getTTSVoiceCloneMaxAudioBytes,
  parseTTSVoiceCloneUpload,
  reserveTTSVoiceCloneUpload,
  validateTTSVoiceCloneAudio,
} = voiceCloneUploadModule;

function createPlugin(id, endpoint, config = {}) {
  return {
    id,
    name: id,
    active: true,
    type: 'tts',
    endpoint,
    auth: { header: '', key_env: '' },
    model_map: ['tts-1-hd'],
    capabilities: {
      tts: {
        endpoint,
        model_map: ['tts-1-hd'],
        config: {
          voices: ['alba'],
          default_voice: 'alba',
          formats: ['wav'],
          default_format: 'wav',
          no_auth_required: true,
          ...config,
        },
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

test('TTS routes a shared model alias through the selected plugin and user valve', async () => {
  const requests = [];
  const providerServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    requests.push({ method: req.method, url: req.url, body });
    res.writeHead(200, { 'Content-Type': 'audio/wav' });
    res.end(Buffer.from('RIFFtest-audio'));
  });
  const providerPort = await startServer(providerServer);
  const savedEndpoint = `http://127.0.0.1:${providerPort}/v1/audio/speech`;
  const plugins = [
    createPlugin('wrong-provider', 'http://127.0.0.1:9/wrong'),
    createPlugin('kyutai-tts-1.6b', 'http://127.0.0.1:9/default', {
      request_variables: ['steps', 'model'],
    }),
  ];
  const apiKeyLookups = [];
  const variableLookups = [];
  const service = new PluginTTSService({
    getAllPlugins: () => plugins,
    getPlugin: id => plugins.find(plugin => plugin.id === id) || null,
    getApiKey: (plugin, userId) => {
      apiKeyLookups.push({ pluginId: plugin.id, userId });
      return null;
    },
    getPluginVariables: (plugin, userId) => {
      variableLookups.push({ pluginId: plugin.id, userId });
      return {
        endpoint: savedEndpoint,
        speed: 1.25,
        steps: 16,
        model: 'must-not-override',
      };
    },
    validateEndpointUrl: endpoint => endpoint,
  });

  try {
    const models = await service.getAvailableTTSModels('user-42');
    assert.deepEqual(
      models.map(({ model, plugin }) => ({ model, plugin })),
      [
        { model: 'tts-1-hd', plugin: 'wrong-provider' },
        { model: 'tts-1-hd', plugin: 'kyutai-tts-1.6b' },
      ]
    );

    const audio = await service.executeTTSRequest(
      'tts-1-hd',
      'hello from a user valve',
      {
        pluginId: 'kyutai-tts-1.6b',
        userId: 'user-42',
        voice: 'alba',
        response_format: 'wav',
      }
    );

    assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.ok(apiKeyLookups.every(lookup => lookup.userId === 'user-42'));
    assert.equal(apiKeyLookups.at(-1)?.pluginId, 'kyutai-tts-1.6b');
    assert.deepEqual(variableLookups, [
      { pluginId: 'kyutai-tts-1.6b', userId: 'user-42' },
    ]);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/v1/audio/speech');
    assert.deepEqual(JSON.parse(requests[0].body), {
      model: 'tts-1-hd',
      input: 'hello from a user valve',
      voice: 'alba',
      response_format: 'wav',
      speed: 1.25,
      steps: 16,
    });
  } finally {
    await new Promise(resolve => providerServer.close(resolve));
  }
});

test('inactive authless TTS plugins are neither listed nor routable', async () => {
  const plugin = createPlugin(
    'inactive-local-provider',
    'http://127.0.0.1:9/v1/audio/speech'
  );
  plugin.active = false;
  const service = new PluginTTSService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  assert.deepEqual(await service.getAvailableTTSModels('user-a'), []);
  await assert.rejects(
    service.executeTTSRequest('tts-1-hd', 'hello', {
      pluginId: plugin.id,
      userId: 'user-a',
    }),
    /No TTS plugin found/
  );
});

test('a discovered TTS capability cannot fall back to an unloaded root model', async () => {
  const plugin = createPlugin(
    'single-resident-model',
    'http://127.0.0.1:9/v1/audio/speech'
  );
  plugin.model_map.push('unloaded-model');
  const service = new PluginTTSService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  assert.equal(
    await service.getPluginForTTS('unloaded-model', plugin.id, 'user-a'),
    null
  );
});

test('voice cloning forwards bounded multipart fields through the selected user endpoint', async () => {
  const requestsA = [];
  const requestsB = [];
  const createProvider = requests =>
    http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push({
        headers: req.headers,
        method: req.method,
        url: req.url,
        body: Buffer.concat(chunks),
      });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from('RIFFxxxxWAVEclone'));
    });

  const providerA = createProvider(requestsA);
  const providerB = createProvider(requestsB);
  const portA = await startServer(providerA);
  const portB = await startServer(providerB);
  const endpoints = {
    'user-a': `http://127.0.0.1:${portA}/v1/audio/voice-clone`,
    'user-b': `http://127.0.0.1:${portB}/v1/audio/voice-clone`,
  };
  const plugin = createPlugin(
    'clone-provider',
    'http://127.0.0.1:9/v1/audio/speech',
    {
      no_auth_required: false,
      supports_voice_cloning: true,
      voice_clone_endpoint: 'http://127.0.0.1:9/v1/audio/voice-clone',
      voice_clone_endpoint_variable: 'clone_endpoint',
      clone_requires_transcript: true,
      clone_audio_mime_types: ['audio/wav'],
      clone_max_audio_bytes: 1024,
      request_variables: ['steps', 'cfg_strength', 'model', 'not_configured'],
    }
  );
  plugin.auth = {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'TEST_KEY',
  };
  const lookups = [];
  const usages = [];
  const service = new PluginTTSService({
    getAllPlugins: userId => {
      lookups.push({ kind: 'plugins', userId });
      return [plugin];
    },
    getPlugin: () => plugin,
    getApiKey: (_plugin, userId) => {
      lookups.push({ kind: 'key', userId });
      return `key-${userId}`;
    },
    getPluginVariables: (_plugin, userId) => {
      lookups.push({ kind: 'variables', userId });
      return {
        clone_endpoint: endpoints[userId],
        steps: userId === 'user-a' ? 12 : 20,
        cfg_strength: 1.5,
        model: 'must-not-override',
        not_allowlisted: 'must-not-forward',
      };
    },
    validateEndpointUrl: endpoint => endpoint,
    recordUsage: usage => usages.push(usage),
  });
  const referenceAudio = {
    buffer: Buffer.from('RIFFxxxxWAVEreference-bytes'),
    originalname: 'sample.wav',
    mimetype: 'audio/wav',
  };

  try {
    const [audioA, audioB] = await Promise.all([
      service.executeVoiceCloneRequest(
        'tts-1-hd',
        'hello as user A',
        referenceAudio,
        {
          pluginId: 'clone-provider',
          userId: 'user-a',
          referenceText: 'reference words A',
          response_format: 'wav',
        }
      ),
      service.executeVoiceCloneRequest(
        'tts-1-hd',
        'hello as user B',
        referenceAudio,
        {
          pluginId: 'clone-provider',
          userId: 'user-b',
          referenceText: 'reference words B',
          response_format: 'wav',
        }
      ),
    ]);

    assert.equal(audioA.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(audioB.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(requestsA.length, 1);
    assert.equal(requestsB.length, 1);
    for (const [request, userId, input, transcript, steps] of [
      [requestsA[0], 'user-a', 'hello as user A', 'reference words A', '12'],
      [requestsB[0], 'user-b', 'hello as user B', 'reference words B', '20'],
    ]) {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/audio/voice-clone');
      assert.equal(request.headers.authorization, `Bearer key-${userId}`);
      assert.match(
        request.headers['content-type'],
        /^multipart\/form-data; boundary=/
      );
      const body = request.body.toString('latin1');
      assert.match(body, /name="model"\r\n\r\ntts-1-hd\r\n/);
      assert.match(body, new RegExp(`name="input"\\r\\n\\r\\n${input}\\r\\n`));
      assert.match(
        body,
        new RegExp(`name="reference_text"\\r\\n\\r\\n${transcript}\\r\\n`)
      );
      assert.match(body, /name="reference_audio"; filename="sample.wav"/);
      assert.match(body, /Content-Type: audio\/wav/);
      assert.match(body, /RIFFxxxxWAVEreference-bytes/);
      assert.match(body, new RegExp(`name="steps"\\r\\n\\r\\n${steps}\\r\\n`));
      assert.match(body, /name="cfg_strength"\r\n\r\n1.5\r\n/);
      assert.doesNotMatch(body, /must-not-override/);
      assert.doesNotMatch(body, /must-not-forward/);
    }
    assert.ok(
      lookups.every(
        lookup => lookup.userId === 'user-a' || lookup.userId === 'user-b'
      )
    );
    assert.deepEqual(usages.map(usage => [usage.userId, usage.status]).sort(), [
      ['user-a', 'success'],
      ['user-b', 'success'],
    ]);
  } finally {
    await Promise.all([
      new Promise(resolve => providerA.close(resolve)),
      new Promise(resolve => providerB.close(resolve)),
    ]);
  }
});

test('voice cloning rejects unsupported plugins and missing required transcripts', async () => {
  const unsupported = createPlugin(
    'unsupported',
    'http://127.0.0.1:9/v1/audio/speech'
  );
  const requiresTranscript = createPlugin(
    'requires-transcript',
    'http://127.0.0.1:9/v1/audio/speech',
    {
      supports_voice_cloning: true,
      voice_clone_endpoint: 'http://127.0.0.1:9/v1/audio/voice-clone',
      clone_requires_transcript: true,
    }
  );
  const plugins = [unsupported, requiresTranscript];
  const service = new PluginTTSService({
    getAllPlugins: () => plugins,
    getPlugin: id => plugins.find(plugin => plugin.id === id) || null,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });
  const referenceAudio = {
    buffer: Buffer.from('RIFFxxxxWAVEreference-bytes'),
    originalname: 'sample.wav',
    mimetype: 'audio/wav',
  };

  await assert.rejects(
    service.executeVoiceCloneRequest('tts-1-hd', 'hello', referenceAudio, {
      pluginId: 'unsupported',
      userId: 'user-a',
    }),
    /does not support voice cloning/
  );
  await assert.rejects(
    service.executeVoiceCloneRequest('tts-1-hd', 'hello', referenceAudio, {
      pluginId: 'requires-transcript',
      userId: 'user-a',
    }),
    /requires a reference audio transcript/
  );
});

test('voice cloning aborts the provider request when its caller disconnects', async () => {
  let providerSawAbort = false;
  let providerStarted;
  const providerStartedPromise = new Promise(resolve => {
    providerStarted = resolve;
  });
  const provider = http.createServer((req, res) => {
    providerStarted();
    req.once('aborted', () => {
      providerSawAbort = true;
    });
    res.once('close', () => {
      if (!res.writableEnded) providerSawAbort = true;
    });
  });
  const port = await startServer(provider);
  const plugin = createPlugin(
    'abortable-clone-provider',
    'http://127.0.0.1:9/v1/audio/speech',
    {
      no_auth_required: true,
      supports_voice_cloning: true,
      voice_clone_endpoint: `http://127.0.0.1:${port}/v1/audio/voice-clone`,
      clone_requires_transcript: true,
      clone_audio_mime_types: ['audio/wav'],
    }
  );
  const service = new PluginTTSService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });
  const controller = new AbortController();
  const request = service.executeVoiceCloneRequest(
    'tts-1-hd',
    'cancel this clone',
    {
      buffer: Buffer.from('RIFFxxxxWAVEreference-bytes'),
      originalname: 'sample.wav',
      mimetype: 'audio/wav',
    },
    {
      pluginId: plugin.id,
      userId: 'user-a',
      referenceText: 'reference words',
      response_format: 'wav',
      signal: controller.signal,
    }
  );

  try {
    await providerStartedPromise;
    controller.abort();
    await assert.rejects(request, /voice clone request was cancelled/i);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(providerSawAbort, true);
  } finally {
    await new Promise(resolve => provider.close(resolve));
  }
});

test('ordinary TTS aborts the provider request and records cancelled usage', async () => {
  let providerSawAbort = false;
  let providerStarted;
  const providerStartedPromise = new Promise(resolve => {
    providerStarted = resolve;
  });
  const provider = http.createServer((req, res) => {
    providerStarted();
    req.once('aborted', () => {
      providerSawAbort = true;
    });
    res.once('close', () => {
      if (!res.writableEnded) providerSawAbort = true;
    });
  });
  const port = await startServer(provider);
  const plugin = createPlugin(
    'abortable-tts-provider',
    `http://127.0.0.1:${port}/v1/audio/speech`
  );
  const usages = [];
  const service = new PluginTTSService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
    recordUsage: usage => usages.push(usage),
  });
  const controller = new AbortController();
  const request = service.executeTTSRequest('tts-1-hd', 'cancel this speech', {
    pluginId: plugin.id,
    userId: 'user-a',
    signal: controller.signal,
  });

  try {
    await providerStartedPromise;
    controller.abort();
    await assert.rejects(request, /provider request was cancelled/i);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(providerSawAbort, true);
    assert.equal(usages.length, 1);
    assert.equal(usages[0].status, 'cancelled');
  } finally {
    await new Promise(resolve => provider.close(resolve));
  }
});

test('ordinary TTS bounds concurrent provider work per user', async () => {
  const provider = http.createServer(() => {});
  const port = await startServer(provider);
  const plugin = createPlugin(
    'bounded-concurrency-provider',
    `http://127.0.0.1:${port}/v1/audio/speech`
  );
  const service = new PluginTTSService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });
  const controller = new AbortController();
  const active = Array.from({ length: 6 }, (_, index) =>
    service.executeTTSRequest('tts-1-hd', `speech ${index}`, {
      pluginId: plugin.id,
      userId: 'same-user',
      signal: controller.signal,
    })
  );

  try {
    await assert.rejects(
      service.executeTTSRequest('tts-1-hd', 'one too many', {
        pluginId: plugin.id,
        userId: 'same-user',
      }),
      /Too many concurrent TTS provider requests/
    );
  } finally {
    controller.abort();
    await Promise.allSettled(active);
    provider.closeAllConnections?.();
    await new Promise(resolve => provider.close(resolve));
  }
});

test('voice clone audio validation enforces MIME, signature, and manifest size', () => {
  assert.equal(TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES, 10 * 1024 * 1024);
  assert.equal(
    getTTSVoiceCloneMaxAudioBytes({ clone_max_audio_bytes: 1024 }),
    1024
  );
  assert.equal(
    getTTSVoiceCloneMaxAudioBytes({
      clone_max_audio_bytes: 20 * 1024 * 1024,
    }),
    TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES
  );
  assert.equal(
    validateTTSVoiceCloneAudio(
      {
        buffer: Buffer.from('RIFFxxxxWAVEalias'),
        originalname: 'alias.wav',
        mimetype: 'audio/vnd.wave',
      },
      { clone_audio_mime_types: ['audio/wav'] }
    ).format,
    'wav'
  );
  assert.throws(
    () =>
      validateTTSVoiceCloneAudio(
        {
          buffer: Buffer.from('not-wave-data'),
          originalname: 'fake.wav',
          mimetype: 'audio/wav',
        },
        { clone_audio_mime_types: ['audio/wav'] }
      ),
    error =>
      error instanceof TTSVoiceCloneUploadError &&
      error.code === 'signature_mismatch'
  );
  assert.throws(
    () =>
      validateTTSVoiceCloneAudio(
        {
          buffer: Buffer.from('RIFFxxxxWAVEtoo-large'),
          originalname: 'large.wav',
          mimetype: 'audio/wav',
        },
        { clone_audio_mime_types: ['audio/wav'], clone_max_audio_bytes: 12 }
      ),
    error =>
      error instanceof TTSVoiceCloneUploadError &&
      error.code === 'file_too_large'
  );
});

test('voice clone upload admission preserves the six-per-user shared ceiling', async () => {
  const held = await Promise.all(
    Array.from({ length: 6 }, () =>
      reserveTTSVoiceCloneUpload('voice-upload-user')
    )
  );
  try {
    await assert.rejects(
      reserveTTSVoiceCloneUpload('voice-upload-user'),
      TTSVoiceCloneConcurrencyError
    );
  } finally {
    await Promise.all(held.map(slot => slot.release()));
  }
  const afterRelease = await reserveTTSVoiceCloneUpload('voice-upload-user');
  await afterRelease.release();
});

test('both voice clone routes reserve shared capacity before memory upload', () => {
  for (const route of ['tts.ts', 'media.ts']) {
    const source = fs.readFileSync(
      path.join(repoRoot, 'backend', 'src', 'routes', route),
      'utf8'
    );
    const reserve = source.indexOf('await reserveTTSVoiceCloneUpload(');
    const parse = source.indexOf('await parseTTSVoiceCloneUpload(');
    assert.ok(reserve >= 0 && reserve < parse, route);
    assert.match(
      source.slice(parse, parse + 120),
      /operationSignal/,
      `${route} must cancel buffering when admission is lost`
    );
  }
});

test('voice clone upload buffering stops when its shared permit is lost', async () => {
  const app = express();
  app.post('/upload', async (req, res) => {
    const controller = new AbortController();
    req.once('data', () =>
      controller.abort(new Error('shared voice upload permit was lost'))
    );
    try {
      await parseTTSVoiceCloneUpload(req, res, controller.signal);
      res.status(200).end();
    } catch (error) {
      res.status(503).json({ error: error.message, buffered: req.file?.size });
    }
  });
  const server = http.createServer(app);
  const port = await startServer(server);
  const boundary = 'libre-stalled-voice-upload';
  let uploadRequest;
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/upload',
          method: 'POST',
          headers: {
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
        },
        incoming => {
          let body = '';
          incoming.setEncoding('utf8');
          incoming.on('data', chunk => {
            body += chunk;
          });
          incoming.on('end', () =>
            resolve({ status: incoming.statusCode, body })
          );
        }
      );
      uploadRequest = request;
      request.once('error', reject);
      request.write(
        `--${boundary}\r\nContent-Disposition: form-data; name="reference_audio"; filename="slow.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      );
      request.write(Buffer.alloc(64 * 1024, 0x61));
    });
    assert.equal(response.status, 503);
    assert.match(response.body, /shared voice upload permit was lost/);
    assert.doesNotMatch(response.body, /"buffered":\s*[1-9]/);
  } finally {
    uploadRequest?.destroy();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});

test('ordinary TTS rejects oversized text instead of concatenating encoded audio containers', async () => {
  const plugin = createPlugin(
    'bounded-provider',
    'http://127.0.0.1:9/v1/audio/speech',
    { max_characters: 5 }
  );
  const service = new PluginTTSService({
    getAllPlugins: () => [plugin],
    getPlugin: () => plugin,
    getApiKey: () => null,
    getPluginVariables: () => ({}),
    validateEndpointUrl: endpoint => endpoint,
  });

  await assert.rejects(
    service.executeTTSRequest('tts-1-hd', 'sixteen characters', {
      pluginId: plugin.id,
      userId: 'user-a',
    }),
    /exceeds maximum length of 5 characters; split it into batches/
  );
});
