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
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-rag-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { closeDatabase, getDatabase } = await import(dist('db.js'));
const closePlatformStorageFixture =
  await initializeSQLitePlatformStorageFixture(
    path.join(repoRoot, 'backend', 'dist')
  );
const { default: storageService } = await import(dist('storage.js'));
const { default: documentService, DocumentService } = await import(
  dist('services/documentService.js')
);
const { getPlatformStorageRuntime } = await import(
  dist('platform/storage/index.js')
);
const { getCoordinator } = await import(
  dist('platform/coordination/service.js')
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
const { default: preferencesService } = await import(
  dist('services/preferencesService.js')
);
const { encryptionService } = await import(
  dist('services/encryptionService.js')
);
const { buildChatDocumentContext } = await import(
  dist('utils/chatDocumentContext.js')
);

const USER = 'rag-user';
const SESSION = 'rag-session';
const DELETE_RACE_USER = 'rag-delete-race-user';
const SPEC_SNAPSHOT_USER = 'rag-spec-snapshot-user';
const LAZY_INDEX_USER = 'rag-lazy-index-user';
const BATCH_SEARCH_USER = 'rag-batch-search-user';
const LEGACY_UPGRADE_USER = 'rag-legacy-upgrade-user';
const LEGACY_TAMPER_USER = 'rag-legacy-tamper-user';
const LEGACY_FAILURE_USER = 'rag-legacy-failure-user';
const LEGACY_BUSY_USER = 'rag-legacy-busy-user';
const LARGE_INDEX_USER = 'rag-large-index-user';
const CHUNK_LIMIT_USER = 'rag-chunk-limit-user';

const withBarrierTimeout = (promise, label, milliseconds = 5_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}`)),
      milliseconds
    );
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

after(async () => {
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
const insertTestUser = userId =>
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', ?, ?)`
    )
    .run(userId, userId, now, now);
for (const userId of [
  USER,
  DELETE_RACE_USER,
  SPEC_SNAPSHOT_USER,
  LAZY_INDEX_USER,
  BATCH_SEARCH_USER,
  LEGACY_UPGRADE_USER,
  LEGACY_TAMPER_USER,
  LEGACY_FAILURE_USER,
  LEGACY_BUSY_USER,
  LARGE_INDEX_USER,
  CHUNK_LIMIT_USER,
]) {
  insertTestUser(userId);
}
getDatabase()
  .prepare(
    `INSERT INTO sessions (
      id, user_id, title, model, created_at, updated_at
    ) VALUES (?, ?, 'rag test', 'test-model', ?, ?)`
  )
  .run(SESSION, USER, now, now);

const seedDocument = async (id, filename, sessionId, chunks) => {
  await storageService.saveDocument(
    {
      id,
      filename,
      fileType: 'txt',
      size: 100,
      sessionId,
      uploadedAt: now,
      createdAt: now,
    },
    USER
  );
  await storageService.saveDocumentChunks(
    id,
    chunks.map((chunk, index) => ({
      id: `${id}-chunk-${index}`,
      documentId: id,
      content: chunk.content,
      embedding: chunk.embedding,
      chunkIndex: index,
      startChar: 0,
      endChar: chunk.content.length,
    }))
  );
};

// One document attached to the session, one uploaded with no session (a
// user-scoped upload), one attached to a different session.
await seedDocument('doc-session', 'session-notes.txt', SESSION, [
  { content: 'The pelican invoice total was four hundred dollars.' },
]);
await seedDocument('doc-global', 'global-handbook.txt', undefined, [
  { content: 'The pelican handbook says refunds take ten days.' },
]);
await seedDocument('doc-other', 'other-session.txt', 'unrelated-session', [
  { content: 'The pelican secret from another chat must stay there.' },
]);

test('document publish resolves a lost commit acknowledgement without deleting its source blob', async () => {
  const platform = getPlatformStorageRuntime();
  const documents = platform.domains.documents;
  const publish = documents.upsertWithBlobAndEnqueue.bind(documents);
  documents.upsertWithBlobAndEnqueue = async (...args) => {
    await publish(...args);
    throw new Error('injected acknowledgement loss after commit');
  };
  let queued;
  try {
    queued = await documentService.queueDocumentProcessing(
      'acknowledged-late.txt',
      Buffer.from('durable source survives an unknown commit outcome'),
      'text/plain',
      USER,
      SESSION
    );
  } finally {
    documents.upsertWithBlobAndEnqueue = publish;
  }

  assert.ok(queued.jobId);
  const persisted = await storageService.getDocument(queued.document.id, USER);
  assert.ok(persisted, 'the committed document must remain published');
  const reference = await platform.blobReferences.find(
    'document',
    queued.document.id,
    'document.source'
  );
  assert.ok(reference, 'the committed blob reference must remain published');
  const descriptor = await platform.blobStore.stat(reference.blobId, USER);
  assert.equal(
    descriptor.id,
    reference.blobId,
    'commit acknowledgement loss must not compensate the durable source blob'
  );
});

test('keyword retrieval sees session documents AND user-scoped uploads', async () => {
  const chunks = await documentService.searchDocuments(
    'pelican refunds invoice',
    USER,
    SESSION,
    5
  );
  const documentIds = new Set(chunks.map(chunk => chunk.documentId));
  assert.ok(documentIds.has('doc-session'), 'session document missing');
  assert.ok(
    documentIds.has('doc-global'),
    'user-scoped upload must join the session scope'
  );
  assert.ok(
    !documentIds.has('doc-other'),
    'documents from other sessions must stay out of scope'
  );
});

test('semantic retrieval tops up unembedded chunks and falls back to keywords', async () => {
  await preferencesService.updatePreferences(
    {
      embeddingSettings: {
        enabled: true,
        model: 'test-embed',
        chunkSize: 1000,
        chunkOverlap: 200,
        similarityThreshold: 0.3,
      },
    },
    USER
  );

  // doc-embedded matches the query embedding; doc-global has NO embeddings
  // and previously became invisible the moment embeddings were enabled.
  await seedDocument('doc-embedded', 'embedded.txt', SESSION, [
    { content: 'Semantic chunk about pelicans.', embedding: [1, 0] },
  ]);
  await getPlatformStorageRuntime().vectorStore.upsert({
    actor: { userId: USER },
    records: [
      {
        namespace: 'document-chunk',
        id: 'doc-embedded-chunk-0',
        ownerUserId: USER,
        resourceId: 'doc-embedded',
        model: 'test-embed',
        dimensions: 2,
        version: 'v1',
        sourceRevision: crypto
          .createHash('sha256')
          .update('Semantic chunk about pelicans.', 'utf8')
          .digest('hex'),
        embedding: [1, 0],
      },
    ],
  });
  documentService.generateEmbeddingForText = async () => [1, 0];

  const chunks = await documentService.searchDocuments(
    'pelican refunds',
    USER,
    SESSION,
    5
  );
  const documentIds = new Set(chunks.map(chunk => chunk.documentId));
  assert.ok(documentIds.has('doc-embedded'), 'embedded chunk missing');
  assert.ok(
    documentIds.has('doc-global'),
    'chunks without embeddings must still surface through keywords'
  );

  // Nothing clears the similarity threshold: keyword search takes over
  // rather than returning an empty context.
  documentService.generateEmbeddingForText = async () => [0, 1];
  const fallback = await documentService.searchDocuments(
    'pelican invoice',
    USER,
    SESSION,
    5
  );
  assert.ok(fallback.length > 0, 'keyword fallback must produce results');

  await preferencesService.updatePreferences(
    {
      embeddingSettings: {
        enabled: false,
        model: 'test-embed',
        chunkSize: 1000,
        chunkOverlap: 200,
        similarityThreshold: 0.3,
      },
    },
    USER
  );
});

test('a queued document observed before worker completion is refreshed from authoritative chunks', async () => {
  await preferencesService.updatePreferences(
    {
      embeddingSettings: {
        enabled: true,
        model: 'test-embed',
        chunkSize: 1000,
        chunkOverlap: 200,
        similarityThreshold: 0.3,
      },
    },
    USER
  );
  await seedDocument('doc-delayed', 'delayed-worker.txt', SESSION, []);
  documentService.generateEmbeddingForText = async () => [1, 0];

  const beforeCompletion = await documentService.searchDocuments(
    'narwhal durable completion',
    USER,
    SESSION,
    20
  );
  assert.ok(
    !beforeCompletion.some(chunk => chunk.documentId === 'doc-delayed'),
    'the queued placeholder must not fabricate chunks'
  );

  const completedChunks = [
    {
      id: 'doc-delayed-chunk-0',
      documentId: 'doc-delayed',
      content: 'The narwhal durable completion arrived from another worker.',
      embedding: [1, 0],
      chunkIndex: 0,
      startChar: 0,
      endChar: 59,
    },
  ];
  await storageService.saveDocumentChunks('doc-delayed', completedChunks);
  const delayedDocument = await storageService.getDocument('doc-delayed', USER);
  assert.ok(delayedDocument);
  // Model the external worker publishing PGVector without touching this app
  // replica's process-local state.
  await documentService.indexDocumentChunks(
    delayedDocument,
    completedChunks,
    USER
  );

  const afterCompletion = await documentService.searchDocuments(
    'narwhal durable completion',
    USER,
    SESSION,
    20
  );
  assert.ok(
    afterCompletion.some(chunk => chunk.documentId === 'doc-delayed'),
    'the app replica must observe durable worker chunks after first seeing an empty placeholder'
  );

  await preferencesService.updatePreferences(
    {
      embeddingSettings: {
        enabled: false,
        model: 'test-embed',
        chunkSize: 1000,
        chunkOverlap: 200,
        similarityThreshold: 0.3,
      },
    },
    USER
  );
});

test('semantic retrieval batches more than 100 scoped documents and keeps the global best hit', async () => {
  await preferencesService.updatePreferences(
    {
      embeddingSettings: {
        enabled: true,
        model: 'batch-search-model',
        chunkSize: 1000,
        chunkOverlap: 0,
        similarityThreshold: 0.2,
      },
    },
    BATCH_SEARCH_USER
  );
  for (let index = 0; index < 101; index += 1) {
    const documentId = `batch-document-${String(index).padStart(3, '0')}`;
    const content = `Opaque semantic payload ${index}.`;
    await storageService.saveDocument(
      {
        id: documentId,
        filename: `${documentId}.txt`,
        content,
        fileType: 'txt',
        size: content.length,
        uploadedAt: now + index,
        createdAt: now + index,
      },
      BATCH_SEARCH_USER
    );
    await storageService.saveDocumentChunks(documentId, [
      {
        id: `${documentId}-chunk`,
        documentId,
        content,
        chunkIndex: 0,
        startChar: 0,
        endChar: content.length,
      },
    ]);
  }

  const service = new DocumentService();
  service.generateEmbeddingForText = async () => [1, 0];
  const platform = getPlatformStorageRuntime();
  const originalQuery = platform.vectorStore.query.bind(platform.vectorStore);
  const batches = [];
  platform.vectorStore.query = async request => {
    batches.push([...request.resourceIds]);
    const resourceId = request.resourceIds[0];
    const chunk = (await storageService.getDocumentChunks(resourceId))[0];
    return [
      {
        id: chunk.id,
        namespace: 'document-chunk',
        ownerUserId: BATCH_SEARCH_USER,
        resourceId,
        model: request.model,
        dimensions: request.dimensions,
        version: request.version,
        sourceRevision: crypto
          .createHash('sha256')
          .update(chunk.content, 'utf8')
          .digest('hex'),
        score: batches.length === 1 ? 0.5 : 0.9,
        attributes: {},
      },
    ];
  };
  let result;
  try {
    result = await service.searchDocuments(
      'quasar zephyr xylophone',
      BATCH_SEARCH_USER,
      undefined,
      1
    );
  } finally {
    platform.vectorStore.query = originalQuery;
  }
  assert.equal(batches.length, 2);
  assert.equal(batches[0].length, 100);
  assert.equal(batches[1].length, 1);
  assert.equal(
    result[0].documentId,
    batches[1][0],
    'global ranking must prefer the higher-scoring hit from the second batch'
  );
});

test('SQLite first-use upgrades legacy inline embeddings without trusting their model provenance', async () => {
  const platform = getPlatformStorageRuntime();
  const settings = {
    enabled: true,
    model: 'legacy-upgrade-current-model',
    chunkSize: 1_000,
    chunkOverlap: 0,
    similarityThreshold: 0.2,
  };
  const seedLegacyDocument = async ({
    userId,
    documentId,
    authoritativeContent,
    legacyContent,
    metadata,
  }) => {
    await preferencesService.updatePreferences(
      { embeddingSettings: settings },
      userId
    );
    await storageService.saveDocument(
      {
        id: documentId,
        filename: `${documentId}.txt`,
        content: authoritativeContent,
        fileType: 'txt',
        size: authoritativeContent.length,
        uploadedAt: now,
        createdAt: now,
        ...(metadata ? { metadata } : {}),
      },
      userId
    );
    await storageService.saveDocumentChunks(documentId, [
      {
        id: `${documentId}-legacy-chunk`,
        documentId,
        content: legacyContent,
        embedding: [0, 1],
        chunkIndex: 0,
        startChar: 0,
        endChar: legacyContent.length,
      },
    ]);
  };

  const documentId = 'legacy-authenticated-inline-document';
  const authoritativeContent =
    'Authoritative cobalt protocol content is rebuilt from document text.';
  await seedLegacyDocument({
    userId: LEGACY_UPGRADE_USER,
    documentId,
    authoritativeContent,
    legacyContent: 'Stale inline chunk content must never be republished.',
  });
  assert.deepEqual(
    await platform.domains.documents.inspectLegacyChunkEmbeddings(
      documentId,
      LEGACY_UPGRADE_USER
    ),
    { present: true, authenticated: true }
  );

  const service = new DocumentService();
  const generated = [];
  service.generateEmbeddingForText = async (text, _userId, spec) => {
    generated.push({ text, model: spec.model });
    return [1, 0];
  };
  const semanticOnly = await service.searchDocuments(
    'quasar xylophone semantic probe',
    LEGACY_UPGRADE_USER,
    undefined,
    5
  );
  assert.equal(semanticOnly[0]?.documentId, documentId);
  assert.equal(semanticOnly[0]?.content, authoritativeContent);
  assert.ok(
    generated.some(call => call.text === authoritativeContent),
    'first use must re-embed authoritative text instead of copying the legacy payload'
  );
  assert.ok(generated.every(call => call.model === settings.model));
  const upgraded = await storageService.getDocument(
    documentId,
    LEGACY_UPGRADE_USER
  );
  assert.equal(upgraded.metadata.embeddingIndex.model, settings.model);
  const upgradedChunks = await storageService.getDocumentChunks(documentId);
  assert.deepEqual(
    upgradedChunks.map(chunk => chunk.embedding),
    [[1, 0]]
  );
  assert.notEqual(upgradedChunks[0].id, `${documentId}-legacy-chunk`);
  assert.equal(
    getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_vector_entries
          WHERE namespace = 'document-chunk' AND owner_user_id = ?
            AND resource_id = ? AND model = ?`
      )
      .get(LEGACY_UPGRADE_USER, documentId, settings.model).count,
    1
  );

  const tamperedDocumentId = 'legacy-corrupt-inline-document';
  const tamperedAuthoritativeContent =
    'Authoritative amber archive survives corrupt legacy vector ciphertext.';
  await seedLegacyDocument({
    userId: LEGACY_TAMPER_USER,
    documentId: tamperedDocumentId,
    authoritativeContent: tamperedAuthoritativeContent,
    legacyContent: 'corruptsignal keyword fallback source',
    metadata: { embeddingIndex: null },
  });
  const encryptedRow = getDatabase()
    .prepare('SELECT embedding FROM document_chunks WHERE document_id = ?')
    .get(tamperedDocumentId);
  assert.equal(encryptionService.isEncrypted(encryptedRow.embedding), true);
  const envelope = encryptedRow.embedding.split(':');
  envelope[1] = `${envelope[1][0] === '0' ? '1' : '0'}${envelope[1].slice(1)}`;
  getDatabase()
    .prepare('UPDATE document_chunks SET embedding = ? WHERE document_id = ?')
    .run(envelope.join(':'), tamperedDocumentId);
  assert.deepEqual(
    await platform.domains.documents.inspectLegacyChunkEmbeddings(
      tamperedDocumentId,
      LEGACY_TAMPER_USER
    ),
    { present: true, authenticated: false },
    'corrupt ciphertext must remain a repair signal'
  );
  const tamperService = new DocumentService();
  tamperService.generateEmbeddingForText = async () => [1, 0];
  const repairedTamper = await tamperService.searchDocuments(
    'quasar xylophone repair probe',
    LEGACY_TAMPER_USER
  );
  assert.equal(repairedTamper[0]?.documentId, tamperedDocumentId);
  assert.equal(
    (await storageService.getDocument(tamperedDocumentId, LEGACY_TAMPER_USER))
      .metadata.embeddingIndex.model,
    settings.model,
    'malformed legacy metadata must not suppress safe source re-embedding'
  );

  const failureDocumentId = 'legacy-provider-failure-document';
  await seedLegacyDocument({
    userId: LEGACY_FAILURE_USER,
    documentId: failureDocumentId,
    authoritativeContent:
      'fallbacktoken authoritative content remains keyword searchable.',
    legacyContent:
      'fallbacktoken legacy content remains visible when embedding fails.',
  });
  const failureService = new DocumentService();
  const failureQuery = 'fallbacktoken semantic request';
  const failureGenerationInputs = [];
  failureService.generateEmbeddingForText = async text => {
    failureGenerationInputs.push(text);
    return text === failureQuery ? [1, 0] : null;
  };
  const providerFallback = await failureService.searchDocuments(
    failureQuery,
    LEGACY_FAILURE_USER
  );
  assert.equal(providerFallback[0]?.documentId, failureDocumentId);
  assert.deepEqual(failureGenerationInputs, [
    failureQuery,
    'fallbacktoken authoritative content remains keyword searchable.',
  ]);
  assert.equal(
    (await storageService.getDocument(failureDocumentId, LEGACY_FAILURE_USER))
      .metadata?.embeddingIndex,
    undefined,
    'provider failure must not publish partial index metadata'
  );
  assert.equal(
    getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_vector_entries
          WHERE namespace = 'document-chunk' AND owner_user_id = ?
            AND resource_id = ?`
      )
      .get(LEGACY_FAILURE_USER, failureDocumentId).count,
    0,
    'provider failure must not publish partial vectors'
  );

  const busyDocumentId = 'legacy-busy-document';
  await seedLegacyDocument({
    userId: LEGACY_BUSY_USER,
    documentId: busyDocumentId,
    authoritativeContent:
      'busyfallback authoritative content remains keyword searchable.',
    legacyContent: 'busyfallback legacy content waits for the resource lease.',
  });
  const competingLease = await getCoordinator().acquireLease(
    `resource:${LEGACY_BUSY_USER}:document:${busyDocumentId}`,
    5_000
  );
  assert.ok(competingLease);
  const busyService = new DocumentService();
  busyService.generateEmbeddingForText = async () => [1, 0];
  try {
    const busyFallback = await busyService.searchDocuments(
      'busyfallback semantic request',
      LEGACY_BUSY_USER
    );
    assert.equal(busyFallback[0]?.documentId, busyDocumentId);
  } finally {
    await competingLease.release();
  }
  assert.equal(
    (await storageService.getDocument(busyDocumentId, LEGACY_BUSY_USER))
      .metadata?.embeddingIndex,
    undefined,
    'a busy repair lease must leave legacy publication untouched'
  );
});

test('SQLite regeneration compensates a vector recreated after document deletion', async () => {
  await preferencesService.updatePreferences(
    {
      embeddingSettings: {
        enabled: true,
        model: 'delete-race-model',
        chunkSize: 1000,
        chunkOverlap: 0,
        similarityThreshold: 0.25,
      },
    },
    DELETE_RACE_USER
  );
  const documentId = 'doc-regeneration-delete-race';
  await storageService.saveDocument(
    {
      id: documentId,
      filename: 'delete-race.txt',
      content: 'A vector publication paused while its document is deleted.',
      fileType: 'txt',
      size: 59,
      uploadedAt: now + 200_000,
      createdAt: now + 200_000,
    },
    DELETE_RACE_USER
  );

  const service = new DocumentService();
  service.generateEmbeddingForText = async () => [1, 0];
  const platform = getPlatformStorageRuntime();
  const originalUpsert = platform.vectorStore.upsert.bind(platform.vectorStore);
  let markUpsertStarted;
  let releaseUpsert;
  const upsertStarted = new Promise(resolve => {
    markUpsertStarted = resolve;
  });
  const upsertReleased = new Promise(resolve => {
    releaseUpsert = resolve;
  });
  platform.vectorStore.upsert = async request => {
    markUpsertStarted();
    await upsertReleased;
    return originalUpsert(request);
  };

  try {
    const regeneration = service.regenerateAllEmbeddings(DELETE_RACE_USER);
    await withBarrierTimeout(
      upsertStarted,
      'SQLite regeneration vector upsert'
    );
    assert.equal(
      await service.deleteDocument(documentId, DELETE_RACE_USER),
      true
    );
    releaseUpsert();
    const result = await regeneration;
    assert.equal(result.documentsRegenerated, 0);
    assert.ok(result.documentsSkipped >= 1);
  } finally {
    releaseUpsert?.();
    platform.vectorStore.upsert = originalUpsert;
  }

  assert.equal(
    getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_vector_entries
          WHERE namespace = ? AND owner_user_id = ? AND resource_id = ?`
      )
      .get('document-chunk', DELETE_RACE_USER, documentId).count,
    0,
    'the post-upsert authoritative check must remove the recreated vector'
  );
  assert.equal(
    getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_resource_deletion_tombstones
          WHERE resource_type = 'document' AND resource_id = ?`
      )
      .get(documentId).count,
    1,
    'relational deletion must be allowed to publish its tombstone while regeneration holds the lease'
  );
});

test('SQLite regeneration and semantic query keep one immutable embedding spec', async () => {
  const modelA = {
    enabled: true,
    model: 'snapshot-model-a',
    chunkSize: 48,
    chunkOverlap: 0,
    similarityThreshold: 0.2,
  };
  const modelB = {
    enabled: true,
    model: 'snapshot-model-b',
    chunkSize: 24,
    chunkOverlap: 0,
    similarityThreshold: 0.85,
  };
  const modelC = {
    enabled: true,
    model: 'snapshot-model-c',
    chunkSize: 16,
    chunkOverlap: 0,
    similarityThreshold: 0.95,
  };
  await preferencesService.updatePreferences(
    { embeddingSettings: modelA },
    SPEC_SNAPSHOT_USER
  );
  const documentId = 'doc-regeneration-model-snapshot';
  await storageService.saveDocument(
    {
      id: documentId,
      filename: 'model-snapshot.txt',
      content:
        'First paragraph uses the captured model.\n\nSecond paragraph must use that same captured model.',
      fileType: 'txt',
      size: 91,
      uploadedAt: now,
      createdAt: now,
    },
    SPEC_SNAPSHOT_USER
  );

  const service = new DocumentService();
  const generationSpecs = [];
  let markGenerationStarted;
  let releaseGeneration;
  const generationStarted = new Promise(resolve => {
    markGenerationStarted = resolve;
  });
  const generationReleased = new Promise(resolve => {
    releaseGeneration = resolve;
  });
  service.generateEmbeddingForText = async (_text, _userId, spec) => {
    generationSpecs.push(structuredClone(spec));
    if (generationSpecs.length === 1) {
      markGenerationStarted();
      await generationReleased;
    }
    return [1, 0];
  };

  const regeneration = service.regenerateAllEmbeddings(SPEC_SNAPSHOT_USER);
  await withBarrierTimeout(
    generationStarted,
    'SQLite regeneration embedding generation'
  );
  await preferencesService.updatePreferences(
    { embeddingSettings: modelB },
    SPEC_SNAPSHOT_USER
  );
  releaseGeneration();
  const result = await regeneration;
  assert.ok(result.documentsRegenerated >= 1);
  assert.ok(generationSpecs.length >= 2);
  for (const spec of generationSpecs) {
    assert.equal(spec.model, modelA.model);
    assert.equal(spec.chunkSize, modelA.chunkSize);
    assert.equal(spec.similarityThreshold, modelA.similarityThreshold);
    assert.equal(spec.version, 'v1');
  }
  const indexed = await storageService.getDocument(
    documentId,
    SPEC_SNAPSHOT_USER
  );
  assert.equal(indexed.metadata.embeddingIndex.model, modelA.model);
  assert.equal(indexed.metadata.embeddingIndex.chunkSize, modelA.chunkSize);
  assert.equal(
    indexed.metadata.embeddingIndex.similarityThreshold,
    modelA.similarityThreshold
  );
  const indexedModels = getDatabase()
    .prepare(
      `SELECT DISTINCT model FROM platform_vector_entries
        WHERE namespace = ? AND owner_user_id = ? AND resource_id = ?`
    )
    .all('document-chunk', SPEC_SNAPSHOT_USER, documentId)
    .map(row => row.model);
  assert.deepEqual(indexedModels, [modelA.model]);

  const platform = getPlatformStorageRuntime();
  const collectionId = 'regeneration-routing-survives';
  await storageService.saveKnowledgeCollection(
    {
      id: collectionId,
      name: 'Regeneration routing race',
      createdAt: now,
      updatedAt: now,
    },
    SPEC_SNAPSHOT_USER
  );
  const documents = platform.domains.documents;
  const originalPublishEmbeddingIndex =
    documents.publishEmbeddingIndex.bind(documents);
  let markIndexPublicationStarted;
  let releaseIndexPublication;
  const indexPublicationStarted = new Promise(resolve => {
    markIndexPublicationStarted = resolve;
  });
  const indexPublicationReleased = new Promise(resolve => {
    releaseIndexPublication = resolve;
  });
  documents.publishEmbeddingIndex = async (...args) => {
    if (args[0] === documentId) {
      markIndexPublicationStarted();
      await indexPublicationReleased;
    }
    return originalPublishEmbeddingIndex(...args);
  };
  try {
    const routingRegeneration =
      service.regenerateAllEmbeddings(SPEC_SNAPSHOT_USER);
    await withBarrierTimeout(
      indexPublicationStarted,
      'SQLite embedding index publication'
    );
    assert.equal(
      await storageService.setDocumentCollection(
        documentId,
        collectionId,
        SPEC_SNAPSHOT_USER
      ),
      true,
      'the collection update must be acknowledged while regeneration is paused'
    );
    releaseIndexPublication();
    await routingRegeneration;
  } finally {
    releaseIndexPublication?.();
    documents.publishEmbeddingIndex = originalPublishEmbeddingIndex;
  }
  assert.equal(
    (await storageService.getDocument(documentId, SPEC_SNAPSHOT_USER))
      .collectionId,
    collectionId,
    'regeneration must not overwrite an acknowledged collection update'
  );

  const beforeSourceRace = await storageService.getDocument(
    documentId,
    SPEC_SNAPSHOT_USER
  );
  const beforeSourceRaceChunks =
    await storageService.getDocumentChunks(documentId);
  let markSourcePublicationStarted;
  let releaseSourcePublication;
  const sourcePublicationStarted = new Promise(resolve => {
    markSourcePublicationStarted = resolve;
  });
  const sourcePublicationReleased = new Promise(resolve => {
    releaseSourcePublication = resolve;
  });
  documents.publishEmbeddingIndex = async (...args) => {
    if (args[0] === documentId) {
      markSourcePublicationStarted();
      await sourcePublicationReleased;
    }
    return originalPublishEmbeddingIndex(...args);
  };
  let sourceRaceResult;
  try {
    const sourceRaceRegeneration =
      service.regenerateAllEmbeddings(SPEC_SNAPSHOT_USER);
    await withBarrierTimeout(
      sourcePublicationStarted,
      'SQLite source-conditional index publication'
    );
    await storageService.saveDocument(
      {
        ...beforeSourceRace,
        content: 'An archive replaced the source while regeneration paused.',
        size: 57,
      },
      SPEC_SNAPSHOT_USER
    );
    releaseSourcePublication();
    sourceRaceResult = await sourceRaceRegeneration;
  } finally {
    releaseSourcePublication?.();
    documents.publishEmbeddingIndex = originalPublishEmbeddingIndex;
  }
  assert.equal(sourceRaceResult.documentsRegenerated, 0);
  assert.equal(sourceRaceResult.documentsSkipped, 1);
  const afterSourceRace = await storageService.getDocument(
    documentId,
    SPEC_SNAPSHOT_USER
  );
  assert.equal(
    afterSourceRace.content,
    'An archive replaced the source while regeneration paused.'
  );
  assert.equal(
    afterSourceRace.metadata.embeddingIndex.aggregateRevision,
    beforeSourceRace.metadata.embeddingIndex.aggregateRevision,
    'a superseded regeneration must not publish index metadata'
  );
  assert.deepEqual(
    await storageService.getDocumentChunks(documentId),
    beforeSourceRaceChunks,
    'a superseded regeneration must not replace chunks derived from the prior source'
  );

  const originalQuery = platform.vectorStore.query.bind(platform.vectorStore);
  let capturedQuery;
  platform.vectorStore.query = async request => {
    capturedQuery = structuredClone(request);
    return [];
  };
  let markQueryEmbeddingStarted;
  let releaseQueryEmbedding;
  const queryEmbeddingStarted = new Promise(resolve => {
    markQueryEmbeddingStarted = resolve;
  });
  const queryEmbeddingReleased = new Promise(resolve => {
    releaseQueryEmbedding = resolve;
  });
  service.generateEmbeddingForText = async (_text, _userId, spec) => {
    assert.equal(spec.model, modelB.model);
    markQueryEmbeddingStarted();
    await queryEmbeddingReleased;
    return [1, 0];
  };
  try {
    const search = service.searchDocuments(
      'immutable query model',
      SPEC_SNAPSHOT_USER
    );
    await withBarrierTimeout(
      queryEmbeddingStarted,
      'SQLite semantic query embedding'
    );
    await preferencesService.updatePreferences(
      { embeddingSettings: modelC },
      SPEC_SNAPSHOT_USER
    );
    releaseQueryEmbedding();
    await search;
  } finally {
    releaseQueryEmbedding?.();
    platform.vectorStore.query = originalQuery;
  }
  assert.equal(capturedQuery.model, modelB.model);
  assert.equal(capturedQuery.minScore, modelB.similarityThreshold);
  assert.equal(capturedQuery.version, 'v1');

  await preferencesService.updatePreferences(
    { embeddingSettings: { ...modelC, enabled: false } },
    SPEC_SNAPSHOT_USER
  );
});

test('SQLite lazy semantic publication serializes with regeneration', async () => {
  const modelA = {
    enabled: true,
    model: 'lazy-index-model-a',
    chunkSize: 40,
    chunkOverlap: 0,
    similarityThreshold: 0.2,
  };
  const modelB = {
    ...modelA,
    model: 'lazy-index-model-b',
    similarityThreshold: 0.8,
  };
  await preferencesService.updatePreferences(
    { embeddingSettings: modelA },
    LAZY_INDEX_USER
  );
  const documentId = 'doc-lazy-index-regeneration-race';
  await storageService.saveDocument(
    {
      id: documentId,
      filename: 'lazy-index-race.txt',
      content:
        'A lazy vector publication begins.\n\nRegeneration must wait for its lease.',
      fileType: 'txt',
      size: 59,
      uploadedAt: now,
      createdAt: now,
    },
    LAZY_INDEX_USER
  );

  const service = new DocumentService();
  service.generateEmbeddingForText = async (_text, _userId, spec) =>
    spec.model === modelA.model ? [1, 0] : [0, 1];
  const first = await service.regenerateAllEmbeddings(LAZY_INDEX_USER);
  assert.equal(first.documentsRegenerated, 1);

  const platform = getPlatformStorageRuntime();
  assert.equal(platform.dialect, 'sqlite');
  const published = await storageService.getDocument(
    documentId,
    LAZY_INDEX_USER
  );
  assert.equal(published.metadata.embeddingIndex.model, modelA.model);
  assert.equal(published.metadata.embeddingIndex.chunkSize, modelA.chunkSize);
  assert.equal(
    published.metadata.embeddingIndex.chunkOverlap,
    modelA.chunkOverlap
  );
  const publishedChunks = await storageService.getDocumentChunks(documentId);
  assert.equal(publishedChunks.length, 2);
  for (const chunk of publishedChunks) {
    assert.deepEqual(chunk.embedding, [1, 0]);
  }
  assert.equal(
    publishedChunks[1].content,
    'Regeneration must wait for its lease.',
    'zero overlap must not duplicate the entire preceding chunk'
  );
  const originalDelete = platform.vectorStore.delete.bind(platform.vectorStore);
  const originalUpsert = platform.vectorStore.upsert.bind(platform.vectorStore);
  let healthyDeleteCalls = 0;
  let healthyUpsertCalls = 0;
  platform.vectorStore.delete = async request => {
    healthyDeleteCalls += 1;
    return originalDelete(request);
  };
  platform.vectorStore.upsert = async request => {
    healthyUpsertCalls += 1;
    return originalUpsert(request);
  };
  try {
    const healthy = await service.searchDocuments(
      'semantic-only healthy index read',
      LAZY_INDEX_USER
    );
    assert.ok(healthy.some(chunk => chunk.documentId === documentId));
    assert.equal(
      healthyDeleteCalls,
      0,
      'a healthy SQLite semantic read must not delete vectors'
    );
    assert.equal(
      healthyUpsertCalls,
      0,
      'a healthy SQLite semantic read must not rewrite vectors'
    );
  } finally {
    platform.vectorStore.delete = originalDelete;
    platform.vectorStore.upsert = originalUpsert;
  }
  await platform.vectorStore.delete({
    actor: { userId: LAZY_INDEX_USER },
    namespace: 'document-chunk',
    ids: [publishedChunks[0].id],
  });
  const originalIndexDocumentChunks = service.indexDocumentChunks.bind(service);
  let markLazyIndexStarted;
  const lazyIndexStarted = new Promise(resolve => {
    markLazyIndexStarted = resolve;
  });
  service.indexDocumentChunks = async (...args) => {
    markLazyIndexStarted();
    return originalIndexDocumentChunks(...args);
  };
  let upsertCalls = 0;
  let markLazyUpsertStarted;
  let releaseLazyUpsert;
  const lazyUpsertStarted = new Promise(resolve => {
    markLazyUpsertStarted = resolve;
  });
  const lazyUpsertReleased = new Promise(resolve => {
    releaseLazyUpsert = resolve;
  });
  platform.vectorStore.upsert = async request => {
    upsertCalls += 1;
    if (upsertCalls === 1) {
      markLazyUpsertStarted();
      await lazyUpsertReleased;
    }
    return originalUpsert(request);
  };

  try {
    const search = service.searchDocuments(
      'lazy vector publication',
      LAZY_INDEX_USER
    );
    await withBarrierTimeout(lazyIndexStarted, 'lazy index invocation');
    await withBarrierTimeout(lazyUpsertStarted, 'lazy vector upsert');
    const competingLease = await getCoordinator().acquireLease(
      `resource:${LAZY_INDEX_USER}:document:${documentId}`,
      5_000
    );
    assert.equal(
      competingLease,
      null,
      'lazy SQLite publication must hold the shared document resource lease'
    );

    await preferencesService.updatePreferences(
      { embeddingSettings: modelB },
      LAZY_INDEX_USER
    );
    const regeneration = service.regenerateAllEmbeddings(LAZY_INDEX_USER);
    releaseLazyUpsert();
    await Promise.all([search, regeneration]);
  } finally {
    releaseLazyUpsert?.();
    service.indexDocumentChunks = originalIndexDocumentChunks;
    platform.vectorStore.upsert = originalUpsert;
  }

  const finalDocument = await storageService.getDocument(
    documentId,
    LAZY_INDEX_USER
  );
  assert.equal(finalDocument.metadata.embeddingIndex.model, modelB.model);
  const finalModels = getDatabase()
    .prepare(
      `SELECT DISTINCT model FROM platform_vector_entries
        WHERE namespace = ? AND owner_user_id = ? AND resource_id = ?`
    )
    .all('document-chunk', LAZY_INDEX_USER, documentId)
    .map(row => row.model);
  assert.deepEqual(
    finalModels,
    [modelB.model],
    'the newer leased regeneration must remain authoritative'
  );

  await preferencesService.updatePreferences(
    { embeddingSettings: { ...modelB, enabled: false } },
    LAZY_INDEX_USER
  );
});

test('SQLite publishes and exactly repairs a 1,001-chunk document in bounded vector batches', async () => {
  const model = {
    enabled: true,
    model: 'large-index-model',
    chunkSize: 16,
    chunkOverlap: 0,
    similarityThreshold: 0.2,
  };
  await preferencesService.updatePreferences(
    { embeddingSettings: model },
    LARGE_INDEX_USER
  );
  const documentId = 'doc-large-vector-index';
  const content = Array.from(
    { length: 1_001 },
    (_, index) => `segment-${String(index).padStart(4, '0')}`
  ).join('\n\n');
  await storageService.saveDocument(
    {
      id: documentId,
      filename: 'large-vector-index.txt',
      content,
      fileType: 'txt',
      size: Buffer.byteLength(content),
      uploadedAt: now,
      createdAt: now,
    },
    LARGE_INDEX_USER
  );

  const service = new DocumentService();
  service.generateEmbeddingForText = async () => [1, 0];
  const platform = getPlatformStorageRuntime();
  const originalUpsert = platform.vectorStore.upsert.bind(platform.vectorStore);
  const batches = [];
  platform.vectorStore.upsert = async request => {
    batches.push(request.records.length);
    return originalUpsert(request);
  };
  try {
    const regenerated = await service.regenerateAllEmbeddings(LARGE_INDEX_USER);
    assert.equal(regenerated.documentsRegenerated, 1);
    assert.equal(regenerated.chunksTotal, 1_001);
    assert.deepEqual(
      batches,
      [1_000, 1],
      'publication must respect the store mutation ceiling'
    );

    const published = await storageService.getDocument(
      documentId,
      LARGE_INDEX_USER
    );
    const chunks = await storageService.getDocumentChunks(documentId);
    assert.equal(chunks.length, 1_001);
    const probe = {
      actor: { userId: LARGE_INDEX_USER },
      namespace: 'document-chunk',
      resourceId: documentId,
      model: published.metadata.embeddingIndex.model,
      dimensions: published.metadata.embeddingIndex.dimensions,
      version: published.metadata.embeddingIndex.version,
      entries: chunks.map(chunk => ({
        id: chunk.id,
        sourceRevision: crypto
          .createHash('sha256')
          .update(chunk.content, 'utf8')
          .digest('hex'),
      })),
    };
    assert.equal(
      await platform.vectorStore.hasExactResourceIndex(probe),
      true,
      'the paged probe must accept the complete 1,001-record index'
    );

    await platform.vectorStore.delete({
      actor: { userId: LARGE_INDEX_USER },
      namespace: 'document-chunk',
      ids: [chunks[500].id],
    });
    assert.equal(
      await platform.vectorStore.hasExactResourceIndex(probe),
      false,
      'the paged probe must reject a partial 1,001-record index'
    );

    batches.length = 0;
    const repaired = await service.searchDocuments(
      'semantic-only repair request',
      LARGE_INDEX_USER
    );
    assert.ok(repaired.some(chunk => chunk.documentId === documentId));
    assert.deepEqual(
      batches,
      [1_000, 1],
      'lazy repair must republish the complete index in bounded batches'
    );
    assert.equal(await platform.vectorStore.hasExactResourceIndex(probe), true);
  } finally {
    platform.vectorStore.upsert = originalUpsert;
    await preferencesService.updatePreferences(
      { embeddingSettings: { ...model, enabled: false } },
      LARGE_INDEX_USER
    );
  }
});

test('durable ingestion rejects 100,001 chunks before publication without retrying', async () => {
  const model = {
    enabled: true,
    model: 'chunk-limit-model',
    chunkSize: 1,
    chunkOverlap: 0,
    similarityThreshold: 0.2,
  };
  await preferencesService.updatePreferences(
    { embeddingSettings: model },
    CHUNK_LIMIT_USER
  );
  const content = Array.from({ length: 100_001 }, () => 'x').join('\n\n');
  const queued = await documentService.queueDocumentProcessing(
    'over-chunk-limit.txt',
    Buffer.from(content),
    'text/plain',
    CHUNK_LIMIT_USER
  );
  const originalGenerate = documentService.generateEmbeddingForText;
  let embeddingCalls = 0;
  documentService.generateEmbeddingForText = async (_text, userId) => {
    if (userId === CHUNK_LIMIT_USER) embeddingCalls += 1;
    return [1, 0];
  };
  const runtime = getDurableJobRuntime();
  const worker = new EmbeddedDurableJobWorker({
    service: runtime.service,
    handlers: createDomainDurableJobHandlers(),
    workerId: 'rag-chunk-limit-worker',
    leaseMs: 1_000,
    pollIntervalMs: 10,
    isActorAuthorized: async () => true,
  });
  try {
    worker.start();
    const deadline = Date.now() + 5_000;
    while (
      runtime.service.getMetadata(queued.jobId).state !== 'dead_letter' &&
      Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    await worker.stop();
    documentService.generateEmbeddingForText = originalGenerate;
  }
  const terminal = runtime.service.getMetadata(queued.jobId);
  assert.equal(terminal.state, 'dead_letter');
  assert.equal(terminal.attemptCount, 1);
  assert.equal(terminal.errorCode, 'document-chunk-limit');
  assert.match(terminal.errorSummary, /100000-chunk indexing limit/);
  assert.match(terminal.errorSummary, /increase the embedding chunk size/i);
  assert.deepEqual(
    runtime.service.listAttempts(queued.jobId).map(attempt => attempt.outcome),
    ['dead_letter'],
    'the deterministic chunk limit must never schedule a retry'
  );
  assert.equal(
    embeddingCalls,
    0,
    'the ceiling must be enforced before any provider-side embedding work'
  );
  const retained = await storageService.getDocument(
    queued.document.id,
    CHUNK_LIMIT_USER
  );
  assert.equal(retained.content ?? '', '');
  assert.equal(retained.metadata.processingStatus, 'queued');
  assert.deepEqual(
    await storageService.getDocumentChunks(queued.document.id),
    [],
    'no relational chunks may be published after the limit failure'
  );
  assert.equal(
    getDatabase()
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_vector_entries
          WHERE namespace = ? AND owner_user_id = ? AND resource_id = ?`
      )
      .get('document-chunk', CHUNK_LIMIT_USER, queued.document.id).count,
    0,
    'no partial vector resource may be published after the limit failure'
  );
  await preferencesService.updatePreferences(
    { embeddingSettings: { ...model, enabled: false } },
    CHUNK_LIMIT_USER
  );
});

test('the chat context builder reports which documents contributed', async () => {
  const context = await buildChatDocumentContext(
    'pelican refunds invoice',
    SESSION,
    USER
  );
  assert.equal(context.hasRelevantContext, true);
  assert.match(context.enhancedContent, /RELEVANT DOCUMENTS/);
  assert.ok(context.sources.length > 0);
  for (const source of context.sources) {
    assert.equal(typeof source.id, 'string');
    assert.equal(typeof source.filename, 'string');
    assert.notEqual(source.filename, '');
  }
  const names = context.sources.map(source => source.filename);
  assert.ok(names.includes('session-notes.txt'));
});

test('chat retrieval propagates Stop while keyword storage is in flight', async () => {
  const originalGetAllDocuments = storageService.getAllDocuments;
  const controller = new AbortController();
  const cancellation = new Error('retrieval stopped');
  let releaseRetrieval;
  const retrievalBlocked = new Promise(resolve => {
    releaseRetrieval = resolve;
  });
  let observeRetrieval;
  const retrievalStarted = new Promise(resolve => {
    observeRetrieval = resolve;
  });
  storageService.getAllDocuments = async (...args) => {
    observeRetrieval();
    await retrievalBlocked;
    return originalGetAllDocuments.apply(storageService, args);
  };

  try {
    const retrieval = buildChatDocumentContext(
      'pelican refunds invoice',
      SESSION,
      USER,
      controller.signal
    );
    await retrievalStarted;
    controller.abort(cancellation);
    releaseRetrieval();
    await assert.rejects(retrieval, error => error === cancellation);
  } finally {
    releaseRetrieval?.();
    storageService.getAllDocuments = originalGetAllDocuments;
  }
});
