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

/** Transactional durable-generation seam used by chat repositories. */
export interface ChatGenerationEnqueuer {
  enqueueSQLite(
    executor: PersistenceSyncExecutor,
    input: ChatGenerationEnqueueInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: ChatGenerationEnqueueInput
  ): Promise<void>;
}
