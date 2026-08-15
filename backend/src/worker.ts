/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import './env.js';

import fs from 'node:fs';
import path from 'node:path';

import {
  closePersistence,
  getPersistence,
  initializePersistence,
  preflightExistingSQLiteDatabase,
} from './persistence/index.js';
import {
  assertPlatformRuntimeConfig,
  resolvePlatformRuntimeConfig,
} from './platform/runtimeConfig.js';
import {
  getOllamaRuntimeConfig,
  normalizeOllamaRuntimeEnvironment,
} from './platform/ollamaRuntimeConfig.js';
import {
  assertNoLegacyDataDirectoryConflict,
  assertPreflightDirectoryOutsideDataDirectory,
  ensurePrivateRuntimeDirectory,
  resolveDataDirectory,
  resolvePreflightDirectory,
} from './utils/dataDirectory.js';
import {
  inspectStorageKeyConfiguration,
  provisionLegacyEncryptionKey,
} from './platform/storage/storageFactory.js';
import {
  LegacyCiphertextIntegrityError,
  verifyLegacyCiphertextIntegrity,
} from './services/legacyCiphertextIntegrity.js';
import {
  preflightIdentityMatchesMarker,
  readPreflightVerificationMarker,
  readSQLitePreflightIdentity,
  writePreflightVerificationMarker,
} from './db.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('durable-worker');
normalizeOllamaRuntimeEnvironment(getOllamaRuntimeConfig());
const config = assertPlatformRuntimeConfig(resolvePlatformRuntimeConfig());
if (config.jobs.workerMode !== 'external') {
  throw new Error('The standalone worker requires JOB_WORKER_MODE=external.');
}
assertNoLegacyDataDirectoryConflict();
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, 'data.sqlite');
const preflightDirectory = resolvePreflightDirectory();
assertPreflightDirectoryOutsideDataDirectory(dataDir, preflightDirectory);
process.env.DATA_DIR = dataDir;
process.env.PLATFORM_PREFLIGHT_TMP_DIR = preflightDirectory;
const initialStorageKeys = inspectStorageKeyConfiguration(process.env);
if (initialStorageKeys.status === 'invalid') {
  throw new Error('Invalid platform storage encryption configuration.');
}
if (
  config.mode === 'team' &&
  !['versioned-keyring', 'legacy-encryption-key'].includes(
    initialStorageKeys.source
  )
) {
  throw new Error(
    'Team mode requires encryption keys supplied by the deployment secret; per-replica key files are not supported.'
  );
}
const encryptionKeyHex = provisionLegacyEncryptionKey(process.env);
process.env.ENCRYPTION_KEY = encryptionKeyHex;
const storageKeys = inspectStorageKeyConfiguration(process.env);
if (storageKeys.status !== 'configured') {
  throw new Error('Invalid platform storage encryption configuration.');
}
let legacyKey: Buffer | undefined;
try {
  if (config.database.backend === 'sqlite' && fs.existsSync(databasePath)) {
    // Same cached preflight as the application entrypoint: data verified once
    // stays verified until the schema generation or the file itself changes.
    const marker = readPreflightVerificationMarker(dataDir);
    const verifiedBefore =
      marker !== null &&
      preflightIdentityMatchesMarker(
        readSQLitePreflightIdentity(databasePath),
        marker
      );
    const skipScanByEnv = process.env.LIBRE_SKIP_STARTUP_INTEGRITY_SCAN === '1';
    if (!verifiedBefore) {
      legacyKey = Buffer.from(encryptionKeyHex, 'hex');
      try {
        preflightExistingSQLiteDatabase(
          databasePath,
          preflightDirectory,
          skipScanByEnv
            ? undefined
            : database =>
                verifyLegacyCiphertextIntegrity(
                  database,
                  legacyKey,
                  {},
                  {
                    requireIdentityLookupToken: false,
                  }
                )
        );
      } catch (error) {
        if (
          error instanceof LegacyCiphertextIntegrityError &&
          error.code === 'verification-limit'
        ) {
          // A database beyond the scan caps must still be able to start.
          logger.warn(
            'Legacy ciphertext verification exceeded its scan limits; continuing without full verification.'
          );
        } else {
          throw error;
        }
      }
      if (skipScanByEnv) {
        logger.warn(
          'LIBRE_SKIP_STARTUP_INTEGRITY_SCAN=1: skipping legacy ciphertext verification.'
        );
      }
    }
  }
} finally {
  legacyKey?.fill(0);
}

const { encryptionService } = await import('./services/encryptionService.js');
await initializePersistence({
  dialect: config.database.backend,
  emailCodec: encryptionService,
  env: process.env,
});
if (config.database.backend === 'sqlite') {
  // Record the settled post-migration identity so the next start can skip
  // the copy and deep scan until the schema generation or file changes.
  const settledIdentity = readSQLitePreflightIdentity(databasePath);
  if (settledIdentity) {
    writePreflightVerificationMarker(dataDir, settledIdentity);
  }
}
if (config.mode === 'team') {
  ensurePrivateRuntimeDirectory(dataDir);
  ensurePrivateRuntimeDirectory(preflightDirectory);
}
process.env.LIBRE_PROCESS_ROLE = 'external-worker';
const { initializeSelectedWorkPersistence } =
  await import('./platform/workPersistence/index.js');
initializeSelectedWorkPersistence(config.database.backend);
const { closePlatformStorageRuntime, initializePlatformStorageRuntime } =
  await import('./platform/storage/platformStorageRuntime.js');
await initializePlatformStorageRuntime({
  persistence: getPersistence(encryptionService),
  cipher: encryptionService,
  env: process.env,
});
const { closeCoordinator, initializeCoordinator } =
  await import('./platform/coordination/service.js');
const { closePluginCacheInvalidation } =
  await import('./services/pluginCacheInvalidation.js');
const {
  closeDurableJobRuntime,
  createDomainDurableJobHandlers,
  initializeDurableJobRuntime,
} = await import('./platform/jobs/index.js');
const coordinator = await initializeCoordinator();
const { default: workTaskService } =
  await import('./services/workTaskService.js');
const { default: workRuntimeService } =
  await import('./services/workRuntimeService.js');
let recoveryLease = await coordinator.acquireLease(
  'work-runtime-startup-recovery',
  120_000
);
const recoveryWaitDeadline = Date.now() + 120_000;
while (
  !recoveryLease &&
  (await coordinator.listPresence('durable-workers')).length === 0 &&
  Date.now() < recoveryWaitDeadline
) {
  await new Promise(resolve => setTimeout(resolve, 250));
  recoveryLease = await coordinator.acquireLease(
    'work-runtime-startup-recovery',
    120_000
  );
}
if (!recoveryLease) {
  if ((await coordinator.listPresence('durable-workers')).length === 0) {
    throw new Error('Timed out waiting for Work runtime recovery.');
  }
} else {
  const ownedRecoveryLease = recoveryLease;
  let recoveryLeaseLost = false;
  const assertRecoveryLease = async (): Promise<void> => {
    if (recoveryLeaseLost) {
      throw new Error('Lost the Work startup recovery lease.');
    }
    try {
      if (await ownedRecoveryLease.extend(120_000)) return;
    } catch {
      // Report expiry and coordination outages through one safe fence.
    }
    recoveryLeaseLost = true;
    throw new Error('Lost the Work startup recovery lease.');
  };
  const recoveryLeaseTimer = setInterval(() => {
    void ownedRecoveryLease
      .extend(120_000)
      .then(extended => {
        if (!extended) recoveryLeaseLost = true;
      })
      .catch(() => {
        recoveryLeaseLost = true;
      });
  }, 40_000);
  recoveryLeaseTimer.unref?.();
  try {
    // Never sweep a runtime owned by an already-ready worker. The first worker
    // after a full outage reconciles container state without globally rewriting
    // shared Work runs; durable job reclaim owns per-run recovery.
    if ((await coordinator.listPresence('durable-workers')).length === 0) {
      await assertRecoveryLease();
      const workCleanup = await workRuntimeService.beginRecovery(
        await workTaskService.listAllTaskRecords(),
        assertRecoveryLease
      );
      if (workCleanup.failed > 0) {
        throw new Error(
          `Work startup recovery could not stop ${workCleanup.failed} sandbox(es).`
        );
      }
    }
    if (recoveryLeaseLost) {
      throw new Error('Lost the Work startup recovery lease.');
    }
  } finally {
    clearInterval(recoveryLeaseTimer);
    await ownedRecoveryLease.release().catch(() => false);
  }
}
const runtime = initializeDurableJobRuntime({
  role: 'external',
  runWorker: true,
  maxConcurrentJobs: config.jobs.concurrency,
  retention: config.jobs.retention,
  handlers: createDomainDurableJobHandlers(),
});
const { closeDurableEventGateway, initializeDurableEventGateway } =
  await import('./platform/events/index.js');
const { default: workEventService } =
  await import('./services/workEventService.js');
workEventService.initializeDurableGateway(
  initializeDurableEventGateway(runtime.service, coordinator)
);
const workerId = runtime.status().workerId;
if (!workerId) throw new Error('Durable worker failed to start.');
const presenceScope = 'durable-workers';
const presenceTtlMs = 30_000;
const refreshPresence = async (): Promise<void> => {
  if (runtime.status().workerHealthy) {
    await coordinator.setPresence(presenceScope, workerId, presenceTtlMs);
  } else {
    await coordinator.clearPresence(presenceScope, workerId);
  }
};
const workerReadyDeadline = Date.now() + 10_000;
while (!runtime.status().workerHealthy && Date.now() < workerReadyDeadline) {
  await new Promise(resolve => setTimeout(resolve, 25));
}
if (!runtime.status().workerHealthy) {
  throw new Error('Durable worker could not establish its database poll loop.');
}
await refreshPresence();
const presenceTimer = setInterval(() => {
  void refreshPresence().catch(() => {
    // Redis is required in external mode. The worker continues to rely on SQL
    // leases, while application readiness fails until presence can refresh.
  });
}, 10_000);
presenceTimer.unref?.();
logger.info(`Durable worker ${workerId} is ready.`);

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received: stopping durable worker.`);
  clearInterval(presenceTimer);
  const result = await closeDurableJobRuntime();
  // Closing the durable runtime first aborts and drains this worker's active
  // handlers. Stop only this process's sweep/control client; never enumerate
  // and stop containers that another worker may own.
  workRuntimeService.beginShutdown();
  await closeDurableEventGateway();
  await coordinator
    .clearPresence(presenceScope, workerId)
    .catch(() => undefined);
  await closePluginCacheInvalidation();
  await closeCoordinator();
  await closePlatformStorageRuntime();
  await closePersistence();
  if (result.failed > 0) process.exitCode = 1;
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
