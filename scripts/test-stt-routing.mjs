import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const { PluginSTTService, STTProviderResponseError } = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend/dist/services/pluginSTTService.js')
  ).href
);
const { parseSTTAudioUpload, STTAudioUploadError, validateSTTAudio } =
  await import(
    pathToFileURL(path.join(repoRoot, 'backend/dist/utils/sttAudioUpload.js'))
      .href
  );

function plugin(id, endpoint, config = {}) {
  return {
    id,
    name: id,
    active: true,
    type: 'completion',
    endpoint: 'http://127.0.0.1:9/chat',
    auth: { header: 'Authorization', prefix: 'Bearer ', key_env: 'TEST_KEY' },
    model_map: [],
    capabilities: {
      stt: {
        endpoint,
        model_map: ['transcribe-model'],
        config,
      },
    },
  };
}

function serviceFor(candidate, variables = {}, usage = []) {
  return new PluginSTTService({
    getAllPlugins: () => [candidate],
    getPlugin: id => (id === candidate.id ? candidate : null),
    getApiKey: (_plugin, userId) => `key-${userId}`,
    getPluginVariables: () => variables,
    validateEndpointUrl: endpoint => endpoint,
    recordUsage: event => usage.push(event),
  });
}

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve({ server, port: address.port });
    });
  });
}

const wav = Buffer.from('RIFFxxxxWAVEaudio-data');
const audio = {
  buffer: wav,
  originalname: 'recording.wav',
  mimetype: 'audio/wav',
  size: wav.length,
};

test('STT sends an OpenAI-compatible multipart request to the selected route', async () => {
  let received;
  const { server, port } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('latin1'),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'hello from audio', language: 'en' }));
  });
  const usage = [];
  const candidate = plugin('openai-compatible', 'http://127.0.0.1:9/default', {
    request_mode: 'multipart',
    endpoint_variable: 'stt_endpoint',
  });
  const service = serviceFor(
    candidate,
    { stt_endpoint: `http://127.0.0.1:${port}/v1/audio/transcriptions` },
    usage
  );

  try {
    const result = await service.transcribe('transcribe-model', audio, {
      pluginId: candidate.id,
      userId: 'user-a',
      language: 'en',
      prompt: 'Libre WebUI',
    });
    assert.deepEqual(result, { text: 'hello from audio', language: 'en' });
    assert.equal(received.url, '/v1/audio/transcriptions');
    assert.equal(received.headers.authorization, 'Bearer key-user-a');
    assert.match(received.headers['content-type'], /^multipart\/form-data;/);
    assert.match(received.body, /name="file"; filename="recording.wav"/);
    assert.match(received.body, /Content-Type: audio\/wav/);
    assert.match(received.body, /RIFFxxxxWAVEaudio-data/);
    assert.match(received.body, /name="model"\r\n\r\ntranscribe-model/);
    assert.match(received.body, /name="language"\r\n\r\nen/);
    assert.match(received.body, /name="prompt"\r\n\r\nLibre WebUI/);
    assert.deepEqual(
      usage.map(event => [event.capability, event.status, event.userId]),
      [['stt', 'success', 'user-a']]
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('STT sends raw audio to a model-qualified Hugging Face endpoint', async () => {
  let received;
  const { server, port } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      contentType: req.headers['content-type'],
      body: Buffer.concat(chunks),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'raw transcript' }));
  });
  const candidate = plugin(
    'huggingface',
    `http://127.0.0.1:${port}/models/{model}`,
    { request_mode: 'raw' }
  );
  const service = serviceFor(candidate);
  try {
    const result = await service.transcribe('transcribe-model', audio, {
      pluginId: candidate.id,
      userId: 'user-b',
    });
    assert.equal(result.text, 'raw transcript');
    assert.equal(received.url, '/models/transcribe-model');
    assert.equal(received.contentType, 'audio/wav');
    assert.deepEqual(received.body, wav);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('STT excludes inactive providers and preserves provider status details', async () => {
  const candidate = plugin('inactive', 'http://127.0.0.1:9/transcribe', {
    request_mode: 'multipart',
  });
  candidate.active = false;
  const inactive = serviceFor(candidate);
  assert.deepEqual(inactive.getAvailableModels('user-a'), []);
  await assert.rejects(
    inactive.transcribe('transcribe-model', audio, {
      pluginId: candidate.id,
      userId: 'user-a',
    }),
    /No speech-to-text plugin found/
  );

  const { server, port } = await startServer((_req, res) => {
    res.writeHead(422, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Audio was undecodable' } }));
  });
  const failing = plugin('failing', `http://127.0.0.1:${port}/transcribe`, {
    request_mode: 'multipart',
  });
  try {
    await assert.rejects(
      serviceFor(failing).transcribe('transcribe-model', audio, {
        pluginId: failing.id,
        userId: 'user-a',
      }),
      error =>
        error instanceof STTProviderResponseError &&
        error.providerStatus === 422 &&
        error.message === 'Audio was undecodable'
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('legacy direct STT plugins execute through their primary route', async () => {
  const { server, port } = await startServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain the multipart body before responding.
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'legacy transcript' }));
  });
  const candidate = {
    ...plugin('legacy-stt', `http://127.0.0.1:${port}/unused`),
    type: 'stt',
    endpoint: `http://127.0.0.1:${port}/transcribe`,
    model_map: ['transcribe-model'],
    capabilities: undefined,
  };
  const service = serviceFor(candidate);

  try {
    assert.deepEqual(service.getAvailableModels('user-a'), [
      {
        model: 'transcribe-model',
        plugin: 'legacy-stt',
        config: undefined,
      },
    ]);
    const result = await service.transcribe('transcribe-model', audio, {
      pluginId: candidate.id,
      userId: 'user-a',
    });
    assert.equal(result.text, 'legacy transcript');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('STT validates MIME, content signatures, configured formats, and size', () => {
  const file = mimetype => ({
    buffer: wav,
    originalname: 'recording.wav',
    mimetype,
    size: wav.length,
  });
  assert.equal(validateSTTAudio(file('audio/wav')).format, 'wav');
  assert.throws(
    () => validateSTTAudio(file('audio/mpeg')),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'signature_mismatch'
  );
  assert.throws(
    () => validateSTTAudio(file('audio/wav'), { formats: ['mp3'] }),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'unsupported_mime_type'
  );
  assert.throws(
    () => validateSTTAudio(file('audio/wav'), { max_audio_bytes: 8 }),
    error =>
      error instanceof STTAudioUploadError && error.code === 'file_too_large'
  );
  const webm = validateSTTAudio({
    buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
    originalname: 'recording.webm',
    mimetype: 'audio/webm;codecs=opus',
    size: 8,
  });
  assert.equal(webm.format, 'webm');
});

test('bundled OpenAI and Hugging Face STT manifests are executable contracts', () => {
  const openai = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins/openai.json'), 'utf8')
  );
  const huggingface = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins/huggingface.json'), 'utf8')
  );
  assert.equal(openai.capabilities.stt.config.request_mode, 'multipart');
  assert.match(openai.capabilities.stt.endpoint, /\/audio\/transcriptions$/);
  assert.equal(huggingface.capabilities.stt.config.request_mode, 'raw');
  assert.match(huggingface.capabilities.stt.endpoint, /\{model\}$/);
  for (const manifest of [openai, huggingface]) {
    const variable = manifest.capabilities.stt.config.endpoint_variable;
    assert.ok(manifest.variables.some(entry => entry.name === variable));
  }
});

test('STT rejects oversized provider transcripts', async () => {
  const { server, port } = await startServer(async (req, res) => {
    for await (const _chunk of req) {
      // Drain request.
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ text: 'x'.repeat(200_001) }));
  });
  const candidate = plugin('oversized', `http://127.0.0.1:${port}/transcribe`, {
    request_mode: 'multipart',
  });
  try {
    await assert.rejects(
      serviceFor(candidate).transcribe('transcribe-model', audio, {
        pluginId: candidate.id,
        userId: 'user-a',
      }),
      /oversized transcript/
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('STT upload accepts only the bounded transcription form', async () => {
  const app = express();
  app.post('/upload', async (req, res) => {
    try {
      await parseSTTAudioUpload(req, res);
      res.json({ fields: req.body, size: req.file?.buffer.length });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  const { server, port } = await startServer(app);

  const makeForm = extra => {
    const form = new FormData();
    form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'voice.wav');
    form.append('model', 'transcribe-model');
    form.append('pluginId', 'openai');
    form.append('language', 'en');
    form.append('prompt', 'Libre WebUI');
    if (extra) form.append('unexpected', 'blocked');
    return form;
  };

  try {
    const accepted = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      body: makeForm(false),
    });
    assert.equal(accepted.status, 200, await accepted.text());

    const rejected = await fetch(`http://127.0.0.1:${port}/upload`, {
      method: 'POST',
      body: makeForm(true),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
