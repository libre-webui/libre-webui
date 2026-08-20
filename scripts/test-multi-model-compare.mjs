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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-compare-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { closeDatabase, getDatabase } = await import(dist('db.js'));
const closePlatformStorageFixture =
  await initializeSQLitePlatformStorageFixture(
    path.join(repoRoot, 'backend', 'dist')
  );
const { default: chatService } = await import(dist('services/chatService.js'));
const { default: durableChatGenerationService } = await import(
  dist('services/durableChatGenerationService.js')
);
const { createDomainDurableJobHandlers } = await import(
  dist('platform/jobs/domainJobHandlers.js')
);
const { EmbeddedDurableJobWorker } = await import(
  dist('platform/jobs/embeddedDurableJobWorker.js')
);
const { getDurableJobRuntime } = await import(
  dist('platform/jobs/durableJobRuntime.js')
);

const USER = 'compare-user';

after(async () => {
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
getDatabase()
  .prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
  )
  .run(USER, USER, now, now);

const session = await chatService.createSession('primary-model', 'cmp', USER);

test('a comparison fan-out shares one user turn across independent jobs', async () => {
  const userMessageId = 'cmp-user-1';
  const primary = await chatService.queueDurableGeneration({
    sessionId: session.id,
    userId: USER,
    userMessageId,
    assistantMessageId: 'cmp-assistant-primary',
    message: 'compare this prompt',
  });
  assert.ok(primary?.jobId);

  const comparison = await chatService.queueDurableGeneration({
    sessionId: session.id,
    userId: USER,
    userMessageId,
    assistantMessageId: 'cmp-assistant-alt',
    message: 'compare this prompt',
    modelOverride: { model: 'alternate-model' },
    compare: true,
  });
  assert.ok(comparison?.jobId);
  assert.notEqual(primary.jobId, comparison.jobId);

  const persisted = await chatService.getSession(session.id, USER);
  const userMessages = persisted.messages.filter(
    message => message.role === 'user'
  );
  assert.equal(
    userMessages.length,
    1,
    'the fan-out must not duplicate the user turn'
  );
  assert.equal(userMessages[0].id, userMessageId);
});

test('the worker hands each comparison job its model override', async () => {
  const captured = [];
  const originalExecute = durableChatGenerationService.execute;
  durableChatGenerationService.execute = async input => {
    captured.push(input);
  };
  const worker = new EmbeddedDurableJobWorker({
    service: getDurableJobRuntime().service,
    handlers: createDomainDurableJobHandlers(),
    workerId: 'compare-worker',
    leaseMs: 1_000,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
  });
  try {
    worker.start();
    const deadline = Date.now() + 5_000;
    while (captured.length < 2 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally {
    await worker.stop();
    durableChatGenerationService.execute = originalExecute;
  }
  assert.equal(captured.length, 2, 'both generations must reach the worker');
  const primary = captured.find(
    input => input.assistantMessageId === 'cmp-assistant-primary'
  );
  const comparison = captured.find(
    input => input.assistantMessageId === 'cmp-assistant-alt'
  );
  assert.ok(primary && comparison);
  assert.equal(primary.modelOverride, undefined);
  assert.equal(comparison.modelOverride.model, 'alternate-model');
  assert.equal(comparison.compare, true);
  assert.equal(comparison.userMessageId, primary.userMessageId);
});

test('an invalid comparison model is rejected before anything persists', async () => {
  await assert.rejects(
    chatService.queueDurableGeneration({
      sessionId: session.id,
      userId: USER,
      userMessageId: 'cmp-user-2',
      assistantMessageId: 'cmp-assistant-bad',
      message: 'bad override',
      modelOverride: { model: '   ' },
    }),
    /comparison model name is invalid/
  );
  await assert.rejects(
    chatService.queueDurableGeneration({
      sessionId: session.id,
      userId: USER,
      userMessageId: 'cmp-user-3',
      assistantMessageId: 'cmp-assistant-bad-provider',
      message: 'bad provider',
      modelOverride: { model: 'ok-model', providerType: 'plugin' },
    }),
    /provider/i
  );
});
