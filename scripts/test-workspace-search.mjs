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
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-search-'));
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
const noteService = await import(dist('services/noteService.js'));
const { createGrant } = await import(dist('services/resourceGrantService.js'));
const { default: storageService } = await import(dist('storage.js'));
const { searchWorkspace, buildSnippet } = await import(
  dist('services/searchService.js')
);

const USER = 'search-user';
const FRIEND = 'search-friend';
const STRANGER = 'search-stranger';

after(async () => {
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
for (const userId of [USER, FRIEND, STRANGER]) {
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(userId, userId, now, now);
}

const owner = { userId: USER, role: 'user' };
const friend = { userId: FRIEND, role: 'user' };
const stranger = { userId: STRANGER, role: 'user' };

const session = await chatService.createSession('m', 'travel planning', USER);
await chatService.addMessage(
  session.id,
  {
    id: 'sm1',
    role: 'user',
    content: 'What is the itinerary for the flamingo expedition in Kenya?',
    timestamp: now,
  },
  USER
);
await chatService.addMessage(
  session.id,
  {
    id: 'sm2',
    role: 'assistant',
    content: 'The flamingo expedition starts at Lake Nakuru at dawn.',
    timestamp: now,
  },
  USER
);

const note = await noteService.createNote(owner, {
  title: 'Packing list',
  content: 'Bring binoculars for the flamingo expedition and a rain jacket.',
});
await createGrant(owner, {
  resourceType: 'note',
  resourceId: note.id,
  principalType: 'user',
  principalId: FRIEND,
  permission: 'read',
});

await storageService.saveDocument(
  {
    id: 'search-doc',
    filename: 'expedition-brief.txt',
    fileType: 'txt',
    content:
      'The flamingo expedition brief covers permits, camp sites, and budgets.',
    size: 70,
    uploadedAt: now,
    createdAt: now,
  },
  USER
);

test('workspace search finds messages, notes, and documents with snippets', async () => {
  const results = await searchWorkspace(owner, 'flamingo expedition');
  assert.equal(results.sessions.length, 1, 'one chat, best message only');
  assert.equal(results.sessions[0].sessionId, session.id);
  assert.match(results.sessions[0].snippet, /flamingo expedition/i);
  assert.equal(results.notes.length, 1);
  assert.equal(results.notes[0].noteId, note.id);
  assert.equal(results.documents.length, 1);
  assert.equal(results.documents[0].documentId, 'search-doc');
  assert.match(results.documents[0].snippet, /permits/);
});

test('search is scoped to what the actor can read', async () => {
  const outsider = await searchWorkspace(stranger, 'flamingo expedition');
  assert.deepEqual(outsider, { sessions: [], notes: [], documents: [] });

  // A shared note is searchable for the grantee; the owner's chats and
  // documents are not.
  const shared = await searchWorkspace(friend, 'flamingo expedition');
  assert.equal(shared.sessions.length, 0);
  assert.equal(shared.documents.length, 0);
  assert.equal(shared.notes.length, 1);
  assert.equal(shared.notes[0].shared, true);
});

test('snippets stay bounded and centered on the first match', () => {
  const long = `${'left padding words '.repeat(40)}the flamingo appears here${' right padding words'.repeat(40)}`;
  const snippet = buildSnippet(long, 'flamingo');
  assert.ok(snippet.length < 260);
  assert.match(snippet, /flamingo appears here/);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'));
});
