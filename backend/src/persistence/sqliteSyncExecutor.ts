/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import type { PersistenceSyncExecutor } from './types.js';

/** Driver-neutral view of an already-owned synchronous SQLite transaction. */
export const createSQLiteSyncExecutor = (
  database: Database.Database
): PersistenceSyncExecutor => ({
  run(sql, parameters = []) {
    const result = database.prepare(sql).run(...parameters);
    return { changes: result.changes };
  },
  get<T>(sql: string, parameters: readonly unknown[] = []): T | undefined {
    return database.prepare(sql).get(...parameters) as T | undefined;
  },
  all<T>(sql: string, parameters: readonly unknown[] = []): T[] {
    return database.prepare(sql).all(...parameters) as T[];
  },
});
