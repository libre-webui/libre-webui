/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

const importBuiltModule = (distRoot, ...segments) =>
  import(pathToFileURL(path.join(distRoot, ...segments)).href);

/**
 * Explicitly compose the same SQLite platform-storage runtime used by the
 * application bootstrap. Route tests import built modules directly, so they
 * must not depend on an implicit production fallback.
 */
export async function initializeSQLitePlatformStorageFixture(distRoot) {
  const [{ encryptionService }, persistenceModule, storageModule] =
    await Promise.all([
      importBuiltModule(distRoot, 'services', 'encryptionService.js'),
      importBuiltModule(distRoot, 'persistence', 'index.js'),
      importBuiltModule(distRoot, 'platform', 'storage', 'index.js'),
    ]);
  const persistence = persistenceModule.getPersistence(encryptionService);
  await storageModule.initializePlatformStorageRuntime({
    persistence,
    cipher: encryptionService,
    env: {
      ...process.env,
      DATABASE_BACKEND: 'sqlite',
      BLOB_STORE_BACKEND: 'local',
      VECTOR_STORE_BACKEND: 'embedded',
    },
  });
  const [coordinationService, jobsModule] = await Promise.all([
    importBuiltModule(distRoot, 'platform', 'coordination', 'service.js'),
    importBuiltModule(distRoot, 'platform', 'jobs', 'index.js'),
  ]);
  await coordinationService.initializeCoordinator();
  jobsModule.initializeDurableJobRuntime({
    role: 'embedded',
    runWorker: false,
    handlers: new Map(),
  });

  return async () => {
    await jobsModule.closeDurableJobRuntime();
    await coordinationService.closeCoordinator();
    await storageModule.closePlatformStorageRuntime();
    await persistenceModule.closePersistence();
  };
}
