/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';

export interface TransactionalWorkExecutionInput {
  actorUserId: string;
  taskId: string;
  runId: string;
}

/** Inserts the durable execution record on the owning domain transaction. */
export interface TransactionalWorkExecutionEnqueuer {
  enqueueSQLite(
    database: Database.Database,
    input: TransactionalWorkExecutionInput
  ): void;
  enqueuePostgres(
    executor: PostgresQueryExecutor,
    input: TransactionalWorkExecutionInput
  ): Promise<void>;
}
