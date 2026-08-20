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
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-queue-'));
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

const USER = 'queue-user';

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

const session = await chatService.createSession('test-model', 'queue', USER);

test('queued prompts persist in order and survive a session reload', async () => {
  await chatService.enqueuePrompt(session.id, USER, 'first queued');
  await chatService.enqueuePrompt(session.id, USER, 'second queued');
  const reloaded = await chatService.getSession(session.id, USER);
  assert.deepEqual(
    reloaded.settings.promptQueue.map(entry => entry.content),
    ['first queued', 'second queued']
  );
});

test('queued prompts can be edited, reordered, and removed atomically', async () => {
  const queue = (await chatService.getSession(session.id, USER)).settings
    .promptQueue;
  const [first, second] = queue;

  const edited = await chatService.updateQueuedPrompt(
    session.id,
    USER,
    second.id,
    'second, edited'
  );
  assert.equal(edited.find(entry => entry.id === second.id).content,
    'second, edited');

  const reordered = await chatService.reorderPromptQueue(session.id, USER, [
    second.id,
    first.id,
  ]);
  assert.deepEqual(
    reordered.map(entry => entry.id),
    [second.id, first.id]
  );

  // Reordering with an unknown id keeps unknown-to-the-order entries
  // instead of dropping them.
  const tolerant = await chatService.reorderPromptQueue(session.id, USER, [
    'missing-entry',
    first.id,
  ]);
  assert.deepEqual(
    tolerant.map(entry => entry.id),
    [first.id, second.id]
  );

  const claimed = await chatService.claimQueuedPrompt(
    session.id,
    USER,
    first.id
  );
  assert.equal(claimed.entry.content, 'first queued');
  assert.deepEqual(
    claimed.queue.map(entry => entry.id),
    [second.id]
  );

  // The claim removed it: a second claim (another tab) loses cleanly.
  assert.equal(
    await chatService.claimQueuedPrompt(session.id, USER, first.id),
    undefined
  );
});

test('the queue enforces its entry cap and content validation', async () => {
  const current = (await chatService.getSession(session.id, USER)).settings
    .promptQueue;
  for (let index = current.length; index < 20; index += 1) {
    await chatService.enqueuePrompt(session.id, USER, `filler ${index}`);
  }
  await assert.rejects(
    chatService.enqueuePrompt(session.id, USER, 'one too many'),
    /at most 20 prompts/
  );
  await assert.rejects(
    chatService.enqueuePrompt(session.id, USER, '   '),
    /needs content/
  );
  await assert.rejects(
    chatService.enqueuePrompt(session.id, USER, 'x'.repeat(8001)),
    /at most 8000 characters/
  );
  assert.equal(
    await chatService.enqueuePrompt('missing-session', USER, 'anything'),
    undefined
  );
});
