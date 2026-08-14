/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { getSQLiteAdapterDatabase } from '../../persistence/index.js';
import type {
  ChatGenerationEnqueuer,
  ChatGenerationEnqueueInput,
} from '../../persistence/chatGenerationTypes.js';
import {
  CHAT_GENERATE_JOB_TYPE,
  chatGenerationIdempotencyScope,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import { PostgresDurableJobService } from './postgresDurableJobService.js';

const durableInput = (input: ChatGenerationEnqueueInput) => ({
  jobType: CHAT_GENERATE_JOB_TYPE,
  actorUserId: input.actorUserId,
  idempotencyScope: chatGenerationIdempotencyScope(input.sessionId),
  idempotencyKey: input.assistantMessageId,
  payload: { mode: 'encrypted' as const, value: input },
  maxAttempts: 5,
});

export const transactionalChatGenerationEnqueuer: ChatGenerationEnqueuer = {
  enqueueSQLite(_executor, input) {
    const database = getSQLiteAdapterDatabase();
    if (!database.inTransaction) {
      throw new Error(
        'SQLite chat generation enqueue requires the selected owning transaction.'
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
