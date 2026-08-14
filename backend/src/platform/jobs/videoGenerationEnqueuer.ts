/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { getSQLiteAdapterDatabase } from '../../persistence/index.js';
import type {
  TransactionalVideoJobInput,
  TransactionalVideoResumeEnqueuer,
  TransactionalVideoSubmissionEnqueuer,
} from '../storage/platformDomainRepositories.js';
import {
  VIDEO_RESUME_IDEMPOTENCY_SCOPE,
  VIDEO_RESUME_JOB_TYPE,
  VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
  VIDEO_SUBMIT_JOB_TYPE,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';

const durableInput = (
  input: TransactionalVideoJobInput,
  phase: 'submit' | 'resume'
) => ({
  jobType: phase === 'submit' ? VIDEO_SUBMIT_JOB_TYPE : VIDEO_RESUME_JOB_TYPE,
  actorUserId: input.ownerUserId,
  idempotencyScope:
    phase === 'submit'
      ? VIDEO_SUBMIT_IDEMPOTENCY_SCOPE
      : VIDEO_RESUME_IDEMPOTENCY_SCOPE,
  idempotencyKey: input.mediaJobId,
  payload: {
    mode: 'encrypted' as const,
    value: { legacyJobId: input.mediaJobId },
  },
  maxAttempts: phase === 'submit' ? 5 : 10,
});

const sqliteEnqueue = (
  database: Parameters<
    TransactionalVideoSubmissionEnqueuer['enqueueSQLite']
  >[0],
  input: TransactionalVideoJobInput,
  phase: 'submit' | 'resume'
): void => {
  if (database !== getSQLiteAdapterDatabase() || !database.inTransaction) {
    throw new Error(
      `SQLite video ${phase} enqueue requires the selected owning transaction.`
    );
  }
  const service = getDurableJobRuntime().service;
  if (service instanceof PostgresDurableJobService) {
    throw new Error('Selected durable job service is not SQLite.');
  }
  service.enqueue(durableInput(input, phase));
};

const postgresEnqueue = async (
  executor: Parameters<
    TransactionalVideoSubmissionEnqueuer['enqueuePostgres']
  >[0],
  input: TransactionalVideoJobInput,
  phase: 'submit' | 'resume'
): Promise<void> => {
  const service = getDurableJobRuntime().service;
  if (!(service instanceof PostgresDurableJobService)) {
    throw new Error('Selected durable job service is not PostgreSQL.');
  }
  await service.enqueueWithExecutor(executor, durableInput(input, phase));
};

export const transactionalVideoSubmissionEnqueuer: TransactionalVideoSubmissionEnqueuer =
  {
    enqueueSQLite: (database, input) =>
      sqliteEnqueue(database, input, 'submit'),
    enqueuePostgres: (executor, input) =>
      postgresEnqueue(executor, input, 'submit'),
  };

export const transactionalVideoResumeEnqueuer: TransactionalVideoResumeEnqueuer =
  {
    enqueueSQLite: (database, input) =>
      sqliteEnqueue(database, input, 'resume'),
    enqueuePostgres: (executor, input) =>
      postgresEnqueue(executor, input, 'resume'),
  };
