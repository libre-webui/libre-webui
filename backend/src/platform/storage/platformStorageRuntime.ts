/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import path from 'node:path';
import type { Persistence } from '../../persistence/types.js';
import {
  getPostgresAdapterDatabase,
  getSQLiteAdapterDatabase,
} from '../../persistence/index.js';
import { resolveDataDirectory } from '../../utils/dataDirectory.js';
import type { BlobStore } from './blobStore.js';
import {
  PostgresBlobReferenceRepository,
  SQLiteBlobReferenceRepository,
  type BlobReferenceRepository,
} from './blobReferenceRepository.js';
import {
  PostgresDurableBlobQuotaPolicy,
  SQLiteDurableBlobQuotaPolicy,
  resolveBlobQuotaOptions,
  type ReconciledBlobQuotaPolicy,
} from './durableBlobQuotaPolicy.js';
import { LocalEncryptedBlobStore } from './localEncryptedBlobStore.js';
import type {
  PlatformContentCipher,
  PlatformDomainRepositories,
} from './platformDomainRepositories.js';
import { createPostgresPlatformDomainRepositories } from './postgresPlatformDomainRepositories.js';
import { createSQLitePlatformDomainRepositories } from './sqlitePlatformDomainRepositories.js';
import { createBlobStore, createVectorStore } from './storageFactory.js';
import { S3EncryptedBlobStore } from './s3EncryptedBlobStore.js';
import type { VectorPrincipalResolver, VectorStore } from './vectorStore.js';

const BLOB_ORPHAN_GRACE_MS = 60 * 60_000;
const BLOB_RECONCILIATION_INTERVAL_MS = 5 * 60_000;
const BLOB_RECONCILIATION_BATCH_SIZE = 1_000;

export interface PlatformStorageHealth {
  ready: boolean;
  dialect: 'sqlite' | 'postgres';
  blobs: 'local' | 's3';
  vectors: 'embedded' | 'pgvector';
  message?: string;
}

export interface PlatformStorageRuntime {
  readonly dialect: 'sqlite' | 'postgres';
  readonly blobStore: BlobStore;
  readonly blobReferences: BlobReferenceRepository;
  readonly blobQuota: ReconciledBlobQuotaPolicy;
  readonly vectorStore: VectorStore;
  readonly domains: PlatformDomainRepositories;
  health(): Promise<PlatformStorageHealth>;
  close(): Promise<void>;
}

export interface PlatformStorageInitializationOptions {
  persistence: Persistence;
  cipher: PlatformContentCipher;
  env?: NodeJS.ProcessEnv;
  principalResolver?: VectorPrincipalResolver;
}

let configured: PlatformStorageRuntime | undefined;
let initializing: Promise<PlatformStorageRuntime> | undefined;

/** Explicit test/composition seam. Production uses initializePlatformStorageRuntime. */
export const configurePlatformStorageRuntime = (
  runtime: PlatformStorageRuntime | undefined
): void => {
  configured = runtime;
};

const selectedName = (
  env: NodeJS.ProcessEnv,
  name: 'BLOB_STORE_BACKEND' | 'VECTOR_STORE_BACKEND',
  fallback: string
): string => env[name]?.trim().toLowerCase() || fallback;

export const initializePlatformStorageRuntime = async (
  options: PlatformStorageInitializationOptions
): Promise<PlatformStorageRuntime> => {
  if (configured) {
    if (configured.dialect !== options.persistence.dialect) {
      throw new Error(
        'Platform storage is initialized for another database dialect'
      );
    }
    return configured;
  }
  if (initializing) return initializing;
  const env = options.env ?? process.env;
  initializing = (async () => {
    const quotaOptions = resolveBlobQuotaOptions(env);
    let runtime: PlatformStorageRuntime;
    if (options.persistence.dialect === 'sqlite') {
      if (selectedName(env, 'BLOB_STORE_BACKEND', 'local') !== 'local') {
        throw new Error(
          'SQLite platform storage requires the local blob backend'
        );
      }
      if (
        selectedName(env, 'VECTOR_STORE_BACKEND', 'embedded') !== 'embedded'
      ) {
        throw new Error(
          'SQLite platform storage requires the embedded vector backend'
        );
      }
      const database = getSQLiteAdapterDatabase();
      const quota = new SQLiteDurableBlobQuotaPolicy(database, quotaOptions);
      const blobStore = createBlobStore({
        rootDirectory: path.join(resolveDataDirectory(), 'blobs'),
        env,
        quotaPolicy: quota,
      });
      if (!(blobStore instanceof LocalEncryptedBlobStore)) {
        throw new Error('SQLite platform storage did not create local storage');
      }
      const blobReferences = new SQLiteBlobReferenceRepository(database);
      const vectorStore = createVectorStore({
        database,
        env,
        ...(options.principalResolver
          ? { principalResolver: options.principalResolver }
          : {}),
      });
      const domains = createSQLitePlatformDomainRepositories(
        database,
        options.cipher
      );
      let reconciliationCursor: string | undefined;
      let reconciliationFailure = false;
      let reconciliationInFlight: Promise<void> | undefined;
      let reconciliationTimer: NodeJS.Timeout | undefined;
      const reconcileBlobLifecycle = (): Promise<void> => {
        if (reconciliationInFlight) return reconciliationInFlight;
        const operation = blobStore
          .reconcileOrphans({
            olderThan: new Date(Date.now() - BLOB_ORPHAN_GRACE_MS),
            maxEntries: BLOB_RECONCILIATION_BATCH_SIZE,
            isReferenced: id => blobReferences.isReferenced(id),
            ...(reconciliationCursor
              ? { continuationToken: reconciliationCursor }
              : {}),
          })
          .then(result => {
            reconciliationCursor = result.complete
              ? undefined
              : result.continuationToken;
            reconciliationFailure = false;
          })
          .catch(error => {
            reconciliationFailure = true;
            throw error;
          })
          .finally(() => {
            if (reconciliationInFlight === operation) {
              reconciliationInFlight = undefined;
            }
          });
        reconciliationInFlight = operation;
        return operation;
      };
      await reconcileBlobLifecycle();
      reconciliationTimer = setInterval(() => {
        void reconcileBlobLifecycle().catch(() => undefined);
      }, BLOB_RECONCILIATION_INTERVAL_MS);
      reconciliationTimer.unref?.();
      runtime = {
        dialect: 'sqlite',
        blobStore,
        blobReferences,
        blobQuota: quota,
        vectorStore,
        domains,
        health: async () =>
          reconciliationFailure
            ? {
                ready: false,
                dialect: 'sqlite',
                blobs: 'local',
                vectors: 'embedded',
                message: 'Local blob lifecycle reconciliation failed',
              }
            : {
                ready: true,
                dialect: 'sqlite',
                blobs: 'local',
                vectors: 'embedded',
              },
        close: async () => {
          if (reconciliationTimer) clearInterval(reconciliationTimer);
          reconciliationTimer = undefined;
          await reconciliationInFlight?.catch(() => undefined);
        },
      };
    } else {
      if (selectedName(env, 'BLOB_STORE_BACKEND', 's3') !== 's3') {
        throw new Error(
          'PostgreSQL platform storage requires the S3 blob backend'
        );
      }
      if (
        selectedName(env, 'VECTOR_STORE_BACKEND', 'pgvector') !== 'pgvector'
      ) {
        throw new Error(
          'PostgreSQL platform storage requires the PGVector backend'
        );
      }
      const database = getPostgresAdapterDatabase();
      const quota = new PostgresDurableBlobQuotaPolicy(database, quotaOptions);
      const blobStore = createBlobStore({
        rootDirectory: path.join(resolveDataDirectory(), 'blobs'),
        env,
        postgresDatabase: database,
        quotaPolicy: quota,
      });
      if (!(blobStore instanceof S3EncryptedBlobStore)) {
        throw new Error(
          'PostgreSQL platform storage did not create S3 storage'
        );
      }
      let reconciliationCursor: string | undefined;
      let reconciliationFailure = false;
      let reconciliationInFlight: Promise<void> | undefined;
      let reconciliationTimer: NodeJS.Timeout | undefined;
      const reconcileBlobLifecycle = (): Promise<void> => {
        if (reconciliationInFlight) return reconciliationInFlight;
        const operation = blobStore
          .reconcileOrphans({
            olderThan: new Date(Date.now() - BLOB_ORPHAN_GRACE_MS),
            maxObjects: BLOB_RECONCILIATION_BATCH_SIZE,
            ...(reconciliationCursor
              ? { continuationToken: reconciliationCursor }
              : {}),
          })
          .then(result => {
            reconciliationCursor = result.complete
              ? undefined
              : result.continuationToken;
            reconciliationFailure = false;
          })
          .catch(error => {
            reconciliationFailure = true;
            throw error;
          })
          .finally(() => {
            if (reconciliationInFlight === operation) {
              reconciliationInFlight = undefined;
            }
          });
        reconciliationInFlight = operation;
        return operation;
      };
      // Resume interrupted deletes immediately. Orphan discovery uses a grace
      // period far beyond the bounded SQL commit timeout so a newly uploaded
      // object cannot be collected before its metadata transaction settles.
      try {
        await reconcileBlobLifecycle();
      } catch (error) {
        await blobStore.close().catch(() => undefined);
        throw error;
      }
      reconciliationTimer = setInterval(() => {
        void reconcileBlobLifecycle().catch(() => undefined);
      }, BLOB_RECONCILIATION_INTERVAL_MS);
      reconciliationTimer.unref?.();
      runtime = {
        dialect: 'postgres',
        blobStore,
        blobReferences: new PostgresBlobReferenceRepository(database),
        blobQuota: quota,
        vectorStore: createVectorStore({
          postgresDatabase: database,
          env,
          ...(options.principalResolver
            ? { principalResolver: options.principalResolver }
            : {}),
        }),
        domains: createPostgresPlatformDomainRepositories(
          database,
          options.cipher
        ),
        health: async () => {
          const databaseHealth = await database.health();
          if (!databaseHealth.ready) {
            return {
              ready: false,
              dialect: 'postgres',
              blobs: 's3',
              vectors: 'pgvector',
              message:
                databaseHealth.message || 'PostgreSQL storage is unavailable',
            };
          }
          const blobHealth =
            'health' in blobStore && typeof blobStore.health === 'function'
              ? await (
                  blobStore as BlobStore & { health(): Promise<boolean> }
                ).health()
              : true;
          if (reconciliationFailure) {
            return {
              ready: false,
              dialect: 'postgres',
              blobs: 's3',
              vectors: 'pgvector',
              message: 'S3 blob lifecycle reconciliation failed',
            };
          }
          return {
            ready: blobHealth,
            dialect: 'postgres',
            blobs: 's3',
            vectors: 'pgvector',
            ...(blobHealth
              ? {}
              : { message: 'S3 blob storage is unavailable' }),
          };
        },
        close: async () => {
          if (reconciliationTimer) clearInterval(reconciliationTimer);
          reconciliationTimer = undefined;
          await reconciliationInFlight?.catch(() => undefined);
          if ('close' in blobStore && typeof blobStore.close === 'function') {
            await (blobStore as BlobStore & { close(): Promise<void> }).close();
          }
        },
      };
    }
    try {
      await runtime.blobQuota.reconcileExpiredReservations();
      await runtime.blobQuota.reconcileMissingStoredObjects(async object => {
        try {
          await runtime.blobStore.stat(object.id, object.ownerUserId);
          return true;
        } catch (error) {
          if (
            error &&
            typeof error === 'object' &&
            'code' in error &&
            (error as { code?: unknown }).code === 'not-found'
          ) {
            return false;
          }
          throw error;
        }
      });
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
    configured = runtime;
    return runtime;
  })();
  try {
    return await initializing;
  } finally {
    initializing = undefined;
  }
};

export const getPlatformStorageRuntime = (): PlatformStorageRuntime => {
  if (!configured) {
    throw new Error(
      'Platform storage has not been initialized by the application bootstrap'
    );
  }
  return configured;
};

export const closePlatformStorageRuntime = async (): Promise<void> => {
  const runtime = configured;
  configured = undefined;
  initializing = undefined;
  await runtime?.close();
};
