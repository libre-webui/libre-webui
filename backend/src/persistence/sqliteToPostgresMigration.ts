/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresRuntimeConfig } from './postgresConfig.js';
import {
  createPostgresDatabase,
  type PostgresDatabase,
  type PostgresQueryExecutor,
} from './postgresDatabase.js';
import { POSTGRES_MIGRATIONS } from './postgresMigrationRegistry.js';
import { runPostgresMigrationCoordinator } from './postgresMigrations.js';
import { inspectPostgresSchema } from './postgresSchemaInspector.js';
import {
  POSTGRES_SQLITE_IMPORT_SCHEMA_SQL,
  SQLITE_IMPORT_TABLE as IMPORT_TABLE,
  SQLITE_IMPORT_TABLE_STATE as IMPORT_TABLE_STATE,
} from './postgresImportState.js';
import {
  preflightSQLiteMigrationLedger,
  SQLITE_MIGRATION_CONTRACT,
} from './sqliteMigrations.js';
import { getPluginDefinitionFingerprint } from '../utils/pluginDefinitionTrust.js';
import type { Plugin } from '../types/index.js';

const IMPORT_LOCK = '6840141877227442765';
const BATCH_SIZE = 250;

export type SQLiteToPostgresMigrationMode = 'dry-run' | 'apply' | 'validate';

type ValueKind = 'text' | 'integer' | 'number' | 'binary';

interface ColumnMapping {
  source: string;
  target: string;
  kind: ValueKind;
}

interface TableMapping {
  source: string;
  target: string;
  columns: readonly ColumnMapping[];
  sourceKey: readonly string[];
  targetKey: readonly string[];
  deferredColumns?: readonly string[];
  overridingSystemValue?: boolean;
  afterImport?: (client: PoolClient) => Promise<void>;
}

export interface SQLiteToPostgresTableReport {
  sourceTable: string;
  targetTable: string;
  rows: number;
  checksum: string;
  status: 'planned' | 'imported' | 'resumed' | 'verified';
}

export interface SQLiteToPostgresMigrationPhaseAnalysis {
  name: string;
  items: number;
  checksum: string;
  warnings: string[];
  blockers: string[];
}

export interface SQLiteToPostgresMigrationPhaseReport {
  name: string;
  items: number;
  checksum: string;
  status: 'planned' | 'imported' | 'resumed' | 'verified';
}

export interface SQLiteToPostgresMigrationPhaseContext {
  sourceDatabase: Database.Database;
  sourcePath: string;
  target: PostgresQueryExecutor;
  sourceFingerprint: string;
}

/** Bounded extension seam for storage-aware conversion under the import lock. */
export interface SQLiteToPostgresMigrationPhase {
  analyze(input: {
    sourceDatabase: Database.Database;
    sourcePath: string;
  }): Promise<SQLiteToPostgresMigrationPhaseAnalysis>;
  apply(
    input: SQLiteToPostgresMigrationPhaseContext & { resume: boolean }
  ): Promise<void>;
  validate(input: SQLiteToPostgresMigrationPhaseContext): Promise<void>;
  rollback?(input: SQLiteToPostgresMigrationPhaseContext): Promise<void>;
  close?(): Promise<void>;
}

export interface SQLiteToPostgresMigrationReport {
  mode: SQLiteToPostgresMigrationMode;
  sourceSchemaVersion: number;
  sourceFingerprint: string;
  targetSchemaVersion: number | null;
  targetInitialized: boolean;
  targetEmpty: boolean;
  compatible: boolean;
  resumed: boolean;
  tables: SQLiteToPostgresTableReport[];
  phases: SQLiteToPostgresMigrationPhaseReport[];
  warnings: string[];
  blockers: string[];
}

export interface SQLiteToPostgresMigrationOptions {
  sourcePath: string;
  /** Defaults to the source data directory's `plugins` child. */
  sourcePluginsPath?: string;
  postgres: PostgresRuntimeConfig;
  mode: SQLiteToPostgresMigrationMode;
  resume?: boolean;
  storagePhase?: SQLiteToPostgresMigrationPhase;
}

interface SourceTableManifest {
  mapping: TableMapping;
  rows: number;
  checksum: string;
}

interface SourceAnalysis {
  database: Database.Database;
  sourcePath: string;
  schemaVersion: number;
  fingerprint: string;
  tables: SourceTableManifest[];
  phases: Array<{
    implementation: SQLiteToPostgresMigrationPhase;
    analysis: SQLiteToPostgresMigrationPhaseAnalysis;
  }>;
  warnings: string[];
  blockers: string[];
}

interface TargetInspection {
  initialized: boolean;
  schemaVersion: number | null;
  structurallyCompatible: boolean;
  empty: boolean;
  importStatus: 'absent' | 'running' | 'complete' | 'failed';
  importFingerprint: string | null;
}

interface ImportRow extends QueryResultRow {
  source_fingerprint: string;
  status: 'running' | 'complete' | 'failed';
}

interface ImportTableRow extends QueryResultRow {
  source_table: string;
  target_table: string;
  row_count: string | number;
  checksum: string;
  status: 'complete';
}

export class SQLiteToPostgresMigrationError extends Error {
  constructor(
    message: string,
    readonly report?: SQLiteToPostgresMigrationReport
  ) {
    super(message);
    this.name = 'SQLiteToPostgresMigrationError';
  }
}

const quote = (identifier: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error('Unsafe persistence identifier');
  }
  return `"${identifier}"`;
};

const mappedColumns = (
  names: readonly string[],
  options: {
    rename?: Readonly<Record<string, string>>;
    integers?: readonly string[];
    numbers?: readonly string[];
    binary?: readonly string[];
  } = {}
): ColumnMapping[] => {
  const integers = new Set(options.integers ?? []);
  const numbers = new Set(options.numbers ?? []);
  const binary = new Set(options.binary ?? []);
  return names.map(source => ({
    source,
    target: options.rename?.[source] ?? source,
    kind: binary.has(source)
      ? 'binary'
      : integers.has(source)
        ? 'integer'
        : numbers.has(source)
          ? 'number'
          : 'text',
  }));
};

const table = (
  source: string,
  target: string,
  names: readonly string[],
  key: readonly string[],
  options: Parameters<typeof mappedColumns>[1] &
    Pick<
      TableMapping,
      'deferredColumns' | 'overridingSystemValue' | 'afterImport'
    > = {}
): TableMapping => ({
  source,
  target,
  columns: mappedColumns(names, options),
  sourceKey: key,
  targetKey: key.map(column => options.rename?.[column] ?? column),
  ...(options.deferredColumns
    ? { deferredColumns: options.deferredColumns }
    : {}),
  ...(options.overridingSystemValue ? { overridingSystemValue: true } : {}),
  ...(options.afterImport ? { afterImport: options.afterImport } : {}),
});

const timestamps = [
  'created_at',
  'updated_at',
  'uploaded_at',
  'timestamp',
  'approved_at',
  'approved_at',
  'activated_at',
  'consent_confirmed_at',
  'started_at',
  'finished_at',
  'available_at',
  'lease_expires_at',
  'cancellation_requested_at',
  'last_heartbeat_at',
  'occurred_at',
  'last_accessed',
  'last_updated',
] as const;

const TABLE_MAPPINGS: readonly TableMapping[] = Object.freeze([
  table(
    'users',
    'users',
    [
      'id',
      'username',
      'email',
      'email_lookup',
      'password_hash',
      'role',
      'account_status',
      'approved_at',
      'approved_by',
      'avatar',
      'created_at',
      'updated_at',
    ],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'personas',
    'personas',
    [
      'id',
      'user_id',
      'name',
      'description',
      'model',
      'parameters',
      'avatar',
      'background',
      'embedding_model',
      'memory_settings',
      'mutation_settings',
      'created_at',
      'updated_at',
    ],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'session_folders',
    'session_folders',
    ['id', 'user_id', 'name', 'created_at', 'updated_at'],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'knowledge_collections',
    'knowledge_collections',
    ['id', 'user_id', 'name', 'created_at', 'updated_at'],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'sessions',
    'sessions',
    [
      'id',
      'user_id',
      'title',
      'model',
      'persona_id',
      'provider_type',
      'provider_id',
      'created_at',
      'updated_at',
      'archived',
      'settings',
      'folder_id',
      'pinned',
    ],
    ['id'],
    { integers: [...timestamps, 'archived', 'pinned'] }
  ),
  table(
    'session_messages',
    'session_messages',
    [
      'id',
      'session_id',
      'role',
      'content',
      'thinking',
      'timestamp',
      'message_index',
      'model',
      'provider_metadata',
      'images',
      'statistics',
      'artifacts',
      'parent_id',
      'branch_index',
      'is_active',
      'rating',
    ],
    ['id'],
    {
      integers: [
        ...timestamps,
        'message_index',
        'branch_index',
        'is_active',
        'rating',
      ],
      deferredColumns: ['parent_id'],
    }
  ),
  table(
    'notes',
    'notes',
    ['id', 'user_id', 'title', 'content', 'created_at', 'updated_at'],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'documents',
    'documents',
    [
      'id',
      'user_id',
      'filename',
      'title',
      'content',
      'file_type',
      'size',
      'session_id',
      'collection_id',
      'metadata',
      'uploaded_at',
      'created_at',
      'updated_at',
    ],
    ['id'],
    { integers: [...timestamps, 'size'] }
  ),
  table(
    'document_chunks',
    'document_chunks',
    [
      'id',
      'document_id',
      'chunk_index',
      'content',
      'start_char',
      'end_char',
      'embedding',
      'created_at',
    ],
    ['id'],
    {
      integers: [...timestamps, 'chunk_index', 'start_char', 'end_char'],
    }
  ),
  table(
    'user_preferences',
    'user_preferences',
    ['id', 'user_id', 'key', 'value', 'created_at', 'updated_at'],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'system_settings',
    'system_settings',
    ['key', 'value', 'updated_at'],
    ['key'],
    { integers: timestamps }
  ),
  table(
    'plugin_credentials',
    'plugin_credentials',
    [
      'id',
      'user_id',
      'plugin_id',
      'api_key',
      'routing_auth_fingerprint',
      'created_at',
      'updated_at',
    ],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'plugin_variables',
    'plugin_variables',
    [
      'id',
      'user_id',
      'plugin_id',
      'variable_name',
      'variable_value',
      'is_encrypted',
      'created_at',
      'updated_at',
    ],
    ['id'],
    { integers: [...timestamps, 'is_encrypted'] }
  ),
  table(
    'plugin_discovered_models',
    'plugin_discovered_models',
    ['user_id', 'plugin_id', 'models_json', 'updated_at'],
    ['user_id', 'plugin_id'],
    { integers: timestamps }
  ),
  table(
    'plugin_discovered_capability_models',
    'plugin_discovered_capability_models',
    ['user_id', 'plugin_id', 'capability', 'models_json', 'updated_at'],
    ['user_id', 'plugin_id', 'capability'],
    { integers: timestamps }
  ),
  table(
    'plugin_activations',
    'plugin_activations',
    ['user_id', 'plugin_id', 'activated_at'],
    ['user_id', 'plugin_id'],
    { integers: timestamps }
  ),
  table(
    'plugin_definition_approvals',
    'plugin_definition_approvals',
    [
      'plugin_id',
      'definition_fingerprint',
      'source_path',
      'approved_by_user_id',
      'approved_at',
    ],
    ['plugin_id'],
    { integers: timestamps }
  ),
  table(
    'plugin_definitions',
    'plugin_definitions',
    [
      'plugin_id',
      'definition_json',
      'definition_fingerprint',
      'approved_by_user_id',
      'approved_at',
      'created_at',
      'updated_at',
    ],
    ['plugin_id'],
    { integers: timestamps }
  ),
  table(
    'plugin_usage_events',
    'plugin_usage_events',
    [
      'id',
      'user_id',
      'plugin_id',
      'plugin_name',
      'capability',
      'model',
      'status',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'input_units',
      'output_units',
      'unit_kind',
      'duration_ms',
      'created_at',
    ],
    ['id'],
    {
      integers: [
        ...timestamps,
        'prompt_tokens',
        'completion_tokens',
        'total_tokens',
        'input_units',
        'output_units',
        'duration_ms',
      ],
    }
  ),
  table(
    'voice_profiles',
    'voice_profiles',
    [
      'id',
      'user_id',
      'name',
      'name_lookup',
      'plugin_id',
      'model',
      'routing_fingerprint',
      'reference_audio',
      'reference_text',
      'audio_mime_type',
      'audio_format',
      'audio_size',
      'consent_confirmed_at',
      'created_at',
      'updated_at',
    ],
    ['id'],
    {
      integers: [...timestamps, 'audio_size'],
      binary: ['name', 'reference_audio', 'reference_text'],
    }
  ),
  table(
    'persona_memories',
    'platform_persona_memories',
    [
      'id',
      'user_id',
      'persona_id',
      'content',
      'timestamp',
      'context',
      'importance_score',
      'memory_type',
      'access_count',
      'last_accessed',
      'decay_factor',
      'consolidated_from',
    ],
    ['id'],
    {
      rename: {
        content: 'encrypted_content',
        context: 'encrypted_context',
        consolidated_from: 'encrypted_consolidated_from',
      },
      integers: [...timestamps, 'access_count'],
      numbers: ['importance_score', 'decay_factor'],
    }
  ),
  table(
    'persona_states',
    'platform_persona_states',
    [
      'persona_id',
      'user_id',
      'runtime_state',
      'mutation_log',
      'last_updated',
      'version',
    ],
    ['persona_id'],
    {
      rename: {
        runtime_state: 'encrypted_runtime_state',
        mutation_log: 'encrypted_mutation_log',
      },
      integers: [...timestamps, 'version'],
    }
  ),
  table(
    'media_generation_jobs',
    'platform_media_generation_jobs',
    [
      'id',
      'user_id',
      'provider_job_id',
      'plugin_id',
      'model',
      'prompt',
      'status',
      'options_json',
      'gallery_id',
      'error',
      'created_at',
      'updated_at',
    ],
    ['id'],
    {
      rename: {
        prompt: 'encrypted_prompt',
        options_json: 'encrypted_options',
        error: 'encrypted_error',
      },
      integers: timestamps,
    }
  ),
  table(
    'platform_event_stream_heads',
    'platform_event_stream_heads',
    ['stream_id', 'last_sequence'],
    ['stream_id'],
    { integers: ['last_sequence'] }
  ),
  table(
    'platform_jobs',
    'platform_jobs',
    [
      'id',
      'job_type',
      'actor_user_id',
      'state',
      'payload_format',
      'payload',
      'idempotency_scope',
      'idempotency_key_hash',
      'request_fingerprint',
      'priority',
      'attempt_count',
      'max_attempts',
      'available_at',
      'lease_owner',
      'lease_token',
      'lease_expires_at',
      'cancellation_requested_at',
      'cancellation_reason',
      'progress_current',
      'progress_total',
      'progress_message',
      'result_reference',
      'error_code',
      'error_summary',
      'created_at',
      'updated_at',
      'started_at',
      'finished_at',
    ],
    ['id'],
    {
      integers: [
        ...timestamps,
        'priority',
        'attempt_count',
        'max_attempts',
        'lease_token',
        'progress_current',
        'progress_total',
      ],
    }
  ),
  table(
    'platform_job_attempts',
    'platform_job_attempts',
    [
      'job_id',
      'attempt_number',
      'lease_token',
      'worker_id',
      'started_at',
      'last_heartbeat_at',
      'finished_at',
      'outcome',
      'error_code',
      'error_summary',
    ],
    ['job_id', 'attempt_number'],
    {
      integers: [...timestamps, 'attempt_number', 'lease_token'],
    }
  ),
  table(
    'platform_events',
    'platform_events',
    [
      'global_cursor',
      'event_id',
      'request_fingerprint',
      'stream_id',
      'stream_sequence',
      'event_type',
      'subject_id',
      'actor_user_id',
      'payload_format',
      'payload',
      'occurred_at',
    ],
    ['global_cursor'],
    {
      integers: [...timestamps, 'global_cursor', 'stream_sequence'],
      overridingSystemValue: true,
      afterImport: async client => {
        await client.query(
          `SELECT setval(
             pg_get_serial_sequence('platform_events', 'global_cursor'),
             GREATEST(COALESCE((SELECT MAX(global_cursor) FROM platform_events), 0), 1),
             EXISTS(SELECT 1 FROM platform_events)
           )`
        );
      },
    }
  ),
  table(
    'platform_resource_deletion_tombstones',
    'platform_resource_deletion_tombstones',
    [
      'resource_type',
      'resource_id',
      'owner_user_id',
      'deletion_incarnation',
      'deletion_token',
      'deleted_at',
      'completed_at',
    ],
    ['resource_type', 'resource_id'],
    {
      integers: ['deletion_incarnation', 'deleted_at', 'completed_at'],
    }
  ),
  table(
    'work_policies',
    'work_policies',
    [
      'id',
      'name',
      'image',
      'memory_limit',
      'cpu_limit',
      'pids_limit',
      'network_default',
      'workspace_size',
      'idle_timeout_ms',
      'created_at',
      'updated_at',
    ],
    ['id'],
    {
      integers: [
        ...timestamps,
        'pids_limit',
        'network_default',
        'idle_timeout_ms',
      ],
    }
  ),
  table(
    'work_tasks',
    'work_tasks',
    [
      'id',
      'user_id',
      'title',
      'model',
      'provider_type',
      'provider_id',
      'status',
      'network_enabled',
      'volume_name',
      'container_name',
      'host_path',
      'policy_id',
      'preview_url',
      'preview_status',
      'created_at',
      'updated_at',
    ],
    ['id'],
    { integers: [...timestamps, 'network_enabled'] }
  ),
  table(
    'work_runs',
    'work_runs',
    [
      'id',
      'task_id',
      'model',
      'provider_type',
      'provider_id',
      'status',
      'error',
      'created_at',
      'started_at',
      'finished_at',
    ],
    ['id'],
    { integers: timestamps }
  ),
  table(
    'work_messages',
    'work_messages',
    [
      'id',
      'task_id',
      'run_id',
      'role',
      'kind',
      'content',
      'metadata',
      'message_index',
      'created_at',
    ],
    ['id'],
    { integers: [...timestamps, 'message_index'] }
  ),
]);

const TARGET_DOMAIN_TABLES = Object.freeze([
  ...new Set([
    ...TABLE_MAPPINGS.map(mapping => mapping.target),
    'platform_blob_objects',
    'platform_generated_media',
    'platform_blob_references',
    'platform_blob_quota_usage',
    'platform_blob_quota_reservations',
    'platform_blob_quota_objects',
    'platform_vector_entries',
    'platform_vector_acl',
  ]),
]);

const canonical = (value: unknown, kind: ValueKind): string => {
  if (value === null || value === undefined) return 'null';
  if (kind === 'binary') {
    if (!Buffer.isBuffer(value))
      throw new Error('Expected binary SQLite value');
    return `binary:${value.toString('base64')}`;
  }
  if (kind === 'integer') {
    if (typeof value === 'bigint') return `integer:${value.toString()}`;
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return `integer:${value}`;
    }
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      return `integer:${BigInt(value).toString()}`;
    }
    throw new Error('Expected an exact integer persistence value');
  }
  if (kind === 'number') {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error('Expected a finite number');
    return `number:${parsed}`;
  }
  if (typeof value !== 'string')
    throw new Error('Expected text persistence value');
  return `text:${value}`;
};

const checksumRows = (
  rows: Iterable<Record<string, unknown>>,
  columns: readonly ColumnMapping[],
  side: 'source' | 'target'
): { rows: number; checksum: string } => {
  const hash = createHash('sha256');
  let count = 0;
  for (const row of rows) {
    hash.update(
      JSON.stringify(
        columns.map(column =>
          canonical(
            row[side === 'source' ? column.source : column.target],
            column.kind
          )
        )
      )
    );
    hash.update('\n');
    count += 1;
  }
  return { rows: count, checksum: hash.digest('hex') };
};

const sourceManifest = (
  database: Database.Database,
  mapping: TableMapping
): SourceTableManifest => {
  const selected = mapping.columns
    .map(column => quote(column.source))
    .join(', ');
  const order = mapping.sourceKey.map(quote).join(', ');
  const rows = database
    .prepare(
      `SELECT ${selected} FROM ${quote(mapping.source)} ORDER BY ${order}`
    )
    .iterate() as Iterable<Record<string, unknown>>;
  return { mapping, ...checksumRows(rows, mapping.columns, 'source') };
};

const safeCount = (value: unknown): number => {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Persistence row count exceeds the supported range');
  }
  return parsed;
};

const sqliteCount = (database: Database.Database, sql: string): number => {
  const row = database.prepare(sql).get() as { count: unknown };
  return safeCount(row.count);
};

const sourceBlockers = (
  database: Database.Database,
  storagePhaseConfigured: boolean
): string[] => {
  const blockers: string[] = [];
  const blockedTables = [
    ['generated_images', 'gallery media requires coordinated blob transfer'],
    [
      'platform_blob_references',
      'blob references require coordinated blob transfer',
    ],
    [
      'platform_blob_quota_usage',
      'blob quota state requires coordinated blob transfer',
    ],
    [
      'platform_blob_quota_reservations',
      'blob reservations require coordinated blob transfer',
    ],
    [
      'platform_blob_quota_objects',
      'blob quota objects require coordinated blob transfer',
    ],
    [
      'platform_vector_entries',
      'encrypted embedded vectors require authenticated decrypt-and-reindex',
    ],
    ['platform_vector_acl', 'vector ACL rows depend on converted vectors'],
    [
      'platform_vector_attributes',
      'vector attributes depend on converted vectors',
    ],
  ] as const;
  if (!storagePhaseConfigured) {
    for (const [tableName, reason] of blockedTables) {
      const count = sqliteCount(
        database,
        `SELECT COUNT(*) AS count FROM ${quote(tableName)}`
      );
      if (count > 0) blockers.push(`${tableName}: ${count} row(s); ${reason}`);
    }
  }
  const linkedMediaJobs = sqliteCount(
    database,
    'SELECT COUNT(*) AS count FROM media_generation_jobs WHERE gallery_id IS NOT NULL'
  );
  if (!storagePhaseConfigured && linkedMediaJobs > 0) {
    blockers.push(
      `media_generation_jobs: ${linkedMediaJobs} row(s) reference gallery media that must be transferred first`
    );
  }
  const missingVoiceLookups = sqliteCount(
    database,
    'SELECT COUNT(*) AS count FROM voice_profiles WHERE name_lookup IS NULL'
  );
  if (missingVoiceLookups > 0) {
    blockers.push(
      `voice_profiles: ${missingVoiceLookups} row(s) lack keyed name lookups; start the current SQLite release once with the correct encryption key before migration`
    );
  }
  return blockers;
};

const sourceWarnings = (
  database: Database.Database,
  storagePhaseConfigured: boolean
): string[] => {
  if (storagePhaseConfigured) return [];
  const embeddedMemories = sqliteCount(
    database,
    'SELECT COUNT(*) AS count FROM persona_memories WHERE embedding IS NOT NULL'
  );
  return embeddedMemories > 0
    ? [
        `${embeddedMemories} legacy persona-memory embedding(s) are derived data and must be rebuilt in the selected PostgreSQL vector store; encrypted memory payloads are preserved exactly.`,
      ]
    : [];
};

interface SourceFile {
  suffix: '' | '-wal';
  path: string;
  stat: fs.BigIntStats;
}

const sameFileState = (left: fs.BigIntStats, right: fs.BigIntStats): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const sourceFiles = (sourcePath: string): SourceFile[] => {
  const result: SourceFile[] = [];
  for (const suffix of ['', '-wal'] as const) {
    const candidate = `${sourcePath}${suffix}`;
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(candidate, { bigint: true });
    } catch (error) {
      if (
        suffix === '-wal' &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        continue;
      }
      throw new Error('Unable to inspect the SQLite migration source');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error(
        'SQLite migration sources must be single-link regular files'
      );
    }
    result.push({ suffix, path: candidate, stat });
  }
  return result;
};

const copySourceFile = (source: SourceFile, destination: string): void => {
  const sourceDescriptor = fs.openSync(
    source.path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  let destinationDescriptor: number | undefined;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sameFileState(opened, source.stat)) {
      throw new Error('SQLite migration source changed before snapshot');
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    let bytesRead = 0;
    while (
      (bytesRead = fs.readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.length,
        null
      )) > 0
    ) {
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(
          destinationDescriptor,
          buffer,
          offset,
          bytesRead - offset
        );
      }
    }
    fs.fsyncSync(destinationDescriptor);
    const after = fs.fstatSync(sourceDescriptor, { bigint: true });
    if (!sameFileState(after, source.stat)) {
      throw new Error('SQLite migration source changed during snapshot');
    }
  } finally {
    buffer.fill(0);
    if (destinationDescriptor !== undefined)
      fs.closeSync(destinationDescriptor);
    fs.closeSync(sourceDescriptor);
  }
};

const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PLUGIN_DEFINITION_BYTES = 8 * 1024 * 1024;

const readStablePluginDefinition = (
  filePath: string,
  expected: fs.BigIntStats
): string => {
  if (
    !expected.isFile() ||
    expected.isSymbolicLink() ||
    expected.nlink !== 1n ||
    expected.size > BigInt(MAX_PLUGIN_DEFINITION_BYTES)
  ) {
    throw new Error(
      'Plugin migration sources must be bounded single-link regular files'
    );
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileState(expected, opened)) {
      throw new Error('Plugin definition changed before migration snapshot');
    }
    const content = fs.readFileSync(descriptor, 'utf8');
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileState(expected, after)) {
      throw new Error('Plugin definition changed during migration snapshot');
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
};

/** Capture node-local definitions into the private SQLite snapshot only. */
const capturePluginDefinitions = (
  database: Database.Database,
  configuredDirectory: string
): void => {
  const directory = path.resolve(configuredDirectory);
  let directoryStat: fs.BigIntStats;
  try {
    directoryStat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('Unable to inspect the plugin migration source directory');
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(
      'Plugin migration source must be a physical directory, not a link'
    );
  }
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      entry => entry.name.endsWith('.json') && !entry.name.startsWith('.')
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const approval = database.prepare(
    `SELECT definition_fingerprint, source_path, approved_by_user_id, approved_at
       FROM plugin_definition_approvals WHERE plugin_id = ?`
  );
  const upsert = database.prepare(
    `INSERT INTO plugin_definitions
       (plugin_id, definition_json, definition_fingerprint,
        approved_by_user_id, approved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plugin_id) DO UPDATE SET
       definition_json = excluded.definition_json,
       definition_fingerprint = excluded.definition_fingerprint,
       approved_by_user_id = excluded.approved_by_user_id,
       approved_at = excluded.approved_at,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`
  );
  const capture = database.transaction(() => {
    for (const entry of entries) {
      const pluginId = path.basename(entry.name, '.json');
      if (!PLUGIN_ID_PATTERN.test(pluginId)) {
        throw new Error('Plugin migration source has an invalid definition ID');
      }
      const filePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(filePath, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error(
          'Plugin migration source contains an unsafe definition'
        );
      }
      const content = readStablePluginDefinition(filePath, stat);
      let fingerprint = createHash('sha256').update(content).digest('hex');
      let createdAt = Number(stat.birthtimeMs);
      let updatedAt = Number(stat.mtimeMs);
      let definitionMatchesId = false;
      try {
        const parsed = JSON.parse(content) as Plugin;
        definitionMatchesId =
          typeof parsed === 'object' &&
          parsed !== null &&
          parsed.id === pluginId;
        if (definitionMatchesId) {
          fingerprint = getPluginDefinitionFingerprint(parsed);
          if (Number.isSafeInteger(parsed.created_at)) {
            createdAt = parsed.created_at!;
          }
          if (Number.isSafeInteger(parsed.updated_at)) {
            updatedAt = parsed.updated_at!;
          }
        }
      } catch {
        // Preserve malformed bytes as an unapproved quarantine shadow.
      }
      const existingApproval = approval.get(pluginId) as
        | {
            definition_fingerprint: string;
            source_path: string;
            approved_by_user_id: string;
            approved_at: number;
          }
        | undefined;
      const approved =
        definitionMatchesId &&
        existingApproval?.definition_fingerprint === fingerprint &&
        path.resolve(existingApproval.source_path) === path.resolve(filePath);
      upsert.run(
        pluginId,
        content,
        fingerprint,
        approved ? existingApproval!.approved_by_user_id : null,
        approved ? existingApproval!.approved_at : null,
        createdAt,
        updatedAt
      );
    }
  });
  capture();
};

const withSourceSnapshot = async <T>(
  inputPath: string,
  inputPluginsPath: string | undefined,
  operation: (database: Database.Database) => Promise<T>
): Promise<T> => {
  const resolved = path.resolve(inputPath);
  const before = sourceFiles(resolved);
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-sqlite-import-')
  );
  fs.chmodSync(directory, 0o700);
  const snapshotPath = path.join(directory, 'source.sqlite');
  let database: Database.Database | undefined;
  try {
    for (const source of before) {
      copySourceFile(source, `${snapshotPath}${source.suffix}`);
    }
    const after = sourceFiles(resolved);
    if (
      after.length !== before.length ||
      before.some(
        (source, index) =>
          source.suffix !== after[index]?.suffix ||
          !sameFileState(source.stat, after[index]!.stat)
      )
    ) {
      throw new Error(
        'SQLite migration source changed while it was being snapshotted; stop Libre and every worker before retrying'
      );
    }
    database = new Database(snapshotPath, { fileMustExist: true });
    if (database.pragma('quick_check', { simple: true }) !== 'ok') {
      throw new Error('SQLite migration snapshot failed quick_check');
    }
    capturePluginDefinitions(
      database,
      inputPluginsPath ?? path.join(path.dirname(resolved), 'plugins')
    );
    database.pragma('query_only = ON');
    if (
      database.prepare('SELECT * FROM pragma_foreign_key_check LIMIT 1').get()
    ) {
      throw new Error('SQLite migration snapshot has a foreign-key violation');
    }
    return await operation(database);
  } finally {
    database?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

const analyzeSource = async (
  database: Database.Database,
  sourcePath: string,
  storagePhase?: SQLiteToPostgresMigrationPhase
): Promise<SourceAnalysis> => {
  const compatibility = preflightSQLiteMigrationLedger(database);
  if (
    compatibility.status !== 'compatible' ||
    compatibility.currentVersion !== compatibility.targetVersion
  ) {
    throw new Error(
      'SQLite source must be started and fully migrated by this Libre release before PostgreSQL import'
    );
  }
  // Application timestamps/counters are safe JS integers, but reading them as
  // bigint avoids any accidental coercion while producing the migration
  // checksum. Run the existing schema inspector first because its PRAGMA sort
  // callbacks intentionally operate on ordinary numbers.
  database.defaultSafeIntegers(true);
  const tables = TABLE_MAPPINGS.map(mapping =>
    sourceManifest(database, mapping)
  );
  const phases = storagePhase
    ? [
        {
          implementation: storagePhase,
          analysis: await storagePhase.analyze({
            sourceDatabase: database,
            sourcePath,
          }),
        },
      ]
    : [];
  for (const phase of phases) {
    if (
      !/^[a-z][a-z0-9._-]{0,63}$/.test(phase.analysis.name) ||
      !Number.isSafeInteger(phase.analysis.items) ||
      phase.analysis.items < 0 ||
      !/^[0-9a-f]{64}$/.test(phase.analysis.checksum)
    ) {
      throw new Error('Storage migration phase returned an invalid manifest');
    }
  }
  const warnings = [
    ...sourceWarnings(database, Boolean(storagePhase)),
    ...phases.flatMap(phase => phase.analysis.warnings),
  ];
  const blockers = [
    ...sourceBlockers(database, Boolean(storagePhase)),
    ...phases.flatMap(phase => phase.analysis.blockers),
  ];
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        format: 1,
        sqliteMigrations: SQLITE_MIGRATION_CONTRACT,
        tables: tables.map(manifest => ({
          source: manifest.mapping.source,
          target: manifest.mapping.target,
          rows: manifest.rows,
          checksum: manifest.checksum,
        })),
        phases: phases.map(phase => ({
          name: phase.analysis.name,
          items: phase.analysis.items,
          checksum: phase.analysis.checksum,
        })),
      })
    )
    .digest('hex');
  return {
    database,
    sourcePath,
    schemaVersion: compatibility.currentVersion,
    fingerprint,
    tables,
    phases,
    warnings,
    blockers,
  };
};

const targetTablesPresent = async (
  database: PostgresQueryExecutor
): Promise<Set<string>> => {
  const result = await database.query<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])`,
    [TARGET_DOMAIN_TABLES]
  );
  return new Set(result.rows.map(row => row.table_name));
};

const targetIsEmpty = async (
  database: PostgresQueryExecutor,
  present: ReadonlySet<string>
): Promise<boolean> => {
  for (const tableName of TARGET_DOMAIN_TABLES) {
    if (!present.has(tableName)) continue;
    const result = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${quote(tableName)}`
    );
    if (result.rows[0]?.count !== '0') return false;
  }
  return true;
};

const inspectTarget = async (
  database: PostgresDatabase
): Promise<TargetInspection> => {
  const tables = await database.query<{
    ledger: string | null;
    imports: string | null;
  }>(
    `SELECT to_regclass('libre_schema_migrations')::text AS ledger,
            to_regclass('${IMPORT_TABLE}')::text AS imports`
  );
  const ledgerExists = Boolean(tables.rows[0]?.ledger);
  const importsExist = Boolean(tables.rows[0]?.imports);
  const present = await targetTablesPresent(database);
  const empty = await targetIsEmpty(database, present);
  let schemaVersion: number | null = null;
  let structurallyCompatible = false;
  if (ledgerExists) {
    const ledger = await database.query<{
      version: number;
      name: string;
      checksum: string;
    }>(
      `SELECT version, name, checksum
         FROM libre_schema_migrations
        ORDER BY version ASC`
    );
    const ledgerCompatible =
      ledger.rows.length === POSTGRES_MIGRATIONS.length &&
      POSTGRES_MIGRATIONS.every(
        (migration, index) =>
          Number(ledger.rows[index]?.version) === migration.version &&
          ledger.rows[index]?.name === migration.name &&
          ledger.rows[index]?.checksum === migration.checksum
      );
    schemaVersion = Number(ledger.rows[ledger.rows.length - 1]?.version ?? 0);
    if (ledgerCompatible) {
      structurallyCompatible = (
        await inspectPostgresSchema(database, POSTGRES_MIGRATIONS)
      ).compatible;
    }
  }
  let importStatus: TargetInspection['importStatus'] = 'absent';
  let importFingerprint: string | null = null;
  if (importsExist) {
    const imports = await database.query<ImportRow>(
      `SELECT source_fingerprint, status
         FROM ${IMPORT_TABLE}
        ORDER BY created_at DESC
        LIMIT 2`
    );
    if (imports.rows.length > 1) {
      throw new Error('PostgreSQL contains multiple SQLite import identities');
    }
    const row = imports.rows[0];
    if (row) {
      importStatus = row.status;
      importFingerprint = row.source_fingerprint;
    }
  }
  return {
    initialized: ledgerExists,
    schemaVersion,
    structurallyCompatible,
    empty,
    importStatus,
    importFingerprint,
  };
};

const baseReport = (
  mode: SQLiteToPostgresMigrationMode,
  source: SourceAnalysis,
  target: TargetInspection,
  status: SQLiteToPostgresTableReport['status']
): SQLiteToPostgresMigrationReport => ({
  mode,
  sourceSchemaVersion: source.schemaVersion,
  sourceFingerprint: source.fingerprint,
  targetSchemaVersion: target.schemaVersion,
  targetInitialized: target.initialized,
  targetEmpty: target.empty,
  compatible:
    source.blockers.length === 0 &&
    (!target.initialized || target.structurallyCompatible),
  resumed: false,
  tables: source.tables.map(manifest => ({
    sourceTable: manifest.mapping.source,
    targetTable: manifest.mapping.target,
    rows: manifest.rows,
    checksum: manifest.checksum,
    status,
  })),
  phases: source.phases.map(phase => ({
    name: phase.analysis.name,
    items: phase.analysis.items,
    checksum: phase.analysis.checksum,
    status,
  })),
  warnings: [...source.warnings],
  blockers: [...source.blockers],
});

const createImportJournal = async (client: PoolClient): Promise<void> => {
  await client.query(POSTGRES_SQLITE_IMPORT_SCHEMA_SQL);
};

const updateCompatibility = async (
  client: PoolClient,
  status: 'migrating' | 'compatible' | 'incompatible',
  failureCode: string | null,
  schemaFingerprint?: string
): Promise<void> => {
  await client.query(
    `UPDATE libre_schema_compatibility
        SET status = $1, failure_code = $2,
            schema_fingerprint = COALESCE($3, schema_fingerprint),
            updated_at = $4
      WHERE singleton = 1`,
    [status, failureCode, schemaFingerprint ?? null, Date.now()]
  );
};

const readJournalTables = async (
  client: PoolClient,
  fingerprint: string
): Promise<Map<string, ImportTableRow>> => {
  const result = await client.query<ImportTableRow>(
    `SELECT source_table, target_table, row_count, checksum, status
       FROM ${IMPORT_TABLE_STATE}
      WHERE source_fingerprint = $1
      ORDER BY source_table ASC`,
    [fingerprint]
  );
  return new Map(result.rows.map(row => [row.source_table, row]));
};

const targetManifest = async (
  executor: PostgresQueryExecutor,
  mapping: TableMapping
): Promise<{ rows: number; checksum: string }> => {
  const selected = mapping.columns
    .map(column => quote(column.target))
    .join(', ');
  const order = mapping.targetKey.map(quote).join(', ');
  const hash = createHash('sha256');
  let offset = 0;
  let count = 0;
  while (true) {
    const result = await executor.query<
      Record<string, unknown> & QueryResultRow
    >(
      `SELECT ${selected}
         FROM ${quote(mapping.target)}
        ORDER BY ${order}
        LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );
    for (const row of result.rows) {
      hash.update(
        JSON.stringify(
          mapping.columns.map(column =>
            canonical(row[column.target], column.kind)
          )
        )
      );
      hash.update('\n');
      count += 1;
    }
    if (result.rows.length < BATCH_SIZE) break;
    offset += result.rows.length;
  }
  return { rows: count, checksum: hash.digest('hex') };
};

const assertManifest = (
  source: SourceTableManifest,
  actual: { rows: number; checksum: string }
): void => {
  if (actual.rows !== source.rows || actual.checksum !== source.checksum) {
    throw new Error(
      `PostgreSQL verification failed for imported table ${source.mapping.target}`
    );
  }
};

const insertSourceRows = async (
  database: Database.Database,
  client: PoolClient,
  mapping: TableMapping
): Promise<void> => {
  const selected = mapping.columns
    .map(column => quote(column.source))
    .join(', ');
  const order = mapping.sourceKey.map(quote).join(', ');
  let offset = 0;
  while (true) {
    const sourceRows = database
      .prepare(
        `SELECT ${selected}
           FROM ${quote(mapping.source)}
          ORDER BY ${order}
          LIMIT ? OFFSET ?`
      )
      .all(BATCH_SIZE, offset) as Array<Record<string, unknown>>;
    if (sourceRows.length === 0) break;
    const values: unknown[] = [];
    const tuples = sourceRows.map(row => {
      const parameters = mapping.columns.map(column => {
        values.push(
          mapping.deferredColumns?.includes(column.target)
            ? null
            : row[column.source]
        );
        return `$${values.length}`;
      });
      return `(${parameters.join(', ')})`;
    });
    await client.query(
      `INSERT INTO ${quote(mapping.target)}
         (${mapping.columns.map(column => quote(column.target)).join(', ')})
       ${mapping.overridingSystemValue ? 'OVERRIDING SYSTEM VALUE' : ''}
       VALUES ${tuples.join(', ')}`,
      values
    );
    offset += sourceRows.length;
  }
  for (const targetColumn of mapping.deferredColumns ?? []) {
    const column = mapping.columns.find(item => item.target === targetColumn);
    if (!column) throw new Error('Invalid deferred import column');
    const primarySource = mapping.sourceKey[0];
    const primaryTarget = mapping.targetKey[0];
    if (!primarySource || !primaryTarget) {
      throw new Error('Deferred import requires a primary key');
    }
    const updates = database
      .prepare(
        `SELECT ${quote(primarySource)} AS import_key,
                ${quote(column.source)} AS import_value
           FROM ${quote(mapping.source)}
          WHERE ${quote(column.source)} IS NOT NULL
          ORDER BY ${quote(primarySource)}`
      )
      .iterate() as Iterable<{ import_key: unknown; import_value: unknown }>;
    for (const update of updates) {
      await client.query(
        `UPDATE ${quote(mapping.target)}
            SET ${quote(targetColumn)} = $1
          WHERE ${quote(primaryTarget)} = $2`,
        [update.import_value, update.import_key]
      );
    }
  }
  await mapping.afterImport?.(client);
};

const importOneTable = async (
  client: PoolClient,
  source: SourceAnalysis,
  manifest: SourceTableManifest
): Promise<void> => {
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    const current = await targetManifest(client, manifest.mapping);
    if (current.rows !== 0) {
      throw new Error(
        `PostgreSQL target table ${manifest.mapping.target} is not empty before import`
      );
    }
    await insertSourceRows(source.database, client, manifest.mapping);
    assertManifest(manifest, await targetManifest(client, manifest.mapping));
    await client.query(
      `INSERT INTO ${IMPORT_TABLE_STATE}
         (source_fingerprint, source_table, target_table, row_count,
          checksum, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'complete', $6)`,
      [
        source.fingerprint,
        manifest.mapping.source,
        manifest.mapping.target,
        manifest.rows,
        manifest.checksum,
        Date.now(),
      ]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
};

const validateCompletedImport = async (
  client: PoolClient,
  source: SourceAnalysis,
  report: SQLiteToPostgresMigrationReport
): Promise<void> => {
  const completed = await readJournalTables(client, source.fingerprint);
  for (const [index, manifest] of source.tables.entries()) {
    const journal = completed.get(manifest.mapping.source);
    if (
      !journal ||
      journal.target_table !== manifest.mapping.target ||
      safeCount(journal.row_count) !== manifest.rows ||
      journal.checksum !== manifest.checksum
    ) {
      throw new Error(
        `SQLite import journal is incomplete for ${manifest.mapping.source}`
      );
    }
    assertManifest(manifest, await targetManifest(client, manifest.mapping));
    report.tables[index]!.status = 'verified';
  }
};

const phaseContext = (
  source: SourceAnalysis,
  target: PostgresQueryExecutor
): SQLiteToPostgresMigrationPhaseContext => ({
  sourceDatabase: source.database,
  sourcePath: source.sourcePath,
  target,
  sourceFingerprint: source.fingerprint,
});

const applyStoragePhases = async (
  client: PoolClient,
  source: SourceAnalysis,
  report: SQLiteToPostgresMigrationReport,
  resume: boolean
): Promise<void> => {
  for (const [index, phase] of source.phases.entries()) {
    await phase.implementation.apply({
      ...phaseContext(source, client),
      resume,
    });
    report.phases[index]!.status = resume ? 'resumed' : 'imported';
    await phase.implementation.validate(phaseContext(source, client));
    report.phases[index]!.status = 'verified';
  }
};

const validateStoragePhases = async (
  client: PoolClient,
  source: SourceAnalysis,
  report: SQLiteToPostgresMigrationReport
): Promise<void> => {
  for (const [index, phase] of source.phases.entries()) {
    await phase.implementation.validate(phaseContext(source, client));
    report.phases[index]!.status = 'verified';
  }
};

const applyImport = async (
  database: PostgresDatabase,
  source: SourceAnalysis,
  report: SQLiteToPostgresMigrationReport,
  resume: boolean
): Promise<void> => {
  await database.withClient(async client => {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [IMPORT_LOCK]);
    let primaryError: unknown;
    try {
      await createImportJournal(client);
      const imports = await client.query<ImportRow>(
        `SELECT source_fingerprint, status FROM ${IMPORT_TABLE} FOR UPDATE`
      );
      if (imports.rows.length > 1) {
        throw new Error(
          'PostgreSQL contains multiple SQLite import identities'
        );
      }
      const existing = imports.rows[0];
      if (existing && existing.source_fingerprint !== source.fingerprint) {
        throw new Error(
          'PostgreSQL was already associated with a different SQLite snapshot'
        );
      }
      if (!existing) {
        const present = await targetTablesPresent(client);
        if (!(await targetIsEmpty(client, present))) {
          throw new Error(
            'PostgreSQL target is not empty and has no matching SQLite import journal'
          );
        }
        await client.query(
          `INSERT INTO ${IMPORT_TABLE}
             (source_fingerprint, source_schema_version, status, table_count,
              created_at, updated_at)
           VALUES ($1, $2, 'running', $3, $4, $4)`,
          [
            source.fingerprint,
            source.schemaVersion,
            source.tables.length,
            Date.now(),
          ]
        );
      } else if (existing.status === 'complete') {
        report.resumed = true;
        await validateCompletedImport(client, source, report);
        await validateStoragePhases(client, source, report);
        return;
      } else if (!resume) {
        throw new Error(
          'A matching SQLite import is incomplete; rerun explicitly with resume enabled'
        );
      } else {
        report.resumed = true;
        await client.query(
          `UPDATE ${IMPORT_TABLE}
              SET status = 'running', updated_at = $2
            WHERE source_fingerprint = $1`,
          [source.fingerprint, Date.now()]
        );
      }

      await updateCompatibility(client, 'migrating', 'sqlite_import_running');
      const completed = await readJournalTables(client, source.fingerprint);
      let storageApplied = false;
      for (const [index, manifest] of source.tables.entries()) {
        const journal = completed.get(manifest.mapping.source);
        if (journal) {
          if (
            journal.target_table !== manifest.mapping.target ||
            safeCount(journal.row_count) !== manifest.rows ||
            journal.checksum !== manifest.checksum
          ) {
            throw new Error(
              `SQLite import journal mismatch for ${manifest.mapping.source}`
            );
          }
          assertManifest(
            manifest,
            await targetManifest(client, manifest.mapping)
          );
          report.tables[index]!.status = 'resumed';
        } else {
          await importOneTable(client, source, manifest);
          report.tables[index]!.status = 'imported';
        }
        if (manifest.mapping.source === 'users') {
          await applyStoragePhases(client, source, report, resume);
          storageApplied = true;
        }
      }
      if (!storageApplied) {
        throw new Error(
          'SQLite import did not reach the storage phase boundary'
        );
      }
      await validateCompletedImport(client, source, report);
      await validateStoragePhases(client, source, report);
      const finishedAt = Date.now();
      await client.query(
        `UPDATE ${IMPORT_TABLE}
            SET status = 'complete', updated_at = $2, completed_at = $2
          WHERE source_fingerprint = $1`,
        [source.fingerprint, finishedAt]
      );
      const completedStructure = await inspectPostgresSchema(
        client,
        POSTGRES_MIGRATIONS
      );
      if (!completedStructure.compatible) {
        throw new Error(
          `Completed SQLite import produced incompatible PostgreSQL structure: ${completedStructure.problems
            .slice(0, 8)
            .join(', ')}`
        );
      }
      await updateCompatibility(
        client,
        'compatible',
        null,
        completedStructure.fingerprint
      );
    } catch (error) {
      primaryError = error;
      await client
        .query(
          `UPDATE ${IMPORT_TABLE}
              SET status = 'failed', updated_at = $2
            WHERE source_fingerprint = $1`,
          [source.fingerprint, Date.now()]
        )
        .catch(() => undefined);
      await updateCompatibility(
        client,
        'incompatible',
        'sqlite_import_incomplete'
      ).catch(() => undefined);
    }
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [
        IMPORT_LOCK,
      ]);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
    if (primaryError) throw primaryError;
  });
};

/**
 * Copy the relational SQLite domains into a clean PostgreSQL schema. The
 * source is inspected through a private immutable snapshot, ciphertext is
 * copied as opaque bytes/text, and each target table is verified before its
 * journal row commits. Physical blobs and encrypted embedded vectors require
 * their storage-aware migration and therefore fail closed here.
 */
export const migrateSQLiteToPostgres = async (
  options: SQLiteToPostgresMigrationOptions
): Promise<SQLiteToPostgresMigrationReport> =>
  withSourceSnapshot(
    options.sourcePath,
    options.sourcePluginsPath,
    async sourceDatabase => {
      try {
        const source = await analyzeSource(
          sourceDatabase,
          path.resolve(options.sourcePath),
          options.storagePhase
        );
        const database = createPostgresDatabase(options.postgres);
        try {
          let target = await inspectTarget(database);
          let report = baseReport(options.mode, source, target, 'planned');

          if (options.mode === 'dry-run') return report;
          if (source.blockers.length > 0) {
            throw new SQLiteToPostgresMigrationError(
              'SQLite source contains storage state that requires a coordinated blob/vector migration',
              report
            );
          }

          if (options.mode === 'validate') {
            if (!target.initialized || !target.structurallyCompatible) {
              throw new SQLiteToPostgresMigrationError(
                'PostgreSQL target schema is not structurally compatible',
                report
              );
            }
            if (
              target.importStatus !== 'complete' ||
              target.importFingerprint !== source.fingerprint
            ) {
              throw new SQLiteToPostgresMigrationError(
                'PostgreSQL target does not contain the completed import for this SQLite snapshot',
                report
              );
            }
            await database.withClient(async client => {
              await validateCompletedImport(client, source, report);
              await validateStoragePhases(client, source, report);
            });
            report.compatible = true;
            return report;
          }

          if (!target.initialized) {
            await runPostgresMigrationCoordinator(
              database,
              {
                migrationMode: 'apply',
                migrationLockTimeoutMs: options.postgres.migrationLockTimeoutMs,
              },
              POSTGRES_MIGRATIONS
            );
            target = await inspectTarget(database);
            report = baseReport(options.mode, source, target, 'planned');
          } else if (!target.structurallyCompatible) {
            throw new SQLiteToPostgresMigrationError(
              'PostgreSQL target schema is not structurally compatible',
              report
            );
          }

          await applyImport(database, source, report, options.resume === true);
          report.compatible = true;
          report.targetInitialized = true;
          report.targetSchemaVersion = POSTGRES_MIGRATIONS.length;
          return report;
        } catch (error) {
          if (error instanceof SQLiteToPostgresMigrationError) throw error;
          throw new SQLiteToPostgresMigrationError(
            error instanceof Error ? error.message : 'SQLite import failed'
          );
        } finally {
          await database.close().catch(() => undefined);
        }
      } finally {
        await options.storagePhase?.close?.().catch(() => undefined);
      }
    }
  );
