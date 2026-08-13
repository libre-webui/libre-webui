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
import { inspectStorageKeyConfiguration } from './platform/storage/index.js';
import { preflightExistingSQLiteDatabase } from './persistence/index.js';
import { verifyLegacyCiphertextIntegrity } from './services/legacyCiphertextIntegrity.js';
import {
  assertExistingStateHasLegacyEncryptionKey,
  assertNoLegacyDataDirectoryConflict,
  assertPreflightDirectoryOutsideDataDirectory,
  resolveDataDirectory,
  resolvePreflightDirectory,
} from './utils/dataDirectory.js';
import path from 'node:path';
import fs from 'node:fs';

assertPlatformRuntimeConfig(resolvePlatformRuntimeConfig());
assertNoLegacyDataDirectoryConflict();
const dataDir = resolveDataDirectory();
const storageKeys = inspectStorageKeyConfiguration({
  ...process.env,
  DATA_DIR: dataDir,
});
const databasePath = path.join(dataDir, 'data.sqlite');
const preflightDirectory = resolvePreflightDirectory();
assertPreflightDirectoryOutsideDataDirectory(dataDir, preflightDirectory);
assertExistingStateHasLegacyEncryptionKey(dataDir);
if (storageKeys.status === 'invalid') {
  throw new Error('Invalid platform storage encryption configuration.');
}
let legacyEncryptionKey: Buffer | undefined;
try {
  if (fs.existsSync(databasePath)) {
    const configuredKey = process.env.ENCRYPTION_KEY?.trim();
    const keyHex = configuredKey
      ? configuredKey
      : fs.readFileSync(path.join(dataDir, '.encryption_key'), 'utf8').trim();
    legacyEncryptionKey = Buffer.from(keyHex, 'hex');
  }
  preflightExistingSQLiteDatabase(databasePath, preflightDirectory, database =>
    verifyLegacyCiphertextIntegrity(
      database,
      legacyEncryptionKey,
      {},
      {
        // Migration v4 commits its nullable lookup column before the identity
        // repository can backfill it. Allow a missing token with either an
        // authenticated envelope or a non-envelope legacy value through this
        // crash-recovery window. Older releases accepted arbitrary strings and
        // blank values; repository initialization encrypts/preserves them or
        // normalizes blanks to NULL before serving requests.
        requireIdentityLookupToken: false,
      }
    )
  );
} finally {
  legacyEncryptionKey?.fill(0);
}
await import('./index.js');
