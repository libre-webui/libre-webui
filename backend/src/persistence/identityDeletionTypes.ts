/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PostgresQueryExecutor } from './postgresDatabase.js';
import type { PersistenceSyncExecutor } from './types.js';

export interface IdentityDeletionInput {
  targetUserId: string;
  actorUserId: string;
}

/**
 * Transactional durable-cleanup seam used by identity repositories. The
 * target user may be deleted in the same transaction because the durable job
 * is authorized as the administrator who requested deletion.
 */
export interface IdentityDeletionEnqueuer {
  enqueueSQLite(
    executor: PersistenceSyncExecutor,
    input: IdentityDeletionInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: IdentityDeletionInput
  ): Promise<void>;
}
