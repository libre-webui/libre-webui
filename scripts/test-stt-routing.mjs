import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const testDataDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-stt-routing-')
);
const previousDataDirectory = process.env.DATA_DIR;
const previousEncryptionKey = process.env.ENCRYPTION_KEY;
process.env.DATA_DIR = testDataDirectory;
process.env.ENCRYPTION_KEY = '7'.repeat(64);

after(() => {
  if (previousDataDirectory === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDirectory;
  if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = previousEncryptionKey;
  fs.rmSync(testDataDirectory, { recursive: true, force: true });
});

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
const { requestAbortSignal } = await import(
  pathToFileURL(path.join(repoRoot, 'backend/dist/routes/stt.js')).href
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

function makePcmWav(durationSeconds = 0.1, sampleRate = 16_000) {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = Math.max(
    blockAlign,
    Math.round(durationSeconds * sampleRate) * blockAlign
  );
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function ebmlElement(id, data) {
  assert.ok(data.length < 127, 'fixture element must use a one-byte size');
  return Buffer.concat([
    Buffer.from(id),
    Buffer.from([0x80 | data.length]),
    data,
  ]);
}

function makeOpusWebm() {
  const float = Buffer.alloc(8);
  float.writeDoubleBE(48_000);
  const header = ebmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebmlElement([0x42, 0x82], Buffer.from('webm'))
  );
  const info = ebmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    ebmlElement([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40]))
  );
  const audio = ebmlElement(
    [0xe1],
    Buffer.concat([
      ebmlElement([0xb5], float),
      ebmlElement([0x9f], Buffer.from([1])),
    ])
  );
  const track = ebmlElement(
    [0xae],
    Buffer.concat([
      ebmlElement([0xd7], Buffer.from([1])),
      ebmlElement([0x83], Buffer.from([2])),
      ebmlElement([0x86], Buffer.from('A_OPUS')),
      ebmlElement(
        [0x63, 0xa2],
        Buffer.concat([
          Buffer.from('OpusHead'),
          Buffer.from([1, 1]),
          Buffer.alloc(8),
          Buffer.from([0]),
        ])
      ),
      audio,
    ])
  );
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], track);
  const cluster = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    Buffer.concat([
      ebmlElement([0xe7], Buffer.from([0])),
      ebmlElement([0xa3], Buffer.from([0x81, 0, 0, 0, 0xf8])),
    ])
  );
  const segment = ebmlElement(
    [0x18, 0x53, 0x80, 0x67],
    Buffer.concat([info, tracks, cluster])
  );
  return Buffer.concat([header, segment]);
}

const wav = makePcmWav();
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
    assert.match(received.body, /RIFF/);
    assert.match(received.body, /WAVEfmt/);
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
  assert.deepEqual(await inactive.getAvailableModels('user-a'), []);
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
    assert.deepEqual(await service.getAvailableModels('user-a'), [
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

test('STT validates audio structure, codec metadata, duration, MIME, extension, and size', () => {
  const file = (mimetype, buffer = wav, originalname = 'recording.wav') => ({
    buffer,
    originalname,
    mimetype,
    size: buffer.length,
  });
  const validatedWav = validateSTTAudio(file('audio/wav'));
  assert.equal(validatedWav.format, 'wav');
  assert.equal(validatedWav.codec, 'pcm');
  assert.equal(validatedWav.sampleRate, 16_000);
  assert.equal(validatedWav.channels, 1);
  assert.ok(validatedWav.durationSeconds > 0);
  assert.throws(
    () => validateSTTAudio(file('audio/mpeg')),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'unsupported_mime_type'
  );
  assert.throws(
    () => validateSTTAudio(file('audio/wav'), { formats: ['webm'] }),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'unsupported_mime_type'
  );
  assert.throws(
    () => validateSTTAudio(file('audio/wav'), { max_audio_bytes: 8 }),
    error =>
      error instanceof STTAudioUploadError && error.code === 'file_too_large'
  );
  assert.throws(
    () => validateSTTAudio(file('audio/wav', wav, 'recording.webm')),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'extension_mismatch'
  );
  assert.throws(
    () =>
      validateSTTAudio(
        file(
          'audio/wav',
          Buffer.from('RIFFxxxxWAVEaudio-data'),
          'recording.wav'
        )
      ),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'invalid_audio_structure'
  );
  const trailingWav = Buffer.concat([wav, Buffer.from('trailing')]);
  assert.throws(
    () => validateSTTAudio(file('audio/wav', trailingWav)),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'invalid_audio_structure'
  );
  assert.throws(
    () =>
      validateSTTAudio(file('audio/wav', makePcmWav(2), 'recording.wav'), {
        max_duration_seconds: 1,
      }),
    error =>
      error instanceof STTAudioUploadError && error.code === 'duration_exceeded'
  );

  const webmBytes = makeOpusWebm();
  const webm = validateSTTAudio(
    file('audio/webm;codecs=opus', webmBytes, 'recording.webm')
  );
  assert.equal(webm.format, 'webm');
  assert.equal(webm.codec, 'opus');
  assert.equal(webm.sampleRate, 48_000);
  assert.equal(webm.channels, 1);
  assert.throws(
    () =>
      validateSTTAudio(
        file(
          'audio/webm',
          Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
          'recording.webm'
        )
      ),
    error =>
      error instanceof STTAudioUploadError &&
      error.code === 'invalid_audio_structure'
  );
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
    assert.deepEqual(manifest.capabilities.stt.config.formats, ['wav', 'webm']);
    assert.equal(manifest.capabilities.stt.config.max_duration_seconds, 300);
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

test('STT observes disconnects before upload parsing and provider dispatch', () => {
  const routeSource = fs.readFileSync(
    path.join(repoRoot, 'backend/src/routes/stt.ts'),
    'utf8'
  );
  const signalIndex = routeSource.indexOf(
    'const abort = requestAbortSignal(req, res);'
  );
  const uploadIndex = routeSource.indexOf(
    'await parseSTTAudioUpload(req, res);'
  );
  assert.ok(signalIndex >= 0 && signalIndex < uploadIndex);

  const req = new EventEmitter();
  req.aborted = true;
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  const disconnected = requestAbortSignal(req, res);
  assert.equal(disconnected.signal.aborted, true);
  disconnected.cleanup();

  const liveReq = new EventEmitter();
  liveReq.aborted = false;
  const liveRes = new EventEmitter();
  liveRes.destroyed = false;
  liveRes.writableEnded = false;
  const closing = requestAbortSignal(liveReq, liveRes);
  liveRes.emit('close');
  assert.equal(closing.signal.aborted, true);
  closing.cleanup();
});
