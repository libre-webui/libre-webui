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
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-data-archive-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY ||= '7'.repeat(64);
process.env.JWT_SECRET ||= 'data-archive-test-jwt-secret';

const testSource = process.env.LIBRE_DATA_ARCHIVE_TEST_SOURCE === '1';
const backendModule = relativePath =>
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      testSource ? 'src' : 'dist',
      testSource ? relativePath.replace(/\.js$/, '.ts') : relativePath
    )
  ).href;

const { closeDatabase, getDatabase } = await import(backendModule('db.js'));
const { default: storageService } = await import(backendModule('storage.js'));
const { default: preferencesService } = await import(
  backendModule('services/preferencesService.js')
);
const { default: dataArchiveService } = await import(
  backendModule('services/dataArchiveService.js')
);
const { authService } = await import(backendModule('services/authService.js'));
const { default: preferencesRouter } = await import(
  backendModule('routes/preferences.js')
);

const SOURCE_USER = 'archive-source-user';
const TARGET_USER = 'archive-target-user';
const ROUTE_USER = 'archive-route-user';
const now = Date.now();

for (const userId of [SOURCE_USER, TARGET_USER, ROUTE_USER]) {
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(userId, userId, now, now);
}

const token = authService.generateToken({
  id: ROUTE_USER,
  username: ROUTE_USER,
  email: null,
  role: 'user',
  status: 'active',
  avatar: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/preferences', preferencesRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Data archive test server did not expose a TCP port');
}
const baseUrl = `http://127.0.0.1:${address.port}/api/preferences`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

function seedSourceUser() {
  preferencesService.updatePreferences(
    {
      defaultModel: 'archive-model',
      ttsSettings: {
        enabled: true,
        autoPlay: true,
        model: 'tts-model',
        voice: 'voice',
        voiceProfileId: 'sensitive-voice-profile',
        speed: 1,
      },
    },
    SOURCE_USER
  );
  storageService.saveSessionFolder(
    {
      id: 'shared-folder-id',
      name: 'Source folder',
      createdAt: now,
      updatedAt: now,
    },
    SOURCE_USER
  );
  storageService.saveKnowledgeCollection(
    {
      id: 'shared-collection-id',
      name: 'Source knowledge',
      createdAt: now,
      updatedAt: now,
    },
    SOURCE_USER
  );
  storageService.saveSession(
    {
      id: 'shared-session-id',
      title: 'Source chat',
      model: 'archive-model',
      folderId: 'shared-folder-id',
      settings: { knowledgeCollectionIds: ['shared-collection-id'] },
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: 'shared-message-id',
          role: 'user',
          content: 'Private source question',
          timestamp: now,
        },
        {
          id: 'source-answer-id',
          role: 'assistant',
          content: 'Portable answer',
          parentId: 'shared-message-id',
          timestamp: now + 1,
        },
      ],
    },
    SOURCE_USER
  );
  storageService.saveDocument(
    {
      id: 'shared-document-id',
      filename: 'source.txt',
      title: 'Source document',
      content: 'Portable extracted document text',
      fileType: 'txt',
      size: 32,
      sessionId: 'shared-session-id',
      collectionId: 'shared-collection-id',
      uploadedAt: now,
      createdAt: now,
    },
    SOURCE_USER
  );
  storageService.saveDocumentChunks('shared-document-id', [
    {
      id: 'shared-chunk-id',
      documentId: 'shared-document-id',
      content: 'Portable extracted document text',
      chunkIndex: 0,
      startChar: 0,
      endChar: 32,
      embedding: [0.1, 0.2],
    },
  ]);
}

seedSourceUser();

test('v2 export is complete, user-scoped, and explicit about exclusions', () => {
  const archive = dataArchiveService.exportUserData(SOURCE_USER);
  assert.equal(archive.format, 'libre-webui-user-data');
  assert.equal(archive.version, 2);
  assert.equal(archive.sessionFolders.length, 1);
  assert.equal(archive.sessions.length, 1);
  assert.equal(archive.sessions[0].messages.length, 2);
  assert.equal(archive.knowledgeCollections.length, 1);
  assert.equal(archive.documents.length, 1);
  assert.equal(archive.documents[0].chunks.length, 1);
  assert.equal('embedding' in archive.documents[0].chunks[0], false);
  assert.equal(archive.preferences.ttsSettings.voiceProfileId, undefined);
  assert.ok(archive.exclusions.some(entry => entry.key === 'voiceProfiles'));

  const targetArchive = dataArchiveService.exportUserData(TARGET_USER);
  assert.equal(targetArchive.sessions.length, 0);
  assert.equal(targetArchive.documents.length, 0);
});

test('preflight is read-only and reports deterministic foreign-ID remapping', () => {
  const archive = dataArchiveService.exportUserData(SOURCE_USER);
  const before = dataArchiveService.exportUserData(TARGET_USER);
  const preflight = dataArchiveService.preflight(archive, 'skip', TARGET_USER);
  assert.equal(preflight.incoming.sessions, 1);
  assert.equal(preflight.incoming.messages, 2);
  assert.equal(preflight.incoming.documents, 1);
  assert.ok(preflight.result.remappedIds >= 4);
  const after = dataArchiveService.exportUserData(TARGET_USER);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.documents, before.documents);
});

test('import round-trips relationships without overwriting another user', () => {
  const sourceArchive = dataArchiveService.exportUserData(SOURCE_USER);
  const result = dataArchiveService.importUserData(
    sourceArchive,
    'skip',
    TARGET_USER
  );
  assert.equal(result.sessions.imported, 1);
  assert.equal(result.documents.imported, 1);
  assert.ok(result.remappedIds >= 4);

  const imported = dataArchiveService.exportUserData(TARGET_USER);
  assert.equal(imported.sessions.length, 1);
  assert.equal(imported.documents.length, 1);
  assert.notEqual(imported.sessions[0].id, sourceArchive.sessions[0].id);
  assert.equal(imported.documents[0].sessionId, imported.sessions[0].id);
  assert.equal(
    imported.documents[0].collectionId,
    imported.knowledgeCollections[0].id
  );
  assert.deepEqual(imported.sessions[0].settings.knowledgeCollectionIds, [
    imported.knowledgeCollections[0].id,
  ]);

  const unchangedSource = dataArchiveService.exportUserData(SOURCE_USER);
  assert.equal(unchangedSource.sessions[0].title, 'Source chat');
  assert.equal(
    unchangedSource.documents[0].content,
    'Portable extracted document text'
  );
});

test('skip is idempotent and overwrite reports and updates matching records', () => {
  const archive = dataArchiveService.exportUserData(SOURCE_USER);
  const skipped = dataArchiveService.importUserData(
    archive,
    'skip',
    TARGET_USER
  );
  assert.equal(skipped.sessions.skipped, 1);
  assert.equal(skipped.documents.skipped, 1);
  assert.equal(
    dataArchiveService.exportUserData(TARGET_USER).sessions.length,
    1
  );

  archive.sessions[0].title = 'Overwritten portable chat';
  archive.documents[0].content = 'Overwritten extracted text';
  archive.preferences.defaultModel = 'overwritten-model';
  const overwritten = dataArchiveService.importUserData(
    archive,
    'overwrite',
    TARGET_USER
  );
  assert.equal(overwritten.sessions.overwritten, 1);
  assert.equal(overwritten.documents.overwritten, 1);
  const target = dataArchiveService.exportUserData(TARGET_USER);
  assert.equal(target.sessions[0].title, 'Overwritten portable chat');
  assert.equal(target.documents[0].content, 'Overwritten extracted text');
  assert.equal(target.preferences.defaultModel, 'overwritten-model');
});

test('a database failure rolls back preferences and every archive section', () => {
  preferencesService.updatePreferences(
    { defaultModel: 'before-rollback' },
    TARGET_USER
  );
  const beforeFolders = storageService.getSessionFolders(TARGET_USER);
  getDatabase().exec(`
    CREATE TRIGGER fail_test_archive_session
    BEFORE INSERT ON sessions
    WHEN NEW.id = 'rollback-session'
    BEGIN
      SELECT RAISE(ABORT, 'forced archive rollback');
    END
  `);
  const archive = {
    format: 'libre-webui-user-data',
    version: 2,
    exportedAt: new Date().toISOString(),
    preferences: { defaultModel: 'must-not-persist' },
    sessionFolders: [
      {
        id: 'rollback-folder',
        name: 'Rollback folder',
        createdAt: now,
        updatedAt: now,
      },
    ],
    sessions: [
      {
        id: 'rollback-session',
        title: 'Must roll back',
        model: 'rollback-model',
        folderId: 'rollback-folder',
        messages: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    knowledgeCollections: [],
    documents: [],
    exclusions: [],
  };

  assert.throws(
    () => dataArchiveService.importUserData(archive, 'skip', TARGET_USER),
    /forced archive rollback/
  );
  getDatabase().exec('DROP TRIGGER fail_test_archive_session');
  assert.equal(
    preferencesService.getPreferences(TARGET_USER).defaultModel,
    'before-rollback'
  );
  assert.deepEqual(
    storageService.getSessionFolders(TARGET_USER),
    beforeFolders
  );
});

test('preflight rejects an import that would exceed account resource limits', () => {
  const existingFolders = storageService.getSessionFolders(TARGET_USER).length;
  const archive = {
    format: 'libre-webui-user-data',
    version: 2,
    exportedAt: new Date().toISOString(),
    preferences: {},
    sessionFolders: Array.from(
      { length: 101 - existingFolders },
      (_, index) => ({
        id: `limit-folder-${index}`,
        name: `Limit folder ${index}`,
        createdAt: now,
        updatedAt: now,
      })
    ),
    sessions: [],
    knowledgeCollections: [],
    documents: [],
    exclusions: [],
  };
  assert.throws(
    () => dataArchiveService.preflight(archive, 'skip', TARGET_USER),
    /per-user limit of 100 session folders/
  );
});

test('legacy browser exports migrate truthfully during preflight', () => {
  const preflight = dataArchiveService.preflight(
    {
      format: 'libre-webui-export',
      version: '1.0',
      exportedAt: new Date().toISOString(),
      preferences: { showUsername: true },
      sessions: [],
      documents: [],
    },
    'skip',
    TARGET_USER
  );
  assert.equal(preflight.migratedFromVersion, '1.0');
  assert.match(preflight.warnings.join(' '), /did not contain folders/);
});

test('validation rejects duplicate IDs and malformed relationships before writes', () => {
  const archive = dataArchiveService.exportUserData(SOURCE_USER);
  archive.sessions.push(structuredClone(archive.sessions[0]));
  assert.throws(
    () => dataArchiveService.preflight(archive, 'skip', TARGET_USER),
    /duplicate ID/
  );
});

test('authenticated routes export only the caller and accept multipart preflight', async () => {
  const exportResponse = await fetch(`${baseUrl}/export`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('cache-control'), 'no-store');
  const exportBody = await exportResponse.json();
  assert.equal(exportBody.success, true);
  assert.equal(exportBody.data.format, 'libre-webui-user-data');
  assert.ok(
    exportBody.data.sessions.every(session =>
      session.messages.every(
        message => message.content !== 'Private source question'
      )
    )
  );

  const archive = dataArchiveService.exportUserData(SOURCE_USER);
  const form = new FormData();
  form.append(
    'archive',
    new Blob([JSON.stringify(archive)], { type: 'application/json' }),
    'archive.json'
  );
  form.append('strategy', 'skip');
  const preflightResponse = await fetch(`${baseUrl}/import/preflight`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const preflightText = await preflightResponse.text();
  assert.equal(preflightResponse.status, 200, preflightText);
  assert.equal(preflightResponse.headers.get('cache-control'), 'no-store');
  const preflightBody = JSON.parse(preflightText);
  assert.equal(preflightBody.success, true);
  assert.equal(preflightBody.data.valid, true);
  assert.equal(preflightBody.data.incoming.sessions, 1);

  const unauthenticated = await fetch(`${baseUrl}/export`);
  assert.equal(unauthenticated.status, 401);
});

test('archive routes hide unexpected errors and disable response caching', async () => {
  const originalExport = dataArchiveService.exportUserData;
  dataArchiveService.exportUserData = () => {
    throw new Error('sensitive database implementation detail');
  };
  try {
    const response = await fetch(`${baseUrl}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.error, 'Failed to export user data');
    assert.doesNotMatch(JSON.stringify(body), /sensitive database/i);
  } finally {
    dataArchiveService.exportUserData = originalExport;
  }
});
