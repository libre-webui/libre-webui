/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const POSTGRES_IMAGE =
  'pgvector/pgvector@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b';
const MINIO_IMAGE =
  'minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e';
const dockerGate = process.env.TEST_TEAM_PLATFORM === '1';

const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'ignore', 'ignore'] : undefined,
  }).trim();

const dockerPort = (container, privatePort) => {
  const output = docker(['port', container, `${privatePort}/tcp`]);
  const address = output.split('\n')[0];
  const port = Number(address.slice(address.lastIndexOf(':') + 1));
  assert.ok(
    Number.isSafeInteger(port) && port > 0,
    `Invalid Docker port: ${output}`
  );
  return port;
};

const pause = milliseconds =>
  new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

const waitFor = async (description, probe) => {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await pause(250);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: lastError });
};

const stopContainer = name => {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
};

const writePostgresToolWrapper = (target, container, tool) => {
  const content = `#!/bin/sh
set -eu
exec docker exec \\
  -e PGHOST=127.0.0.1 \\
  -e PGPORT=5432 \\
  -e PGDATABASE="\${PGDATABASE}" \\
  -e PGUSER="\${PGUSER}" \\
  -e PGPASSWORD="\${PGPASSWORD}" \\
  -e PGSSLMODE=disable \\
  "${container}" ${tool} "$@"
`;
  fs.writeFileSync(target, content, { mode: 0o700, flag: 'wx' });
};

const writeCommitThenFailRestoreWrapper = (target, restoreWrapper) => {
  const content = `#!/bin/sh
set -eu
"${restoreWrapper}" "$@"
exit 41
`;
  fs.writeFileSync(target, content, { mode: 0o700, flag: 'wx' });
};

const writeRestoreThenBreakHeadWrapper = (
  target,
  restoreWrapper,
  container
) => {
  const content = `#!/bin/sh
set -eu
"${restoreWrapper}" "$@"
exec docker exec \\
  -e PGHOST=127.0.0.1 \\
  -e PGPORT=5432 \\
  -e PGDATABASE="\${PGDATABASE}" \\
  -e PGUSER="\${PGUSER}" \\
  -e PGPASSWORD="\${PGPASSWORD}" \\
  -e PGSSLMODE=disable \\
  "${container}" psql -v ON_ERROR_STOP=1 -c \\
  "SET session_replication_role = replica; DELETE FROM platform_event_stream_heads"
`;
  fs.writeFileSync(target, content, { mode: 0o700, flag: 'wx' });
};

const emailCodec = {
  encrypt: plaintext =>
    `${'a'.repeat(32)}:${Buffer.from(plaintext, 'utf8').toString('hex')}:${'b'.repeat(32)}`,
  decryptAuthenticated: ciphertext =>
    Buffer.from(ciphertext.split(':')[1], 'hex').toString('utf8'),
  decryptBuffer: ciphertext => Buffer.from(ciphertext),
  isEncrypted: value =>
    new RegExp(`^${'a'.repeat(32)}:[0-9a-f]+:${'b'.repeat(32)}$`).test(value),
  lookupToken: plaintext =>
    createHash('sha256').update(plaintext.toLowerCase()).digest('hex'),
};

const collect = async stream => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

test(
  'team backup restores a clean PostgreSQL and versioned S3 target with authenticated PGVector state',
  { skip: dockerGate ? false : 'TEST_TEAM_PLATFORM=1 is required' },
  async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'libre-team-backup-test-')
    );
    fs.chmodSync(root, 0o700);
    const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
    const postgresContainer = `libre-team-pg-${suffix}`;
    const minioContainer = `libre-team-minio-${suffix}`;
    const previousTmpDir = process.env.TMPDIR;
    const previousEncryptionKey = process.env.ENCRYPTION_KEY;
    let sourcePersistence;
    let restoredDatabase;
    let sourceS3;
    let targetS3;
    try {
      process.env.TMPDIR = root;
      process.env.ENCRYPTION_KEY = '31'.repeat(32);
      const [
        { resolvePostgresRuntimeConfig },
        { createPostgresDatabase, PostgresDatabase },
        { initializePostgresPersistence },
        { generateBackupKeys, verifyBackupArchive },
        {
          createTeamBackupArchive,
          restoreTeamBackupArchive,
          TeamRestoreRollbackError,
        },
        { createS3EncryptedBlobStore },
        { createStorageKeyringFromEnvironment },
        { PgVectorStore },
        { PostgresDurableJobRepository },
        { PostgresDurableJobService },
      ] = await Promise.all([
        import('../backend/dist/persistence/postgresConfig.js'),
        import('../backend/dist/persistence/postgresDatabase.js'),
        import('../backend/dist/persistence/postgresPersistence.js'),
        import('../backend/dist/platform/recovery/backupArchive.js'),
        import('../backend/dist/platform/recovery/teamBackupArchive.js'),
        import('../backend/dist/platform/storage/s3EncryptedBlobStore.js'),
        import('../backend/dist/platform/storage/storageFactory.js'),
        import('../backend/dist/platform/storage/pgVectorStore.js'),
        import('../backend/dist/platform/jobs/postgresDurableJobRepository.js'),
        import('../backend/dist/platform/jobs/postgresDurableJobService.js'),
      ]);
      docker([
        'run',
        '--detach',
        '--rm',
        '--name',
        postgresContainer,
        '--env',
        'POSTGRES_USER=postgres',
        '--env',
        'POSTGRES_PASSWORD=postgres-test-password',
        '--env',
        'POSTGRES_DB=postgres',
        '--publish',
        '127.0.0.1::5432',
        '--volume',
        `${root}:${root}`,
        POSTGRES_IMAGE,
      ]);
      docker([
        'run',
        '--detach',
        '--rm',
        '--name',
        minioContainer,
        '--env',
        'MINIO_ROOT_USER=libre-test-access',
        '--env',
        'MINIO_ROOT_PASSWORD=libre-test-secret-key',
        '--publish',
        '127.0.0.1::9000',
        MINIO_IMAGE,
        'server',
        '/data',
      ]);

      await waitFor(
        'PostgreSQL',
        () =>
          spawnSync(
            'docker',
            [
              'exec',
              '--env',
              'PGPASSWORD=postgres-test-password',
              postgresContainer,
              'psql',
              '--host=127.0.0.1',
              '--username=postgres',
              '--dbname=postgres',
              '--tuples-only',
              '--command=SELECT 1',
            ],
            { stdio: 'ignore' }
          ).status === 0
      );
      const postgresPort = dockerPort(postgresContainer, 5432);
      const minioPort = dockerPort(minioContainer, 9000);
      await waitFor('MinIO', async () => {
        const response = await fetch(
          `http://127.0.0.1:${minioPort}/minio/health/ready`
        );
        return response.ok;
      });

      docker([
        'exec',
        '--env',
        'PGPASSWORD=postgres-test-password',
        postgresContainer,
        'createdb',
        '--host=127.0.0.1',
        '-U',
        'postgres',
        'libre_source_test',
      ]);
      docker([
        'exec',
        '--env',
        'PGPASSWORD=postgres-test-password',
        postgresContainer,
        'createdb',
        '--host=127.0.0.1',
        '-U',
        'postgres',
        'libre_target_test',
      ]);
      const sourceUrl = `postgresql://postgres:postgres-test-password@127.0.0.1:${postgresPort}/libre_source_test`;
      const targetUrl = `postgresql://postgres:postgres-test-password@127.0.0.1:${postgresPort}/libre_target_test`;
      const endpoint = `http://127.0.0.1:${minioPort}`;
      const credentials = {
        accessKeyId: 'libre-test-access',
        secretAccessKey: 'libre-test-secret-key',
      };
      const s3Client = new S3Client({
        endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        credentials,
      });
      sourceS3 = s3Client;
      targetS3 = s3Client;
      for (const bucket of ['libre-source-test', 'libre-target-test']) {
        await s3Client.send(new CreateBucketCommand({ Bucket: bucket }));
        await s3Client.send(
          new PutBucketVersioningCommand({
            Bucket: bucket,
            VersioningConfiguration: { Status: 'Enabled' },
          })
        );
      }

      const encryptionKey = process.env.ENCRYPTION_KEY;
      const baseEnvironment = {
        LIBRE_PLATFORM_MODE: 'team',
        DATABASE_BACKEND: 'postgres',
        DATABASE_SSL_MODE: 'disable',
        POSTGRES_MIGRATION_MODE: 'apply',
        BLOB_STORE_BACKEND: 's3',
        VECTOR_STORE_BACKEND: 'pgvector',
        COORDINATION_BACKEND: 'redis',
        REDIS_URL: 'redis://127.0.0.1:6379',
        JOB_WORKER_MODE: 'external',
        S3_REGION: 'us-east-1',
        S3_ENDPOINT: endpoint,
        S3_ACCESS_KEY_ID: credentials.accessKeyId,
        S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        S3_FORCE_PATH_STYLE: 'true',
        S3_BLOB_PREFIX: 'libre-team-test',
        ENCRYPTION_KEY: encryptionKey,
        DATA_DIR: path.join(root, 'unused-data-dir'),
      };
      const sourceEnvironment = {
        ...baseEnvironment,
        POSTGRES_POOL_MAX: '7',
        POSTGRES_CONNECT_TIMEOUT_MS: '4000',
        POSTGRES_IDLE_TIMEOUT_MS: '20000',
        POSTGRES_STATEMENT_TIMEOUT_MS: '25000',
        POSTGRES_MIGRATION_LOCK_TIMEOUT_MS: '45000',
        REDIS_CONNECT_TIMEOUT_MS: '3500',
        BLOB_QUOTA_BYTES_PER_USER: '8589934592',
        BLOB_QUOTA_RESERVATION_TTL_MS: '7200000',
        DATABASE_URL: sourceUrl,
        S3_BUCKET: 'libre-source-test',
      };
      const targetEnvironment = {
        ...baseEnvironment,
        DATABASE_URL: targetUrl,
        S3_BUCKET: 'libre-target-test',
      };

      sourcePersistence = await initializePostgresPersistence(
        resolvePostgresRuntimeConfig(sourceEnvironment),
        emailCodec
      );
      const now = Date.now();
      const ownerUserId = 'team-backup-owner';
      await sourcePersistence.repositories.identity.insert({
        id: ownerUserId,
        username: 'team-owner',
        email: 'team-owner@example.test',
        password_hash: 'test-password-hash',
        role: 'admin',
        account_status: 'active',
        approved_at: now,
        approved_by: null,
        avatar: null,
        created_at: now,
        updated_at: now,
      });

      const keyring = createStorageKeyringFromEnvironment(sourceEnvironment);
      const sourceBlobStore = createS3EncryptedBlobStore({
        database: sourcePersistence.database,
        keyring,
        env: sourceEnvironment,
      });
      const plaintext = Buffer.from('authenticated team backup object', 'utf8');
      const descriptor = await sourceBlobStore.put({
        ownerUserId,
        purpose: 'document.source',
        contentType: 'text/plain',
        originalFilename: 'source.txt',
        expectedSize: plaintext.length,
        source: Readable.from([plaintext]),
      });
      const secondPlaintext = Buffer.from(
        'second authenticated team backup object',
        'utf8'
      );
      const secondDescriptor = await sourceBlobStore.put({
        ownerUserId,
        purpose: 'document.source',
        contentType: 'text/plain',
        originalFilename: 'source-second.txt',
        expectedSize: secondPlaintext.length,
        source: Readable.from([secondPlaintext]),
      });
      const sourceVectorStore = new PgVectorStore({
        database: sourcePersistence.database,
      });
      await sourceVectorStore.upsert({
        actor: { userId: ownerUserId },
        records: [
          {
            namespace: 'document-chunks',
            id: 'team-vector-1',
            ownerUserId,
            resourceId: 'team-document-1',
            model: 'team-test-model',
            dimensions: 3,
            version: '1',
            sourceRevision: 'source-1',
            embedding: [1, 0, 0],
            attributes: { chunk: '0' },
          },
        ],
      });
      const durableService = new PostgresDurableJobService(
        new PostgresDurableJobRepository(sourcePersistence.database),
        keyring
      );
      const durableJobPayload = {
        documentId: 'team-document-1',
        operation: 'backup-roundtrip',
      };
      const durableJob = await durableService.enqueue({
        jobType: 'document.extract-embed.v1',
        actorUserId: ownerUserId,
        payload: { mode: 'encrypted', value: durableJobPayload },
        idempotencyScope: 'team-backup-test',
        idempotencyKey: 'representative-job',
      });
      const durableEventId = randomUUID();
      const durableEventPayload = { stage: 'queued', total: 1 };
      const durableEventCursor = await durableService.appendEvent({
        eventId: durableEventId,
        streamId: `job:${durableJob.id}`,
        eventType: 'job.queued',
        subjectId: durableJob.id,
        actorUserId: ownerUserId,
        payload: { mode: 'encrypted', value: durableEventPayload },
      });
      await sourcePersistence.close();
      sourcePersistence = undefined;

      const dumpWrapper = path.join(root, 'pg-dump-wrapper');
      const restoreWrapper = path.join(root, 'pg-restore-wrapper');
      const restoreThenBreakHeadWrapper = path.join(
        root,
        'pg-restore-then-break-head-wrapper'
      );
      const commitThenFailRestoreWrapper = path.join(
        root,
        'pg-restore-commit-then-fail-wrapper'
      );
      writePostgresToolWrapper(dumpWrapper, postgresContainer, 'pg_dump');
      writePostgresToolWrapper(restoreWrapper, postgresContainer, 'pg_restore');
      writeRestoreThenBreakHeadWrapper(
        restoreThenBreakHeadWrapper,
        restoreWrapper,
        postgresContainer
      );
      writeCommitThenFailRestoreWrapper(
        commitThenFailRestoreWrapper,
        restoreWrapper
      );
      const keys = generateBackupKeys(path.join(root, 'backup-keys'));
      const archivePath = path.join(root, 'team.librebackup');
      const created = await createTeamBackupArchive({
        outputPath: archivePath,
        encryptionKeyPath: keys.encryptionKeyPath,
        signingPrivateKeyPath: keys.signingPrivateKeyPath,
        env: sourceEnvironment,
        offline: true,
        pgDumpCommand: dumpWrapper,
        toolTimeoutMs: 120_000,
      });
      assert.equal(created.inventory.s3.objects.length, 2);
      assert.equal(created.inventory.vectors.records, 1);
      assert.deepEqual(
        {
          jobs: created.inventory.durable.jobs,
          events: created.inventory.durable.events,
          streams: created.inventory.durable.streams,
          records: created.inventory.durable.records,
          encryptedRecords: created.inventory.durable.encryptedRecords,
          referenceRecords: created.inventory.durable.referenceRecords,
          lastGlobalCursor: created.inventory.durable.lastGlobalCursor,
        },
        {
          jobs: 1,
          events: 2,
          streams: 1,
          records: 3,
          encryptedRecords: 2,
          referenceRecords: 1,
          lastGlobalCursor: durableEventCursor,
        }
      );
      assert.equal(created.inventory.durable.verified, true);
      assert.equal(created.inventory.durable.encryptedAuthenticated, true);
      assert.equal(created.inventory.durable.streamHeadsVerified, true);
      assert.ok(created.inventory.durable.plaintextBytes > 0);
      assert.ok(created.inventory.durable.referenceBytes > 0);
      assert.equal(created.verification.payloadVerified, true);
      assert.equal(
        verifyBackupArchive({
          archivePath,
          signingPublicKeyPath: keys.signingPublicKeyPath,
          encryptionKeyPath: keys.encryptionKeyPath,
        }).payloadVerified,
        true
      );

      // Source verification authenticates the encrypted durable envelopes
      // before pg_dump. A signed archive must never canonize corrupt SQL state.
      const sourceMutationDatabase = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          ...sourceEnvironment,
          POSTGRES_MIGRATION_MODE: 'validate',
        })
      );
      const originalDurablePayload = await sourceMutationDatabase.query(
        'SELECT payload FROM platform_jobs WHERE id = $1',
        [durableJob.id]
      );
      await sourceMutationDatabase.query(
        `UPDATE platform_jobs
            SET payload = jsonb_set(payload::jsonb, '{tag}', '"AAAAAAAAAAAAAAAAAAAAAA=="')::text
          WHERE id = $1`,
        [durableJob.id]
      );
      const corruptArchivePath = path.join(root, 'corrupt-team.librebackup');
      try {
        await assert.rejects(
          createTeamBackupArchive({
            outputPath: corruptArchivePath,
            encryptionKeyPath: keys.encryptionKeyPath,
            signingPrivateKeyPath: keys.signingPrivateKeyPath,
            env: sourceEnvironment,
            offline: true,
            pgDumpCommand: dumpWrapper,
            toolTimeoutMs: 120_000,
          }),
          /Durable payload authentication failed/
        );
      } finally {
        await sourceMutationDatabase.query(
          'UPDATE platform_jobs SET payload = $2 WHERE id = $1',
          [durableJob.id, originalDurablePayload.rows[0]?.payload]
        );
        await sourceMutationDatabase.close();
      }
      assert.equal(fs.existsSync(corruptArchivePath), false);

      const preflight = await restoreTeamBackupArchive({
        archivePath,
        signingPublicKeyPath: keys.signingPublicKeyPath,
        encryptionKeyPath: keys.encryptionKeyPath,
        targetEnv: targetEnvironment,
        apply: false,
        pgRestoreCommand: restoreWrapper,
      });
      assert.equal(preflight.applied, false);
      const preflightDatabase = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          ...targetEnvironment,
          POSTGRES_MIGRATION_MODE: 'validate',
        })
      );
      const preflightRelations = await preflightDatabase.query(
        `SELECT COUNT(*)::integer AS count
           FROM pg_class relation
           JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = current_schema()
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'S')`
      );
      assert.equal(preflightRelations.rows[0]?.count, 0);
      await preflightDatabase.query('CREATE SCHEMA restore_hidden_test');
      await preflightDatabase.query(
        'CREATE TABLE restore_hidden_test.sentinel (id integer PRIMARY KEY)'
      );
      try {
        await assert.rejects(
          restoreTeamBackupArchive({
            archivePath,
            signingPublicKeyPath: keys.signingPublicKeyPath,
            encryptionKeyPath: keys.encryptionKeyPath,
            targetEnv: targetEnvironment,
            apply: false,
            pgRestoreCommand: restoreWrapper,
          }),
          /clean PostgreSQL database with only bootstrap schemas/
        );
      } finally {
        await preflightDatabase.query(
          'DROP SCHEMA restore_hidden_test CASCADE'
        );
      }
      await preflightDatabase.query(
        'CREATE TABLE information_schema.libre_restore_sentinel (id integer PRIMARY KEY)'
      );
      try {
        await assert.rejects(
          restoreTeamBackupArchive({
            archivePath,
            signingPublicKeyPath: keys.signingPublicKeyPath,
            encryptionKeyPath: keys.encryptionKeyPath,
            targetEnv: targetEnvironment,
            apply: false,
            pgRestoreCommand: restoreWrapper,
          }),
          /clean PostgreSQL database/
        );
      } finally {
        await preflightDatabase.query(
          'DROP TABLE information_schema.libre_restore_sentinel'
        );
      }
      await preflightDatabase.close();
      const preflightVersions = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: 'libre-target-test',
          Prefix: 'libre-team-test/',
        })
      );
      assert.equal(preflightVersions.Versions?.length ?? 0, 0);
      assert.equal(preflightVersions.DeleteMarkers?.length ?? 0, 0);
      await assert.rejects(
        restoreTeamBackupArchive({
          archivePath,
          signingPublicKeyPath: keys.signingPublicKeyPath,
          encryptionKeyPath: keys.encryptionKeyPath,
          targetEnv: targetEnvironment,
          apply: true,
          pgRestoreCommand: restoreWrapper,
        }),
        /configuration output directory/
      );

      // A verification failure after the second immutable PUT must roll back
      // both completed versions. The same clean target must then be usable by
      // an ordinary retry; otherwise one transient S3 failure permanently
      // poisons the restore destination.
      const originalS3Send = S3Client.prototype.send;
      let targetHeadCount = 0;
      S3Client.prototype.send = function (command, ...args) {
        if (
          command instanceof HeadObjectCommand &&
          command.input.Bucket === 'libre-target-test' &&
          ++targetHeadCount === 2
        ) {
          return Promise.reject(
            new Error('injected second restored-object HEAD failure')
          );
        }
        return originalS3Send.call(this, command, ...args);
      };
      try {
        await assert.rejects(
          restoreTeamBackupArchive({
            archivePath,
            signingPublicKeyPath: keys.signingPublicKeyPath,
            encryptionKeyPath: keys.encryptionKeyPath,
            targetEnv: targetEnvironment,
            apply: true,
            configurationOutputDirectory: path.join(
              root,
              'failed-restored-configuration'
            ),
            pgRestoreCommand: restoreWrapper,
            toolTimeoutMs: 120_000,
          }),
          /injected second restored-object HEAD failure/
        );
      } finally {
        S3Client.prototype.send = originalS3Send;
      }
      assert.equal(targetHeadCount, 2);
      const rolledBackVersions = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: 'libre-target-test',
          Prefix: 'libre-team-test/',
        })
      );
      assert.equal(rolledBackVersions.Versions?.length ?? 0, 0);
      assert.equal(rolledBackVersions.DeleteMarkers?.length ?? 0, 0);

      // Rollback is a recovery boundary of its own. If exact-version S3
      // deletion and PostgreSQL cleanup both fail, the restore must surface a
      // deterministic dirty-target error instead of preserving only the
      // publication failure. Its retry guidance must agree with the actual
      // clean-target preflight behavior.
      const dirtyConfiguration = path.join(
        root,
        'rollback-failure-configuration'
      );
      fs.mkdirSync(dirtyConfiguration, { mode: 0o700 });
      const originalDatabaseTransaction =
        PostgresDatabase.prototype.transaction;
      let rollbackPhaseReached = false;
      let s3RollbackFailureInjected = false;
      let databaseRollbackFailureInjected = false;
      let rollbackFailure;
      S3Client.prototype.send = function (command, ...args) {
        if (
          command instanceof DeleteObjectCommand &&
          command.input.Bucket === 'libre-target-test' &&
          command.input.VersionId &&
          !s3RollbackFailureInjected
        ) {
          s3RollbackFailureInjected = true;
          rollbackPhaseReached = true;
          return Promise.reject(
            new Error('injected exact-version rollback delete failure')
          );
        }
        return originalS3Send.call(this, command, ...args);
      };
      PostgresDatabase.prototype.transaction = function (...args) {
        if (rollbackPhaseReached && !databaseRollbackFailureInjected) {
          databaseRollbackFailureInjected = true;
          return Promise.reject(
            new Error('injected PostgreSQL restore rollback failure')
          );
        }
        return originalDatabaseTransaction.call(this, ...args);
      };
      try {
        await assert.rejects(
          restoreTeamBackupArchive({
            archivePath,
            signingPublicKeyPath: keys.signingPublicKeyPath,
            encryptionKeyPath: keys.encryptionKeyPath,
            targetEnv: targetEnvironment,
            apply: true,
            configurationOutputDirectory: dirtyConfiguration,
            pgRestoreCommand: restoreWrapper,
            toolTimeoutMs: 120_000,
          }),
          error => {
            rollbackFailure = error;
            return true;
          }
        );
      } finally {
        S3Client.prototype.send = originalS3Send;
        PostgresDatabase.prototype.transaction = originalDatabaseTransaction;
      }
      assert.equal(s3RollbackFailureInjected, true);
      assert.equal(databaseRollbackFailureInjected, true);
      assert.ok(rollbackFailure instanceof TeamRestoreRollbackError);
      assert.equal(rollbackFailure.rollbackFailureCount, 2);
      assert.match(rollbackFailure.message, /rollback was incomplete/);
      assert.match(rollbackFailure.message, /target may contain restored/i);
      assert.match(
        rollbackFailure.message,
        /Do not retry until both targets have been inspected and cleaned/
      );
      assert.equal(
        rollbackFailure.cause?.message,
        'Restored configuration target must not already exist.'
      );
      assert.equal(rollbackFailure.errors.length, 3);
      assert.match(
        rollbackFailure.errors[1].message,
        /S3 rollback failed.*injected exact-version rollback delete failure/
      );
      assert.match(
        rollbackFailure.errors[2].message,
        /PostgreSQL restore rollback failed.*injected PostgreSQL restore rollback failure/
      );

      const dirtyVersions = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: 'libre-target-test',
          Prefix: 'libre-team-test/',
        })
      );
      assert.equal(dirtyVersions.Versions?.length ?? 0, 1);
      assert.equal(dirtyVersions.DeleteMarkers?.length ?? 0, 0);
      const dirtyDatabase = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          ...targetEnvironment,
          POSTGRES_MIGRATION_MODE: 'validate',
        })
      );
      try {
        const dirtyUsers = await dirtyDatabase.query(
          'SELECT username FROM users WHERE id = $1',
          [ownerUserId]
        );
        assert.equal(dirtyUsers.rows[0]?.username, 'team-owner');
        await assert.rejects(
          restoreTeamBackupArchive({
            archivePath,
            signingPublicKeyPath: keys.signingPublicKeyPath,
            encryptionKeyPath: keys.encryptionKeyPath,
            targetEnv: targetEnvironment,
            apply: false,
            pgRestoreCommand: restoreWrapper,
          }),
          /clean PostgreSQL database/
        );
        await dirtyDatabase.transaction(async client => {
          await client.query('DROP SCHEMA IF EXISTS public CASCADE');
          await client.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
        });
      } finally {
        await dirtyDatabase.close();
      }
      await assert.rejects(
        restoreTeamBackupArchive({
          archivePath,
          signingPublicKeyPath: keys.signingPublicKeyPath,
          encryptionKeyPath: keys.encryptionKeyPath,
          targetEnv: targetEnvironment,
          apply: false,
          pgRestoreCommand: restoreWrapper,
        }),
        /empty versioned S3 prefix/
      );
      for (const item of [
        ...(dirtyVersions.Versions ?? []),
        ...(dirtyVersions.DeleteMarkers ?? []),
      ]) {
        assert.ok(item.Key && item.VersionId);
        await s3Client.send(
          new DeleteObjectCommand({
            Bucket: 'libre-target-test',
            Key: item.Key,
            VersionId: item.VersionId,
          })
        );
      }
      const cleanedVersions = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: 'libre-target-test',
          Prefix: 'libre-team-test/',
        })
      );
      assert.equal(cleanedVersions.Versions?.length ?? 0, 0);
      assert.equal(cleanedVersions.DeleteMarkers?.length ?? 0, 0);

      // A non-zero tool result does not prove that pg_restore left the target
      // untouched. This wrapper lets the real --single-transaction restore
      // commit, then exits non-zero before the parent observes success. The
      // unknown outcome must still compensate both PostgreSQL and every exact
      // S3 version so an immediate ordinary retry is safe.
      await assert.rejects(
        restoreTeamBackupArchive({
          archivePath,
          signingPublicKeyPath: keys.signingPublicKeyPath,
          encryptionKeyPath: keys.encryptionKeyPath,
          targetEnv: targetEnvironment,
          apply: true,
          configurationOutputDirectory: path.join(
            root,
            'unknown-outcome-configuration'
          ),
          pgRestoreCommand: commitThenFailRestoreWrapper,
          toolTimeoutMs: 120_000,
        }),
        /PostgreSQL recovery tool failed \(exit 41\)/
      );
      const unknownOutcomeDatabase = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          ...targetEnvironment,
          POSTGRES_MIGRATION_MODE: 'validate',
        })
      );
      try {
        const relation = await unknownOutcomeDatabase.query(
          `SELECT to_regclass('public.users')::text AS relation`
        );
        assert.equal(relation.rows[0]?.relation, null);
      } finally {
        await unknownOutcomeDatabase.close();
      }
      const unknownOutcomeVersions = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: 'libre-target-test',
          Prefix: 'libre-team-test/',
        })
      );
      assert.equal(unknownOutcomeVersions.Versions?.length ?? 0, 0);
      assert.equal(unknownOutcomeVersions.DeleteMarkers?.length ?? 0, 0);
      const retryPreflight = await restoreTeamBackupArchive({
        archivePath,
        signingPublicKeyPath: keys.signingPublicKeyPath,
        encryptionKeyPath: keys.encryptionKeyPath,
        targetEnv: targetEnvironment,
        apply: false,
        pgRestoreCommand: restoreWrapper,
      });
      assert.equal(retryPreflight.applied, false);

      // Restore verification must rerun the authenticated durable checks on
      // the actual target, not trust only the signed source inventory.
      await assert.rejects(
        restoreTeamBackupArchive({
          archivePath,
          signingPublicKeyPath: keys.signingPublicKeyPath,
          encryptionKeyPath: keys.encryptionKeyPath,
          targetEnv: targetEnvironment,
          apply: true,
          configurationOutputDirectory: path.join(
            root,
            'broken-head-configuration'
          ),
          pgRestoreCommand: restoreThenBreakHeadWrapper,
          toolTimeoutMs: 120_000,
        }),
        /Durable event stream heads are not contiguous/
      );
      const brokenHeadDatabase = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          ...targetEnvironment,
          POSTGRES_MIGRATION_MODE: 'validate',
        })
      );
      try {
        const relation = await brokenHeadDatabase.query(
          `SELECT to_regclass('public.platform_events')::text AS relation`
        );
        assert.equal(relation.rows[0]?.relation, null);
      } finally {
        await brokenHeadDatabase.close();
      }
      const brokenHeadVersions = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: 'libre-target-test',
          Prefix: 'libre-team-test/',
        })
      );
      assert.equal(brokenHeadVersions.Versions?.length ?? 0, 0);
      assert.equal(brokenHeadVersions.DeleteMarkers?.length ?? 0, 0);

      const applied = await restoreTeamBackupArchive({
        archivePath,
        signingPublicKeyPath: keys.signingPublicKeyPath,
        encryptionKeyPath: keys.encryptionKeyPath,
        targetEnv: targetEnvironment,
        apply: true,
        configurationOutputDirectory: path.join(root, 'restored-configuration'),
        pgRestoreCommand: restoreWrapper,
        toolTimeoutMs: 120_000,
      });
      assert.equal(applied.applied, true);
      const restoredSecretsPath = path.join(
        root,
        'restored-configuration',
        'secrets.json'
      );
      assert.equal(fs.statSync(restoredSecretsPath).mode & 0o777, 0o600);
      const restoredSecrets = JSON.parse(
        fs.readFileSync(restoredSecretsPath, 'utf8')
      );
      assert.equal(restoredSecrets.ENCRYPTION_KEY, encryptionKey);
      assert.equal(restoredSecrets.DATABASE_URL, targetUrl);
      assert.equal(restoredSecrets.S3_BUCKET, 'libre-target-test');
      const restoredRuntimePath = path.join(
        root,
        'restored-configuration',
        'runtime.json'
      );
      assert.equal(fs.statSync(restoredRuntimePath).mode & 0o777, 0o600);
      const restoredRuntime = JSON.parse(
        fs.readFileSync(restoredRuntimePath, 'utf8')
      );
      for (const name of [
        'POSTGRES_POOL_MAX',
        'POSTGRES_CONNECT_TIMEOUT_MS',
        'POSTGRES_IDLE_TIMEOUT_MS',
        'POSTGRES_STATEMENT_TIMEOUT_MS',
        'POSTGRES_MIGRATION_LOCK_TIMEOUT_MS',
        'REDIS_CONNECT_TIMEOUT_MS',
        'BLOB_QUOTA_BYTES_PER_USER',
        'BLOB_QUOTA_RESERVATION_TTL_MS',
      ]) {
        assert.equal(restoredRuntime[name], sourceEnvironment[name]);
      }

      restoredDatabase = createPostgresDatabase(
        resolvePostgresRuntimeConfig({
          ...targetEnvironment,
          POSTGRES_MIGRATION_MODE: 'validate',
        })
      );
      const restoredUser = await restoredDatabase.query(
        'SELECT username FROM users WHERE id = $1',
        [ownerUserId]
      );
      assert.equal(restoredUser.rows[0]?.username, 'team-owner');
      const restoredDurableService = new PostgresDurableJobService(
        new PostgresDurableJobRepository(restoredDatabase),
        createStorageKeyringFromEnvironment(targetEnvironment)
      );
      const restoredEvents = await restoredDurableService.replayEvents(0, {
        streamId: `job:${durableJob.id}`,
      });
      assert.equal(restoredEvents.length, 2);
      const restoredCustomEvent = restoredEvents.find(
        event => event.eventId === durableEventId
      );
      assert.equal(restoredCustomEvent?.cursor, durableEventCursor);
      assert.deepEqual(restoredCustomEvent?.payload, durableEventPayload);
      const restoredLease = await restoredDurableService.claim(
        'team-backup-restore-verifier',
        10_000
      );
      assert.equal(restoredLease?.id, durableJob.id);
      assert.deepEqual(
        await restoredDurableService.readPayload(restoredLease),
        durableJobPayload
      );
      const restoredBlobStore = createS3EncryptedBlobStore({
        database: restoredDatabase,
        keyring: createStorageKeyringFromEnvironment(targetEnvironment),
        env: targetEnvironment,
      });
      const opened = await restoredBlobStore.open({
        id: descriptor.id,
        ownerUserId,
      });
      assert.deepEqual(await collect(opened.body), plaintext);
      const secondOpened = await restoredBlobStore.open({
        id: secondDescriptor.id,
        ownerUserId,
      });
      assert.deepEqual(await collect(secondOpened.body), secondPlaintext);
      const hits = await new PgVectorStore({
        database: restoredDatabase,
      }).query({
        actor: { userId: ownerUserId },
        namespace: 'document-chunks',
        model: 'team-test-model',
        dimensions: 3,
        version: '1',
        embedding: [1, 0, 0],
        limit: 5,
      });
      assert.deepEqual(
        hits.map(hit => hit.id),
        ['team-vector-1']
      );
    } finally {
      if (sourcePersistence)
        await sourcePersistence.close().catch(() => undefined);
      if (restoredDatabase)
        await restoredDatabase.close().catch(() => undefined);
      if (sourceS3) sourceS3.destroy();
      if (targetS3 && targetS3 !== sourceS3) targetS3.destroy();
      stopContainer(minioContainer);
      stopContainer(postgresContainer);
      if (previousTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpDir;
      if (previousEncryptionKey === undefined)
        delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = previousEncryptionKey;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
