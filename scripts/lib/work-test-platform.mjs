/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Initialize the same selected SQLite/Work/job adapters used by production. */
export const initializeWorkTestPlatform = async repoRoot => {
  const dist = relativePath =>
    import(
      pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
    );
  const [persistence, encryption, work, jobs, coordination] = await Promise.all(
    [
      dist('persistence/index.js'),
      dist('services/encryptionService.js'),
      dist('platform/workPersistence/index.js'),
      dist('platform/jobs/durableJobRuntime.js'),
      dist('platform/coordination/service.js'),
    ]
  );
  let persistenceInitialized = false;
  let workInitialized = false;
  let jobsInitialized = false;
  let coordinatorInitialized = false;
  try {
    await persistence.initializePersistence({
      dialect: 'sqlite',
      emailCodec: encryption.encryptionService,
      env: process.env,
    });
    persistenceInitialized = true;
    work.initializeSelectedWorkPersistence('sqlite');
    workInitialized = true;
    await coordination.initializeCoordinator();
    coordinatorInitialized = true;
    jobs.initializeDurableJobRuntime({
      role: 'embedded',
      runWorker: false,
      handlers: new Map(),
      env: process.env,
    });
    jobsInitialized = true;
  } catch (error) {
    if (jobsInitialized) await jobs.closeDurableJobRuntime();
    if (coordinatorInitialized) await coordination.closeCoordinator();
    if (workInitialized) work.resetWorkPersistenceForTests();
    if (persistenceInitialized) await persistence.closePersistence();
    throw error;
  }

  return async () => {
    await jobs.closeDurableJobRuntime();
    await coordination.closeCoordinator();
    work.resetWorkPersistenceForTests();
    await persistence.closePersistence();
  };
};
