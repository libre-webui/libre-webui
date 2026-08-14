/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PostgresQueryExecutor } from './postgresDatabase.js';
import type { PersistenceSyncExecutor } from './types.js';

export interface ChatGenerationEnqueueInput {
  sessionId: string;
  actorUserId: string;
  userMessageId: string;
  assistantMessageId: string;
  message: string;
  hasImages: boolean;
  options: Record<string, unknown>;
  webSearch: boolean;
  regenerate: boolean;
  originalMessageId?: string;
}

export interface ChatGenerationEnqueueResult {
  /** False means an exact durable job already existed before this transaction. */
  created: boolean;
}

/** Transactional durable-generation seam used by chat repositories. */
export interface ChatGenerationEnqueuer {
  enqueueSQLite(
    executor: PersistenceSyncExecutor,
    input: ChatGenerationEnqueueInput
  ): ChatGenerationEnqueueResult;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: ChatGenerationEnqueueInput
  ): Promise<ChatGenerationEnqueueResult>;
}
