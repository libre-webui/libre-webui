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
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import Database from 'better-sqlite3';
import { Pool } from 'pg';

if (
  process.env.LIBRE_TEAM_STORAGE_INTEGRATION !== '1' &&
  process.env.TEST_TEAM_PLATFORM !== '1'
) {
  console.log(
    'SKIP SQLite-to-team storage migration (set TEST_TEAM_PLATFORM=1)'
  );
  process.exit(0);
}

const required = name => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for team storage migration`);
  return value;
};

const repoRoot = path.resolve(import.meta.dirname, '..');
const backendDist = path.join(repoRoot, 'backend', 'dist');
const postgresUrl = required('TEST_POSTGRES_URL');
const s3Endpoint = required('TEST_S3_ENDPOINT');
const s3Bucket = required('TEST_S3_BUCKET');
const s3Region = process.env.TEST_S3_REGION?.trim() || 'us-east-1';
const s3AccessKeyId = required('TEST_S3_ACCESS_KEY_ID');
const s3SecretAccessKey = required('TEST_S3_SECRET_ACCESS_KEY');
const storageKeyHex =
  process.env.TEST_STORAGE_ENCRYPTION_KEY?.trim() || '91'.repeat(32);
process.env.ENCRYPTION_KEY ||= storageKeyHex;

const schemaName = `libre_storage_migration_${crypto.randomUUID().replaceAll('-', '')}`;
const keyPrefix = `libre-storage-migration/${crypto.randomUUID()}`;
const sourceDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-storage-migration-source-')
);
fs.chmodSync(sourceDirectory, 0o700);
const sourcePath = path.join(sourceDirectory, 'data.sqlite');
const sourceBlobRoot = path.join(sourceDirectory, 'blobs');
const sourcePluginsPath = path.join(sourceDirectory, 'plugins');
const databaseModuleUrl = pathToFileURL(path.join(backendDist, 'db.js')).href;

const initialize = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `const database = await import(${JSON.stringify(databaseModuleUrl)}); database.getDatabase(); database.closeDatabase();`,
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_DIR: sourceDirectory,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    },
    encoding: 'utf8',
  }
);
assert.equal(
  initialize.status,
  0,
  `${initialize.stderr}\n${initialize.stdout}`
);
fs.mkdirSync(sourcePluginsPath, { recursive: true, mode: 0o700 });

const storage = await import(
  pathToFileURL(path.join(backendDist, 'platform', 'storage', 'index.js')).href
);
const { createSQLiteToTeamStorageMigrationPhase } = await import(
  pathToFileURL(
    path.join(
      backendDist,
      'platform',
      'storage',
      'sqliteToTeamStorageMigration.js'
    )
  ).href
);
const { migrateSQLiteToPostgres } = await import(
  pathToFileURL(
    path.join(backendDist, 'persistence', 'sqliteToPostgresMigration.js')
  ).href
);
const { PostgresDatabase } = await import(
  pathToFileURL(path.join(backendDist, 'persistence', 'postgresDatabase.js'))
    .href
);
const { encryptionService } = await import(
  pathToFileURL(path.join(backendDist, 'services', 'encryptionService.js')).href
);

const s3ClientConfiguration = {
  region: s3Region,
  endpoint: s3Endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
  },
};
const phaseEnvironment = {
  ...process.env,
  S3_BUCKET: s3Bucket,
  S3_REGION: s3Region,
  S3_ENDPOINT: s3Endpoint,
  S3_FORCE_PATH_STYLE: 'true',
  S3_ACCESS_KEY_ID: s3AccessKeyId,
  S3_SECRET_ACCESS_KEY: s3SecretAccessKey,
  S3_BLOB_PREFIX: keyPrefix,
  STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'migration-v1',
  STORAGE_ENCRYPTION_KEYS: JSON.stringify({
    legacy: storageKeyHex,
    'migration-v1': storageKeyHex,
  }),
};
const keyring = new storage.Aes256GcmKeyring('migration-v1', {
  'migration-v1': Buffer.from(storageKeyHex, 'hex'),
});
const phaseOptions = overrides => ({
  env: phaseEnvironment,
  keyring,
  cipher: encryptionService,
  sourceBlobRoot,
  ...overrides,
});

const bootstrapPool = new Pool({ connectionString: postgresUrl, max: 1 });
const targetUrl = new URL(postgresUrl);
targetUrl.searchParams.set('options', `-csearch_path=${schemaName},public`);
const postgresConfiguration = {
  connectionString: targetUrl.toString(),
  applicationName: 'libre-storage-migration-test',
  poolMaximum: 4,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
  migrationLockTimeoutMs: 30_000,
  migrationMode: 'apply',
  sslMode: 'disable',
};
const inspectionPool = new Pool({
  connectionString: postgresUrl,
  max: 2,
  options: `-c search_path=${schemaName},public`,
});
const inspectionDatabase = new PostgresDatabase(inspectionPool);
const s3Client = new S3Client(s3ClientConfiguration);

const ensureBucket = async () => {
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: s3Bucket }));
  } catch {
    await s3Client.send(new CreateBucketCommand({ Bucket: s3Bucket }));
  }
  await s3Client.send(
    new PutBucketVersioningCommand({
      Bucket: s3Bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    })
  );
};

const sourceDatabase = new Database(sourcePath);
sourceDatabase.pragma('foreign_keys = ON');
const ownerUserId = `migration-owner-${crypto.randomUUID()}`;
const mediaId = `migration-media-${crypto.randomUUID()}`;
const vectorId = `migration-vector-${crypto.randomUUID()}`;
const resourceId = `migration-document-${crypto.randomUUID()}`;
const personaId = `migration-persona-${crypto.randomUUID()}`;
const memoryId = `migration-memory-${crypto.randomUUID()}`;
const legacyDocumentId = `migration-legacy-document-${crypto.randomUUID()}`;
const legacyDocumentChunkCount = 1_001;
const legacyChunkIds = Array.from(
  { length: legacyDocumentChunkCount },
  (_, index) => `${legacyDocumentId}-chunk-${String(index).padStart(4, '0')}`
);
const legacyChunkId = legacyChunkIds[0];
const legacyBoundaryChunkId = legacyChunkIds.at(-1);
assert.ok(legacyChunkId);
assert.ok(legacyBoundaryChunkId);
const legacyExtraVectorId = `migration-legacy-extra-${crypto.randomUUID()}`;
const legacyDocumentModel = 'migration-regenerated-document-embedding';
const legacyDocumentContent =
  'Authenticated legacy document content receives a provenance-safe index.';
const now = Date.now();
let migrationFingerprint;

try {
  await ensureBucket();
  await bootstrapPool.query(`CREATE SCHEMA ${schemaName}`);

  sourceDatabase
    .prepare(
      `INSERT INTO users
         (id, username, password_hash, role, account_status, created_at, updated_at)
       VALUES (?, ?, ?, 'user', 'active', ?, ?)`
    )
    .run(
      ownerUserId,
      encryptionService.encrypt('storage-migration-owner'),
      'integration-only',
      now,
      now
    );
  sourceDatabase
    .prepare(
      `INSERT INTO personas
         (id, user_id, name, description, model, parameters, embedding_model,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'migration-chat-model', ?,
               'migration-memory-embedding', ?, ?)`
    )
    .run(
      personaId,
      ownerUserId,
      encryptionService.encrypt('Migration persona'),
      encryptionService.encrypt('Migrated memory owner'),
      encryptionService.encrypt('{}'),
      now,
      now
    );
  const legacyEmbedding = Buffer.alloc(12);
  legacyEmbedding.writeFloatLE(0, 0);
  legacyEmbedding.writeFloatLE(1, 4);
  legacyEmbedding.writeFloatLE(0, 8);
  sourceDatabase
    .prepare(
      `INSERT INTO persona_memories
         (id, user_id, persona_id, content, embedding, timestamp, context,
          importance_score, memory_type, access_count, decay_factor)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0.8, 'preference', 0, 1)`
    )
    .run(
      memoryId,
      ownerUserId,
      personaId,
      encryptionService.encrypt('The owner prefers authenticated migration'),
      legacyEmbedding,
      now
    );
  legacyEmbedding.fill(0);

  const sourceQuota = new storage.SQLiteDurableBlobQuotaPolicy(sourceDatabase, {
    maximumBytesPerOwner: 1024 * 1024,
    reservationTtlMs: 60_000,
  });
  const sourceBlobStore = new storage.LocalEncryptedBlobStore({
    rootDirectory: sourceBlobRoot,
    keyring,
    quotaPolicy: sourceQuota,
  });
  const plaintext = Buffer.concat([
    Buffer.from('authenticated-solo-to-team:'),
    crypto.randomBytes(48_000),
  ]);
  const descriptor = await sourceBlobStore.put({
    ownerUserId,
    purpose: 'gallery.media',
    contentType: 'image/png',
    expectedSize: plaintext.length,
    metadata: {
      resourceType: 'generated-media',
      resourceId: mediaId,
    },
    source: Readable.from([
      plaintext.subarray(0, 10_000),
      plaintext.subarray(10_000),
    ]),
  });
  sourceDatabase
    .prepare(
      `INSERT INTO platform_blob_references
         (blob_id, owner_user_id, resource_type, resource_id, purpose, created_at)
       VALUES (?, ?, 'generated-media', ?, 'gallery.media', ?)`
    )
    .run(descriptor.id, ownerUserId, mediaId, now);
  sourceDatabase
    .prepare(
      `INSERT INTO generated_images
         (id, user_id, kind, prompt, model, plugin_id, image_data, mime_type,
          size, quality, metadata, created_at)
       VALUES (?, ?, 'image', ?, 'migration-image-model', NULL, '',
               'image/png', '1024x1024', 'standard', ?, ?)`
    )
    .run(
      mediaId,
      ownerUserId,
      encryptionService.encrypt('private migration prompt'),
      encryptionService.encrypt(JSON.stringify({ seed: 17 })),
      now
    );

  const sourceVectors = new storage.SqliteEncryptedVectorStore({
    database: sourceDatabase,
    keyring,
  });
  sourceDatabase
    .prepare(
      `INSERT INTO documents
         (id, user_id, filename, title, content, file_type, size, session_id,
          collection_id, metadata, uploaded_at, created_at, updated_at)
       VALUES (?, ?, 'legacy-document.txt', NULL, ?, 'txt', ?, NULL, NULL,
               NULL, ?, ?, ?)`
    )
    .run(
      legacyDocumentId,
      ownerUserId,
      encryptionService.encrypt(legacyDocumentContent),
      legacyDocumentContent.length,
      now,
      now,
      now
    );
  const insertLegacyChunk = sourceDatabase.prepare(
    `INSERT INTO document_chunks
       (id, document_id, chunk_index, content, start_char, end_char,
        embedding, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
  );
  const encryptedLegacyChunkContent = encryptionService.encrypt(
    legacyDocumentContent
  );
  const encryptedLegacyEmbedding = encryptionService.encrypt(
    JSON.stringify([0, 1, 0])
  );
  sourceDatabase.transaction(() => {
    for (const [index, chunkId] of legacyChunkIds.entries()) {
      insertLegacyChunk.run(
        chunkId,
        legacyDocumentId,
        index,
        encryptedLegacyChunkContent,
        legacyDocumentContent.length,
        encryptedLegacyEmbedding,
        now
      );
    }
  })();
  const sourceDomains = storage.createSQLitePlatformDomainRepositories(
    sourceDatabase,
    encryptionService
  );
  assert.deepEqual(
    await sourceDomains.documents.inspectLegacyChunkEmbeddings(
      legacyDocumentId,
      ownerUserId
    ),
    { present: true, authenticated: true },
    'the bounded solo legacy inspection must authenticate all 1,001 chunks'
  );
  await sourceVectors.upsert({
    actor: { userId: ownerUserId },
    records: [
      {
        namespace: 'document-chunk',
        id: vectorId,
        ownerUserId,
        resourceId,
        model: 'migration-embedding',
        dimensions: 3,
        version: 'v1',
        sourceRevision: crypto
          .createHash('sha256')
          .update('migration chunk')
          .digest('hex'),
        embedding: [1, 0, 0],
        attributes: { kind: 'migration' },
        grants: [{ type: 'group', id: 'migration-readers' }],
        createdAt: now,
      },
    ],
  });

  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const blockedLegacy = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(blockedLegacy.compatible, false);
  assert.match(
    blockedLegacy.blockers.join('\n'),
    /1 legacy document index\(es\) across 1 owner\(s\)/
  );
  assert.match(
    blockedLegacy.blockers.join('\n'),
    /same DATA_DIR and ENCRYPTION_KEY/
  );
  assert.match(
    blockedLegacy.blockers.join('\n'),
    /Settings -> Documents -> Regenerate embeddings/
  );
  assert.match(
    blockedLegacy.blockers.join('\n'),
    /missing authenticated embeddingIndex metadata/
  );

  const regeneratedChunks = legacyChunkIds.map((id, chunkIndex) => ({
    id,
    documentId: legacyDocumentId,
    content: legacyDocumentContent,
    embedding: [-0, 1, 0],
    chunkIndex,
    startChar: 0,
    endChar: legacyDocumentContent.length,
  }));
  const regeneratedSpec = {
    model: legacyDocumentModel,
    version: 'v1',
    chunkerVersion: 'v1',
    chunkSize: 1_000,
    chunkOverlap: 0,
    similarityThreshold: 0.2,
  };
  const regeneratedIndex = storage.createDocumentIndexMetadata(
    regeneratedChunks,
    regeneratedSpec,
    now
  );
  sourceDatabase
    .prepare('UPDATE documents SET metadata = ? WHERE id = ?')
    .run(
      encryptionService.encrypt(
        JSON.stringify({ embeddingIndex: regeneratedIndex })
      ),
      legacyDocumentId
    );
  const regeneratedSourceRevision = crypto
    .createHash('sha256')
    .update(legacyDocumentContent)
    .digest('hex');
  const regeneratedVectorRecords = legacyChunkIds.map(id => ({
    namespace: 'document-chunk',
    id,
    ownerUserId,
    resourceId: legacyDocumentId,
    model: legacyDocumentModel,
    dimensions: 3,
    version: 'v1',
    sourceRevision: regeneratedSourceRevision,
    embedding: [-0, 1, 0],
    attributes: { kind: 'regenerated-document' },
    createdAt: now,
  }));
  const firstRegeneratedVectorRecord = regeneratedVectorRecords[0];
  const boundaryRegeneratedVectorRecord = regeneratedVectorRecords.at(-1);
  assert.ok(firstRegeneratedVectorRecord);
  assert.ok(boundaryRegeneratedVectorRecord);
  const upsertDocumentVectors = async records => {
    for (
      let offset = 0;
      offset < records.length;
      offset += storage.MAX_VECTOR_RECORDS_PER_UPSERT
    ) {
      await sourceVectors.upsert({
        actor: { userId: ownerUserId },
        records: records.slice(
          offset,
          offset + storage.MAX_VECTOR_RECORDS_PER_UPSERT
        ),
      });
    }
  };
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const blockedMissingCoverage = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(blockedMissingCoverage.compatible, false);
  assert.match(
    blockedMissingCoverage.blockers.join('\n'),
    /incomplete or extra platform vector coverage/
  );
  await upsertDocumentVectors(regeneratedVectorRecords);

  sourceDatabase
    .prepare('UPDATE document_chunks SET embedding = ? WHERE id = ?')
    .run(
      encryptionService.encrypt(JSON.stringify([1, 0, 0])),
      legacyBoundaryChunkId
    );
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const blockedTamper = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(blockedTamper.compatible, false);
  assert.match(
    blockedTamper.blockers.join('\n'),
    /platform vector payload does not match inline index/
  );
  sourceDatabase
    .prepare('UPDATE document_chunks SET embedding = ? WHERE id = ?')
    .run(
      encryptionService.encrypt(JSON.stringify([0, 1, 0])),
      legacyBoundaryChunkId
    );

  await sourceVectors.delete({
    actor: { userId: ownerUserId },
    namespace: 'document-chunk',
    ids: [legacyBoundaryChunkId],
  });
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const blockedPartial = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(blockedPartial.compatible, false);
  assert.match(
    blockedPartial.blockers.join('\n'),
    /incomplete or extra platform vector coverage/
  );
  await upsertDocumentVectors([boundaryRegeneratedVectorRecord]);

  await sourceVectors.upsert({
    actor: { userId: ownerUserId },
    records: [
      {
        ...firstRegeneratedVectorRecord,
        id: legacyExtraVectorId,
      },
    ],
  });
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const blockedExtra = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(blockedExtra.compatible, false);
  assert.match(
    blockedExtra.blockers.join('\n'),
    /incomplete or extra platform vector coverage/
  );
  await sourceVectors.delete({
    actor: { userId: ownerUserId },
    namespace: 'document-chunk',
    ids: [legacyExtraVectorId],
  });

  sourceDatabase.prepare('UPDATE documents SET metadata = ? WHERE id = ?').run(
    encryptionService.encrypt(
      JSON.stringify({
        embeddingIndex: {
          ...regeneratedIndex,
          aggregateRevision: '0'.repeat(64),
        },
      })
    ),
    legacyDocumentId
  );
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const blockedAggregate = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(blockedAggregate.compatible, false);
  assert.match(
    blockedAggregate.blockers.join('\n'),
    /embeddingIndex aggregate revision mismatch/
  );
  sourceDatabase
    .prepare('UPDATE documents SET metadata = ? WHERE id = ?')
    .run(
      encryptionService.encrypt(
        JSON.stringify({ embeddingIndex: regeneratedIndex })
      ),
      legacyDocumentId
    );
  sourceDatabase.pragma('wal_checkpoint(TRUNCATE)');
  const provenModern = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'dry-run',
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(provenModern.compatible, true);
  assert.equal(provenModern.blockers.length, 0);
  sourceDatabase.close();

  let acknowledgementLossInjected = false;
  let injected = false;
  const crashingPhase = createSQLiteToTeamStorageMigrationPhase(
    phaseOptions({
      afterBlobMetadataCommitted() {
        if (!acknowledgementLossInjected) {
          acknowledgementLossInjected = true;
          throw new Error(
            'injected migration connection loss after PostgreSQL COMMIT'
          );
        }
      },
      afterItemCommitted() {
        if (!injected) {
          injected = true;
          throw new Error('injected storage migration crash');
        }
      },
    })
  );
  await assert.rejects(
    migrateSQLiteToPostgres({
      sourcePath,
      sourcePluginsPath,
      postgres: postgresConfiguration,
      mode: 'apply',
      storagePhase: crashingPhase,
    }),
    /injected storage migration crash/
  );
  assert.equal(acknowledgementLossInjected, true);
  assert.equal(injected, true);
  assert.equal(
    (
      await inspectionDatabase.query(
        'SELECT status FROM libre_sqlite_imports ORDER BY created_at DESC LIMIT 1'
      )
    ).rows[0].status,
    'failed'
  );
  const committedBlob = await inspectionDatabase.query(
    `SELECT object_key,
            (SELECT COUNT(*)::int FROM platform_blob_quota_objects
              WHERE blob_id = platform_blob_objects.id) AS quota_rows,
            (SELECT COUNT(*)::int FROM libre_sqlite_storage_import_items
              WHERE item_type = 'blob'
                AND target_id = platform_blob_objects.id) AS journal_rows
       FROM platform_blob_objects`
  );
  assert.equal(committedBlob.rowCount, 1);
  assert.equal(committedBlob.rows[0].quota_rows, 1);
  assert.equal(committedBlob.rows[0].journal_rows, 1);
  const committedBlobVersions = await s3Client.send(
    new ListObjectVersionsCommand({
      Bucket: s3Bucket,
      Prefix: committedBlob.rows[0].object_key,
    })
  );
  assert.equal(committedBlobVersions.Versions?.length ?? 0, 1);
  assert.equal(committedBlobVersions.DeleteMarkers?.length ?? 0, 0);

  const resumed = await migrateSQLiteToPostgres({
    sourcePath,
    sourcePluginsPath,
    postgres: postgresConfiguration,
    mode: 'apply',
    resume: true,
    storagePhase: createSQLiteToTeamStorageMigrationPhase(phaseOptions({})),
  });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(
    resumed.phases.map(phase => ({
      name: phase.name,
      items: phase.items,
      status: phase.status,
    })),
    [{ name: 'platform-storage', items: 1_006, status: 'verified' }]
  );
  migrationFingerprint = resumed.sourceFingerprint;

  const cliValidation = spawnSync(
    process.execPath,
    [
      path.join(backendDist, 'cli', 'migrateSqliteToPostgres.js'),
      '--source',
      sourcePath,
      '--plugins',
      sourcePluginsPath,
      '--mode',
      'validate',
    ],
    {
      cwd: repoRoot,
      env: {
        ...phaseEnvironment,
        DATABASE_URL: targetUrl.toString(),
        DATABASE_SSL_MODE: 'disable',
        ENCRYPTION_KEY: storageKeyHex,
      },
      encoding: 'utf8',
    }
  );
  assert.equal(
    cliValidation.status,
    0,
    `${cliValidation.stderr}\n${cliValidation.stdout}`
  );
  const validated = JSON.parse(cliValidation.stdout);
  assert.equal(validated.compatible, true);
  assert.equal(validated.phases[0].name, 'platform-storage');
  assert.equal(validated.phases[0].status, 'verified');

  const targetCounts = await inspectionDatabase.query(
    `SELECT
       (SELECT COUNT(*)::int FROM platform_blob_objects) AS blobs,
       (SELECT COUNT(*)::int FROM platform_generated_media) AS gallery,
       (SELECT COUNT(*)::int FROM platform_blob_references) AS refs,
       (SELECT COUNT(*)::int FROM platform_vector_entries) AS vectors,
       (SELECT COUNT(*)::int FROM libre_sqlite_storage_import_items) AS journal`
  );
  assert.deepEqual(targetCounts.rows[0], {
    blobs: 1,
    gallery: 1,
    refs: 1,
    vectors: 1_003,
    journal: 1_006,
  });
  const targetUsage = await inspectionDatabase.query(
    `SELECT stored_bytes, reserved_bytes FROM platform_blob_quota_usage
      WHERE owner_user_id = $1`,
    [ownerUserId]
  );
  assert.equal(Number(targetUsage.rows[0].stored_bytes), plaintext.length);
  assert.equal(Number(targetUsage.rows[0].reserved_bytes), 0);
  assert.equal(
    (
      await s3Client.send(
        new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: `${keyPrefix}/`,
        })
      )
    ).Contents?.length,
    1
  );

  const targetVectors = new storage.PgVectorStore({
    database: inspectionDatabase,
    principalResolver: {
      async resolveGroupIds() {
        return [];
      },
    },
  });
  assert.equal(
    (
      await targetVectors.query({
        actor: { userId: ownerUserId },
        namespace: 'document-chunk',
        model: 'migration-embedding',
        dimensions: 3,
        version: 'v1',
        embedding: [1, 0, 0],
        resourceIds: [resourceId],
        limit: 5,
      })
    ).length,
    1
  );
  const migratedDocument = await inspectionDatabase.query(
    `SELECT d.metadata, c.id AS chunk_id, c.content, c.embedding
       FROM documents d
       JOIN document_chunks c ON c.document_id = d.id
      WHERE d.id = $1 AND d.user_id = $2`,
    [legacyDocumentId, ownerUserId]
  );
  assert.equal(migratedDocument.rowCount, legacyDocumentChunkCount);
  assert.deepEqual(
    JSON.parse(
      encryptionService.decryptAuthenticated(migratedDocument.rows[0].embedding)
    ),
    [0, 1, 0],
    'the relational import must preserve authenticated inline ciphertext for exact rollback compatibility'
  );
  assert.equal(
    encryptionService.decryptAuthenticated(migratedDocument.rows[0].content),
    legacyDocumentContent
  );
  assert.deepEqual(
    JSON.parse(
      encryptionService.decryptAuthenticated(migratedDocument.rows[0].metadata)
    ).embeddingIndex,
    regeneratedIndex
  );
  const targetDomains = storage.createPostgresPlatformDomainRepositories(
    inspectionDatabase,
    encryptionService
  );
  const repositoryChunks =
    await targetDomains.documents.listChunks(legacyDocumentId);
  assert.equal(repositoryChunks.length, legacyDocumentChunkCount);
  assert.equal(
    Object.prototype.hasOwnProperty.call(repositoryChunks[0], 'embedding'),
    false,
    'team reads must hydrate content from PostgreSQL while treating PGVector as the only embedding authority'
  );
  assert.equal(
    (
      await targetVectors.query({
        actor: { userId: ownerUserId },
        namespace: 'document-chunk',
        model: legacyDocumentModel,
        dimensions: 3,
        version: 'v1',
        embedding: [0, 1, 0],
        resourceIds: [legacyDocumentId],
        limit: 5,
      })
    )[0]?.id,
    legacyChunkId,
    'a fully regenerated SQLite document must remain semantically retrievable through PGVector'
  );
  assert.deepEqual(
    await targetVectors.query({
      actor: {
        userId: `forged-${crypto.randomUUID()}`,
        groupIds: ['migration-readers'],
      },
      namespace: 'document-chunk',
      model: 'migration-embedding',
      dimensions: 3,
      version: 'v1',
      embedding: [1, 0, 0],
      resourceIds: [resourceId],
      limit: 5,
    }),
    []
  );
  assert.equal(
    (
      await targetVectors.query({
        actor: { userId: ownerUserId },
        namespace: 'persona-memory',
        model: 'migration-memory-embedding',
        dimensions: 3,
        version: 'v1',
        embedding: [0, 1, 0],
        resourceIds: [personaId],
        limit: 5,
      })
    )[0]?.id,
    memoryId,
    'legacy persona embeddings must be authenticated and reindexed, not discarded'
  );

  const rollbackSource = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rollbackPhase = createSQLiteToTeamStorageMigrationPhase(
      phaseOptions({})
    );
    await rollbackPhase.rollback({
      sourceDatabase: rollbackSource,
      sourcePath,
      target: inspectionDatabase,
      sourceFingerprint: migrationFingerprint,
    });
    await rollbackPhase.close();
  } finally {
    rollbackSource.close();
  }
  const afterRollback = await inspectionDatabase.query(
    `SELECT
       (SELECT COUNT(*)::int FROM platform_blob_objects) AS blobs,
       (SELECT COUNT(*)::int FROM platform_generated_media) AS gallery,
       (SELECT COUNT(*)::int FROM platform_blob_references) AS refs,
       (SELECT COUNT(*)::int FROM platform_vector_entries) AS vectors,
       (SELECT COUNT(*)::int FROM libre_sqlite_storage_import_items) AS journal`
  );
  assert.deepEqual(afterRollback.rows[0], {
    blobs: 0,
    gallery: 0,
    refs: 0,
    vectors: 0,
    journal: 0,
  });
  assert.equal(
    (
      await s3Client.send(
        new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: `${keyPrefix}/`,
        })
      )
    ).Contents?.length || 0,
    0
  );
  const retainedVersions = await s3Client.send(
    new ListObjectVersionsCommand({
      Bucket: s3Bucket,
      Prefix: `${keyPrefix}/`,
    })
  );
  assert.equal(retainedVersions.Versions?.length ?? 0, 0);
  assert.equal(retainedVersions.DeleteMarkers?.length ?? 0, 0);

  plaintext.fill(0);
  console.log(
    'PASS resumable SQLite local blob/vector migration to MinIO + PGVector'
  );
} finally {
  if (sourceDatabase.open) sourceDatabase.close();
  s3Client.destroy();
  await inspectionDatabase.close().catch(() => undefined);
  await bootstrapPool
    .query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    .catch(() => undefined);
  await bootstrapPool.end();
  fs.rmSync(sourceDirectory, { recursive: true, force: true });
}
