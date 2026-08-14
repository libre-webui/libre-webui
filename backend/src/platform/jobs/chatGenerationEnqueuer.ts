/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { assertSelectedSQLiteTransaction } from '../../persistence/index.js';
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
import { durableEventId } from './durableEventIdentity.js';

const durableInput = (input: ChatGenerationEnqueueInput) => ({
  jobType: CHAT_GENERATE_JOB_TYPE,
  actorUserId: input.actorUserId,
  idempotencyScope: chatGenerationIdempotencyScope(input.sessionId),
  idempotencyKey: input.assistantMessageId,
  payload: { mode: 'encrypted' as const, value: input },
  // Permit exactly one reclaim after worker death without blocking later
  // prompts behind a long sequence of provider retries.
  maxAttempts: 2,
});

const cancellationIdentity = (input: ChatGenerationEnqueueInput) => ({
  eventId: durableEventId(
    'chat',
    input.sessionId,
    input.assistantMessageId,
    'cancel-requested',
    input.actorUserId
  ),
  streamId: `chat:${input.sessionId}`,
  subjectId: input.assistantMessageId,
  actorUserId: input.actorUserId,
});

export const transactionalChatGenerationEnqueuer: ChatGenerationEnqueuer = {
  enqueueSQLite(_executor, input) {
    assertSelectedSQLiteTransaction();
    const service = getDurableJobRuntime().service;
    if (service instanceof PostgresDurableJobService) {
      throw new Error('Selected durable job service is not SQLite.');
    }
    const cancellation = cancellationIdentity(input);
    const cancellationCommitted = service.getEvent(cancellation.eventId);
    const existing = service.getByIdempotency(
      input.actorUserId,
      chatGenerationIdempotencyScope(input.sessionId),
      input.assistantMessageId
    );
    const job = service.enqueue(durableInput(input));
    if (
      cancellationCommitted?.streamId === cancellation.streamId &&
      cancellationCommitted.eventType === 'chat.cancel-requested.v1' &&
      cancellationCommitted.subjectId === cancellation.subjectId &&
      cancellationCommitted.actorUserId === cancellation.actorUserId
    ) {
      service.cancel(job.id, input.actorUserId, 'user-requested');
    }
    return { created: existing === null };
  },

  async enqueuePostgres(executor, input) {
    const service = getDurableJobRuntime().service;
    if (!(service instanceof PostgresDurableJobService)) {
      throw new Error('Selected durable job service is not PostgreSQL.');
    }
    const enqueue = await service.enqueueChatGenerationWithExecutor(
      executor,
      durableInput(input),
      cancellationIdentity(input)
    );
    return { created: enqueue.created };
  },
};
