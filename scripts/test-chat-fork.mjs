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
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-fork-'));
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

const USER = 'fork-user';
const OTHER = 'fork-other';

after(async () => {
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
for (const userId of [USER, OTHER]) {
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(userId, userId, now, now);
}

const session = await chatService.createSession('fork-model', 'origin', USER);
await chatService.addMessage(
  session.id,
  { id: 'u1', role: 'user', content: 'first question', timestamp: now },
  USER
);
await chatService.addMessage(
  session.id,
  {
    id: 'a1',
    role: 'assistant',
    content: 'first answer',
    model: 'fork-model',
    timestamp: now,
  },
  USER
);
// A regeneration variant of a1.
await chatService.addMessage(
  session.id,
  {
    id: 'a1b',
    role: 'assistant',
    content: 'first answer, regenerated',
    model: 'fork-model',
    parentId: 'a1',
    timestamp: now,
  },
  USER
);
await chatService.addMessage(
  session.id,
  { id: 'u2', role: 'user', content: 'second question', timestamp: now },
  USER
);
await chatService.addMessage(
  session.id,
  {
    id: 'a2',
    role: 'assistant',
    content: 'second answer',
    model: 'fork-model',
    timestamp: now,
  },
  USER
);

test('forking at a message copies the prefix with remapped identities', async () => {
  const fork = await chatService.forkSession(session.id, USER, {
    messageId: 'a1b',
  });
  assert.ok(fork);
  assert.notEqual(fork.id, session.id);
  // The prefix ends at the fork point: u2/a2 stay behind.
  assert.deepEqual(
    fork.messages
      .filter(message => message.role !== 'system')
      .map(message => message.content),
    ['first question', 'first answer', 'first answer, regenerated']
  );
  const originalIds = new Set(['u1', 'a1', 'a1b', 'u2', 'a2']);
  assert.ok(
    fork.messages.every(message => !originalIds.has(message.id)),
    'every forked message must get a fresh identity'
  );
  const forkedVariant = fork.messages.find(
    message => message.content === 'first answer, regenerated'
  );
  const forkedOriginal = fork.messages.find(
    message => message.content === 'first answer'
  );
  assert.equal(
    forkedVariant.parentId,
    forkedOriginal.id,
    'the variant parent must be remapped to the forked id'
  );
  assert.equal(fork.settings.forkedFrom.sessionId, session.id);
  assert.equal(fork.settings.forkedFrom.messageId, 'a1b');

  // The original is untouched and the fork is independently mutable.
  const original = await chatService.getSession(session.id, USER);
  assert.equal(original.messages.filter(m => m.role !== 'system').length, 5);
  const persistedFork = await chatService.getSession(fork.id, USER);
  assert.ok(persistedFork, 'the fork must persist');
});

test('forking without a message copies the whole conversation', async () => {
  const fork = await chatService.forkSession(session.id, USER, {
    title: 'full copy',
  });
  assert.equal(fork.title, 'full copy');
  assert.equal(
    fork.messages.filter(m => m.role !== 'system').length,
    5,
    'a whole-chat fork keeps every message, variants included'
  );
});

test('forking enforces ownership and valid fork points', async () => {
  assert.equal(
    await chatService.forkSession(session.id, OTHER, {}),
    undefined,
    'another user must not fork a foreign chat'
  );
  await assert.rejects(
    chatService.forkSession(session.id, USER, { messageId: 'missing' }),
    /fork point message was not found/
  );
});
