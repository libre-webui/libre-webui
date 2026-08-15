/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

// Validate every platform selector before importing the application graph.
// Several legacy services still initialize local state during module
// evaluation; an unavailable team adapter must fail without creating a local
// database, key, plugin directory, or other misleading fallback state.
import './env.js';
import {
  assertPlatformRuntimeConfig,
  resolvePlatformRuntimeConfig,
} from './platform/runtimeConfig.js';
import {
  getOllamaRuntimeConfig,
  normalizeOllamaRuntimeEnvironment,
} from './platform/ollamaRuntimeConfig.js';
import {
  inspectStorageKeyConfiguration,
  provisionLegacyEncryptionKey,
} from './platform/storage/storageFactory.js';
import {
  initializePersistence,
  preflightExistingSQLiteDatabase,
  preflightIdentityMatchesMarker,
  readPreflightVerificationMarker,
  readSQLitePreflightIdentity,
  writePreflightVerificationMarker,
} from './persistence/index.js';
import {
  LegacyCiphertextIntegrityError,
  verifyLegacyCiphertextIntegrity,
} from './services/legacyCiphertextIntegrity.js';
import { createLogger } from './utils/logger.js';
import {
  assertNoLegacyDataDirectoryConflict,
  assertPreflightDirectoryOutsideDataDirectory,
  ensurePrivateRuntimeDirectory,
  resolveDataDirectory,
  resolvePreflightDirectory,
} from './utils/dataDirectory.js';
import path from 'node:path';
import fs from 'node:fs';

// Provider limits are pure configuration. Reject malformed values before
// resolving data paths, provisioning keys, or opening persistence.
normalizeOllamaRuntimeEnvironment(getOllamaRuntimeConfig());
const platformConfig = assertPlatformRuntimeConfig(
  resolvePlatformRuntimeConfig()
);
// Preserve the raw relative-path provenance until compatibility checks have
// run. Source launches historically resolved relative paths from backend/;
// packaged launchers resolve caller-relative paths once and pass absolutes.
assertNoLegacyDataDirectoryConflict();
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, 'data.sqlite');
const preflightDirectory =
  platformConfig.database.backend === 'sqlite'
    ? resolvePreflightDirectory()
    : undefined;
if (preflightDirectory) {
  assertPreflightDirectoryOutsideDataDirectory(dataDir, preflightDirectory);
}

// Every stateful module consumes one absolute runtime selection. Do not let a
// downstream service reinterpret a relative DATA_DIR using its own cwd.
process.env.DATA_DIR = dataDir;
if (preflightDirectory) {
  process.env.PLATFORM_PREFLIGHT_TMP_DIR = preflightDirectory;
}
const initialStorageKeys = inspectStorageKeyConfiguration(process.env);
if (initialStorageKeys.status === 'invalid') {
  throw new Error('Invalid platform storage encryption configuration.');
}
if (
  platformConfig.mode === 'team' &&
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
const startupLogger = createLogger('startup');
let legacyEncryptionKey: Buffer | undefined;
try {
  if (
    platformConfig.database.backend === 'sqlite' &&
    fs.existsSync(databasePath)
  ) {
    // The deep preflight copies the whole database and authenticates every
    // encrypted row. Data verified once stays verified: later rows are
    // written by this code generation, so the scan only reruns when the
    // schema generation or the database file itself changes. The identity
    // probe opens the database and may create WAL bookkeeping, so it runs
    // only when a marker from an earlier successful start exists; a first
    // or rejected bootstrap keeps the source directory untouched.
    const marker = readPreflightVerificationMarker(dataDir);
    const verifiedBefore =
      marker !== null &&
      preflightIdentityMatchesMarker(
        readSQLitePreflightIdentity(databasePath),
        marker
      );
    const skipScanByEnv = process.env.LIBRE_SKIP_STARTUP_INTEGRITY_SCAN === '1';
    if (!verifiedBefore) {
      legacyEncryptionKey = Buffer.from(encryptionKeyHex, 'hex');
      try {
        preflightExistingSQLiteDatabase(
          databasePath,
          preflightDirectory,
          skipScanByEnv
            ? undefined
            : database =>
                verifyLegacyCiphertextIntegrity(
                  database,
                  legacyEncryptionKey,
                  {},
                  {
                    // Migration v4 commits its nullable lookup column before
                    // the identity repository can backfill it. Allow a
                    // missing token with either an authenticated envelope or
                    // a non-envelope legacy value through this
                    // crash-recovery window.
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
          startupLogger.warn(
            'Legacy ciphertext verification exceeded its scan limits; continuing without full verification.'
          );
        } else {
          throw error;
        }
      }
      if (skipScanByEnv) {
        startupLogger.warn(
          'LIBRE_SKIP_STARTUP_INTEGRITY_SCAN=1: skipping legacy ciphertext verification.'
        );
      }
    }
  }
} finally {
  legacyEncryptionKey?.fill(0);
}

// The identity codec is safe to load only after key selection. Initialize the
// selected database before importing routes and service singletons, which
// prevents PostgreSQL mode from ever constructing a local SQLite fallback.
const { encryptionService } = await import('./services/encryptionService.js');
await initializePersistence({
  dialect: platformConfig.database.backend,
  emailCodec: encryptionService,
  env: process.env,
});
if (platformConfig.database.backend === 'sqlite') {
  // Record the settled post-migration identity so the next start can skip
  // the copy and deep scan until the schema generation or file changes.
  const settledIdentity = readSQLitePreflightIdentity(databasePath);
  if (settledIdentity) {
    writePreflightVerificationMarker(dataDir, settledIdentity);
  }
}
if (platformConfig.mode === 'team') {
  const teamPreflightDirectory = resolvePreflightDirectory();
  assertPreflightDirectoryOutsideDataDirectory(dataDir, teamPreflightDirectory);
  // Team DATA_DIR and preflight paths hold only per-replica scratch state.
  // Create them after selectors, keys, and the shared schema are validated.
  ensurePrivateRuntimeDirectory(dataDir);
  ensurePrivateRuntimeDirectory(teamPreflightDirectory);
}
const { initializeSelectedWorkPersistence } =
  await import('./platform/workPersistence/index.js');
initializeSelectedWorkPersistence(platformConfig.database.backend);
process.env.LIBRE_PROCESS_ROLE =
  platformConfig.jobs.workerMode === 'external'
    ? 'app-external'
    : 'app-embedded';
await import('./index.js');
