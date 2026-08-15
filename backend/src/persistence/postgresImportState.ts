/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PostgresQueryExecutor } from './postgresDatabase.js';

export const SQLITE_IMPORT_TABLE = 'libre_sqlite_imports';
export const SQLITE_IMPORT_TABLE_STATE = 'libre_sqlite_import_tables';
export const SQLITE_STORAGE_IMPORT_TABLE = 'libre_sqlite_storage_import_items';

/** Optional, application-owned journal retained after a SQLite team import. */
export const POSTGRES_SQLITE_IMPORT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${SQLITE_IMPORT_TABLE} (
  source_fingerprint char(64) PRIMARY KEY
    CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
  source_schema_version integer NOT NULL CHECK (source_schema_version > 0),
  status text NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  table_count integer NOT NULL CHECK (table_count > 0),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  completed_at bigint
);

CREATE TABLE IF NOT EXISTS ${SQLITE_IMPORT_TABLE_STATE} (
  source_fingerprint char(64) NOT NULL
    REFERENCES ${SQLITE_IMPORT_TABLE}(source_fingerprint) ON DELETE CASCADE,
  source_table text NOT NULL,
  target_table text NOT NULL,
  row_count bigint NOT NULL CHECK (row_count >= 0),
  checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status = 'complete'),
  updated_at bigint NOT NULL,
  PRIMARY KEY (source_fingerprint, source_table)
);

CREATE TABLE IF NOT EXISTS ${SQLITE_STORAGE_IMPORT_TABLE} (
  source_fingerprint char(64) NOT NULL
    REFERENCES ${SQLITE_IMPORT_TABLE}(source_fingerprint) ON DELETE CASCADE,
  item_type text NOT NULL
    CHECK (item_type IN ('blob', 'vector', 'gallery', 'reference')),
  source_id char(64) NOT NULL CHECK (source_id ~ '^[0-9a-f]{64}$'),
  source_checksum char(64) NOT NULL
    CHECK (source_checksum ~ '^[0-9a-f]{64}$'),
  target_id text NOT NULL,
  status text NOT NULL CHECK (status = 'complete'),
  updated_at bigint NOT NULL,
  PRIMARY KEY (source_fingerprint, item_type, source_id)
);
`;

/** Read-only signal used by startup/readiness to reject partial imports. */
export const inspectSQLiteImportCompletion = async (
  database: PostgresQueryExecutor
): Promise<'absent' | 'running' | 'failed' | 'complete'> => {
  const exists = await database.query<{ imports: string | null }>(
    `SELECT to_regclass('${SQLITE_IMPORT_TABLE}')::text AS imports`
  );
  if (!exists.rows[0]?.imports) return 'absent';
  const result = await database.query<{ status: string }>(
    `SELECT status
       FROM ${SQLITE_IMPORT_TABLE}
      ORDER BY created_at DESC
      LIMIT 2`
  );
  if (result.rows.length > 1) return 'failed';
  const status = result.rows[0]?.status;
  return status === 'running' || status === 'failed' || status === 'complete'
    ? status
    : 'failed';
};
