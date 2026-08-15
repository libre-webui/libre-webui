/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { assertSelectedSQLiteTransaction } from '../../persistence/index.js';
import type {
  TransactionalResourceDeletionEnqueuer,
  TransactionalResourceDeletionInput,
} from '../storage/platformDomainRepositories.js';
import {
  RESOURCE_DELETE_IDEMPOTENCY_SCOPE,
  RESOURCE_DELETE_JOB_TYPE,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';

const durableInput = (input: TransactionalResourceDeletionInput) => ({
  jobType: RESOURCE_DELETE_JOB_TYPE,
  actorUserId: input.ownerUserId,
  idempotencyScope: RESOURCE_DELETE_IDEMPOTENCY_SCOPE,
  idempotencyKey: input.deletionToken,
  payload: {
    mode: 'encrypted' as const,
    value: {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      deletionIncarnation: input.deletionIncarnation,
      deletionToken: input.deletionToken,
    },
  },
  maxAttempts: 5,
});

export const transactionalResourceDeletionEnqueuer: TransactionalResourceDeletionEnqueuer =
  {
    enqueueSQLite(_executor, input) {
      assertSelectedSQLiteTransaction();
      const service = getDurableJobRuntime().service;
      if (service instanceof PostgresDurableJobService) {
        throw new Error('Selected durable job service is not SQLite.');
      }
      service.enqueue(durableInput(input));
    },

    async enqueuePostgres(executor, input) {
      const service = getDurableJobRuntime().service;
      if (!(service instanceof PostgresDurableJobService)) {
        throw new Error('Selected durable job service is not PostgreSQL.');
      }
      await service.enqueueWithExecutor(executor, durableInput(input));
    },
  };
