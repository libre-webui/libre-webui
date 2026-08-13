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
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const distRoot = path.join(repoRoot, 'backend', 'dist');
const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-content-resource-limits-')
);
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.ENCRYPTION_KEY = '1'.repeat(64);
process.env.JWT_SECRET = 'content-resource-limits-test-secret';

const importDist = relativePath =>
  import(pathToFileURL(path.join(distRoot, relativePath)).href);

const databaseModule = await importDist('db.js');
const database = databaseModule.getDatabase();
const storageService = (await importDist('storage.js')).default;
const chatService = (await importDist('services/chatService.js')).default;
const { authService } = await importDist('services/authService.js');
const notesRouter = (await importDist('routes/notes.js')).default;
const limits = await importDist('utils/resourceLimits.js');

const now = Date.now();
const user = {
  id: 'content-limit-user',
  username: 'content-limit-user',
  email: null,
  role: 'user',
  status: 'active',
  avatar: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
database
  .prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', ?, 'active', NULL, ?, ?)`
  )
  .run(user.id, user.username, user.role, now, now);

const token = authService.generateToken(user);
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/notes', notesRouter);
const server = http.createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const notesUrl = `http://127.0.0.1:${address.port}/api/notes`;
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

after(async () => {
  await new Promise(resolve => server.close(resolve));
  databaseModule.closeDatabase();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test('note payloads and per-user storage are bounded', async () => {
  let response = await fetch(notesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: { unexpected: true }, content: '' }),
  });
  assert.equal(response.status, 400);

  response = await fetch(notesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'oversized',
      content: 'x'.repeat(limits.MAX_NOTE_CONTENT_LENGTH + 1),
    }),
  });
  assert.equal(response.status, 400);

  for (let index = 0; index < limits.MAX_NOTES_PER_USER; index += 1) {
    const timestamp = now + index;
    storageService.saveNote(
      {
        id: `note-${index}`,
        title: `Note ${index}`,
        content: 'bounded',
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      user.id
    );
  }

  assert.equal(
    storageService.getNotes(user.id).length,
    limits.MAX_NOTES_PER_USER
  );
  assert.throws(
    () =>
      storageService.saveNote(
        {
          id: 'note-over-quota',
          title: 'Over quota',
          content: '',
          createdAt: now,
          updatedAt: now,
        },
        user.id
      ),
    error =>
      error instanceof limits.ResourcePolicyError && error.statusCode === 409
  );

  const existing = storageService.getNote('note-0', user.id);
  assert.ok(existing);
  storageService.saveNote(
    { ...existing, title: 'Updated while at quota', updatedAt: Date.now() },
    user.id
  );

  response = await fetch(notesUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Over quota through API', content: '' }),
  });
  assert.equal(response.status, 409);

  response = await fetch(notesUrl, { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, limits.MAX_NOTES_PER_USER);
});

test('session-folder names and per-user storage are bounded', () => {
  assert.throws(
    () => chatService.createSessionFolder({ unexpected: true }, user.id),
    error =>
      error instanceof limits.ResourcePolicyError && error.statusCode === 400
  );
  assert.throws(
    () =>
      chatService.createSessionFolder(
        'x'.repeat(limits.MAX_SESSION_FOLDER_NAME_LENGTH + 1),
        user.id
      ),
    error =>
      error instanceof limits.ResourcePolicyError && error.statusCode === 400
  );

  for (let index = 0; index < limits.MAX_SESSION_FOLDERS_PER_USER; index += 1) {
    const timestamp = now + index;
    storageService.saveSessionFolder(
      {
        id: `folder-${index}`,
        name: `Folder ${index}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      user.id
    );
  }

  assert.equal(
    storageService.getSessionFolders(user.id).length,
    limits.MAX_SESSION_FOLDERS_PER_USER
  );
  assert.throws(
    () => chatService.createSessionFolder('Over quota', user.id),
    error =>
      error instanceof limits.ResourcePolicyError && error.statusCode === 409
  );

  const renamed = chatService.renameSessionFolder(
    'folder-0',
    'Renamed while at quota',
    user.id
  );
  assert.equal(renamed?.name, 'Renamed while at quota');
});

test('the welcome document picker matches the PDF and text upload contract', () => {
  const picker = fs.readFileSync(
    path.join(repoRoot, 'frontend', 'src', 'pages', 'ChatPage.tsx'),
    'utf8'
  );
  const route = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'documents.ts'),
    'utf8'
  );
  assert.match(picker, /accept='\.pdf,\.txt'/);
  assert.doesNotMatch(picker, /accept='\.pdf,\.txt,\.md'/);
  assert.match(route, /Only PDF and TXT files are allowed/);
});
