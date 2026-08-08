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

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-rag-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { closeDatabase, getDatabase } = await import(dist('db.js'));
const { default: storageService } = await import(dist('storage.js'));
const { default: documentService } = await import(
  dist('services/documentService.js')
);
const { default: preferencesService } = await import(
  dist('services/preferencesService.js')
);
const { buildChatDocumentContext } = await import(
  dist('utils/chatDocumentContext.js')
);

const USER = 'rag-user';
const SESSION = 'rag-session';

after(() => {
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
    ) VALUES (?, ?, NULL, 'unused', 'admin', ?, ?)`
  )
  .run(USER, USER, now, now);
getDatabase()
  .prepare(
    `INSERT INTO sessions (
      id, user_id, title, model, created_at, updated_at
    ) VALUES (?, ?, 'rag test', 'test-model', ?, ?)`
  )
  .run(SESSION, USER, now, now);

const seedDocument = (id, filename, sessionId, chunks) => {
  storageService.saveDocument(
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
  storageService.saveDocumentChunks(
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
seedDocument('doc-session', 'session-notes.txt', SESSION, [
  { content: 'The pelican invoice total was four hundred dollars.' },
]);
seedDocument('doc-global', 'global-handbook.txt', undefined, [
  { content: 'The pelican handbook says refunds take ten days.' },
]);
seedDocument('doc-other', 'other-session.txt', 'unrelated-session', [
  { content: 'The pelican secret from another chat must stay there.' },
]);

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
  preferencesService.updatePreferences(
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
  seedDocument('doc-embedded', 'embedded.txt', SESSION, [
    { content: 'Semantic chunk about pelicans.', embedding: [1, 0] },
  ]);
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

  preferencesService.updatePreferences(
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
