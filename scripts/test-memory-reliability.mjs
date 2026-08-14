/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-memory-reliability-')
);
process.env.DATA_DIR = path.join(root, 'data');
process.env.ENCRYPTION_KEY ||= 'a'.repeat(64);

const { configurePlatformStorageRuntime } =
  await import('../backend/dist/platform/storage/platformStorageRuntime.js');
const { MemoryService } =
  await import('../backend/dist/services/memoryService.js');

const clone = value => structuredClone(value);

const vectorHit = record => ({
  id: record.id,
  namespace: record.namespace,
  ownerUserId: record.ownerUserId,
  resourceId: record.resourceId,
  model: record.model,
  dimensions: record.dimensions,
  version: record.version,
  sourceRevision: record.sourceRevision,
  score: 1,
  attributes: record.attributes ?? {},
});

const createRuntime = ({
  rows = new Map(),
  vectors = new Map(),
  insert,
  upsert,
  afterUpsert,
  query,
} = {}) => {
  const memories = {
    async insert(record) {
      if (insert) return insert(record);
      if (rows.has(record.id)) throw new Error('duplicate memory identifier');
      rows.set(record.id, clone(record));
    },
    async findByOwner(id, userId, personaId) {
      const record = rows.get(id);
      return record?.userId === userId && record?.personaId === personaId
        ? clone(record)
        : undefined;
    },
    async deleteIds(ids) {
      let deleted = 0;
      for (const id of ids) deleted += rows.delete(id) ? 1 : 0;
      return deleted;
    },
  };
  const vectorStore = {
    async upsert(request) {
      if (upsert) await upsert(request);
      else {
        for (const record of request.records) {
          vectors.set(record.id, clone(record));
        }
      }
      await afterUpsert?.(request);
    },
    async query(request) {
      if (query) return query(request);
      return [...vectors.values()].map(vectorHit);
    },
    async delete({ ids = [] }) {
      let deleted = 0;
      for (const id of ids) deleted += vectors.delete(id) ? 1 : 0;
      return deleted;
    },
    async deleteAllForOwner() {
      return 0;
    },
  };
  return {
    runtime: {
      dialect: 'postgres',
      blobStore: {},
      blobReferences: {},
      blobQuota: {},
      vectorStore,
      domains: { memories },
      async health() {
        return {
          ready: true,
          dialect: 'postgres',
          blobs: 's3',
          vectors: 'pgvector',
        };
      },
      async close() {},
    },
    rows,
    vectors,
  };
};

const serviceWithEmbedding = embedding => {
  const service = new MemoryService();
  service.generateEmbedding = async () => embedding;
  service.findSimilarMemories = async () => [];
  return service;
};

test('memory insert acknowledgement loss resolves the committed row and retry is idempotent', async () => {
  const rows = new Map();
  let loseAcknowledgement = true;
  const fixture = createRuntime({
    rows,
    async insert(record) {
      if (rows.has(record.id)) throw new Error('duplicate memory identifier');
      rows.set(record.id, clone(record));
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('injected post-COMMIT insert acknowledgement loss');
      }
    },
  });
  configurePlatformStorageRuntime(fixture.runtime);
  const service = serviceWithEmbedding(null);

  const first = await service.storeMemory(
    'memory-owner',
    'memory-persona',
    'the exact retry payload',
    'memory-model',
    undefined,
    0.7,
    'fact'
  );
  const retry = await service.storeMemory(
    'memory-owner',
    'memory-persona',
    'the exact retry payload',
    'memory-model',
    undefined,
    0.7,
    'fact'
  );

  assert.equal(first.id, retry.id);
  assert.equal(rows.size, 1);
});

test('vector acknowledgement loss authenticates the committed vector before success', async () => {
  const rows = new Map();
  const vectors = new Map();
  let loseAcknowledgement = true;
  const fixture = createRuntime({
    rows,
    vectors,
    async upsert({ records }) {
      for (const record of records) vectors.set(record.id, clone(record));
      if (loseAcknowledgement) {
        loseAcknowledgement = false;
        throw new Error('injected post-COMMIT vector acknowledgement loss');
      }
    },
  });
  configurePlatformStorageRuntime(fixture.runtime);
  const service = serviceWithEmbedding([0.25, 0.75]);

  const stored = await service.storeMemory(
    'vector-owner',
    'vector-persona',
    'committed vector payload',
    'memory-model',
    undefined,
    0.7,
    'fact'
  );

  assert.equal(rows.size, 1);
  assert.equal(vectors.size, 1);
  assert.ok(vectors.has(stored.id));
});

test('unconfirmed vector outcome retains SQL and the exact retry heals it', async () => {
  const rows = new Map();
  const vectors = new Map();
  let failBeforeCommit = true;
  const fixture = createRuntime({
    rows,
    vectors,
    async upsert({ records }) {
      if (failBeforeCommit) {
        failBeforeCommit = false;
        throw new Error('injected vector rollback');
      }
      for (const record of records) vectors.set(record.id, clone(record));
    },
  });
  configurePlatformStorageRuntime(fixture.runtime);
  const service = serviceWithEmbedding([0.4, 0.6]);
  const request = [
    'retry-owner',
    'retry-persona',
    'retry heals the missing vector',
    'memory-model',
    undefined,
    0.8,
    'instruction',
  ];

  await assert.rejects(
    service.storeMemory(...request),
    /relational memory was retained for idempotent retry/
  );
  assert.equal(rows.size, 1);
  assert.equal(vectors.size, 0);

  const retry = await service.storeMemory(...request);
  assert.equal(rows.size, 1);
  assert.equal(vectors.size, 1);
  assert.ok(vectors.has(retry.id));
});

test('persona deletion during vector publication still removes the recreated vector', async () => {
  const rows = new Map();
  const vectors = new Map();
  const fixture = createRuntime({
    rows,
    vectors,
    async afterUpsert({ records }) {
      rows.delete(records[0].id);
    },
  });
  configurePlatformStorageRuntime(fixture.runtime);
  const service = serviceWithEmbedding([0.1, 0.9]);

  await assert.rejects(
    service.storeMemory(
      'deleted-owner',
      'deleted-persona',
      'deleted during indexing',
      'memory-model',
      undefined,
      0.7,
      'context'
    ),
    /disappeared while it was being indexed/
  );
  assert.equal(rows.size, 0);
  assert.equal(vectors.size, 0);
});

const integrationUrl = process.env.TEST_POSTGRES_URL?.trim();

test(
  'real PostgreSQL and PGVector resolve post-COMMIT memory acknowledgement loss',
  { skip: integrationUrl ? false : 'TEST_POSTGRES_URL is not configured' },
  async () => {
    const parsed = new URL(integrationUrl);
    assert.match(
      parsed.pathname.slice(1),
      /test/i,
      'TEST_POSTGRES_URL must name a disposable test database'
    );
    const schema = `libre_memory_ack_${process.pid}_${Date.now()}`;
    const schemaUrl = new URL(integrationUrl);
    schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const { resolvePostgresRuntimeConfig } =
      await import('../backend/dist/persistence/postgresConfig.js');
    const { createPostgresDatabase } =
      await import('../backend/dist/persistence/postgresDatabase.js');
    const { createPostgresPlatformDomainRepositories } =
      await import('../backend/dist/platform/storage/postgresPlatformDomainRepositories.js');
    const { PgVectorStore } =
      await import('../backend/dist/platform/storage/pgVectorStore.js');
    const { POSTGRES_VECTOR_SCHEMA_SQL } =
      await import('../backend/dist/platform/storage/storageSchemaContracts.js');
    const bootstrap = createPostgresDatabase(
      resolvePostgresRuntimeConfig({
        DATABASE_URL: integrationUrl,
        DATABASE_SSL_MODE: 'disable',
        POSTGRES_APPLICATION_NAME: 'libre-memory-ack-bootstrap',
      })
    );
    let database;
    try {
      await bootstrap.query('CREATE EXTENSION IF NOT EXISTS vector');
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      database = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          DATABASE_URL: schemaUrl.toString(),
          DATABASE_SSL_MODE: 'disable',
          POSTGRES_APPLICATION_NAME: 'libre-memory-ack-test',
        })
      );
      await database.query(`
        CREATE TABLE users (id TEXT PRIMARY KEY);
        CREATE TABLE personas (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
        );
      `);
      await database.query(POSTGRES_VECTOR_SCHEMA_SQL);
      await database.query("INSERT INTO users (id) VALUES ('real-owner')");
      await database.query(
        "INSERT INTO personas (id, user_id) VALUES ('real-persona', 'real-owner')"
      );
      const cipher = {
        encrypt: plaintext =>
          `enc:${Buffer.from(plaintext).toString('base64')}`,
        decrypt: ciphertext =>
          Buffer.from(ciphertext.slice(4), 'base64').toString('utf8'),
        decryptAuthenticated: ciphertext =>
          Buffer.from(ciphertext.slice(4), 'base64').toString('utf8'),
        isEncrypted: ciphertext => ciphertext.startsWith('enc:'),
      };
      let loseInsertAcknowledgement = true;
      const insertAckDatabase = {
        query: async (sql, parameters) => {
          const result = await database.query(sql, parameters);
          if (
            loseInsertAcknowledgement &&
            sql.includes('INSERT INTO platform_persona_memories')
          ) {
            loseInsertAcknowledgement = false;
            throw new Error('injected real memory INSERT acknowledgement loss');
          }
          return result;
        },
        transaction: database.transaction.bind(database),
      };
      let vectorStore = new PgVectorStore({ database });
      let domains = createPostgresPlatformDomainRepositories(
        insertAckDatabase,
        cipher
      );
      configurePlatformStorageRuntime({
        dialect: 'postgres',
        blobStore: {},
        blobReferences: {},
        blobQuota: {},
        vectorStore,
        domains,
        async health() {
          return {
            ready: true,
            dialect: 'postgres',
            blobs: 's3',
            vectors: 'pgvector',
          };
        },
        async close() {},
      });
      let service = serviceWithEmbedding(null);
      const insertResolved = await service.storeMemory(
        'real-owner',
        'real-persona',
        'real insert acknowledgement loss',
        'real-memory-model',
        undefined,
        0.7,
        'fact'
      );
      const insertRetry = await service.storeMemory(
        'real-owner',
        'real-persona',
        'real insert acknowledgement loss',
        'real-memory-model',
        undefined,
        0.7,
        'fact'
      );
      assert.equal(insertResolved.id, insertRetry.id);

      let loseVectorAcknowledgement = true;
      const vectorAckDatabase = {
        query: database.query.bind(database),
        transaction: async (operation, options) => {
          const result = await database.transaction(operation, options);
          if (loseVectorAcknowledgement) {
            loseVectorAcknowledgement = false;
            throw new Error('injected real PGVector acknowledgement loss');
          }
          return result;
        },
      };
      vectorStore = new PgVectorStore({ database: vectorAckDatabase });
      domains = createPostgresPlatformDomainRepositories(database, cipher);
      configurePlatformStorageRuntime({
        dialect: 'postgres',
        blobStore: {},
        blobReferences: {},
        blobQuota: {},
        vectorStore,
        domains,
        async health() {
          return {
            ready: true,
            dialect: 'postgres',
            blobs: 's3',
            vectors: 'pgvector',
          };
        },
        async close() {},
      });
      service = serviceWithEmbedding([0.25, 0.75]);
      const vectorResolved = await service.storeMemory(
        'real-owner',
        'real-persona',
        'real vector acknowledgement loss',
        'real-memory-model',
        undefined,
        0.8,
        'instruction'
      );

      const counts = await database.query(`
        SELECT
          (SELECT COUNT(*)::integer FROM platform_persona_memories) AS memories,
          (SELECT COUNT(*)::integer FROM platform_vector_entries) AS vectors
      `);
      assert.equal(counts.rows[0].memories, 2);
      assert.equal(counts.rows[0].vectors, 1);
      const vector = await database.query(
        `SELECT id, source_revision, attributes
           FROM platform_vector_entries
          WHERE namespace = 'persona-memory' AND owner_user_id = $1 AND id = $2`,
        ['real-owner', vectorResolved.id]
      );
      assert.equal(vector.rowCount, 1);
      assert.equal(vector.rows[0].attributes.memoryType, 'instruction');
    } finally {
      configurePlatformStorageRuntime(undefined);
      await database?.close();
      await bootstrap.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await bootstrap.close();
    }
  }
);

test.after(async () => {
  configurePlatformStorageRuntime(undefined);
  const { closePersistence } =
    await import('../backend/dist/persistence/index.js');
  await closePersistence();
  fs.rmSync(root, { recursive: true, force: true });
});
