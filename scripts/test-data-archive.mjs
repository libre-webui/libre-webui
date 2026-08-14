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
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

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

if (testSource) {
  throw new Error(
    'LIBRE_DATA_ARCHIVE_TEST_SOURCE is incompatible with the built platform-storage fixture; build the backend and test dist instead.'
  );
}
const closePlatformStorageFixture =
  await initializeSQLitePlatformStorageFixture(
    path.join(repoRoot, 'backend', 'dist')
  );

const { closeDatabase, getDatabase } = await import(backendModule('db.js'));
const { default: storageService } = await import(backendModule('storage.js'));
const { default: preferencesService } = await import(
  backendModule('services/preferencesService.js')
);
const { default: dataArchiveService, DataArchiveValidationError } =
  await import(backendModule('services/dataArchiveService.js'));
const { getPlatformStorageRuntime } = await import(
  backendModule('platform/storage/index.js')
);
const { transactionalResourceDeletionEnqueuer } = await import(
  backendModule('platform/jobs/resourceDeletionEnqueuer.js')
);
const { getDurableJobRuntime } = await import(
  backendModule('platform/jobs/durableJobRuntime.js')
);
const { createDomainDurableJobHandlers } = await import(
  backendModule('platform/jobs/domainJobHandlers.js')
);
const { authService } = await import(backendModule('services/authService.js'));
const { default: preferencesRouter } = await import(
  backendModule('routes/preferences.js')
);

const SOURCE_USER = 'archive-source-user';
const TARGET_USER = 'archive-target-user';
const ROUTE_USER = 'archive-route-user';
const LIMIT_USER = 'archive-limit-user';
const OVER_LIMIT_USER = 'archive-over-limit-user';
const now = Date.now();

for (const userId of [
  SOURCE_USER,
  TARGET_USER,
  ROUTE_USER,
  LIMIT_USER,
  OVER_LIMIT_USER,
]) {
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
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

async function seedSourceUser() {
  await preferencesService.updatePreferences(
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
  await storageService.saveSessionFolder(
    {
      id: 'shared-folder-id',
      name: 'Source folder',
      createdAt: now,
      updatedAt: now,
    },
    SOURCE_USER
  );
  await storageService.saveKnowledgeCollection(
    {
      id: 'shared-collection-id',
      name: 'Source knowledge',
      createdAt: now,
      updatedAt: now,
    },
    SOURCE_USER
  );
  await storageService.saveNote(
    {
      id: 'shared-note-id',
      title: 'Source Note',
      content: 'Portable private Note content',
      createdAt: now,
      updatedAt: now,
    },
    SOURCE_USER
  );
  await storageService.saveSession(
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
  await storageService.saveDocument(
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
  await storageService.saveDocumentChunks('shared-document-id', [
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

await seedSourceUser();

async function asVersion2Archive() {
  const archive = structuredClone(
    await dataArchiveService.exportUserData(SOURCE_USER)
  );
  archive.version = 2;
  delete archive.notes;
  delete archive.integrity;
  return archive;
}

test('v3 export is complete, checksummed, user-scoped, and explicit about exclusions', async () => {
  const archive = await dataArchiveService.exportUserData(SOURCE_USER);
  assert.equal(archive.format, 'libre-webui-user-data');
  assert.equal(archive.version, 3);
  assert.equal(archive.integrity.algorithm, 'sha256');
  assert.equal(archive.integrity.canonicalization, 'libre-json-sort-v1');
  assert.match(archive.integrity.digest, /^[a-f0-9]{64}$/);
  assert.equal(archive.sessionFolders.length, 1);
  assert.equal(archive.sessions.length, 1);
  assert.equal(archive.sessions[0].messages.length, 2);
  assert.equal(archive.notes.length, 1);
  assert.equal(archive.notes[0].content, 'Portable private Note content');
  assert.equal(archive.knowledgeCollections.length, 1);
  assert.equal(archive.documents.length, 1);
  assert.equal(archive.documents[0].chunks.length, 1);
  assert.equal('embedding' in archive.documents[0].chunks[0], false);
  assert.equal(archive.preferences.ttsSettings.voiceProfileId, undefined);
  assert.match(
    archive.exclusions.find(entry => entry.key === 'voiceProfiles').reason,
    /biometric/i
  );
  assert.ok(
    archive.exclusions.some(entry => entry.key === 'personasAndMemory')
  );
  assert.equal(
    archive.exclusions.some(entry => /notes/i.test(entry.key)),
    false
  );

  const targetArchive = await dataArchiveService.exportUserData(TARGET_USER);
  assert.equal(targetArchive.sessions.length, 0);
  assert.equal(targetArchive.notes.length, 0);
  assert.equal(targetArchive.documents.length, 0);
});

test('v3 integrity is canonical across key order and rejects tampering', async () => {
  const archive = await dataArchiveService.exportUserData(SOURCE_USER);
  const reordered = Object.fromEntries(Object.entries(archive).reverse());
  assert.equal(
    (await dataArchiveService.preflight(reordered, 'skip', TARGET_USER)).valid,
    true
  );

  const tampered = structuredClone(archive);
  tampered.notes[0].content = 'Content changed after export';
  await assert.rejects(
    () => dataArchiveService.preflight(tampered, 'skip', TARGET_USER),
    /integrity check failed/i
  );
});

test('preflight is read-only and reports deterministic foreign-ID remapping', async () => {
  const archive = await dataArchiveService.exportUserData(SOURCE_USER);
  const before = await dataArchiveService.exportUserData(TARGET_USER);
  const preflight = await dataArchiveService.preflight(
    archive,
    'skip',
    TARGET_USER
  );
  assert.equal(preflight.incoming.sessions, 1);
  assert.equal(preflight.incoming.messages, 2);
  assert.equal(preflight.incoming.notes, 1);
  assert.equal(preflight.incoming.documents, 1);
  assert.equal(preflight.result.notes.imported, 1);
  assert.ok(preflight.result.remappedIds >= 5);
  const after = await dataArchiveService.exportUserData(TARGET_USER);
  assert.deepEqual(after.sessions, before.sessions);
  assert.deepEqual(after.notes, before.notes);
  assert.deepEqual(after.documents, before.documents);
});

test('import round-trips relationships without overwriting another user', async () => {
  const sourceArchive = await dataArchiveService.exportUserData(SOURCE_USER);
  const result = await dataArchiveService.importUserData(
    sourceArchive,
    'skip',
    TARGET_USER
  );
  assert.equal(result.sessions.imported, 1);
  assert.equal(result.notes.imported, 1);
  assert.equal(result.documents.imported, 1);
  assert.ok(result.remappedIds >= 5);

  const imported = await dataArchiveService.exportUserData(TARGET_USER);
  assert.equal(imported.sessions.length, 1);
  assert.equal(imported.notes.length, 1);
  assert.equal(imported.documents.length, 1);
  assert.notEqual(imported.sessions[0].id, sourceArchive.sessions[0].id);
  assert.notEqual(imported.notes[0].id, sourceArchive.notes[0].id);
  assert.equal(imported.notes[0].content, sourceArchive.notes[0].content);
  assert.equal(imported.documents[0].sessionId, imported.sessions[0].id);
  assert.equal(
    imported.documents[0].collectionId,
    imported.knowledgeCollections[0].id
  );
  assert.deepEqual(imported.sessions[0].settings.knowledgeCollectionIds, [
    imported.knowledgeCollections[0].id,
  ]);

  const unchangedSource = await dataArchiveService.exportUserData(SOURCE_USER);
  assert.equal(unchangedSource.sessions[0].title, 'Source chat');
  assert.equal(
    unchangedSource.documents[0].content,
    'Portable extracted document text'
  );
});

test('skip is idempotent and overwrite reports and updates matching records', async () => {
  let archive = await dataArchiveService.exportUserData(SOURCE_USER);
  const skipped = await dataArchiveService.importUserData(
    archive,
    'skip',
    TARGET_USER
  );
  assert.equal(skipped.sessions.skipped, 1);
  assert.equal(skipped.notes.skipped, 1);
  assert.equal(skipped.documents.skipped, 1);
  assert.equal(
    (await dataArchiveService.exportUserData(TARGET_USER)).sessions.length,
    1
  );

  await preferencesService.updatePreferences(
    { defaultModel: 'overwritten-model' },
    SOURCE_USER
  );
  await storageService.saveSession(
    {
      ...(await storageService.getSession('shared-session-id', SOURCE_USER)),
      title: 'Overwritten portable chat',
    },
    SOURCE_USER
  );
  await storageService.saveDocument(
    {
      ...(await storageService.getDocument('shared-document-id', SOURCE_USER)),
      content: 'Overwritten extracted text',
    },
    SOURCE_USER
  );
  await storageService.saveNote(
    {
      ...(await storageService.getNote('shared-note-id', SOURCE_USER)),
      content: 'Overwritten portable Note',
    },
    SOURCE_USER
  );
  archive = await dataArchiveService.exportUserData(SOURCE_USER);
  const overwritten = await dataArchiveService.importUserData(
    archive,
    'overwrite',
    TARGET_USER
  );
  assert.equal(overwritten.sessions.overwritten, 1);
  assert.equal(overwritten.notes.overwritten, 1);
  assert.equal(overwritten.documents.overwritten, 1);
  const target = await dataArchiveService.exportUserData(TARGET_USER);
  assert.equal(target.sessions[0].title, 'Overwritten portable chat');
  assert.equal(target.notes[0].content, 'Overwritten portable Note');
  assert.equal(target.documents[0].content, 'Overwritten extracted text');
  assert.equal(target.preferences.defaultModel, 'overwritten-model');
});

test('deleted document archive IDs are retained tombstones and re-import as fresh occurrences', async () => {
  const owner = 'archive-incarnation-owner';
  const createdAt = now + 20_000;
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(owner, owner, createdAt, createdAt);
  await storageService.saveDocument(
    {
      id: 'portable-incarnation-document',
      filename: 'incarnation.txt',
      content: 'first incarnation',
      fileType: 'txt',
      uploadedAt: createdAt,
      createdAt,
    },
    owner
  );
  const archive = await dataArchiveService.exportUserData(owner);
  const platform = getPlatformStorageRuntime();
  assert.equal(
    await platform.domains.documents.deleteAndEnqueue(
      'portable-incarnation-document',
      owner,
      transactionalResourceDeletionEnqueuer
    ),
    true
  );
  const tombstone = getDatabase()
    .prepare(
      `SELECT deletion_token, deletion_incarnation
         FROM platform_resource_deletion_tombstones
        WHERE resource_type = 'document' AND resource_id = ?`
    )
    .get('portable-incarnation-document');
  assert.match(tombstone.deletion_token, /^[0-9a-f]{64}$/);
  assert.equal(tombstone.deletion_incarnation, 1);
  const originalCleanup = getDurableJobRuntime().service.getByIdempotency(
    owner,
    'resource.delete.v1',
    tombstone.deletion_token
  );
  assert.ok(originalCleanup);

  const firstImport = await dataArchiveService.importUserData(
    archive,
    'skip',
    owner
  );
  assert.equal(firstImport.documents.imported, 1);
  assert.ok(firstImport.remappedIds >= 1);
  const restored = await storageService.getAllDocuments(owner);
  assert.equal(restored.length, 1);
  assert.notEqual(restored[0].id, 'portable-incarnation-document');

  await platform.vectorStore.upsert({
    actor: { userId: owner },
    records: [
      {
        namespace: 'document-chunk',
        id: 'deleted-incarnation-vector',
        ownerUserId: owner,
        resourceId: 'portable-incarnation-document',
        model: 'archive-fixture',
        dimensions: 2,
        version: '1',
        sourceRevision: 'deleted-occurrence',
        embedding: [1, 0],
      },
      {
        namespace: 'document-chunk',
        id: 'replacement-incarnation-vector',
        ownerUserId: owner,
        resourceId: restored[0].id,
        model: 'archive-fixture',
        dimensions: 2,
        version: '1',
        sourceRevision: 'replacement-occurrence',
        embedding: [0, 1],
      },
    ],
  });
  const deleteHandler = createDomainDurableJobHandlers().get(
    'resource.delete.v1'
  );
  assert.ok(deleteHandler);
  await deleteHandler({
    signal: new AbortController().signal,
    payload: {
      resourceType: 'document',
      resourceId: 'portable-incarnation-document',
      deletionIncarnation: tombstone.deletion_incarnation,
      deletionToken: tombstone.deletion_token,
    },
    actorUserId: owner,
    attemptCount: 1,
    reportProgress: async () => undefined,
    assertSideEffectAllowed: async () => undefined,
  });
  const survivingVectors = await platform.vectorStore.query({
    actor: { userId: owner },
    namespace: 'document-chunk',
    model: 'archive-fixture',
    dimensions: 2,
    version: '1',
    embedding: [0, 1],
    limit: 10,
    resourceIds: [
      'portable-incarnation-document',
      restored[0].id,
    ],
  });
  assert.deepEqual(
    survivingVectors.map(vector => vector.id),
    ['replacement-incarnation-vector']
  );
  assert.ok(
    await storageService.getDocument(restored[0].id, owner),
    'the old cleanup occurrence must not remove the remapped document'
  );

  assert.equal(
    await platform.domains.documents.deleteAndEnqueue(
      restored[0].id,
      owner,
      transactionalResourceDeletionEnqueuer
    ),
    true
  );
  const secondTombstone = getDatabase()
    .prepare(
      `SELECT deletion_token
         FROM platform_resource_deletion_tombstones
        WHERE resource_type = 'document' AND resource_id = ?`
    )
    .get(restored[0].id);
  assert.notEqual(secondTombstone.deletion_token, tombstone.deletion_token);
  const secondCleanup = getDurableJobRuntime().service.getByIdempotency(
    owner,
    'resource.delete.v1',
    secondTombstone.deletion_token
  );
  assert.ok(secondCleanup);
  assert.notEqual(secondCleanup.id, originalCleanup.id);
});

test('archive apply re-resolves a document tombstoned after preflight mapping', async () => {
  const owner = 'archive-barrier-owner';
  const createdAt = now + 30_000;
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(owner, owner, createdAt, createdAt);
  await storageService.saveDocument(
    {
      id: 'portable-barrier-document',
      filename: 'barrier.txt',
      content: 'before the barrier',
      fileType: 'txt',
      uploadedAt: createdAt,
      createdAt,
    },
    owner
  );
  const archive = await dataArchiveService.exportUserData(owner);
  const archiveRepository = (await import(backendModule('persistence/index.js')))
    .getInitializedPersistence().repositories.resources.archive;
  const originalApply = archiveRepository.applyImport.bind(archiveRepository);
  let injected = false;
  archiveRepository.applyImport = async plan => {
    if (!injected) {
      injected = true;
      await getPlatformStorageRuntime().domains.documents.deleteAndEnqueue(
        'portable-barrier-document',
        owner,
        transactionalResourceDeletionEnqueuer
      );
    }
    return originalApply(plan);
  };
  try {
    const imported = await dataArchiveService.importUserData(
      archive,
      'overwrite',
      owner
    );
    assert.equal(imported.documents.imported, 1);
    assert.ok(imported.remappedIds >= 1);
    const documents = await storageService.getAllDocuments(owner);
    assert.equal(documents.length, 1);
    assert.notEqual(documents[0].id, 'portable-barrier-document');
    assert.equal(documents[0].content, 'before the barrier');
  } finally {
    archiveRepository.applyImport = originalApply;
  }
});

test('a database failure rolls back preferences and every archive section', async () => {
  await preferencesService.updatePreferences(
    { defaultModel: 'before-rollback' },
    TARGET_USER
  );
  const beforeFolders = await storageService.getSessionFolders(TARGET_USER);
  const beforeNotes = await storageService.getNotes(TARGET_USER);
  getDatabase().exec(`
    CREATE TRIGGER fail_test_archive_session
    BEFORE INSERT ON sessions
    WHEN NEW.user_id = '${TARGET_USER}'
    BEGIN
      SELECT RAISE(ABORT, 'forced archive rollback');
    END
  `);
  const archive = await dataArchiveService.exportUserData(SOURCE_USER);

  await assert.rejects(
    () => dataArchiveService.importUserData(archive, 'overwrite', TARGET_USER),
    /forced archive rollback/
  );
  getDatabase().exec('DROP TRIGGER fail_test_archive_session');
  assert.equal(
    (await preferencesService.getPreferences(TARGET_USER)).defaultModel,
    'before-rollback'
  );
  assert.deepEqual(
    await storageService.getSessionFolders(TARGET_USER),
    beforeFolders
  );
  assert.deepEqual(await storageService.getNotes(TARGET_USER), beforeNotes);
});

test('preflight rejects an import that would exceed account resource limits', async () => {
  const existingFolders = (await storageService.getSessionFolders(TARGET_USER))
    .length;
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
  await assert.rejects(
    () => dataArchiveService.preflight(archive, 'skip', TARGET_USER),
    /per-user limit of 100 session folders/
  );
});

test('preflight includes Notes in account quotas', async () => {
  for (let index = 0; index < 100; index += 1) {
    await storageService.saveNote(
      {
        id: `existing-limit-note-${index}`,
        title: `Limit Note ${index}`,
        content: 'Existing Note',
        createdAt: now + index,
        updatedAt: now + index,
      },
      LIMIT_USER
    );
  }
  const archive = await dataArchiveService.exportUserData(SOURCE_USER);
  await assert.rejects(
    () => dataArchiveService.preflight(archive, 'skip', LIMIT_USER),
    /per-user limit of 100 Notes/
  );
});

test('version 2 archives migrate with explicit checksum and Notes warnings', async () => {
  const archive = await asVersion2Archive();
  const preflight = await dataArchiveService.preflight(
    archive,
    'skip',
    TARGET_USER
  );
  assert.equal(preflight.version, 3);
  assert.equal(preflight.migratedFromVersion, '2');
  assert.match(preflight.warnings.join(' '), /without integrity verification/i);
  assert.match(preflight.warnings.join(' '), /did not contain Notes/i);
  assert.equal(preflight.incoming.notes, 0);
});

test('legacy browser exports migrate truthfully during preflight', async () => {
  const preflight = await dataArchiveService.preflight(
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
  assert.match(preflight.warnings.join(' '), /without integrity verification/i);
  assert.match(preflight.warnings.join(' '), /did not contain folders/);
  assert.match(preflight.warnings.join(' '), /Notes/);
});

test('validation rejects duplicate IDs before writes', async () => {
  const archive = await asVersion2Archive();
  archive.sessions.push(structuredClone(archive.sessions[0]));
  await assert.rejects(
    () => dataArchiveService.preflight(archive, 'skip', TARGET_USER),
    /duplicate ID/
  );
});

test('validation precisely rejects every dangling included relationship', async () => {
  const cases = [
    {
      mutate: archive => {
        archive.sessions[0].folderId = 'missing-folder';
      },
      error:
        /sessions\[0\]\.folderId references missing session folder missing-folder/,
    },
    {
      mutate: archive => {
        archive.sessions[0].settings.knowledgeCollectionIds = [
          'missing-collection',
        ];
      },
      error:
        /sessions\[0\]\.settings\.knowledgeCollectionIds\[0\] references missing knowledge collection missing-collection/,
    },
    {
      mutate: archive => {
        archive.sessions[0].messages[1].parentId = 'missing-parent';
      },
      error:
        /sessions\[0\]\.messages\[1\]\.parentId must reference a message in the same session/,
    },
    {
      mutate: archive => {
        archive.documents[0].sessionId = 'missing-session';
      },
      error:
        /documents\[0\]\.sessionId references missing session missing-session/,
    },
    {
      mutate: archive => {
        archive.documents[0].collectionId = 'missing-collection';
      },
      error:
        /documents\[0\]\.collectionId references missing knowledge collection missing-collection/,
    },
  ];

  for (const { mutate, error } of cases) {
    const archive = await asVersion2Archive();
    mutate(archive);
    await assert.rejects(
      () => dataArchiveService.preflight(archive, 'skip', TARGET_USER),
      error
    );
  }
});

test('excluded persona references produce a projected detach warning', async () => {
  const archive = await asVersion2Archive();
  archive.sessions[0].personaId = 'persona-not-in-archive';
  const preflight = await dataArchiveService.preflight(
    archive,
    'skip',
    TARGET_USER
  );
  assert.match(
    preflight.warnings.join(' '),
    /will be detached from persona persona-not-in-archive because personas are excluded/
  );
});

test('export refuses an archive that its importer could not restore', async () => {
  const originalGetAllSessions = storageService.getAllSessions;
  storageService.getAllSessions = () =>
    Array.from({ length: 5_001 }, (_, index) => ({
      id: `too-many-sessions-${index}`,
      title: `Session ${index}`,
      model: 'archive-model',
      messages: [],
      createdAt: now,
      updatedAt: now,
    }));
  try {
    await assert.rejects(
      () => dataArchiveService.exportUserData(SOURCE_USER),
      /Archive contains 5001 sessions; the maximum is 5000/
    );
  } finally {
    storageService.getAllSessions = originalGetAllSessions;
  }
});

test('export self-validation catches a corrupt stored relationship', async () => {
  getDatabase()
    .prepare('UPDATE sessions SET folder_id = ? WHERE id = ? AND user_id = ?')
    .run('missing-stored-folder', 'shared-session-id', SOURCE_USER);
  try {
    await assert.rejects(
      () => dataArchiveService.exportUserData(SOURCE_USER),
      /sessions\[0\]\.folderId references missing session folder missing-stored-folder/
    );
  } finally {
    getDatabase()
      .prepare('UPDATE sessions SET folder_id = ? WHERE id = ? AND user_id = ?')
      .run('shared-folder-id', 'shared-session-id', SOURCE_USER);
  }
});

test('export detects rows hidden by bounded storage readers', async () => {
  const encrypted = getDatabase()
    .prepare('SELECT title, content FROM notes WHERE id = ?')
    .get('shared-note-id');
  const insert = getDatabase().prepare(
    `INSERT INTO notes (id, user_id, title, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  getDatabase().transaction(() => {
    for (let index = 0; index < 101; index += 1) {
      insert.run(
        `hidden-note-${index}`,
        OVER_LIMIT_USER,
        encrypted.title,
        encrypted.content,
        now + index,
        now + index
      );
    }
  })();
  await assert.rejects(
    () => dataArchiveService.exportUserData(OVER_LIMIT_USER),
    /Account contains 101 Notes; the portable archive maximum is 100/
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
  assert.equal(exportBody.data.version, 3);
  assert.match(exportBody.data.integrity.digest, /^[a-f0-9]{64}$/);
  assert.equal(exportBody.data.notes.length, 0);
  assert.ok(
    exportBody.data.sessions.every(session =>
      session.messages.every(
        message => message.content !== 'Private source question'
      )
    )
  );

  const archive = await dataArchiveService.exportUserData(SOURCE_USER);
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
  assert.equal(preflightBody.data.incoming.notes, 1);
  assert.equal(preflightBody.data.result.notes.imported, 1);

  const unauthenticated = await fetch(`${baseUrl}/export`);
  assert.equal(unauthenticated.status, 401);
});

test('archive export route returns precise safe validation failures', async () => {
  const originalExport = dataArchiveService.exportUserData;
  dataArchiveService.exportUserData = () => {
    throw new DataArchiveValidationError(
      'Archive contains 5001 sessions; the maximum is 5000'
    );
  };
  try {
    const response = await fetch(`${baseUrl}/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(
      body.error,
      'Archive contains 5001 sessions; the maximum is 5000'
    );
  } finally {
    dataArchiveService.exportUserData = originalExport;
  }
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
