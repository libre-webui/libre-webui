/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Pool } from 'pg';

if (
  process.env.LIBRE_TEAM_STORAGE_INTEGRATION !== '1' &&
  process.env.TEST_TEAM_PLATFORM !== '1'
) {
  console.log('SKIP team storage integration (set TEST_TEAM_PLATFORM=1)');
  process.exit(0);
}

const required = name => {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for team storage integration`);
  return value;
};

const postgresUrl = required('TEST_POSTGRES_URL');
const s3Endpoint = required('TEST_S3_ENDPOINT');
const s3Bucket = required('TEST_S3_BUCKET');
const s3Region = process.env.TEST_S3_REGION?.trim() || 'us-east-1';
const s3AccessKeyId = required('TEST_S3_ACCESS_KEY_ID');
const s3SecretAccessKey = required('TEST_S3_SECRET_ACCESS_KEY');
process.env.ENCRYPTION_KEY ||=
  process.env.TEST_STORAGE_ENCRYPTION_KEY?.trim() || '91'.repeat(32);
const keyPrefix = `libre-integration/${crypto.randomUUID()}`;
const schemaName = `libre_storage_${crypto.randomUUID().replaceAll('-', '')}`;

const {
  Aes256GcmKeyring,
  BlobNotFoundError,
  BlobQuotaExceededError,
  PgVectorStore,
  PostgresDurableBlobQuotaPolicy,
  S3EncryptedBlobStore,
  POSTGRES_BLOB_SCHEMA_SQL,
  POSTGRES_VECTOR_SCHEMA_SQL,
} = await import('../backend/dist/platform/storage/index.js');
const { POSTGRES_CORE_PERSISTENCE_SQL } =
  await import('../backend/dist/persistence/postgresCoreMigration.js');
const { PostgresDatabase } =
  await import('../backend/dist/persistence/postgresDatabase.js');

const s3Config = {
  region: s3Region,
  endpoint: s3Endpoint,
  forcePathStyle: true,
  credentials: {
    accessKeyId: s3AccessKeyId,
    secretAccessKey: s3SecretAccessKey,
  },
};

const bootstrapPool = new Pool({ connectionString: postgresUrl, max: 1 });
await bootstrapPool.query(`CREATE SCHEMA ${schemaName}`);
const pool = new Pool({
  connectionString: postgresUrl,
  max: 8,
  options: `-c search_path=${schemaName},public`,
});
const database = new PostgresDatabase(pool);
const clients = [new S3Client(s3Config), new S3Client(s3Config)];
const ownerA = `owner-a-${crypto.randomUUID()}`;
const ownerB = `owner-b-${crypto.randomUUID()}`;
const groupMembership = new Map();
const keyring = new Aes256GcmKeyring('integration-v1', {
  'integration-v1': Buffer.from(
    process.env.TEST_STORAGE_ENCRYPTION_KEY?.trim() || '91'.repeat(32),
    'hex'
  ),
});

const readBytes = async body => {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const ensureBucket = async client => {
  try {
    await client.send(new HeadBucketCommand({ Bucket: s3Bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: s3Bucket }));
  }
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: s3Bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    })
  );
};

const exactObjectVersions = async objectKey => {
  const page = await clients[0].send(
    new ListObjectVersionsCommand({
      Bucket: s3Bucket,
      Prefix: objectKey,
    })
  );
  return {
    versions: (page.Versions ?? []).filter(item => item.Key === objectKey),
    deleteMarkers: (page.DeleteMarkers ?? []).filter(
      item => item.Key === objectKey
    ),
  };
};

const assertNoObjectVersions = async objectKey => {
  const retained = await exactObjectVersions(objectKey);
  assert.equal(retained.versions.length, 0, `${objectKey} retained a version`);
  assert.equal(
    retained.deleteMarkers.length,
    0,
    `${objectKey} retained a delete marker`
  );
};

const prefixVersionInventory = async () => {
  const page = await clients[0].send(
    new ListObjectVersionsCommand({
      Bucket: s3Bucket,
      Prefix: `${keyPrefix}/`,
    })
  );
  return [
    ...(page.Versions ?? []).map(
      item => `version:${item.Key}:${item.VersionId ?? 'null'}`
    ),
    ...(page.DeleteMarkers ?? []).map(
      item => `marker:${item.Key}:${item.VersionId ?? 'null'}`
    ),
  ].sort();
};

const source = value =>
  Readable.from([
    value.subarray(0, Math.min(value.length, 17)),
    value.subarray(Math.min(value.length, 17)),
  ]);

const put = (store, ownerUserId, bytes, purpose = 'document.source') =>
  store.put({
    ownerUserId,
    purpose,
    contentType: 'application/octet-stream',
    expectedSize: bytes.length,
    originalFilename: 'private-source.bin',
    metadata: { resourceType: 'document', resourceId: crypto.randomUUID() },
    source: source(bytes),
  });

const managedObjectKey = id =>
  `${keyPrefix}/v1/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.blob`;

const dropFaultTrigger = async name => {
  await database.query(
    `DROP TRIGGER IF EXISTS ${name} ON platform_blob_quota_objects`
  );
  await database.query(`DROP FUNCTION IF EXISTS ${name}()`);
};

try {
  await ensureBucket(clients[0]);
  await database.query(POSTGRES_CORE_PERSISTENCE_SQL);
  await database.query(POSTGRES_BLOB_SCHEMA_SQL);
  await database.query(POSTGRES_VECTOR_SCHEMA_SQL);
  const now = Date.now();
  for (const owner of [ownerA, ownerB]) {
    await database.query(
      `INSERT INTO users
         (id, username, password_hash, role, account_status, created_at, updated_at)
       VALUES ($1, $2, 'integration-only', 'user', 'active', $3, $3)`,
      [owner, owner, now]
    );
  }

  const quotaA = new PostgresDurableBlobQuotaPolicy(database, {
    maximumBytesPerOwner: 8 * 1024 * 1024,
    reservationTtlMs: 60_000,
  });
  const quotaB = new PostgresDurableBlobQuotaPolicy(database, {
    maximumBytesPerOwner: 8 * 1024 * 1024,
    reservationTtlMs: 60_000,
  });
  const storeA = new S3EncryptedBlobStore({
    database,
    client: clients[0],
    bucket: s3Bucket,
    keyPrefix,
    keyring,
    quotaPolicy: quotaA,
    chunkBytes: 64 * 1024,
  });
  const storeB = new S3EncryptedBlobStore({
    database,
    client: clients[1],
    bucket: s3Bucket,
    keyPrefix,
    keyring,
    quotaPolicy: quotaB,
    chunkBytes: 64 * 1024,
  });

  assert.equal(await storeA.health(), true);
  const plaintext = Buffer.concat([
    Buffer.from('cross-replica-private-prefix:'),
    crypto.randomBytes(180_000),
  ]);
  const descriptor = await put(storeA, ownerA, plaintext);
  assert.equal(
    descriptor.sha256,
    crypto.createHash('sha256').update(plaintext).digest('hex')
  );
  const otherReplicaRead = await storeB.open({
    id: descriptor.id,
    ownerUserId: ownerA,
  });
  assert.deepEqual(await readBytes(otherReplicaRead.body), plaintext);
  const ranged = await storeB.open({
    id: descriptor.id,
    ownerUserId: ownerA,
    range: { start: 65_500, end: 131_099 },
  });
  assert.deepEqual(
    await readBytes(ranged.body),
    plaintext.subarray(65_500, 131_100)
  );
  await assert.rejects(
    storeB.open({ id: descriptor.id, ownerUserId: ownerB }),
    BlobNotFoundError
  );

  const row = await database.query(
    'SELECT object_key, encrypted_metadata::text AS encrypted_metadata FROM platform_blob_objects WHERE id = $1',
    [descriptor.id]
  );
  assert.equal(row.rows.length, 1);
  assert.equal(String(row.rows[0].object_key).includes('http'), false);
  assert.equal(
    String(row.rows[0].encrypted_metadata).includes('private-source'),
    false
  );
  const physical = await clients[0].send(
    new GetObjectCommand({ Bucket: s3Bucket, Key: row.rows[0].object_key })
  );
  const ciphertext = await readBytes(physical.Body);
  assert.equal(
    ciphertext.includes(Buffer.from('cross-replica-private-prefix')),
    false
  );

  // Emulate a hard kill after Upload.done() but before the SQL metadata
  // transaction. A recent object must survive; once outside the grace window,
  // bounded reconciliation must discover and remove it. A tracked object and
  // an unknown operator key beneath the prefix must never be collected.
  const killedUploadId = crypto.randomUUID();
  const killedUploadKey = managedObjectKey(killedUploadId);
  const unknownOperatorKey = `${keyPrefix}/v1/operator-owned-object`;
  await clients[0].send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: killedUploadKey,
      Body: crypto.randomBytes(32),
      Metadata: { 'libre-format': '1' },
    })
  );
  await clients[0].send(
    new PutObjectCommand({
      Bucket: s3Bucket,
      Key: unknownOperatorKey,
      Body: Buffer.from('operator-owned'),
    })
  );
  const recentPass = await storeB.reconcileOrphans({
    olderThan: new Date(Date.now() - 60_000),
    maxObjects: 100,
  });
  assert.equal(recentPass.complete, true);
  assert.equal(recentPass.deletedOrphans, 0);
  await clients[0].send(
    new HeadObjectCommand({ Bucket: s3Bucket, Key: killedUploadKey })
  );
  const agedPass = await storeB.reconcileOrphans({
    olderThan: new Date(Date.now() + 1_000),
    maxObjects: 100,
  });
  assert.equal(agedPass.complete, true);
  assert.equal(agedPass.deletedOrphans, 1);
  await assert.rejects(
    clients[0].send(
      new HeadObjectCommand({ Bucket: s3Bucket, Key: killedUploadKey })
    )
  );
  await assertNoObjectVersions(killedUploadKey);
  await clients[0].send(
    new HeadObjectCommand({ Bucket: s3Bucket, Key: row.rows[0].object_key })
  );
  await clients[0].send(
    new HeadObjectCommand({ Bucket: s3Bucket, Key: unknownOperatorKey })
  );

  const pagedOrphanKeys = Array.from({ length: 3 }, () =>
    managedObjectKey(crypto.randomUUID())
  ).sort();
  for (const objectKey of pagedOrphanKeys) {
    await clients[0].send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: objectKey,
        Body: crypto.randomBytes(8),
        Metadata: { 'libre-format': '1' },
      })
    );
  }
  let reconciliationCursor;
  let completedPagedScan = false;
  let pagedDeletes = 0;
  for (let pass = 0; pass < 20 && !completedPagedScan; pass += 1) {
    const result = await storeB.reconcileOrphans({
      olderThan: new Date(Date.now() + 1_000),
      maxObjects: 1,
      ...(reconciliationCursor
        ? { continuationToken: reconciliationCursor }
        : {}),
    });
    assert.ok(result.inspectedObjects <= 1);
    pagedDeletes += result.deletedOrphans;
    reconciliationCursor = result.continuationToken;
    completedPagedScan = result.complete;
  }
  assert.equal(completedPagedScan, true);
  assert.equal(pagedDeletes, pagedOrphanKeys.length);
  for (const objectKey of pagedOrphanKeys) {
    await assertNoObjectVersions(objectKey);
  }
  await clients[0].send(
    new DeleteObjectCommand({ Bucket: s3Bucket, Key: unknownOperatorKey })
  );

  const unconsumed = await storeB.open({
    id: descriptor.id,
    ownerUserId: ownerA,
  });
  unconsumed.body.destroy();
  await new Promise(resolve => unconsumed.body.once('close', resolve));
  assert.equal((await storeB.stat(descriptor.id, ownerA)).id, descriptor.id);

  const vectorA = new PgVectorStore({
    database,
    principalResolver: {
      async resolveGroupIds(userId) {
        return groupMembership.get(userId) || [];
      },
    },
  });
  const vectorB = new PgVectorStore({
    database,
    principalResolver: {
      async resolveGroupIds(userId) {
        return groupMembership.get(userId) || [];
      },
    },
  });
  const resourceId = `document-${crypto.randomUUID()}`;
  await vectorA.upsert({
    actor: { userId: ownerA },
    records: [
      {
        namespace: 'document-chunk',
        id: `chunk-${crypto.randomUUID()}`,
        ownerUserId: ownerA,
        resourceId,
        model: 'integration-embedding',
        dimensions: 3,
        version: 'v1',
        sourceRevision: crypto
          .createHash('sha256')
          .update('chunk')
          .digest('hex'),
        embedding: [1, 0, 0],
        grants: [{ type: 'group', id: 'trusted-readers' }],
      },
    ],
  });
  const vectorQuery = actor => ({
    actor,
    namespace: 'document-chunk',
    model: 'integration-embedding',
    dimensions: 3,
    version: 'v1',
    embedding: [1, 0, 0],
    limit: 10,
    resourceIds: [resourceId],
  });
  assert.deepEqual(
    await vectorB.query(
      vectorQuery({ userId: ownerB, groupIds: ['trusted-readers'] })
    ),
    [],
    'caller-forged group claims must never authorize retrieval'
  );
  groupMembership.set(ownerB, ['trusted-readers']);
  assert.equal(
    (await vectorB.query(vectorQuery({ userId: ownerB }))).length,
    1
  );
  groupMembership.delete(ownerB);
  assert.deepEqual(
    await vectorB.query(
      vectorQuery({ userId: ownerB, groupIds: ['trusted-readers'] })
    ),
    [],
    'revocation must be observed without rebuilding the vector index'
  );
  assert.equal(
    (await vectorA.query(vectorQuery({ userId: ownerA }))).length,
    1
  );

  const concurrentOwner = `quota-${crypto.randomUUID()}`;
  const constrainedQuotaA = new PostgresDurableBlobQuotaPolicy(database, {
    maximumBytesPerOwner: 100_000,
    reservationTtlMs: 60_000,
  });
  const constrainedQuotaB = new PostgresDurableBlobQuotaPolicy(database, {
    maximumBytesPerOwner: 100_000,
    reservationTtlMs: 60_000,
  });
  const constrainedStores = [
    new S3EncryptedBlobStore({
      database,
      client: clients[0],
      bucket: s3Bucket,
      keyPrefix,
      keyring,
      quotaPolicy: constrainedQuotaA,
      chunkBytes: 64 * 1024,
    }),
    new S3EncryptedBlobStore({
      database,
      client: clients[1],
      bucket: s3Bucket,
      keyPrefix,
      keyring,
      quotaPolicy: constrainedQuotaB,
      chunkBytes: 64 * 1024,
    }),
  ];
  const concurrent = await Promise.allSettled(
    constrainedStores.map(store =>
      put(store, concurrentOwner, crypto.randomBytes(70_000))
    )
  );
  assert.equal(
    concurrent.filter(result => result.status === 'fulfilled').length,
    1
  );
  assert.equal(
    concurrent.filter(result => result.status === 'rejected').length,
    1
  );
  assert.ok(
    concurrent.find(result => result.status === 'rejected').reason instanceof
      BlobQuotaExceededError
  );
  const successfulQuotaBlob = concurrent.find(
    result => result.status === 'fulfilled'
  ).value;
  await constrainedStores[0].delete({
    id: successfulQuotaBlob.id,
    ownerUserId: concurrentOwner,
  });
  await assertNoObjectVersions(managedObjectKey(successfulQuotaBlob.id));

  const beforeFaultObjects = await prefixVersionInventory();
  await database.query(`
    CREATE FUNCTION libre_test_blob_commit_fault() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected blob commit fault'; END $$;
    CREATE TRIGGER libre_test_blob_commit_fault
      BEFORE INSERT ON platform_blob_quota_objects
      FOR EACH ROW EXECUTE FUNCTION libre_test_blob_commit_fault();
  `);
  await assert.rejects(put(storeA, ownerB, crypto.randomBytes(8_000)));
  await dropFaultTrigger('libre_test_blob_commit_fault');
  const afterFaultObjects = await prefixVersionInventory();
  assert.deepEqual(
    afterFaultObjects,
    beforeFaultObjects,
    'failed metadata/quota transaction must remove the uploaded object'
  );
  const leakedReservation = await database.query(
    `SELECT COUNT(*)::int AS count FROM platform_blob_quota_reservations
      WHERE owner_user_id = $1`,
    [ownerB]
  );
  assert.equal(leakedReservation.rows[0].count, 0);

  // PostgreSQL can commit metadata/quota and then lose the acknowledgement.
  // Outcome resolution must authenticate the committed SQL/object state and
  // return success, never purge the immutable version as though SQL were
  // absent.
  const acknowledgementLossId = crypto.randomUUID();
  const acknowledgementLossBytes = crypto.randomBytes(9_000);
  const acknowledgementLossQuota = new PostgresDurableBlobQuotaPolicy(
    database,
    {
      maximumBytesPerOwner: 8 * 1024 * 1024,
      reservationTtlMs: 60_000,
    }
  );
  let acknowledgementLossInjected = false;
  const acknowledgementLossStore = new S3EncryptedBlobStore({
    database,
    client: clients[0],
    bucket: s3Bucket,
    keyPrefix,
    keyring,
    quotaPolicy: {
      reserve: async request => {
        const reservation = await acknowledgementLossQuota.reserve(request);
        return {
          ...reservation,
          commitWithMetadata: async (descriptor, operation) => {
            await reservation.commitWithMetadata(descriptor, operation);
            acknowledgementLossInjected = true;
            throw new Error(
              'injected connection loss after PostgreSQL blob commit'
            );
          },
        };
      },
    },
    chunkBytes: 64 * 1024,
  });
  const acknowledgedDescriptor = await acknowledgementLossStore.putWithId(
    {
      ownerUserId: ownerB,
      purpose: 'document.source',
      contentType: 'application/octet-stream',
      originalFilename: 'acknowledgement-loss.bin',
      expectedSize: acknowledgementLossBytes.length,
      metadata: { boundary: 'post-commit-acknowledgement-loss' },
      source: source(acknowledgementLossBytes),
    },
    acknowledgementLossId
  );
  assert.equal(acknowledgementLossInjected, true);
  assert.equal(acknowledgedDescriptor.id, acknowledgementLossId);
  const acknowledgedRead = await storeB.open({
    id: acknowledgementLossId,
    ownerUserId: ownerB,
  });
  assert.deepEqual(
    await readBytes(acknowledgedRead.body),
    acknowledgementLossBytes
  );
  const acknowledgedSql = await database.query(
    `SELECT
       (SELECT COUNT(*)::int FROM platform_blob_objects WHERE id = $1) AS metadata,
       (SELECT COUNT(*)::int FROM platform_blob_quota_objects WHERE blob_id = $1) AS quota,
       (SELECT COUNT(*)::int FROM platform_blob_quota_reservations
         WHERE owner_user_id = $2) AS reservations`,
    [acknowledgementLossId, ownerB]
  );
  assert.deepEqual(acknowledgedSql.rows[0], {
    metadata: 1,
    quota: 1,
    reservations: 0,
  });
  const acknowledgedVersions = await exactObjectVersions(
    managedObjectKey(acknowledgementLossId)
  );
  assert.equal(acknowledgedVersions.versions.length, 1);
  assert.equal(acknowledgedVersions.deleteMarkers.length, 0);
  await storeA.delete({
    id: acknowledgementLossId,
    ownerUserId: ownerB,
  });
  await assertNoObjectVersions(managedObjectKey(acknowledgementLossId));

  const retryBlob = await put(storeA, ownerB, crypto.randomBytes(12_000));
  await database.query(`
    CREATE FUNCTION libre_test_blob_delete_fault() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected blob delete fault'; END $$;
    CREATE TRIGGER libre_test_blob_delete_fault
      BEFORE DELETE ON platform_blob_quota_objects
      FOR EACH ROW EXECUTE FUNCTION libre_test_blob_delete_fault();
  `);
  await assert.rejects(
    storeA.delete({ id: retryBlob.id, ownerUserId: ownerB })
  );
  const retained = await database.query(
    'SELECT state FROM platform_blob_objects WHERE id = $1',
    [retryBlob.id]
  );
  assert.equal(retained.rows[0].state, 'deleting');
  await dropFaultTrigger('libre_test_blob_delete_fault');
  const reconciliation = await storeB.reconcileOrphans({
    olderThan: new Date(Date.now() + 1_000),
  });
  assert.ok(reconciliation.resumedDeletes >= 1);
  assert.equal(
    (
      await database.query(
        'SELECT 1 FROM platform_blob_objects WHERE id = $1',
        [retryBlob.id]
      )
    ).rowCount,
    0
  );
  await assertNoObjectVersions(managedObjectKey(retryBlob.id));

  // Deletion and a deterministic import/replacement of the same ID are fenced
  // by one PostgreSQL advisory lock. Hold the delete inside its first exact-key
  // version listing, start the replacement from another replica, then prove
  // the replacement cannot publish until deletion is stably empty and that it
  // survives with exactly one immutable version.
  const replacementId = crypto.randomUUID();
  const replacementKey = managedObjectKey(replacementId);
  const originalReplacement = await storeA.putWithId(
    {
      ownerUserId: ownerB,
      purpose: 'document.source',
      contentType: 'application/octet-stream',
      expectedSize: 16,
      source: source(Buffer.alloc(16, 1)),
    },
    replacementId
  );
  assert.equal(originalReplacement.id, replacementId);
  const originalSend = clients[0].send.bind(clients[0]);
  let releaseDeleteListing;
  const deleteListingReleased = new Promise(resolve => {
    releaseDeleteListing = resolve;
  });
  let enterDeleteListing;
  const deleteListingEntered = new Promise(resolve => {
    enterDeleteListing = resolve;
  });
  let pausedDeleteListing = false;
  clients[0].send = async (command, ...args) => {
    if (
      !pausedDeleteListing &&
      command instanceof ListObjectVersionsCommand &&
      command.input.Prefix === replacementKey
    ) {
      pausedDeleteListing = true;
      enterDeleteListing();
      await deleteListingReleased;
    }
    return originalSend(command, ...args);
  };
  let replacementSettled = false;
  try {
    const deletePromise = storeA.delete({
      id: replacementId,
      ownerUserId: ownerB,
    });
    await deleteListingEntered;
    const replacementBytes = Buffer.alloc(24, 2);
    const replacementPromise = storeB
      .putWithId(
        {
          ownerUserId: ownerB,
          purpose: 'document.source',
          contentType: 'application/octet-stream',
          expectedSize: replacementBytes.length,
          source: source(replacementBytes),
        },
        replacementId
      )
      .finally(() => {
        replacementSettled = true;
      });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(
      replacementSettled,
      false,
      'same-key replacement must wait for physical deletion to finish'
    );
    releaseDeleteListing();
    assert.equal(await deletePromise, true);
    const replacement = await replacementPromise;
    assert.equal(replacement.id, replacementId);
    const openedReplacement = await storeA.open({
      id: replacementId,
      ownerUserId: ownerB,
    });
    assert.deepEqual(await readBytes(openedReplacement.body), replacementBytes);
    const retainedReplacement = await exactObjectVersions(replacementKey);
    assert.equal(retainedReplacement.versions.length, 1);
    assert.equal(retainedReplacement.deleteMarkers.length, 0);
  } finally {
    releaseDeleteListing?.();
    clients[0].send = originalSend;
  }
  await storeB.delete({ id: replacementId, ownerUserId: ownerB });
  await assertNoObjectVersions(replacementKey);

  await vectorB.delete({
    actor: { userId: ownerA },
    namespace: 'document-chunk',
    resourceId,
  });
  await storeB.delete({ id: descriptor.id, ownerUserId: ownerA });
  await assertNoObjectVersions(managedObjectKey(descriptor.id));
  assert.deepEqual(await vectorA.verifyIntegrity(), {
    records: 0,
    components: 0,
  });
  const usage = await database.query(
    `SELECT stored_bytes, reserved_bytes FROM platform_blob_quota_usage
      WHERE owner_user_id = ANY($1::text[])`,
    [[ownerA, ownerB, concurrentOwner]]
  );
  for (const item of usage.rows) {
    assert.equal(Number(item.stored_bytes), 0);
    assert.equal(Number(item.reserved_bytes), 0);
  }

  console.log('PASS real MinIO + PostgreSQL/pgvector storage integration');
} finally {
  await dropFaultTrigger('libre_test_blob_commit_fault').catch(() => undefined);
  await dropFaultTrigger('libre_test_blob_delete_fault').catch(() => undefined);
  for (const client of clients) client.destroy();
  await database.close();
  await bootstrapPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await bootstrapPool.end();
}
