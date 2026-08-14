/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const integrationUrl = process.env.TEST_POSTGRES_URL?.trim();

const withBarrierTimeout = (promise, label, milliseconds = 10_000) =>
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

test(
  'real PostgreSQL document regeneration is deletion-safe and spec-consistent',
  { skip: integrationUrl ? false : 'TEST_POSTGRES_URL is not configured' },
  async () => {
    const parsed = new URL(integrationUrl);
    assert.match(
      parsed.pathname.slice(1),
      /test/i,
      'TEST_POSTGRES_URL must name a disposable test database'
    );

    const temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'libre-document-indexing-pg-')
    );
    const previousEnvironment = Object.fromEntries(
      [
        'BLOB_STORE_BACKEND',
        'COORDINATION_BACKEND',
        'DATABASE_BACKEND',
        'DATABASE_SSL_MODE',
        'DATABASE_URL',
        'DATA_DIR',
        'ENCRYPTION_KEY',
        'JOB_WORKER_MODE',
        'LIBRE_PLATFORM_MODE',
        'POSTGRES_APPLICATION_NAME',
        'S3_BUCKET',
        'S3_REGION',
        'VECTOR_STORE_BACKEND',
      ].map(name => [name, process.env[name]])
    );
    const uniqueSuffix = `${process.pid}_${Date.now()}`;
    const databaseName = `libre_document_index_test_${uniqueSuffix}`;
    const schema = `libre_document_index_${uniqueSuffix}`;
    assert.match(databaseName, /^libre_document_index_test_[a-z0-9_]{1,40}$/);
    assert.match(schema, /^libre_document_index_[a-z0-9_]{1,40}$/);
    assert.ok(databaseName.length <= 63);
    assert.ok(schema.length <= 63);
    const quotedDatabaseName = `"${databaseName}"`;
    const quotedSchema = `"${schema}"`;
    const databaseUrl = new URL(integrationUrl);
    databaseUrl.pathname = `/${databaseName}`;
    databaseUrl.searchParams.delete('options');
    const schemaUrl = new URL(databaseUrl);
    schemaUrl.searchParams.set('options', `-c search_path=${schema},public`);
    Object.assign(process.env, {
      BLOB_STORE_BACKEND: 's3',
      COORDINATION_BACKEND: 'local',
      DATABASE_BACKEND: 'postgres',
      DATABASE_SSL_MODE: 'disable',
      DATABASE_URL: schemaUrl.toString(),
      DATA_DIR: temporaryRoot,
      ENCRYPTION_KEY: '7'.repeat(64),
      JOB_WORKER_MODE: 'embedded',
      LIBRE_PLATFORM_MODE: 'solo',
      POSTGRES_APPLICATION_NAME: 'libre-document-indexing-test',
      S3_BUCKET: 'document-indexing-test',
      S3_REGION: 'us-east-1',
      VECTOR_STORE_BACKEND: 'pgvector',
    });

    const { createPostgresDatabase } =
      await import('../backend/dist/persistence/postgresDatabase.js');
    const { resolvePostgresRuntimeConfig } =
      await import('../backend/dist/persistence/postgresConfig.js');
    const bootstrap = createPostgresDatabase(
      resolvePostgresRuntimeConfig({
        DATABASE_URL: integrationUrl,
        DATABASE_SSL_MODE: 'disable',
        POSTGRES_APPLICATION_NAME: 'libre-document-indexing-bootstrap',
      })
    );
    let persistenceKernel;
    let storageRuntime;
    let coordination;
    let jobs;
    let databaseCreated = false;
    let databaseCleanupError;
    try {
      // PostgreSQL extensions are database-wide. A schema in the shared
      // integration database is therefore not sufficient isolation: another
      // test can install or temporarily drop pgvector from a different search
      // path. Start from template0 so this test's migrations must install and
      // use their own pgvector extension.
      await bootstrap.query(
        `CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`
      );
      databaseCreated = true;
      const databaseBootstrap = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          DATABASE_URL: databaseUrl.toString(),
          DATABASE_SSL_MODE: 'disable',
          POSTGRES_APPLICATION_NAME: 'libre-document-indexing-database',
        })
      );
      try {
        await databaseBootstrap.query(`CREATE SCHEMA ${quotedSchema}`);
      } finally {
        await databaseBootstrap.close();
      }

      const { encryptionService } =
        await import('../backend/dist/services/encryptionService.js');
      persistenceKernel = await import('../backend/dist/persistence/index.js');
      storageRuntime =
        await import('../backend/dist/platform/storage/index.js');
      coordination =
        await import('../backend/dist/platform/coordination/service.js');
      const { createPostgresPlatformDomainRepositories } =
        await import('../backend/dist/platform/storage/postgresPlatformDomainRepositories.js');
      const { PgVectorStore } =
        await import('../backend/dist/platform/storage/pgVectorStore.js');

      await persistenceKernel.closePersistence();
      const persistence = await persistenceKernel.initializePersistence({
        dialect: 'postgres',
        emailCodec: encryptionService,
        env: process.env,
      });
      const vectorExtension = await persistence.database.query(
        `SELECT namespace.nspname AS schema_name
           FROM pg_extension extension
           JOIN pg_namespace namespace
             ON namespace.oid = extension.extnamespace
          WHERE extension.extname = 'vector'`
      );
      assert.deepEqual(vectorExtension.rows, [{ schema_name: schema }]);
      // Import the narrow runtime only after PostgreSQL is selected. The jobs
      // barrel exports application handlers and would otherwise construct
      // stateful service singletons before persistence bootstrap.
      jobs = await import('../backend/dist/platform/jobs/durableJobRuntime.js');
      const domains = createPostgresPlatformDomainRepositories(
        persistence.database,
        encryptionService
      );
      const vectorStore = new PgVectorStore({ database: persistence.database });
      storageRuntime.configurePlatformStorageRuntime({
        dialect: 'postgres',
        blobStore: {},
        blobReferences: {},
        blobQuota: {},
        vectorStore,
        domains,
        health: async () => ({
          ready: true,
          dialect: 'postgres',
          blobs: 's3',
          vectors: 'pgvector',
        }),
        close: async () => undefined,
      });
      await coordination.initializeCoordinator();
      jobs.initializeDurableJobRuntime({
        role: 'external',
        runWorker: false,
        handlers: new Map(),
      });

      const { DocumentService } =
        await import('../backend/dist/services/documentService.js');
      const { default: storageService } =
        await import('../backend/dist/storage.js');
      const { default: preferencesService } =
        await import('../backend/dist/services/preferencesService.js');

      const now = Date.now();
      const deleteUser = 'pg-document-delete-race';
      const specUser = 'pg-document-spec-snapshot';
      const largeIndexUser = 'pg-document-large-index';
      for (const [index, userId] of [
        deleteUser,
        specUser,
        largeIndexUser,
      ].entries()) {
        await persistence.repositories.identity.insert({
          id: userId,
          username: userId,
          email: null,
          password_hash: 'unused',
          role: 'admin',
          account_status: 'active',
          approved_at: now + index,
          approved_by: null,
          avatar: null,
          created_at: now + index,
          updated_at: now + index,
        });
      }

      const deleteModel = {
        enabled: true,
        model: 'pg-delete-race-model',
        chunkSize: 1000,
        chunkOverlap: 0,
        similarityThreshold: 0.25,
      };
      await preferencesService.updatePreferences(
        { embeddingSettings: deleteModel },
        deleteUser
      );
      const deleteDocumentId = 'pg-document-regeneration-delete-race';
      await storageService.saveDocument(
        {
          id: deleteDocumentId,
          filename: 'delete-race.txt',
          content: 'PostgreSQL upsert pauses while deletion publishes.',
          fileType: 'txt',
          size: 50,
          uploadedAt: now,
          createdAt: now,
        },
        deleteUser
      );

      const deleteService = new DocumentService();
      deleteService.generateEmbeddingForText = async () => [1, 0];
      const originalUpsert = vectorStore.upsert.bind(vectorStore);
      let markUpsertStarted;
      let releaseUpsert;
      const upsertStarted = new Promise(resolve => {
        markUpsertStarted = resolve;
      });
      const upsertReleased = new Promise(resolve => {
        releaseUpsert = resolve;
      });
      vectorStore.upsert = async request => {
        markUpsertStarted();
        await upsertReleased;
        return originalUpsert(request);
      };
      try {
        const regeneration = deleteService.regenerateAllEmbeddings(deleteUser);
        await withBarrierTimeout(upsertStarted, 'PostgreSQL vector upsert');
        assert.equal(
          await deleteService.deleteDocument(deleteDocumentId, deleteUser),
          true
        );
        releaseUpsert();
        const result = await regeneration;
        assert.equal(result.documentsRegenerated, 0);
        assert.equal(result.documentsSkipped, 1);
      } finally {
        releaseUpsert?.();
        vectorStore.upsert = originalUpsert;
      }

      const deletedVectors = await persistence.database.query(
        `SELECT COUNT(*)::integer AS count
           FROM platform_vector_entries
          WHERE namespace = $1 AND owner_user_id = $2 AND resource_id = $3`,
        ['document-chunk', deleteUser, deleteDocumentId]
      );
      assert.equal(deletedVectors.rows[0].count, 0);
      const deletion = await persistence.database.query(
        `SELECT COUNT(*)::integer AS count
           FROM platform_resource_deletion_tombstones
          WHERE resource_type = 'document' AND resource_id = $1`,
        [deleteDocumentId]
      );
      assert.equal(deletion.rows[0].count, 1);

      const modelA = {
        enabled: true,
        model: 'pg-snapshot-model-a',
        chunkSize: 48,
        chunkOverlap: 0,
        similarityThreshold: 0.2,
      };
      const modelB = {
        enabled: true,
        model: 'pg-snapshot-model-b',
        chunkSize: 24,
        chunkOverlap: 0,
        similarityThreshold: 0.85,
      };
      const modelC = {
        enabled: true,
        model: 'pg-snapshot-model-c',
        chunkSize: 16,
        chunkOverlap: 0,
        similarityThreshold: 0.95,
      };
      await preferencesService.updatePreferences(
        { embeddingSettings: modelA },
        specUser
      );
      const specDocumentId = 'pg-document-regeneration-model-snapshot';
      await storageService.saveDocument(
        {
          id: specDocumentId,
          filename: 'model-snapshot.txt',
          content:
            'First paragraph uses one model.\n\nSecond paragraph keeps the same model.',
          fileType: 'txt',
          size: 73,
          uploadedAt: now,
          createdAt: now,
        },
        specUser
      );

      const specService = new DocumentService();
      const generationSpecs = [];
      let markGenerationStarted;
      let releaseGeneration;
      const generationStarted = new Promise(resolve => {
        markGenerationStarted = resolve;
      });
      const generationReleased = new Promise(resolve => {
        releaseGeneration = resolve;
      });
      specService.generateEmbeddingForText = async (_text, _userId, spec) => {
        generationSpecs.push(structuredClone(spec));
        if (generationSpecs.length === 1) {
          markGenerationStarted();
          await generationReleased;
        }
        return [1, 0];
      };
      const specRegeneration = specService.regenerateAllEmbeddings(specUser);
      await withBarrierTimeout(
        generationStarted,
        'PostgreSQL embedding generation'
      );
      await preferencesService.updatePreferences(
        { embeddingSettings: modelB },
        specUser
      );
      releaseGeneration();
      const specResult = await specRegeneration;
      assert.equal(specResult.documentsRegenerated, 1);
      assert.ok(generationSpecs.length >= 2);
      for (const spec of generationSpecs) {
        assert.equal(spec.model, modelA.model);
        assert.equal(spec.chunkSize, modelA.chunkSize);
        assert.equal(spec.similarityThreshold, modelA.similarityThreshold);
        assert.equal(spec.version, 'v1');
      }
      const indexedDocument = await storageService.getDocument(
        specDocumentId,
        specUser
      );
      assert.equal(indexedDocument.metadata.embeddingIndex.model, modelA.model);
      assert.equal(
        indexedDocument.metadata.embeddingIndex.chunkSize,
        modelA.chunkSize
      );
      const indexedModels = await persistence.database.query(
        `SELECT DISTINCT model
           FROM platform_vector_entries
          WHERE namespace = $1 AND owner_user_id = $2 AND resource_id = $3
          ORDER BY model`,
        ['document-chunk', specUser, specDocumentId]
      );
      assert.deepEqual(
        indexedModels.rows.map(row => row.model),
        [modelA.model]
      );

      // PostgreSQL intentionally stores embeddings only in PGVector. Prove a
      // real vector hit can hydrate its authoritative relational chunk even
      // though document_chunks.embedding is NULL. None of these query terms
      // occur in the document, so keyword fallback cannot satisfy the check.
      await preferencesService.updatePreferences(
        { embeddingSettings: modelA },
        specUser
      );
      specService.generateEmbeddingForText = async (_text, _userId, spec) => {
        assert.equal(spec.model, modelA.model);
        return [1, 0];
      };
      const semanticOnly = await specService.searchDocuments(
        'quasar zephyr xylophone',
        specUser
      );
      assert.ok(
        semanticOnly.some(chunk => chunk.documentId === specDocumentId),
        'a PGVector-only hit must hydrate the PostgreSQL relational chunk'
      );
      await preferencesService.updatePreferences(
        { embeddingSettings: modelB },
        specUser
      );

      const largeIndexModel = {
        enabled: true,
        model: 'pg-large-index-model',
        chunkSize: 16,
        chunkOverlap: 0,
        similarityThreshold: 0.2,
      };
      await preferencesService.updatePreferences(
        { embeddingSettings: largeIndexModel },
        largeIndexUser
      );
      const largeDocumentId = 'pg-document-large-vector-index';
      const largeContent = Array.from(
        { length: 1_001 },
        (_, index) => `segment-${String(index).padStart(4, '0')}`
      ).join('\n\n');
      await storageService.saveDocument(
        {
          id: largeDocumentId,
          filename: 'large-vector-index.txt',
          content: largeContent,
          fileType: 'txt',
          size: Buffer.byteLength(largeContent),
          uploadedAt: now,
          createdAt: now,
        },
        largeIndexUser
      );
      const largeService = new DocumentService();
      largeService.generateEmbeddingForText = async () => [1, 0];
      const boundedUpsert = vectorStore.upsert.bind(vectorStore);
      const largeBatches = [];
      vectorStore.upsert = async request => {
        largeBatches.push(request.records.length);
        return boundedUpsert(request);
      };
      try {
        const largeRegeneration =
          await largeService.regenerateAllEmbeddings(largeIndexUser);
        assert.equal(largeRegeneration.documentsRegenerated, 1);
        assert.equal(largeRegeneration.chunksTotal, 1_001);
        assert.deepEqual(largeBatches, [1_000, 1]);

        const largeDocument = await storageService.getDocument(
          largeDocumentId,
          largeIndexUser
        );
        const largeChunks =
          await storageService.getDocumentChunks(largeDocumentId);
        assert.equal(largeChunks.length, 1_001);
        const largeProbe = {
          actor: { userId: largeIndexUser },
          namespace: 'document-chunk',
          resourceId: largeDocumentId,
          model: largeDocument.metadata.embeddingIndex.model,
          dimensions: largeDocument.metadata.embeddingIndex.dimensions,
          version: largeDocument.metadata.embeddingIndex.version,
          entries: largeChunks.map(chunk => ({
            id: chunk.id,
            sourceRevision: crypto
              .createHash('sha256')
              .update(chunk.content, 'utf8')
              .digest('hex'),
          })),
        };
        assert.equal(
          await vectorStore.hasExactResourceIndex(largeProbe),
          true,
          'the PostgreSQL paged probe must accept 1,001 exact records'
        );
        await vectorStore.delete({
          actor: { userId: largeIndexUser },
          namespace: 'document-chunk',
          ids: [largeChunks[500].id],
        });
        assert.equal(
          await vectorStore.hasExactResourceIndex(largeProbe),
          false,
          'the PostgreSQL paged probe must reject a partial resource'
        );

        largeBatches.length = 0;
        const repaired =
          await largeService.regenerateAllEmbeddings(largeIndexUser);
        assert.equal(repaired.documentsRegenerated, 1);
        assert.deepEqual(
          largeBatches,
          [1_000, 1],
          'explicit repair must republish in bounded batches'
        );
        assert.equal(await vectorStore.hasExactResourceIndex(largeProbe), true);
      } finally {
        vectorStore.upsert = boundedUpsert;
      }

      const collectionId = 'pg-regeneration-routing-survives';
      await storageService.saveKnowledgeCollection(
        {
          id: collectionId,
          name: 'PostgreSQL regeneration routing race',
          createdAt: now,
          updatedAt: now,
        },
        specUser
      );
      const documents =
        storageRuntime.getPlatformStorageRuntime().domains.documents;
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
        if (args[0] === specDocumentId) {
          markIndexPublicationStarted();
          await indexPublicationReleased;
        }
        return originalPublishEmbeddingIndex(...args);
      };
      specService.generateEmbeddingForText = async (_text, _userId, spec) => {
        assert.equal(spec.model, modelB.model);
        return [0, 1];
      };
      try {
        const routingRegeneration =
          specService.regenerateAllEmbeddings(specUser);
        await withBarrierTimeout(
          indexPublicationStarted,
          'PostgreSQL embedding index publication'
        );
        assert.equal(
          await storageService.setDocumentCollection(
            specDocumentId,
            collectionId,
            specUser
          ),
          true,
          'the PostgreSQL collection update must be acknowledged while regeneration is paused'
        );
        releaseIndexPublication();
        await routingRegeneration;
      } finally {
        releaseIndexPublication?.();
        documents.publishEmbeddingIndex = originalPublishEmbeddingIndex;
      }
      assert.equal(
        (await storageService.getDocument(specDocumentId, specUser))
          .collectionId,
        collectionId,
        'PostgreSQL regeneration must preserve an acknowledged collection update'
      );

      const originalQuery = vectorStore.query.bind(vectorStore);
      let capturedQuery;
      vectorStore.query = async request => {
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
      specService.generateEmbeddingForText = async (_text, _userId, spec) => {
        assert.equal(spec.model, modelB.model);
        markQueryEmbeddingStarted();
        await queryEmbeddingReleased;
        return [1, 0];
      };
      try {
        const search = specService.searchDocuments(
          'immutable PostgreSQL query model',
          specUser
        );
        await withBarrierTimeout(
          queryEmbeddingStarted,
          'PostgreSQL query embedding'
        );
        await preferencesService.updatePreferences(
          { embeddingSettings: modelC },
          specUser
        );
        releaseQueryEmbedding();
        await search;
      } finally {
        releaseQueryEmbedding?.();
        vectorStore.query = originalQuery;
      }
      assert.equal(capturedQuery.model, modelB.model);
      assert.equal(capturedQuery.minScore, modelB.similarityThreshold);
      assert.equal(capturedQuery.version, 'v1');
    } finally {
      await jobs?.closeDurableJobRuntime().catch(() => undefined);
      await coordination?.closeCoordinator().catch(() => undefined);
      await storageRuntime
        ?.closePlatformStorageRuntime()
        .catch(() => undefined);
      await persistenceKernel?.closePersistence().catch(() => undefined);
      if (databaseCreated) {
        try {
          await bootstrap.query(
            `DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`
          );
        } catch (error) {
          databaseCleanupError = error;
        }
      }
      await bootstrap.close().catch(() => undefined);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      for (const [name, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (databaseCleanupError) throw databaseCleanupError;
    }
  }
);
