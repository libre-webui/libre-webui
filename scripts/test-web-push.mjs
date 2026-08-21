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

/*
 * Web Push (CLIENT-01): RFC 8291 aes128gcm encryption against the published
 * test vector, VAPID key persistence and ES256 authorization, subscription
 * validation and endpoint hygiene, per-device dedup, session-revocation
 * cleanup, and the notification fan-out enqueueing one durable delivery per
 * registered device.
 */

import assert from 'node:assert/strict';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-web-push-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'web-push-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '7'.repeat(64);
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});
const { initializeCoordinator, getCoordinator } = await distModule(
  'platform/coordination/service.js'
);
await initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
const runtime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const eventsModule = await distModule('platform/events/index.js');
eventsModule.initializeDurableEventGateway(runtime.service, getCoordinator());

const [
  { getDatabase },
  webPush,
  { notificationService },
  sessions,
  { PUSH_DELIVER_JOB_TYPE },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/webPushService.js'),
  distModule('services/notificationService.js'),
  distModule('services/authSessionService.js'),
  distModule('platform/jobs/domainJobContracts.js'),
]);

const database = getDatabase();
const now = Date.now();
const createUser = id => {
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status, avatar,
          created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
    )
    .run(id, id, now, now);
};
const OWNER = 'push-owner';
createUser(OWNER);

after(async () => {
  await runtime.close?.();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

const validSubscription = (endpoint = 'https://push.example.com/send/abc') => ({
  endpoint,
  keys: {
    // Any valid P-256 point works for storage; use the RFC vector's key.
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
});

test('payload encryption reproduces the RFC 8291 test vector', () => {
  const body = webPush.encryptPushPayload(
    Buffer.from(
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'base64url'
    ),
    Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'),
    Buffer.from('When I grow up, I want to be a watermelon', 'utf8'),
    {
      ephemeralPrivateKey: Buffer.from(
        'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
        'base64url'
      ),
      salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
    }
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
      'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
  );
});

test('VAPID keys generate once, persist, and sign a verifiable ES256 token', async () => {
  const keys = await webPush.getVapidKeys();
  const again = await webPush.getVapidKeys();
  assert.equal(keys.publicKey, again.publicKey);
  const publicPoint = Buffer.from(keys.publicKey, 'base64url');
  assert.equal(publicPoint.length, 65);
  assert.equal(publicPoint[0], 0x04);

  const authorization = await webPush.buildVapidAuthorization(
    'https://push.example.com'
  );
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
  assert.ok(match, 'authorization header has the vapid t=..., k=... shape');
  assert.equal(match[2], keys.publicKey);

  const [headerPart, payloadPart, signaturePart] = match[1].split('.');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString());
  assert.equal(header.alg, 'ES256');
  assert.equal(payload.aud, 'https://push.example.com');
  assert.ok(payload.exp > Date.now() / 1000);
  assert.match(payload.sub, /^(mailto:|https:)/);

  const verifyKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: publicPoint.subarray(1, 33).toString('base64url'),
      y: publicPoint.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  assert.equal(
    cryptoVerify(
      'sha256',
      Buffer.from(`${headerPart}.${payloadPart}`, 'utf8'),
      { key: verifyKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signaturePart, 'base64url')
    ),
    true
  );
});

test('subscriptions validate endpoints and keys and deduplicate per endpoint', async () => {
  await assert.rejects(
    () =>
      webPush.subscribe(
        OWNER,
        null,
        validSubscription('http://push.example.com/insecure'),
        null
      ),
    /HTTPS/
  );
  await assert.rejects(
    () =>
      webPush.subscribe(
        OWNER,
        null,
        validSubscription('https://10.0.0.8/private'),
        null
      ),
    /private or local/
  );
  await assert.rejects(
    () =>
      webPush.subscribe(
        OWNER,
        null,
        {
          endpoint: 'https://push.example.com/send/short-key',
          keys: { p256dh: 'AAAA', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
        },
        null
      ),
    /p256dh/
  );

  const first = await webPush.subscribe(
    OWNER,
    null,
    validSubscription(),
    'agent-one'
  );
  const second = await webPush.subscribe(
    OWNER,
    null,
    validSubscription(),
    'agent-two'
  );
  assert.equal(first.id, second.id, 'same endpoint stays one subscription');
  const stored = await webPush.listSubscriptionsForUser(OWNER);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].user_agent, 'agent-two');
  // The endpoint and keys are encrypted at rest.
  assert.ok(!stored[0].subscription.includes('push.example.com'));
});

test('publishing a notification enqueues one durable push per device', async () => {
  await webPush.subscribe(
    OWNER,
    null,
    validSubscription('https://push.example.com/send/second-device'),
    null
  );
  const published = await notificationService.publish({
    userId: OWNER,
    type: 'system',
    title: 'Push fan-out check',
    body: 'Body stays encrypted in the inbox',
    sourceKey: 'push-fanout',
  });
  assert.equal(published, true);
  const jobs = database
    .prepare('SELECT COUNT(*) AS count FROM platform_jobs WHERE job_type = ?')
    .get(PUSH_DELIVER_JOB_TYPE);
  assert.equal(jobs.count, 2, 'one delivery per registered device');
});

test('revoking an auth session removes its device subscriptions', async () => {
  const session = await sessions.createAuthSession(
    OWNER,
    { kind: 'password' },
    Date.now() + 60_000
  );
  await webPush.subscribe(
    OWNER,
    session.id,
    validSubscription('https://push.example.com/send/session-bound'),
    null
  );
  assert.equal((await webPush.listSubscriptionsForUser(OWNER)).length, 3);

  webPush.registerPushSessionCleanup();
  await sessions.revokeAuthSession(session.id, OWNER);
  // The cleanup listener runs asynchronously off the revocation dispatch.
  let remaining = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    remaining = await webPush.listSubscriptionsForUser(OWNER);
    if (remaining.length === 2) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(remaining.length, 2);
  assert.ok(remaining.every(row => row.session_id !== session.id));

  // Unsubscribe removes exactly the named endpoint.
  assert.equal(
    await webPush.unsubscribe(
      OWNER,
      'https://push.example.com/send/second-device'
    ),
    true
  );
  assert.equal((await webPush.listSubscriptionsForUser(OWNER)).length, 1);
});
