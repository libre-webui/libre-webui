/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'node:crypto';
import {
  getPostgresAdapterDatabase,
  getSQLiteAdapterDatabase,
  type Persistence,
} from '../../persistence/index.js';
import { createStorageKeyringFromEnvironment } from '../storage/index.js';
import { DurableJobService } from './durableJobService.js';
import {
  EmbeddedDurableJobWorker,
  type DurableJobHandler,
} from './embeddedDurableJobWorker.js';
import { SQLiteDurableJobRepository } from './sqliteDurableJobRepository.js';
import { PostgresDurableJobRepository } from './postgresDurableJobRepository.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';
import { PostgresDurableJobWorker } from './postgresDurableJobWorker.js';
import { OWNER_DELETE_CONTENT_JOB_TYPE } from './domainJobContracts.js';

export type DurableWorkerRole = 'embedded' | 'external';
export type DurableJobRuntimeService =
  DurableJobService | PostgresDurableJobService;
export type DurableJobRuntimeWorker =
  EmbeddedDurableJobWorker | PostgresDurableJobWorker;

export interface DurableJobBackendOptions {
  role: DurableWorkerRole;
  handlers: ReadonlyMap<string, DurableJobHandler>;
  env?: NodeJS.ProcessEnv;
  isActorAuthorized?: (
    actorUserId: string,
    jobType: string
  ) => Promise<boolean>;
  workerId?: string;
  maxConcurrentJobs?: number;
  onCancellationRequested?: (jobId: string) => void;
}

export interface DurableJobRuntimeBackend {
  service: DurableJobRuntimeService;
  worker: DurableJobRuntimeWorker;
}

type DurableJobActorAuthority = NonNullable<
  DurableJobBackendOptions['isActorAuthorized']
>;

const repositoryActorAuthority =
  (persistence: Persistence): DurableJobActorAuthority =>
  async (actorUserId, jobType) => {
    const accountStatus =
      await persistence.repositories.identity.findAccountStatusById(
        actorUserId
      );
    return (
      accountStatus === 'active' ||
      (accountStatus === 'retiring' &&
        jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
    );
  };

/**
 * Adapter composition boundary for the durable-job runtime. Native driver
 * handles are confined here and in the dialect repositories; the common
 * runtime and domain publishers depend only on repository contracts.
 */
export const createDurableJobRuntimeBackend = (
  persistence: Persistence,
  options: DurableJobBackendOptions
): DurableJobRuntimeBackend => {
  const keyring = createStorageKeyringFromEnvironment(
    options.env ?? process.env
  );
  const workerId =
    options.workerId ?? `${options.role}-${process.pid}-${randomUUID()}`;
  const isActorAuthorized: DurableJobActorAuthority =
    options.isActorAuthorized ?? repositoryActorAuthority(persistence);

  if (persistence.dialect === 'postgres') {
    const service = new PostgresDurableJobService(
      new PostgresDurableJobRepository(getPostgresAdapterDatabase()),
      keyring,
      undefined,
      options.onCancellationRequested
    );
    return {
      service,
      worker: new PostgresDurableJobWorker({
        service,
        handlers: options.handlers,
        workerId,
        reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
        isActorAuthorized,
        ...(options.maxConcurrentJobs !== undefined
          ? { maxConcurrentJobs: options.maxConcurrentJobs }
          : {}),
      }),
    };
  }

  const service = new DurableJobService(
    new SQLiteDurableJobRepository(getSQLiteAdapterDatabase()),
    keyring,
    undefined,
    options.onCancellationRequested
  );
  return {
    service,
    worker: new EmbeddedDurableJobWorker({
      service,
      handlers: options.handlers,
      workerId,
      reconcileBeforePolling: () => service.reconcileDeletionLifecycleJobs(),
      isActorAuthorized,
      ...(options.maxConcurrentJobs !== undefined
        ? { maxConcurrentJobs: options.maxConcurrentJobs }
        : {}),
    }),
  };
};
