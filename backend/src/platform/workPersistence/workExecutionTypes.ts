/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';
import type { PersistenceSyncExecutor } from '../../persistence/types.js';

export interface TransactionalWorkExecutionInput {
  actorUserId: string;
  taskId: string;
  runId: string;
}

/** Inserts the durable execution record on the owning domain transaction. */
export interface TransactionalWorkExecutionEnqueuer {
  enqueueSQLite(
    executor: PersistenceSyncExecutor,
    input: TransactionalWorkExecutionInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: TransactionalWorkExecutionInput
  ): Promise<void>;
}
