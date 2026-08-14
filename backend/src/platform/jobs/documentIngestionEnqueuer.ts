/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { assertSelectedSQLiteTransaction } from '../../persistence/index.js';
import type {
  TransactionalDocumentIngestionEnqueuer,
  TransactionalDocumentIngestionInput,
} from '../storage/platformDomainRepositories.js';
import {
  DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
  DOCUMENT_INGEST_JOB_TYPE,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';

const durableInput = (input: TransactionalDocumentIngestionInput) => ({
  jobType: DOCUMENT_INGEST_JOB_TYPE,
  actorUserId: input.ownerUserId,
  idempotencyScope: DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
  idempotencyKey: input.documentId,
  payload: {
    mode: 'encrypted' as const,
    value: { documentId: input.documentId },
  },
  maxAttempts: 5,
});

export const transactionalDocumentIngestionEnqueuer: TransactionalDocumentIngestionEnqueuer =
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
