/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { getSQLiteAdapterDatabase } from '../../persistence/index.js';
import type {
  TransactionalWorkExecutionEnqueuer,
  TransactionalWorkExecutionInput,
} from '../workPersistence/workExecutionTypes.js';
import {
  WORK_EXECUTE_IDEMPOTENCY_SCOPE,
  WORK_EXECUTE_JOB_TYPE,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';

const durableInput = (input: TransactionalWorkExecutionInput) => ({
  jobType: WORK_EXECUTE_JOB_TYPE,
  actorUserId: input.actorUserId,
  idempotencyScope: WORK_EXECUTE_IDEMPOTENCY_SCOPE,
  idempotencyKey: input.runId,
  payload: {
    mode: 'encrypted' as const,
    value: { taskId: input.taskId, runId: input.runId },
  },
  maxAttempts: 3,
});

export const transactionalWorkExecutionEnqueuer: TransactionalWorkExecutionEnqueuer =
  {
    enqueueSQLite(database, input) {
      if (database !== getSQLiteAdapterDatabase() || !database.inTransaction) {
        throw new Error(
          'SQLite Work execution enqueue requires the selected owning transaction.'
        );
      }
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
