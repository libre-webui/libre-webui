/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { getSQLiteAdapterDatabase } from '../../persistence/index.js';
import type {
  IdentityDeletionEnqueuer,
  IdentityDeletionInput,
} from '../../persistence/identityDeletionTypes.js';
import {
  OWNER_DELETE_CONTENT_IDEMPOTENCY_SCOPE,
  OWNER_DELETE_CONTENT_JOB_TYPE,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';

const durableInput = (input: IdentityDeletionInput) => ({
  jobType: OWNER_DELETE_CONTENT_JOB_TYPE,
  actorUserId: input.actorUserId,
  idempotencyScope: OWNER_DELETE_CONTENT_IDEMPOTENCY_SCOPE,
  idempotencyKey: input.targetUserId,
  payload: { mode: 'encrypted' as const, value: input },
  maxAttempts: 10,
  priority: 100,
});

export const transactionalIdentityDeletionEnqueuer: IdentityDeletionEnqueuer = {
  enqueueSQLite(_executor, input) {
    const database = getSQLiteAdapterDatabase();
    if (!database.inTransaction) {
      throw new Error(
        'SQLite identity deletion enqueue requires the selected owning transaction.'
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
