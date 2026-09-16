/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
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
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-email-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'email-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '7'.repeat(64);
// Environment defaults the administrator can override from the UI.
process.env.SMTP_HOST = 'env.mail.test';
process.env.SMTP_FROM = 'Libre WebUI <env@example.test>';
process.env.SMTP_SECURITY = 'none';
process.env.BASE_URL = 'https://chat.example.test';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;
delete process.env.SMTP_PORT;

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
  { getDatabase, closeDatabase },
  { emailService, EmailSettingsError },
  { notificationService },
  { default: preferencesService },
  { userModel },
  { authService },
  { default: emailRouter },
  { EMAIL_DELIVER_JOB_TYPE },
  { createDomainDurableJobHandlers },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/emailService.js'),
  distModule('services/notificationService.js'),
  distModule('services/preferencesService.js'),
  distModule('models/userModel.js'),
  distModule('services/authService.js'),
  distModule('routes/email.js'),
  distModule('platform/jobs/domainJobContracts.js'),
  distModule('platform/jobs/domainJobHandlers.js'),
]);

getDatabase();

const admin = await userModel.createUser({
  username: 'email-admin',
  email: 'admin@example.test',
  password: 'admin-password-123',
  role: 'admin',
});
const subscriber = await userModel.createUser({
  username: 'email-subscriber',
  email: 'subscriber@example.test',
  password: 'subscriber-password-123',
  role: 'user',
});
const bystander = await userModel.createUser({
  username: 'email-bystander',
  email: 'bystander@example.test',
  password: 'bystander-password-123',
  role: 'user',
});
const addressless = await userModel.createUser({
  username: 'email-addressless',
  email: null,
  password: 'addressless-password-123',
  role: 'user',
});
const tokens = {
  admin: authService.generateToken(admin),
  subscriber: authService.generateToken(subscriber),
};

const app = express();
app.use(express.json());
app.use('/api/email', emailRouter);
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const call = (method, route, token, body) =>
  fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

/** Accepts every message; records what arrived. */
const startAcceptingSmtp = async () => {
  const messages = [];
  const sockets = new Set();
  const smtp = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    let current = '';
    const reply = line => socket.write(`${line}\r\n`);
    reply('220 accept.test ready');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index === -1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = '';
            reply('250 2.0.0 queued');
          } else {
            current += `${line}\r\n`;
          }
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          reply('250-accept.test');
          reply('250 8BITMIME');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else {
          reply('250 ok');
        }
      }
    });
  });
  await new Promise(resolve => smtp.listen(0, '127.0.0.1', resolve));
  return {
    port: smtp.address().port,
    messages,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => smtp.close(resolve));
    },
  };
};

const enqueued = [];
const originalEnqueue = runtime.service.enqueue.bind(runtime.service);
runtime.service.enqueue = async input => {
  enqueued.push(input);
  return originalEnqueue(input);
};

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

test('email settings resolve from the environment, override from the UI, and never return the password', async () => {
  const initial = await emailService.getSettings();
  assert.equal(initial.host, 'env.mail.test');
  assert.equal(initial.sources.host, 'env');
  assert.equal(initial.from, 'Libre WebUI <env@example.test>');
  assert.equal(initial.security, 'none');
  assert.equal(initial.port, 587);
  assert.equal(initial.configured, true);
  assert.equal(initial.enabled, false);
  assert.equal(initial.available, false);
  assert.equal(initial.passwordConfigured, false);
  assert.equal('password' in initial, false);

  const stored = await emailService.updateSettings({
    host: 'ui.mail.test',
    port: '2525',
    username: 'relay',
    password: 's3cret-value',
    appUrl: 'https://ui.example.test/',
  });
  assert.equal(stored.host, 'ui.mail.test');
  assert.equal(stored.sources.host, 'stored');
  assert.equal(stored.port, 2525);
  assert.equal(stored.passwordConfigured, true);
  assert.equal(stored.sources.password, 'stored');
  assert.equal(stored.appUrl, 'https://ui.example.test');
  assert.equal(JSON.stringify(stored).includes('s3cret-value'), false);

  // The stored password is encrypted at rest, never plain text.
  const { getSystemSetting } = await distModule(
    'services/systemSettingsService.js'
  );
  const raw = await getSystemSetting('email.smtp.password');
  assert.ok(raw && !raw.includes('s3cret-value'));
  assert.equal(encryptionService.decryptAuthenticated(raw), 's3cret-value');

  // Clearing a field restores the environment default.
  const cleared = await emailService.updateSettings({ host: '' });
  assert.equal(cleared.host, 'env.mail.test');
  assert.equal(cleared.sources.host, 'env');

  await assert.rejects(
    emailService.updateSettings({ port: '70000' }),
    EmailSettingsError
  );
  await assert.rejects(
    emailService.updateSettings({ from: 'not an address' }),
    EmailSettingsError
  );
  await assert.rejects(
    emailService.updateSettings({ security: 'ssl3' }),
    EmailSettingsError
  );
  await assert.rejects(
    emailService.updateSettings({ username: 'lonely', password: '' }),
    EmailSettingsError
  );

  const enabled = await emailService.updateSettings({
    username: '',
    password: '',
    enabled: true,
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.available, true);
  assert.equal(enabled.passwordConfigured, false);
});

test('the settings routes hide server details from users and reject their writes', async () => {
  const asUser = await call('GET', '/api/email/settings', tokens.subscriber);
  assert.equal(asUser.status, 200);
  const userView = (await asUser.json()).data;
  assert.equal(userView.available, true);
  assert.equal(userView.recipient, 'subscriber@example.test');
  assert.equal('host' in userView, false);
  assert.equal('passwordConfigured' in userView, false);

  const forbidden = await call(
    'PUT',
    '/api/email/settings',
    tokens.subscriber,
    {
      enabled: false,
    }
  );
  assert.equal(forbidden.status, 403);
  const forbiddenTest = await call(
    'POST',
    '/api/email/test',
    tokens.subscriber
  );
  assert.equal(forbiddenTest.status, 403);

  const asAdmin = await call('GET', '/api/email/settings', tokens.admin);
  const adminView = (await asAdmin.json()).data;
  assert.equal(adminView.host, 'env.mail.test');
  assert.equal(adminView.sources.host, 'env');
  assert.equal('password' in adminView, false);

  const rejected = await call('PUT', '/api/email/settings', tokens.admin, {
    port: 'abc',
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /port/i);

  const smtp = await startAcceptingSmtp();
  try {
    const saved = await call('PUT', '/api/email/settings', tokens.admin, {
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
    });
    assert.equal(saved.status, 200);
    const tested = await call('POST', '/api/email/test', tokens.admin, {});
    const testedBody = await tested.json();
    assert.equal(tested.status, 200, JSON.stringify(testedBody));
    const outcome = testedBody.data;
    assert.equal(outcome.ok, true);
    assert.equal(outcome.sentTo, 'admin@example.test');
    assert.equal(smtp.messages.length, 1);
    assert.match(
      smtp.messages[0],
      /^From: "Libre WebUI" <env@example\.test>\r\n/
    );
    assert.match(smtp.messages[0], /\r\nTo: admin@example\.test\r\n/);
    assert.match(smtp.messages[0], /\r\nSubject: Libre WebUI test message\r\n/);

    const probeOnly = await call('POST', '/api/email/test', tokens.admin, {
      to: '',
    });
    assert.equal(probeOnly.status, 200);
    assert.equal(
      smtp.messages.length,
      2,
      'admins default to their own address'
    );
  } finally {
    await smtp.close();
  }

  const unreachable = await call('PUT', '/api/email/settings', tokens.admin, {
    port: 1,
  });
  assert.equal(unreachable.status, 200);
  const failed = await call('POST', '/api/email/test', tokens.admin, {});
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).code, 'ERR_SMTP_CONNECT');
});

test('email preferences default off and merge partially', async () => {
  const defaults = await preferencesService.getPreferences(subscriber.id);
  assert.deepEqual(defaults.emailNotifications, {
    channelMentions: false,
    automationRuns: false,
  });
  await preferencesService.updatePreferences(
    { emailNotifications: { channelMentions: true } },
    subscriber.id
  );
  const partial = await preferencesService.getPreferences(subscriber.id);
  assert.deepEqual(partial.emailNotifications, {
    channelMentions: true,
    automationRuns: false,
  });
  await preferencesService.updatePreferences(
    { emailNotifications: { automationRuns: 'yes' } },
    subscriber.id
  );
  const coerced = await preferencesService.getPreferences(subscriber.id);
  assert.deepEqual(coerced.emailNotifications, {
    channelMentions: true,
    automationRuns: false,
  });
});

test('a channel mention and an automation run are emailed only to users who opted in', async () => {
  await preferencesService.updatePreferences(
    { emailNotifications: { channelMentions: true, automationRuns: true } },
    subscriber.id
  );
  await preferencesService.updatePreferences(
    { emailNotifications: { channelMentions: true, automationRuns: true } },
    addressless.id
  );
  enqueued.length = 0;

  const publishMention = userId =>
    notificationService.publish({
      userId,
      type: 'channel-mention',
      title: 'alice mentioned you in #general',
      body: '@you can you look at the build?',
      href: '/channels?channel=general',
      sourceKey: `channel-message:m1:${userId}`,
    });

  assert.equal(await publishMention(subscriber.id), true);
  assert.equal(await publishMention(bystander.id), true);
  assert.equal(await publishMention(addressless.id), true);
  const mentionJobs = enqueued.filter(
    job => job.jobType === EMAIL_DELIVER_JOB_TYPE
  );
  assert.equal(mentionJobs.length, 1, 'only the opted-in user with an address');
  const mention = mentionJobs[0].payload.value;
  assert.equal(mention.to, 'subscriber@example.test');
  assert.equal(mention.kind, 'channelMentions');
  assert.equal(mention.subject, 'alice mentioned you in #general');
  assert.match(mention.text, /can you look at the build\?/);
  assert.match(
    mention.text,
    /https:\/\/ui\.example\.test\/channels\?channel=general/
  );
  assert.match(
    mention.html,
    /<a href="https:\/\/ui\.example\.test\/channels\?channel=general"/
  );

  // A deduplicated mention never produces a second message.
  enqueued.length = 0;
  assert.equal(await publishMention(subscriber.id), false);
  assert.equal(enqueued.length, 0);

  // Direct messages and shares are not emailed: only mentions opt in.
  await notificationService.publish({
    userId: subscriber.id,
    type: 'channel-dm',
    title: 'alice sent you a message',
    sourceKey: `channel-message:m2:${subscriber.id}`,
  });
  assert.equal(enqueued.length, 0);

  const emailed = await emailService.notifyAutomationRun({
    userId: subscriber.id,
    runId: 'run-1',
    automationName: 'Morning digest',
    status: 'succeeded',
    result: 'Three items need your attention today.\n\n1. ...',
    href: '/c/session-1',
  });
  assert.equal(emailed, true);
  const runJob = enqueued.find(job => job.jobType === EMAIL_DELIVER_JOB_TYPE);
  assert.ok(runJob);
  assert.equal(runJob.idempotencyKey, `${subscriber.id}:automation-run:run-1`);
  assert.equal(runJob.payload.value.kind, 'automationRuns');
  assert.equal(
    runJob.payload.value.subject,
    'Automation finished: Morning digest'
  );
  assert.match(runJob.payload.value.text, /Three items need your attention/);
  assert.match(
    runJob.payload.value.text,
    /https:\/\/ui\.example\.test\/c\/session-1/
  );

  enqueued.length = 0;
  const failedRun = await emailService.notifyAutomationRun({
    userId: subscriber.id,
    runId: 'run-2',
    automationName: 'Morning digest',
    status: 'failed',
    error: 'model unavailable',
  });
  assert.equal(failedRun, true);
  assert.equal(
    enqueued[0].payload.value.subject,
    'Automation failed: Morning digest'
  );
  assert.match(enqueued[0].payload.value.text, /Error: model unavailable/);

  enqueued.length = 0;
  assert.equal(
    await emailService.notifyAutomationRun({
      userId: bystander.id,
      runId: 'run-3',
      automationName: 'Nope',
      status: 'succeeded',
    }),
    false
  );
  assert.equal(enqueued.length, 0);
});

test('the delivery job sends through the configured server and settles when email is switched off', async () => {
  const handlers = createDomainDurableJobHandlers();
  const deliver = handlers.get(EMAIL_DELIVER_JOB_TYPE);
  assert.ok(deliver);
  const context = payload => ({
    payload,
    signal: new AbortController().signal,
    assertSideEffectAllowed: async () => undefined,
  });
  const payload = {
    kind: 'channelMentions',
    to: 'subscriber@example.test',
    subject: 'Ping',
    text: 'You were mentioned.',
    html: '<p>You were mentioned.</p>',
  };

  const smtp = await startAcceptingSmtp();
  try {
    await emailService.updateSettings({
      host: '127.0.0.1',
      port: smtp.port,
      security: 'none',
      enabled: true,
    });
    const delivered = await deliver(context(payload));
    assert.equal(delivered.resultReference, 'email:channelMentions:delivered');
    assert.equal(smtp.messages.length, 1);
    assert.match(smtp.messages[0], /multipart\/alternative/);
  } finally {
    await smtp.close();
  }

  // The relay is gone: a transient failure asks for a retry.
  await assert.rejects(deliver(context(payload)), error => {
    assert.equal(error.retryable, true);
    assert.equal(error.safeCode, 'email-delivery-failed');
    return true;
  });

  await assert.rejects(
    deliver(context({ ...payload, to: '' })),
    error => error.retryable === false && error.safeCode === 'invalid-payload'
  );

  await emailService.updateSettings({ enabled: false });
  const settled = await deliver(context(payload));
  assert.equal(settled.resultReference, 'email:channelMentions:unavailable');
});
