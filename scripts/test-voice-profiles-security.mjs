/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

process.env.ENCRYPTION_KEY ||= '8'.repeat(64);
process.env.JWT_SECRET ||= 'voice-profile-security-test-jwt-secret';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const originalWorkingDirectory = process.cwd();
const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-voice-profile-security-')
);
process.env.DATA_DIR = path.join(testDataDir, 'data');
process.chdir(testDataDir);

const databaseModule = await import(
  pathToFileURL(path.join(distRoot, 'db.js')).href
);
const voiceProfileService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'voiceProfileService.js'))
      .href
  )
).default;
const { encryptionService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'encryptionService.js')).href
);
const pluginService = (
  await import(
    pathToFileURL(path.join(distRoot, 'services', 'pluginService.js')).href
  )
).default;
const { authService } = await import(
  pathToFileURL(path.join(distRoot, 'services', 'authService.js')).href
);
const ttsRoutes = (
  await import(pathToFileURL(path.join(distRoot, 'routes', 'tts.js')).href)
).default;
const mediaRoutes = (
  await import(pathToFileURL(path.join(distRoot, 'routes', 'media.js')).href)
).default;

const ROUTING_FINGERPRINT = 'a'.repeat(64);

after(() => {
  databaseModule.closeDatabase();
  process.chdir(originalWorkingDirectory);
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function upsertUser(userId) {
  const now = Date.now();
  databaseModule
    .getDatabase()
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, avatar, created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .run(userId, userId, now, now);
  return {
    id: userId,
    username: userId,
    email: null,
    role: 'user',
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
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
    for (const [key, value] of originals) target[key] = value;
  }
}

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

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function clonePlugin() {
  return {
    id: 'longcat-audiodit',
    name: 'LongCat AudioDiT',
    type: 'tts',
    active: true,
    endpoint: 'http://127.0.0.1:9/v1/audio/speech',
    auth: { header: '', prefix: '', key_env: '' },
    model_map: ['meituan-longcat/LongCat-AudioDiT-3.5B'],
    capabilities: {
      tts: {
        endpoint: 'http://127.0.0.1:9/v1/audio/speech',
        model_map: ['meituan-longcat/LongCat-AudioDiT-3.5B'],
        config: {
          no_auth_required: true,
          supports_voice_cloning: true,
          voice_clone_endpoint: 'http://127.0.0.1:9/v1/audio/voice-clone',
          clone_requires_transcript: true,
          clone_audio_mime_types: ['audio/wav'],
          clone_max_audio_bytes: 1024,
          formats: ['wav'],
          default_format: 'wav',
        },
      },
    },
  };
}

function savedVoiceCloneForm({
  consent = true,
  name = 'Saved from route',
} = {}) {
  const form = new FormData();
  form.set('saveVoiceName', name);
  form.set('pluginId', 'longcat-audiodit');
  form.set('model', 'meituan-longcat/LongCat-AudioDiT-3.5B');
  form.set('input', 'verify this reusable voice');
  form.set('reference_text', 'exact route transcript');
  form.set('response_format', 'wav');
  if (consent) form.set('consentToStore', 'true');
  form.set(
    'reference_audio',
    new Blob([wavAudio('route-secret').buffer], { type: 'audio/wav' }),
    'reference.wav'
  );
  return form;
}

function wavAudio(marker = 'reference-secret') {
  const buffer = Buffer.from(`RIFFxxxxWAVE${marker}`, 'utf8');
  return {
    buffer,
    originalname: 'reference.wav',
    mimetype: 'audio/wav',
    format: 'wav',
    size: buffer.length,
  };
}

function createProfile(userId, overrides = {}) {
  return voiceProfileService.create(userId, {
    name: 'Private voice',
    pluginId: 'longcat-audiodit',
    model: 'meituan-longcat/LongCat-AudioDiT-3.5B',
    routingFingerprint: ROUTING_FINGERPRINT,
    referenceAudio: wavAudio(),
    referenceText: 'exact reference transcript',
    ...overrides,
  });
}

function sparseWavAudio(size, marker = 'quota-secret') {
  const buffer = Buffer.alloc(size);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  buffer.write(marker, 12, 'ascii');
  return {
    buffer,
    originalname: 'reference.wav',
    mimetype: 'audio/wav',
    format: 'wav',
    size: buffer.length,
  };
}

test('voice profile secrets are encrypted at rest and authenticated to their row owner', () => {
  const ownerId = 'voice-profile-encryption-owner';
  upsertUser(ownerId);
  const profile = createProfile(ownerId);
  const row = databaseModule
    .getDatabase()
    .prepare('SELECT * FROM voice_profiles WHERE id = ?')
    .get(profile.id);

  assert.ok(Buffer.isBuffer(row.name));
  assert.ok(Buffer.isBuffer(row.reference_audio));
  assert.ok(Buffer.isBuffer(row.reference_text));
  assert.equal(row.name.subarray(0, 4).toString('ascii'), 'LWB1');
  assert.equal(row.reference_audio.subarray(0, 4).toString('ascii'), 'LWB1');
  assert.equal(row.reference_text.subarray(0, 4).toString('ascii'), 'LWB1');
  assert.equal(row.name.includes(Buffer.from('Private voice')), false);
  assert.equal(
    row.reference_audio.includes(Buffer.from('reference-secret')),
    false
  );
  assert.equal(
    row.reference_text.includes(Buffer.from('exact reference transcript')),
    false
  );

  const loaded = voiceProfileService.get(profile.id, ownerId, {
    clone_audio_mime_types: ['audio/wav'],
  });
  assert.equal(loaded.name, 'Private voice');
  assert.equal(loaded.referenceText, 'exact reference transcript');
  assert.deepEqual(loaded.referenceAudio.buffer, wavAudio().buffer);

  const originalLoggerError = console.error;
  console.error = () => {};
  try {
    assert.throws(
      () =>
        encryptionService.decryptBuffer(
          row.reference_audio,
          Buffer.from(`voice-profile:${profile.id}:another-user:audio`, 'utf8')
        ),
      /Failed to decrypt binary data/
    );

    const tampered = Buffer.from(row.reference_audio);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(
      () =>
        encryptionService.decryptBuffer(
          tampered,
          Buffer.from(`voice-profile:${profile.id}:${ownerId}:audio`, 'utf8')
        ),
      /Failed to decrypt binary data/
    );
  } finally {
    console.error = originalLoggerError;
  }
});

test('list, get, and delete enforce ownership and expose metadata only', () => {
  const ownerId = 'voice-profile-isolation-owner';
  const attackerId = 'voice-profile-isolation-attacker';
  upsertUser(ownerId);
  upsertUser(attackerId);
  const profile = createProfile(ownerId);

  const ownerList = voiceProfileService.list(ownerId);
  assert.equal(
    ownerList.some(item => item.id === profile.id),
    true
  );
  assert.equal('referenceAudio' in ownerList[0], false);
  assert.equal('referenceText' in ownerList[0], false);

  assert.equal(voiceProfileService.list(attackerId).length, 0);
  assert.equal(voiceProfileService.get(profile.id, attackerId), null);
  assert.equal(voiceProfileService.delete(profile.id, attackerId), false);
  assert.ok(voiceProfileService.get(profile.id, ownerId));
  assert.equal(voiceProfileService.delete(profile.id, ownerId), true);
  assert.equal(voiceProfileService.get(profile.id, ownerId), null);
});

test('profile queries remain bound to the saved provider and model', () => {
  const ownerId = 'voice-profile-routing-owner';
  upsertUser(ownerId);
  const profile = createProfile(ownerId);

  assert.deepEqual(
    voiceProfileService
      .list(ownerId, {
        pluginId: 'longcat-audiodit',
        model: 'meituan-longcat/LongCat-AudioDiT-3.5B',
      })
      .map(item => item.id),
    [profile.id]
  );
  assert.deepEqual(
    voiceProfileService.list(ownerId, { pluginId: 'different-provider' }),
    []
  );
  assert.deepEqual(
    voiceProfileService.list(ownerId, { model: 'different/model' }),
    []
  );
  assert.throws(
    () => voiceProfileService.list(ownerId, { pluginId: '../provider' }),
    /Invalid TTS plugin ID/
  );
  assert.throws(
    () => voiceProfileService.list(ownerId, { model: '../model' }),
    /invalid patterns/
  );
});

test('saved voice use fails closed after provider routing changes', async () => {
  const owner = upsertUser('voice-profile-routing-change-owner');
  const profile = createProfile(owner.id);
  const plugin = clonePlugin();
  const app = express();
  app.use(express.json());
  app.use('/api/tts', ttsRoutes);
  const server = await listen(app);

  try {
    await withPatchedProperties(
      pluginService,
      {
        getPluginForTTS: () => plugin,
        getCredentialRoutingAuthFingerprint: () => 'b'.repeat(64),
        executeVoiceCloneRequest: async () => {
          throw new Error('provider must not be called');
        },
      },
      async () => {
        const response = await fetch(`${server.baseUrl}/api/tts/generate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authService.generateToken(owner)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: profile.model,
            pluginId: profile.pluginId,
            input: 'do not forward this stored voice',
            voiceProfileId: profile.id,
            response_format: 'wav',
          }),
        });
        assert.equal(response.status, 400);
        assert.match((await response.json()).message, /routing changed/i);
      }
    );
  } finally {
    await server.close();
  }
});

test('profile validation bounds names, transcripts, and per-user storage', () => {
  const ownerId = 'voice-profile-limits-owner';
  upsertUser(ownerId);

  for (const [name, pattern] of [
    ['', /name is required/],
    ['a'.repeat(81), /at most 80 characters/],
    ['line\nbreak', /unsupported characters/],
  ]) {
    assert.throws(() => createProfile(ownerId, { name }), pattern);
  }
  assert.throws(
    () => createProfile(ownerId, { referenceText: 't'.repeat(32_001) }),
    /at most 32000 characters/
  );

  for (let index = 0; index < 50; index += 1) {
    createProfile(ownerId, {
      name: `Voice ${index}`,
      referenceText: undefined,
    });
  }
  assert.throws(
    () => createProfile(ownerId, { name: 'Voice 51' }),
    /maximum of 50 saved voice profiles/
  );
});

test('profile storage enforces duplicate names and aggregate audio quota atomically', () => {
  const duplicateOwnerId = 'voice-profile-duplicate-owner';
  upsertUser(duplicateOwnerId);
  createProfile(duplicateOwnerId, { name: 'My Voice' });
  assert.throws(
    () => createProfile(duplicateOwnerId, { name: 'my voice' }),
    /already exists/
  );

  const quotaOwnerId = 'voice-profile-quota-owner';
  upsertUser(quotaOwnerId);
  const database = databaseModule.getDatabase();
  const now = Date.now();
  database
    .prepare(
      `INSERT INTO voice_profiles
         (id, user_id, name, plugin_id, model, routing_fingerprint, reference_audio,
          reference_text, audio_mime_type, audio_format, audio_size,
          consent_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      'quota-fixture',
      quotaOwnerId,
      encryptionService.encryptBuffer(
        Buffer.from('Quota fixture'),
        Buffer.from(`voice-profile:quota-fixture:${quotaOwnerId}:name`, 'utf8')
      ),
      'longcat-audiodit',
      'meituan-longcat/LongCat-AudioDiT-3.5B',
      ROUTING_FINGERPRINT,
      Buffer.from('LWB1fixture'),
      'audio/wav',
      'wav',
      100 * 1024 * 1024 - 16,
      now,
      now,
      now
    );

  assert.throws(
    () =>
      createProfile(quotaOwnerId, {
        name: 'Over quota',
        referenceAudio: sparseWavAudio(17),
      }),
    /limited to 104857600 bytes/
  );
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM voice_profiles WHERE user_id = ?')
      .get(quotaOwnerId).count,
    1,
    'a failed quota check must not leave a partial row'
  );
});

test('deleting a user cascades deletion of encrypted voice profiles', () => {
  const ownerId = 'voice-profile-cascade-owner';
  upsertUser(ownerId);
  const profile = createProfile(ownerId);
  const database = databaseModule.getDatabase();

  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM voice_profiles WHERE id = ?')
      .get(profile.id).count,
    1
  );
  database.prepare('DELETE FROM users WHERE id = ?').run(ownerId);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM voice_profiles WHERE id = ?')
      .get(profile.id).count,
    0
  );
});

test('HTTP routes require consent, redact secrets, isolate owners, and bind profile use to its provider route', async () => {
  const owner = upsertUser('voice-profile-route-owner');
  const attacker = upsertUser('voice-profile-route-attacker');
  const ownerHeaders = {
    Authorization: `Bearer ${authService.generateToken(owner)}`,
  };
  const attackerHeaders = {
    Authorization: `Bearer ${authService.generateToken(attacker)}`,
  };
  const plugin = clonePlugin();
  const cloneCalls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/tts', ttsRoutes);
  app.use('/api/media', mediaRoutes);
  const server = await listen(app);

  try {
    await withPatchedProperties(
      pluginService,
      {
        getCredentialRoutingAuthFingerprint: () => ROUTING_FINGERPRINT,
        getPluginForTTS: (model, pluginId) =>
          model === 'meituan-longcat/LongCat-AudioDiT-3.5B' &&
          (!pluginId || pluginId === plugin.id)
            ? plugin
            : null,
        executeVoiceCloneRequest: async (
          model,
          input,
          referenceAudio,
          options
        ) => {
          cloneCalls.push({ model, input, referenceAudio, options });
          return Buffer.from('RIFFxxxxWAVEprofile-output');
        },
      },
      async () => {
        const noConsent = await fetch(
          `${server.baseUrl}/api/media/audio/voice-clone`,
          {
            method: 'POST',
            headers: ownerHeaders,
            body: savedVoiceCloneForm({ consent: false }),
          }
        );
        assert.equal(noConsent.status, 400);
        assert.match((await noConsent.json()).message, /consent/i);

        const created = await fetch(
          `${server.baseUrl}/api/media/audio/voice-clone`,
          {
            method: 'POST',
            headers: ownerHeaders,
            body: savedVoiceCloneForm(),
          }
        );
        assert.equal(created.status, 200);
        const createdBody = await created.json();
        assert.equal(createdBody.success, true);
        assert.doesNotMatch(JSON.stringify(createdBody), /route-secret/);
        assert.doesNotMatch(
          JSON.stringify(createdBody),
          /exact route transcript/
        );

        const ownerList = await fetch(
          `${server.baseUrl}/api/tts/voice-profiles`,
          { headers: ownerHeaders }
        );
        assert.equal(ownerList.status, 200);
        const ownerListBody = await ownerList.json();
        assert.equal(ownerListBody.data.length, 1);
        assert.equal(ownerListBody.data[0].name, 'Saved from route');
        const profileId = ownerListBody.data[0].id;
        assert.equal('referenceAudio' in ownerListBody.data[0], false);
        assert.equal('referenceText' in ownerListBody.data[0], false);

        const attackerList = await fetch(
          `${server.baseUrl}/api/tts/voice-profiles`,
          { headers: attackerHeaders }
        );
        assert.equal(attackerList.status, 200);
        assert.deepEqual((await attackerList.json()).data, []);

        const attackerUse = await fetch(`${server.baseUrl}/api/tts/generate`, {
          method: 'POST',
          headers: { ...attackerHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'meituan-longcat/LongCat-AudioDiT-3.5B',
            pluginId: plugin.id,
            input: 'stolen voice attempt',
            voiceProfileId: profileId,
            response_format: 'wav',
          }),
        });
        assert.equal(attackerUse.status, 404);
        assert.match((await attackerUse.json()).message, /not found/i);
        assert.equal(cloneCalls.length, 1);

        const mismatchedModel = await fetch(
          `${server.baseUrl}/api/tts/generate`,
          {
            method: 'POST',
            headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'different/model',
              pluginId: plugin.id,
              input: 'wrong route attempt',
              voiceProfileId: profileId,
              response_format: 'wav',
            }),
          }
        );
        assert.equal(mismatchedModel.status, 400);
        assert.match((await mismatchedModel.json()).message, /does not match/i);
        assert.equal(cloneCalls.length, 1);

        const conflictingVoice = await fetch(
          `${server.baseUrl}/api/tts/generate`,
          {
            method: 'POST',
            headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'meituan-longcat/LongCat-AudioDiT-3.5B',
              pluginId: plugin.id,
              input: 'ambiguous voice attempt',
              voice: 'preset',
              voiceProfileId: profileId,
              response_format: 'wav',
            }),
          }
        );
        assert.equal(conflictingVoice.status, 400);
        assert.match(
          (await conflictingVoice.json()).message,
          /cannot be used together/i
        );
        assert.equal(cloneCalls.length, 1);

        const generated = await fetch(`${server.baseUrl}/api/tts/generate`, {
          method: 'POST',
          headers: { ...ownerHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'meituan-longcat/LongCat-AudioDiT-3.5B',
            pluginId: plugin.id,
            input: 'authorized saved voice',
            voiceProfileId: profileId,
            response_format: 'wav',
          }),
        });
        assert.equal(generated.status, 200);
        assert.equal(generated.headers.get('content-type'), 'audio/wav');
        assert.equal(cloneCalls.length, 2);
        assert.equal(cloneCalls[1].model, ownerListBody.data[0].model);
        assert.equal(
          cloneCalls[1].options.pluginId,
          ownerListBody.data[0].pluginId
        );
        assert.equal(cloneCalls[1].options.userId, owner.id);
        assert.equal(
          cloneCalls[1].options.referenceText,
          'exact route transcript'
        );
        assert.deepEqual(
          cloneCalls[1].referenceAudio.buffer,
          wavAudio('route-secret').buffer
        );

        const attackerDelete = await fetch(
          `${server.baseUrl}/api/tts/voice-profiles/${profileId}`,
          { method: 'DELETE', headers: attackerHeaders }
        );
        assert.equal(attackerDelete.status, 404);
        assert.ok(voiceProfileService.getMetadata(profileId, owner.id));

        const ownerDelete = await fetch(
          `${server.baseUrl}/api/tts/voice-profiles/${profileId}`,
          { method: 'DELETE', headers: ownerHeaders }
        );
        assert.equal(ownerDelete.status, 204);
        assert.equal(
          voiceProfileService.getMetadata(profileId, owner.id),
          null
        );
      }
    );
  } finally {
    await server.close();
  }
});

test('saved-voice generation caps in-flight batches per user and globally across response modes', async () => {
  const owner = upsertUser('voice-profile-concurrency-owner');
  const peer = upsertUser('voice-profile-concurrency-peer');
  const third = upsertUser('voice-profile-concurrency-third');
  const profile = createProfile(owner.id, { name: 'Owner concurrent voice' });
  const peerProfile = createProfile(peer.id, { name: 'Peer concurrent voice' });
  const thirdProfile = createProfile(third.id, {
    name: 'Third concurrent voice',
  });
  const plugin = clonePlugin();
  const pendingProviderCalls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/tts', ttsRoutes);
  const server = await listen(app);
  const headersFor = user => ({
    Authorization: `Bearer ${authService.generateToken(user)}`,
    'Content-Type': 'application/json',
  });
  const generate = (user, profileId, index, base64 = false) =>
    fetch(
      `${server.baseUrl}/api/tts/${base64 ? 'generate-base64' : 'generate'}`,
      {
        method: 'POST',
        headers: headersFor(user),
        body: JSON.stringify({
          model: 'meituan-longcat/LongCat-AudioDiT-3.5B',
          pluginId: plugin.id,
          input: `concurrent batch ${index}`,
          voiceProfileId: profileId,
          response_format: 'wav',
        }),
      }
    );

  try {
    await withPatchedProperties(
      pluginService,
      {
        getCredentialRoutingAuthFingerprint: () => ROUTING_FINGERPRINT,
        getPluginForTTS: () => plugin,
        executeVoiceCloneRequest: (...args) =>
          new Promise(resolve => {
            pendingProviderCalls.push({ args, resolve });
          }),
      },
      async () => {
        const firstFour = Array.from({ length: 4 }, (_, index) =>
          generate(owner, profile.id, index, index % 2 === 1)
        );
        await waitUntil(
          () => pendingProviderCalls.length === 4,
          'Four owner batches did not reach the provider'
        );

        const rejected = await generate(owner, profile.id, 5);
        assert.equal(rejected.status, 429);
        assert.match(
          (await rejected.json()).message,
          /concurrent saved-voice/i
        );
        assert.equal(pendingProviderCalls.length, 4);

        const peerRequests = Array.from({ length: 4 }, (_, index) =>
          generate(peer, peerProfile.id, index + 6, index % 2 === 0)
        );
        await waitUntil(
          () => pendingProviderCalls.length === 8,
          'A separate user should receive an independent per-user budget'
        );

        const globalRejected = await generate(third, thirdProfile.id, 10);
        assert.equal(globalRejected.status, 429);
        assert.match(
          (await globalRejected.json()).message,
          /concurrent saved-voice/i
        );

        for (const pending of pendingProviderCalls.splice(0)) {
          pending.resolve(Buffer.from('RIFFxxxxWAVEconcurrent-output'));
        }
        assert.deepEqual(
          (await Promise.all(firstFour)).map(response => response.status),
          [200, 200, 200, 200]
        );
        assert.deepEqual(
          (await Promise.all(peerRequests)).map(response => response.status),
          [200, 200, 200, 200]
        );

        const afterRelease = generate(owner, profile.id, 6);
        await waitUntil(
          () => pendingProviderCalls.length === 1,
          'Owner slot was not released after provider completion'
        );
        pendingProviderCalls
          .shift()
          .resolve(Buffer.from('RIFFxxxxWAVEreleased-output'));
        assert.equal((await afterRelease).status, 200);
      }
    );
  } finally {
    for (const pending of pendingProviderCalls.splice(0)) {
      pending.resolve(Buffer.from('RIFFxxxxWAVEcleanup'));
    }
    await server.close();
  }
});
