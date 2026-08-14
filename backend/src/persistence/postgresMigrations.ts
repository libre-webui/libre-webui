/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresDatabase } from './postgresDatabase.js';
import type { PostgresRuntimeConfig } from './postgresConfig.js';
import type {
  PostgresMigration,
  PostgresSchemaCompatibility,
} from './postgresMigrationTypes.js';
import {
  inspectPostgresSchema,
  POSTGRES_COORDINATOR_SCHEMA_SQL,
} from './postgresSchemaInspector.js';
import { inspectSQLiteImportCompletion } from './postgresImportState.js';

const MIGRATION_ADVISORY_LOCK = '6840141877227442764';
const LEDGER_TABLE = 'libre_schema_migrations';
const STATE_TABLE = 'libre_schema_compatibility';

interface AppliedMigrationRow extends QueryResultRow {
  version: number;
  name: string;
  checksum: string;
  minimum_compatible_version: number;
}

interface ExistsRow extends QueryResultRow {
  ledger: string | null;
  state: string | null;
}

export class PostgresMigrationError extends Error {
  constructor(
    message: string,
    readonly compatibility: PostgresSchemaCompatibility
  ) {
    super(message);
    this.name = 'PostgresMigrationError';
  }
}

const checksumFor = (migration: PostgresMigration): string =>
  createHash('sha256')
    .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
    .digest('hex');

export const validatePostgresMigrationRegistry = (
  migrations: readonly PostgresMigration[]
): readonly PostgresMigration[] => {
  if (migrations.length === 0) {
    throw new Error('The PostgreSQL migration registry must not be empty');
  }
  const names = new Set<string>();
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `PostgreSQL migration versions must be contiguous from 1 (expected ${expectedVersion})`
      );
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(migration.name)) {
      throw new Error(
        `Invalid PostgreSQL migration name at version ${migration.version}`
      );
    }
    if (names.has(migration.name)) {
      throw new Error(`Duplicate PostgreSQL migration name: ${migration.name}`);
    }
    names.add(migration.name);
    if (migration.checksum !== checksumFor(migration)) {
      throw new Error(
        `PostgreSQL migration checksum mismatch at version ${migration.version}`
      );
    }
    if (
      !Number.isSafeInteger(migration.minimumCompatibleVersion) ||
      migration.minimumCompatibleVersion < 1 ||
      migration.minimumCompatibleVersion > migration.version
    ) {
      throw new Error(
        `Invalid minimum compatible version at PostgreSQL migration ${migration.version}`
      );
    }
    if (!migration.sql.trim() || !migration.rollbackPlan.trim()) {
      throw new Error(
        `PostgreSQL migration ${migration.version} requires SQL and a rollback plan`
      );
    }
  }
  return migrations;
};

const pause = (milliseconds: number): Promise<void> =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

const acquireMigrationLeadership = async (
  client: PoolClient,
  timeoutMs: number
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [MIGRATION_ADVISORY_LOCK]
    );
    if (result.rows[0]?.acquired === true) return;
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the PostgreSQL migration leader');
    }
    await pause(Math.min(100, Math.max(1, deadline - Date.now())));
  }
};

const releaseMigrationLeadership = async (
  client: PoolClient
): Promise<void> => {
  const result = await client.query<{ released: boolean }>(
    'SELECT pg_advisory_unlock($1::bigint) AS released',
    [MIGRATION_ADVISORY_LOCK]
  );
  if (result.rows[0]?.released !== true) {
    throw new Error('PostgreSQL migration leadership was not held');
  }
};

const targetCompatibility = (
  migrations: readonly PostgresMigration[],
  status: PostgresSchemaCompatibility['status'],
  currentVersion: number,
  reason?: string
): PostgresSchemaCompatibility => {
  const target = migrations[migrations.length - 1]!;
  return {
    dialect: 'postgres',
    status,
    currentVersion,
    targetVersion: target.version,
    minimumSupportedVersion: target.minimumCompatibleVersion,
    mixedVersionPolicy: 'exact-schema-version',
    ...(reason ? { reason } : {}),
  };
};

const readAppliedMigrations = async (
  client: PoolClient
): Promise<AppliedMigrationRow[]> => {
  const result = await client.query<AppliedMigrationRow>(
    `SELECT version, name, checksum, minimum_compatible_version
       FROM ${LEDGER_TABLE}
      ORDER BY version ASC`
  );
  return result.rows;
};

const assertAppliedLedger = (
  applied: readonly AppliedMigrationRow[],
  migrations: readonly PostgresMigration[]
): void => {
  for (const [index, row] of applied.entries()) {
    const expected = migrations[index];
    if (!expected) {
      throw new Error('Database schema is newer than this Libre binary');
    }
    if (
      Number(row.version) !== expected.version ||
      row.name !== expected.name ||
      row.checksum !== expected.checksum ||
      Number(row.minimum_compatible_version) !==
        expected.minimumCompatibleVersion
    ) {
      throw new Error(
        `PostgreSQL migration ledger mismatch at version ${row.version}`
      );
    }
  }
};

const tablesExist = async (client: PoolClient): Promise<boolean> => {
  const result = await client.query<ExistsRow>(
    `SELECT to_regclass('${LEDGER_TABLE}')::text AS ledger,
            to_regclass('${STATE_TABLE}')::text AS state`
  );
  return Boolean(result.rows[0]?.ledger && result.rows[0]?.state);
};

const assertFreshSchemaIsEmpty = async (client: PoolClient): Promise<void> => {
  const result = await client.query<{ relation_count: string }>(
    `SELECT COUNT(*)::text AS relation_count
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relkind IN ('r', 'p')
        AND relation.relname NOT LIKE 'pg_%'`
  );
  if (Number(result.rows[0]?.relation_count || 0) !== 0) {
    throw new Error(
      'PostgreSQL schema has application tables but no Libre migration ledger; migrate from SQLite with the supported import tool or use a clean schema'
    );
  }
};

const coordinatorTablesAreEmpty = async (
  client: PoolClient
): Promise<boolean> => {
  const result = await client.query<{
    ledger_count: string;
    state_count: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM ${LEDGER_TABLE}) AS ledger_count,
       (SELECT COUNT(*)::text FROM ${STATE_TABLE}) AS state_count`
  );
  return (
    Number(result.rows[0]?.ledger_count || 0) === 0 &&
    Number(result.rows[0]?.state_count || 0) === 0
  );
};

const removeEmptyCoordinatorTables = async (
  client: PoolClient
): Promise<void> => {
  if (!(await coordinatorTablesAreEmpty(client))) return;
  await client.query(`DROP TABLE ${STATE_TABLE}`);
  await client.query(`DROP TABLE ${LEDGER_TABLE}`);
};

const updateState = async (
  client: PoolClient,
  values: {
    status: 'migrating' | 'compatible' | 'incompatible';
    currentVersion: number;
    targetVersion: number;
    minimumReaderVersion: number;
    owner: string | null;
    failureCode: string | null;
    schemaFingerprint?: string | null;
  }
): Promise<void> => {
  await client.query(
    `INSERT INTO ${STATE_TABLE}
       (singleton, status, current_version, target_version,
       minimum_reader_version, migration_owner, failure_code,
       schema_fingerprint, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (singleton) DO UPDATE SET
       status = EXCLUDED.status,
       current_version = EXCLUDED.current_version,
       target_version = EXCLUDED.target_version,
       minimum_reader_version = EXCLUDED.minimum_reader_version,
       migration_owner = EXCLUDED.migration_owner,
       failure_code = EXCLUDED.failure_code,
       schema_fingerprint = EXCLUDED.schema_fingerprint,
       updated_at = EXCLUDED.updated_at`,
    [
      values.status,
      values.currentVersion,
      values.targetVersion,
      values.minimumReaderVersion,
      values.owner,
      values.failureCode,
      values.schemaFingerprint ?? null,
      Date.now(),
    ]
  );
};

/**
 * Coordinate schema startup under one session advisory lock. The supported
 * mixed-version policy is deliberately exact: drain old replicas before an
 * upgrade, then start binaries that all target the same schema version.
 */
export const runPostgresMigrationCoordinator = async (
  database: PostgresDatabase,
  config: Pick<
    PostgresRuntimeConfig,
    'migrationLockTimeoutMs' | 'migrationMode'
  >,
  registry: readonly PostgresMigration[]
): Promise<PostgresSchemaCompatibility> => {
  const migrations = validatePostgresMigrationRegistry(registry);
  const target = migrations[migrations.length - 1]!;
  const owner = randomUUID();

  return database.withClient(async client => {
    await acquireMigrationLeadership(client, config.migrationLockTimeoutMs);
    let result: PostgresSchemaCompatibility | undefined;
    let primaryError: unknown;
    try {
      const exists = await tablesExist(client);
      if (!exists && config.migrationMode === 'validate') {
        const compatibility = targetCompatibility(
          migrations,
          'incompatible',
          0,
          'PostgreSQL schema is uninitialized and migration mode is validate-only'
        );
        throw new PostgresMigrationError(compatibility.reason!, compatibility);
      }
      if (!exists) {
        await assertFreshSchemaIsEmpty(client);
        await client.query(POSTGRES_COORDINATOR_SCHEMA_SQL);
      }

      let applied = await readAppliedMigrations(client);
      assertAppliedLedger(applied, migrations);
      let currentVersion = applied.length;

      if (
        config.migrationMode === 'validate' &&
        currentVersion !== target.version
      ) {
        const compatibility = targetCompatibility(
          migrations,
          'incompatible',
          currentVersion,
          'PostgreSQL schema does not exactly match this binary'
        );
        throw new PostgresMigrationError(compatibility.reason!, compatibility);
      }

      await updateState(client, {
        status: 'migrating',
        currentVersion,
        targetVersion: target.version,
        minimumReaderVersion: target.minimumCompatibleVersion,
        owner,
        failureCode: null,
      });

      for (const migration of migrations.slice(currentVersion)) {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO ${LEDGER_TABLE}
               (version, name, checksum, minimum_compatible_version,
                rollback_plan, applied_at, applied_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              migration.version,
              migration.name,
              migration.checksum,
              migration.minimumCompatibleVersion,
              migration.rollbackPlan,
              Date.now(),
              owner,
            ]
          );
          await updateState(client, {
            status: 'migrating',
            currentVersion: migration.version,
            targetVersion: target.version,
            minimumReaderVersion: target.minimumCompatibleVersion,
            owner,
            failureCode: null,
          });
          await client.query('COMMIT');
          currentVersion = migration.version;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            const combined = new Error(
              'PostgreSQL migration and rollback both failed'
            );
            Object.defineProperty(combined, 'cause', {
              value: error,
              enumerable: false,
            });
            Object.defineProperty(combined, 'rollbackError', {
              value: rollbackError,
              enumerable: false,
            });
            throw combined;
          }
          try {
            await updateState(client, {
              status: 'incompatible',
              currentVersion,
              targetVersion: target.version,
              minimumReaderVersion: target.minimumCompatibleVersion,
              owner: null,
              failureCode: 'migration_failed',
            });
          } catch {
            // Preserve the original migration failure. The ledger remains the
            // source of truth when even the failure marker cannot be written.
          }
          if (currentVersion === 0) {
            try {
              await removeEmptyCoordinatorTables(client);
            } catch {
              // A retained empty coordinator schema is safe and will be
              // retried. Never hide the original migration failure.
            }
          }
          throw error;
        }
      }

      applied = await readAppliedMigrations(client);
      assertAppliedLedger(applied, migrations);
      if (applied.length !== target.version) {
        throw new Error('PostgreSQL schema did not reach the target version');
      }
      const structure = await inspectPostgresSchema(client, migrations);
      if (!structure.compatible) {
        const compatibility = targetCompatibility(
          migrations,
          'incompatible',
          target.version,
          `PostgreSQL schema structure is incompatible: ${structure.problems
            .slice(0, 8)
            .join(', ')}`
        );
        await updateState(client, {
          status: 'incompatible',
          currentVersion: target.version,
          targetVersion: target.version,
          minimumReaderVersion: target.minimumCompatibleVersion,
          owner: null,
          failureCode: 'schema_structure_invalid',
          schemaFingerprint: structure.fingerprint,
        });
        throw new PostgresMigrationError(compatibility.reason!, compatibility);
      }
      const importStatus = await inspectSQLiteImportCompletion(client);
      if (importStatus === 'running' || importStatus === 'failed') {
        const compatibility = targetCompatibility(
          migrations,
          'incompatible',
          target.version,
          'PostgreSQL has an incomplete SQLite import; resume and validate the supported import before starting Libre'
        );
        await updateState(client, {
          status: 'incompatible',
          currentVersion: target.version,
          targetVersion: target.version,
          minimumReaderVersion: target.minimumCompatibleVersion,
          owner: null,
          failureCode: 'sqlite_import_incomplete',
          schemaFingerprint: structure.fingerprint,
        });
        throw new PostgresMigrationError(compatibility.reason!, compatibility);
      }
      await updateState(client, {
        status: 'compatible',
        currentVersion: target.version,
        targetVersion: target.version,
        minimumReaderVersion: target.minimumCompatibleVersion,
        owner: null,
        failureCode: null,
        schemaFingerprint: structure.fingerprint,
      });
      result = targetCompatibility(migrations, 'compatible', target.version);
    } catch (error) {
      primaryError = error;
    }

    try {
      await releaseMigrationLeadership(client);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
    if (primaryError) throw primaryError;
    if (!result)
      throw new Error('PostgreSQL migration did not produce a result');
    return result;
  });
};
