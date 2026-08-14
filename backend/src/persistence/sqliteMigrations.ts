/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type Database from 'better-sqlite3';
import {
  SQLITE_BLOB_QUOTA_SCHEMA_SQL,
  SQLITE_BLOB_REFERENCE_SCHEMA_SQL,
} from '../platform/storage/storageSchemaContracts.js';
export {
  SQLITE_BLOB_QUOTA_SCHEMA_SQL,
  SQLITE_BLOB_REFERENCE_SCHEMA_SQL,
} from '../platform/storage/storageSchemaContracts.js';

const MIGRATION_TABLE = '_libre_schema_migrations';

const LEGACY_REQUIRED_SCHEMA = {
  users: [
    'id',
    'username',
    'email',
    'password_hash',
    'role',
    'account_status',
    'approved_at',
    'approved_by',
    'avatar',
    'created_at',
    'updated_at',
  ],
  personas: [
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
  sessions: [
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
  session_folders: ['id', 'user_id', 'name', 'created_at', 'updated_at'],
  knowledge_collections: ['id', 'user_id', 'name', 'created_at', 'updated_at'],
  notes: ['id', 'user_id', 'title', 'content', 'created_at', 'updated_at'],
  session_messages: [
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
  documents: [
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
  document_chunks: [
    'id',
    'document_id',
    'chunk_index',
    'content',
    'start_char',
    'end_char',
    'embedding',
    'created_at',
  ],
  user_preferences: [
    'id',
    'user_id',
    'key',
    'value',
    'created_at',
    'updated_at',
  ],
  system_settings: ['key', 'value', 'updated_at'],
  plugin_credentials: [
    'id',
    'user_id',
    'plugin_id',
    'api_key',
    'routing_auth_fingerprint',
    'created_at',
    'updated_at',
  ],
  plugin_variables: [
    'id',
    'user_id',
    'plugin_id',
    'variable_name',
    'variable_value',
    'is_encrypted',
    'created_at',
    'updated_at',
  ],
  plugin_discovered_models: [
    'user_id',
    'plugin_id',
    'models_json',
    'updated_at',
  ],
  plugin_discovered_capability_models: [
    'user_id',
    'plugin_id',
    'capability',
    'models_json',
    'updated_at',
  ],
  plugin_activations: ['user_id', 'plugin_id', 'activated_at'],
  plugin_definition_approvals: [
    'plugin_id',
    'definition_fingerprint',
    'source_path',
    'approved_by_user_id',
    'approved_at',
  ],
  plugin_usage_events: [
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
  voice_profiles: [
    'id',
    'user_id',
    'name',
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
  generated_images: [
    'id',
    'user_id',
    'kind',
    'prompt',
    'model',
    'plugin_id',
    'image_data',
    'mime_type',
    'size',
    'quality',
    'metadata',
    'created_at',
  ],
  media_generation_jobs: [
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
  work_policies: [
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
  work_tasks: [
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
    'preview_url',
    'preview_status',
    'policy_id',
    'created_at',
    'updated_at',
  ],
  work_runs: [
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
  work_messages: [
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
  persona_memories: [
    'id',
    'user_id',
    'persona_id',
    'content',
    'embedding',
    'timestamp',
    'context',
    'importance_score',
    'memory_type',
    'access_count',
    'last_accessed',
    'decay_factor',
    'consolidated_from',
  ],
  persona_states: [
    'persona_id',
    'user_id',
    'runtime_state',
    'mutation_log',
    'last_updated',
    'version',
  ],
} as const;

/**
 * SQLite vector storage is application schema, not adapter-owned scratch
 * state. Keep this statement immutable after release and add a new migration
 * for every later schema change.
 */
export const PLATFORM_VECTOR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS platform_vector_entries (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK(dimensions > 0),
    embedding_version TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, owner_user_id, id)
  );

  CREATE TABLE IF NOT EXISTS platform_vector_acl (
    namespace TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    vector_id TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK(principal_type IN ('user', 'group')),
    principal_id TEXT NOT NULL,
    PRIMARY KEY (
      namespace,
      owner_user_id,
      vector_id,
      principal_type,
      principal_id
    ),
    FOREIGN KEY (namespace, owner_user_id, vector_id)
      REFERENCES platform_vector_entries(namespace, owner_user_id, id)
      ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS platform_vector_attributes (
    namespace TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    vector_id TEXT NOT NULL,
    attribute_key TEXT NOT NULL,
    attribute_value TEXT NOT NULL,
    PRIMARY KEY (namespace, owner_user_id, vector_id, attribute_key),
    FOREIGN KEY (namespace, owner_user_id, vector_id)
      REFERENCES platform_vector_entries(namespace, owner_user_id, id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_platform_vectors_scope
    ON platform_vector_entries(
      namespace,
      model,
      dimensions,
      embedding_version,
      owner_user_id
    );
  CREATE INDEX IF NOT EXISTS idx_platform_vectors_resource
    ON platform_vector_entries(namespace, resource_id, owner_user_id);
  CREATE INDEX IF NOT EXISTS idx_platform_vector_acl_principal
    ON platform_vector_acl(
      principal_type,
      principal_id,
      namespace,
      owner_user_id,
      vector_id
    );
  CREATE INDEX IF NOT EXISTS idx_platform_vector_attributes_lookup
    ON platform_vector_attributes(
      attribute_key,
      attribute_value,
      namespace,
      owner_user_id,
      vector_id
    );
`;

/**
 * Solo-mode durable jobs and the transactional event log. The event table is
 * also the local outbox: every job transition appends to it in the same
 * transaction, and consumers replay its monotonic global cursor.
 */
export const DURABLE_JOBS_EVENTS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS platform_jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(
      state IN ('queued', 'running', 'succeeded', 'cancelled', 'dead_letter')
    ),
    payload_format TEXT NOT NULL CHECK(
      payload_format IN ('encrypted', 'reference')
    ),
    payload TEXT NOT NULL,
    idempotency_scope TEXT NOT NULL,
    idempotency_key_hash TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
    available_at INTEGER NOT NULL,
    lease_owner TEXT,
    lease_token INTEGER NOT NULL DEFAULT 0 CHECK(lease_token >= 0),
    lease_expires_at INTEGER,
    cancellation_requested_at INTEGER,
    cancellation_reason TEXT,
    progress_current INTEGER NOT NULL DEFAULT 0 CHECK(progress_current >= 0),
    progress_total INTEGER NOT NULL DEFAULT 100 CHECK(progress_total > 0),
    progress_message TEXT,
    result_reference TEXT,
    error_code TEXT,
    error_summary TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    UNIQUE (actor_user_id, idempotency_scope, idempotency_key_hash),
    CHECK(progress_current <= progress_total),
    CHECK(
      (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR
      (state != 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
  );

  CREATE TABLE IF NOT EXISTS platform_job_attempts (
    job_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
    lease_token INTEGER NOT NULL CHECK(lease_token > 0),
    worker_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT NOT NULL CHECK(
      outcome IN (
        'running',
        'succeeded',
        'retry_scheduled',
        'cancelled',
        'dead_letter',
        'abandoned'
      )
    ),
    error_code TEXT,
    error_summary TEXT,
    PRIMARY KEY (job_id, attempt_number),
    UNIQUE (job_id, lease_token),
    FOREIGN KEY (job_id) REFERENCES platform_jobs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS platform_event_stream_heads (
    stream_id TEXT PRIMARY KEY,
    last_sequence INTEGER NOT NULL CHECK(last_sequence >= 0)
  );

  CREATE TABLE IF NOT EXISTS platform_events (
    global_cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    stream_id TEXT NOT NULL,
    stream_sequence INTEGER NOT NULL CHECK(stream_sequence > 0),
    event_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    actor_user_id TEXT,
    payload_format TEXT NOT NULL CHECK(
      payload_format IN ('encrypted', 'reference')
    ),
    payload TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    UNIQUE (stream_id, stream_sequence),
    FOREIGN KEY (stream_id) REFERENCES platform_event_stream_heads(stream_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_platform_jobs_claim
    ON platform_jobs(state, available_at, lease_expires_at, priority, created_at);
  CREATE INDEX IF NOT EXISTS idx_platform_jobs_actor_created
    ON platform_jobs(actor_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_platform_job_attempts_worker
    ON platform_job_attempts(worker_id, outcome, last_heartbeat_at);
  CREATE INDEX IF NOT EXISTS idx_platform_events_stream_cursor
    ON platform_events(stream_id, global_cursor);
  CREATE INDEX IF NOT EXISTS idx_platform_events_occurred
    ON platform_events(occurred_at, global_cursor);
`;

const PLATFORM_VECTOR_REQUIRED_SCHEMA = {
  platform_vector_entries: [
    'namespace',
    'id',
    'owner_user_id',
    'resource_id',
    'model',
    'dimensions',
    'embedding_version',
    'source_revision',
    'embedding',
    'created_at',
    'updated_at',
  ],
  platform_vector_acl: [
    'namespace',
    'owner_user_id',
    'vector_id',
    'principal_type',
    'principal_id',
  ],
  platform_vector_attributes: [
    'namespace',
    'owner_user_id',
    'vector_id',
    'attribute_key',
    'attribute_value',
  ],
} as const;

const DURABLE_JOBS_EVENTS_REQUIRED_SCHEMA = {
  platform_jobs: [
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
  platform_job_attempts: [
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
  platform_event_stream_heads: ['stream_id', 'last_sequence'],
  platform_events: [
    'global_cursor',
    'event_id',
    'stream_id',
    'stream_sequence',
    'event_type',
    'subject_id',
    'actor_user_id',
    'payload_format',
    'payload',
    'occurred_at',
  ],
} as const;

const IDENTITY_EMAIL_LOOKUP_REQUIRED_SCHEMA = {
  users: ['email_lookup'],
} as const;

const BLOB_REFERENCE_REQUIRED_SCHEMA = {
  platform_blob_references: [
    'blob_id',
    'owner_user_id',
    'resource_type',
    'resource_id',
    'purpose',
    'created_at',
  ],
} as const;

const BLOB_QUOTA_REQUIRED_SCHEMA = {
  platform_blob_quota_usage: [
    'owner_user_id',
    'stored_bytes',
    'reserved_bytes',
    'updated_at',
  ],
  platform_blob_quota_reservations: [
    'id',
    'owner_user_id',
    'purpose',
    'reserved_bytes',
    'consumed_bytes',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  platform_blob_quota_objects: [
    'blob_id',
    'owner_user_id',
    'purpose',
    'stored_bytes',
    'created_at',
  ],
} as const;

const VOICE_PROFILE_NAME_LOOKUP_REQUIRED_SCHEMA = {
  voice_profiles: ['name_lookup'],
} as const;

const PLUGIN_DEFINITION_REQUIRED_SCHEMA = {
  plugin_definitions: [
    'plugin_id',
    'definition_json',
    'definition_fingerprint',
    'approved_by_user_id',
    'approved_at',
    'created_at',
    'updated_at',
  ],
} as const;

const WORK_PREVIEW_UPSTREAM_REQUIRED_SCHEMA = {
  work_tasks: ['preview_upstream_host', 'preview_upstream_port'],
} as const;

const DURABLE_EVENT_IDEMPOTENCY_REQUIRED_SCHEMA = {
  platform_events: ['request_fingerprint'],
} as const;

const RESOURCE_DELETION_LIFECYCLE_REQUIRED_SCHEMA = {
  platform_resource_deletion_tombstones: [
    'resource_type',
    'resource_id',
    'owner_user_id',
    'deletion_incarnation',
    'deletion_token',
    'deleted_at',
    'completed_at',
  ],
} as const;

export const IDENTITY_EMAIL_LOOKUP_SCHEMA_SQL = `
  ALTER TABLE users ADD COLUMN email_lookup TEXT;
  CREATE UNIQUE INDEX idx_users_email_lookup
    ON users(email_lookup)
    WHERE email_lookup IS NOT NULL;
`;

export const VOICE_PROFILE_NAME_LOOKUP_SCHEMA_SQL = `
  ALTER TABLE voice_profiles ADD COLUMN name_lookup TEXT;
  CREATE UNIQUE INDEX idx_voice_profiles_name_lookup
    ON voice_profiles(user_id, plugin_id, model, name_lookup)
    WHERE name_lookup IS NOT NULL;
`;

export const PLUGIN_DEFINITION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS plugin_definitions (
    plugin_id TEXT PRIMARY KEY,
    definition_json TEXT NOT NULL,
    definition_fingerprint TEXT NOT NULL,
    approved_by_user_id TEXT,
    approved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (approved_by_user_id IS NULL AND approved_at IS NULL)
      OR
      (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
    )
  );

  CREATE INDEX IF NOT EXISTS idx_plugin_definitions_updated
    ON plugin_definitions(updated_at DESC, plugin_id);
`;

export const IDENTITY_ACCOUNT_RETIREMENT_SCHEMA_SQL = `
  CREATE TABLE users__retiring_v9 (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    email_lookup TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    account_status TEXT NOT NULL DEFAULT 'active'
      CHECK(account_status IN ('pending', 'active', 'retiring')),
    approved_at INTEGER,
    approved_by TEXT,
    avatar TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export const WORK_PREVIEW_UPSTREAM_SCHEMA_SQL = `
  ALTER TABLE work_tasks ADD COLUMN preview_upstream_host TEXT
    CHECK (
      preview_upstream_host IS NULL
      OR length(preview_upstream_host) BETWEEN 1 AND 253
    );
  ALTER TABLE work_tasks ADD COLUMN preview_upstream_port INTEGER
    CHECK (
      preview_upstream_port IS NULL
      OR preview_upstream_port BETWEEN 1 AND 65535
    );
`;

export const DURABLE_EVENT_IDEMPOTENCY_SCHEMA_SQL = `
  ALTER TABLE platform_events ADD COLUMN request_fingerprint TEXT NOT NULL
    DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
    CHECK (
      length(request_fingerprint) = 64
      AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    );
`;

export const RESOURCE_DELETION_LIFECYCLE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS platform_resource_deletion_tombstones (
    resource_type TEXT NOT NULL
      CHECK (resource_type IN ('document', 'generated-media', 'persona')),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
    owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 256),
    deletion_incarnation INTEGER NOT NULL CHECK (deletion_incarnation > 0),
    deletion_token TEXT NOT NULL UNIQUE
      CHECK (
        length(deletion_token) = 64
        AND deletion_token NOT GLOB '*[^0-9a-f]*'
      ),
    deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0),
    completed_at INTEGER CHECK (
      completed_at IS NULL OR completed_at >= deleted_at
    ),
    PRIMARY KEY (resource_type, resource_id)
  );

  CREATE INDEX IF NOT EXISTS idx_platform_resource_tombstones_owner
    ON platform_resource_deletion_tombstones(
      owner_user_id,
      deleted_at,
      resource_type,
      resource_id
    );
`;

const REQUIRED_SCHEMA = {
  ...LEGACY_REQUIRED_SCHEMA,
  users: [
    ...LEGACY_REQUIRED_SCHEMA.users,
    ...IDENTITY_EMAIL_LOOKUP_REQUIRED_SCHEMA.users,
  ],
  voice_profiles: [
    ...LEGACY_REQUIRED_SCHEMA.voice_profiles,
    ...VOICE_PROFILE_NAME_LOOKUP_REQUIRED_SCHEMA.voice_profiles,
  ],
  ...PLATFORM_VECTOR_REQUIRED_SCHEMA,
  ...DURABLE_JOBS_EVENTS_REQUIRED_SCHEMA,
  ...BLOB_REFERENCE_REQUIRED_SCHEMA,
  ...PLUGIN_DEFINITION_REQUIRED_SCHEMA,
} as const;

const LEGACY_ADDITIVE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  users: ['avatar', 'account_status', 'approved_at', 'approved_by'],
  personas: ['embedding_model', 'memory_settings', 'mutation_settings'],
  sessions: [
    'persona_id',
    'provider_type',
    'provider_id',
    'archived',
    'settings',
    'folder_id',
    'pinned',
  ],
  session_messages: [
    'thinking',
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
  documents: ['file_type', 'size', 'session_id', 'collection_id'],
  plugin_credentials: ['routing_auth_fingerprint'],
  plugin_definition_approvals: ['source_path'],
  generated_images: ['kind', 'plugin_id', 'mime_type', 'metadata'],
  voice_profiles: ['routing_fingerprint'],
  work_tasks: ['provider_type', 'provider_id', 'host_path', 'policy_id'],
  work_runs: ['provider_type', 'provider_id'],
  persona_memories: [
    'memory_type',
    'access_count',
    'last_accessed',
    'decay_factor',
    'consolidated_from',
  ],
};

const LEGACY_BOOTSTRAP_CORE_TABLES = [
  'users',
  'sessions',
  'session_messages',
  'documents',
  'document_chunks',
  'user_preferences',
  'system_settings',
  'personas',
] as const;

export type SchemaCompatibilityStatus =
  'uninitialized' | 'migrating' | 'compatible' | 'incompatible';

export interface SchemaCompatibilityState {
  dialect: 'sqlite';
  status: SchemaCompatibilityStatus;
  currentVersion: number;
  targetVersion: number;
  minimumSupportedVersion: number;
  reason?: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export interface SQLiteSchemaInspection {
  dialect: 'sqlite';
  status: SchemaCompatibilityStatus;
  compatible: boolean;
  ledgerPresent: boolean;
  currentVersion: number;
  targetVersion: number;
  minimumSupportedVersion: number;
  missing: string[];
  appliedMigrations: Array<{
    version: number;
    name: string;
    checksum: string;
    checksumMatches: boolean;
  }>;
  reason?: string;
}

interface SQLiteMigration {
  version: number;
  name: string;
  checksum: string;
  apply(database: Database.Database): void;
  requiresForeignKeysDisabled?: boolean;
}

interface AppliedMigrationValidation {
  currentVersion: number;
  legacyPlatformVectorChecksumRepairRequired: boolean;
}

const addColumnIfMissing = (
  database: Database.Database,
  table: string,
  column: string,
  definition: string
): void => {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{
    name: string;
  }>;
  if (!columns.some(item => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
};

const ensurePersonaPersistence = (database: Database.Database): void => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS persona_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding BLOB,
      timestamp INTEGER NOT NULL,
      context TEXT,
      importance_score REAL DEFAULT 0.5,
      memory_type TEXT DEFAULT 'general',
      access_count INTEGER DEFAULT 0,
      last_accessed INTEGER,
      decay_factor REAL DEFAULT 1.0,
      consolidated_from TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS persona_states (
      persona_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      runtime_state TEXT NOT NULL,
      mutation_log TEXT NOT NULL,
      last_updated INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
    );
  `);

  addColumnIfMissing(
    database,
    'persona_memories',
    'memory_type',
    "TEXT DEFAULT 'general'"
  );
  addColumnIfMissing(
    database,
    'persona_memories',
    'access_count',
    'INTEGER DEFAULT 0'
  );
  addColumnIfMissing(
    database,
    'persona_memories',
    'last_accessed',
    'INTEGER DEFAULT NULL'
  );
  addColumnIfMissing(
    database,
    'persona_memories',
    'decay_factor',
    'REAL DEFAULT 1.0'
  );
  addColumnIfMissing(
    database,
    'persona_memories',
    'consolidated_from',
    'TEXT DEFAULT NULL'
  );

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_persona_memories_user_persona
      ON persona_memories(user_id, persona_id);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_timestamp
      ON persona_memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_importance
      ON persona_memories(importance_score);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_type
      ON persona_memories(memory_type);
    CREATE INDEX IF NOT EXISTS idx_persona_memories_last_accessed
      ON persona_memories(last_accessed);
    CREATE INDEX IF NOT EXISTS idx_persona_states_user
      ON persona_states(user_id);
    CREATE INDEX IF NOT EXISTS idx_persona_states_updated
      ON persona_states(last_updated);
  `);
};

type RequiredSchema = Readonly<Record<string, readonly string[]>>;

interface RequiredForeignKey {
  table: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete: 'CASCADE' | 'SET NULL';
}

interface RequiredIndex {
  name: string;
  table: string;
  columns: readonly string[];
  unique?: boolean;
  sqlFragment?: string;
}

const REQUIRED_PRIMARY_KEYS: Readonly<Record<string, readonly string[]>> = {
  [MIGRATION_TABLE]: ['version'],
  users: ['id'],
  personas: ['id'],
  sessions: ['id'],
  session_messages: ['id'],
  plugin_credentials: ['id'],
  work_tasks: ['id'],
  work_runs: ['id'],
  work_messages: ['id'],
  persona_memories: ['id'],
  persona_states: ['persona_id'],
  platform_vector_entries: ['namespace', 'owner_user_id', 'id'],
  platform_vector_acl: [
    'namespace',
    'owner_user_id',
    'vector_id',
    'principal_type',
    'principal_id',
  ],
  platform_vector_attributes: [
    'namespace',
    'owner_user_id',
    'vector_id',
    'attribute_key',
  ],
  platform_jobs: ['id'],
  platform_job_attempts: ['job_id', 'attempt_number'],
  platform_event_stream_heads: ['stream_id'],
  platform_events: ['global_cursor'],
  platform_blob_references: ['blob_id'],
  platform_blob_quota_usage: ['owner_user_id'],
  platform_blob_quota_reservations: ['id'],
  platform_blob_quota_objects: ['blob_id'],
  plugin_definitions: ['plugin_id'],
  platform_resource_deletion_tombstones: ['resource_type', 'resource_id'],
};

const REQUIRED_UNIQUE_KEYS: Readonly<Record<string, readonly string[][]>> = {
  [MIGRATION_TABLE]: [['name']],
  users: [['username'], ['email']],
  plugin_credentials: [['user_id', 'plugin_id']],
  work_tasks: [['volume_name'], ['container_name']],
  work_messages: [['task_id', 'message_index']],
  platform_jobs: [
    ['actor_user_id', 'idempotency_scope', 'idempotency_key_hash'],
  ],
  platform_job_attempts: [['job_id', 'lease_token']],
  platform_events: [['event_id'], ['stream_id', 'stream_sequence']],
  platform_blob_references: [['resource_type', 'resource_id', 'purpose']],
  platform_resource_deletion_tombstones: [['deletion_token']],
};

const REQUIRED_FOREIGN_KEYS: readonly RequiredForeignKey[] = [
  {
    table: 'sessions',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'session_messages',
    columns: ['session_id'],
    referencedTable: 'sessions',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'plugin_credentials',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'work_tasks',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'work_runs',
    columns: ['task_id'],
    referencedTable: 'work_tasks',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'work_messages',
    columns: ['task_id'],
    referencedTable: 'work_tasks',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'work_messages',
    columns: ['run_id'],
    referencedTable: 'work_runs',
    referencedColumns: ['id'],
    onDelete: 'SET NULL',
  },
  {
    table: 'persona_memories',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'persona_memories',
    columns: ['persona_id'],
    referencedTable: 'personas',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'persona_states',
    columns: ['persona_id'],
    referencedTable: 'personas',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'platform_vector_acl',
    columns: ['namespace', 'owner_user_id', 'vector_id'],
    referencedTable: 'platform_vector_entries',
    referencedColumns: ['namespace', 'owner_user_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'platform_vector_attributes',
    columns: ['namespace', 'owner_user_id', 'vector_id'],
    referencedTable: 'platform_vector_entries',
    referencedColumns: ['namespace', 'owner_user_id', 'id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'platform_job_attempts',
    columns: ['job_id'],
    referencedTable: 'platform_jobs',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'platform_events',
    columns: ['stream_id'],
    referencedTable: 'platform_event_stream_heads',
    referencedColumns: ['stream_id'],
    onDelete: 'CASCADE',
  },
];

const REQUIRED_INDEXES: readonly RequiredIndex[] = [
  {
    name: 'idx_users_email_lookup',
    table: 'users',
    columns: ['email_lookup'],
    unique: true,
    sqlFragment: 'WHERE email_lookup IS NOT NULL',
  },
  {
    name: 'idx_voice_profiles_name_lookup',
    table: 'voice_profiles',
    columns: ['user_id', 'plugin_id', 'model', 'name_lookup'],
    unique: true,
    sqlFragment: 'WHERE name_lookup IS NOT NULL',
  },
  {
    name: 'idx_plugin_definitions_updated',
    table: 'plugin_definitions',
    columns: ['updated_at', 'plugin_id'],
  },
  {
    name: 'idx_sessions_user_id',
    table: 'sessions',
    columns: ['user_id'],
  },
  {
    name: 'idx_session_messages_session_id',
    table: 'session_messages',
    columns: ['session_id'],
  },
  {
    name: 'idx_plugin_credentials_user_id',
    table: 'plugin_credentials',
    columns: ['user_id'],
  },
  {
    name: 'idx_work_runs_one_active',
    table: 'work_runs',
    columns: ['task_id'],
    unique: true,
    sqlFragment: "WHERE status IN ('queued', 'preparing', 'running')",
  },
  {
    name: 'idx_platform_vectors_scope',
    table: 'platform_vector_entries',
    columns: [
      'namespace',
      'model',
      'dimensions',
      'embedding_version',
      'owner_user_id',
    ],
  },
  {
    name: 'idx_platform_vectors_resource',
    table: 'platform_vector_entries',
    columns: ['namespace', 'resource_id', 'owner_user_id'],
  },
  {
    name: 'idx_platform_vector_acl_principal',
    table: 'platform_vector_acl',
    columns: [
      'principal_type',
      'principal_id',
      'namespace',
      'owner_user_id',
      'vector_id',
    ],
  },
  {
    name: 'idx_platform_vector_attributes_lookup',
    table: 'platform_vector_attributes',
    columns: [
      'attribute_key',
      'attribute_value',
      'namespace',
      'owner_user_id',
      'vector_id',
    ],
  },
  {
    name: 'idx_platform_jobs_claim',
    table: 'platform_jobs',
    columns: [
      'state',
      'available_at',
      'lease_expires_at',
      'priority',
      'created_at',
    ],
  },
  {
    name: 'idx_platform_jobs_actor_created',
    table: 'platform_jobs',
    columns: ['actor_user_id', 'created_at'],
  },
  {
    name: 'idx_platform_job_attempts_worker',
    table: 'platform_job_attempts',
    columns: ['worker_id', 'outcome', 'last_heartbeat_at'],
  },
  {
    name: 'idx_platform_events_stream_cursor',
    table: 'platform_events',
    columns: ['stream_id', 'global_cursor'],
  },
  {
    name: 'idx_platform_events_occurred',
    table: 'platform_events',
    columns: ['occurred_at', 'global_cursor'],
  },
  {
    name: 'idx_platform_blob_references_owner',
    table: 'platform_blob_references',
    columns: ['owner_user_id', 'purpose', 'created_at'],
  },
  {
    name: 'idx_platform_blob_references_resource',
    table: 'platform_blob_references',
    columns: ['resource_type', 'resource_id'],
  },
  {
    name: 'idx_platform_blob_quota_reservations_expiry',
    table: 'platform_blob_quota_reservations',
    columns: ['expires_at', 'id'],
  },
  {
    name: 'idx_platform_blob_quota_reservations_owner',
    table: 'platform_blob_quota_reservations',
    columns: ['owner_user_id', 'expires_at'],
  },
  {
    name: 'idx_platform_blob_quota_objects_owner',
    table: 'platform_blob_quota_objects',
    columns: ['owner_user_id', 'purpose', 'created_at'],
  },
  {
    name: 'idx_platform_resource_tombstones_owner',
    table: 'platform_resource_deletion_tombstones',
    columns: ['owner_user_id', 'deleted_at', 'resource_type', 'resource_id'],
  },
];

const REQUIRED_TABLE_SQL_FRAGMENTS: Readonly<
  Record<string, readonly string[]>
> = {
  platform_vector_entries: ['CHECK(dimensions > 0)'],
  platform_vector_acl: ["CHECK(principal_type IN ('user', 'group'))"],
  platform_jobs: [
    "state IN ('queued', 'running', 'succeeded', 'cancelled', 'dead_letter')",
    "payload_format IN ('encrypted', 'reference')",
    'UNIQUE (actor_user_id, idempotency_scope, idempotency_key_hash)',
    "state = 'running' AND lease_owner IS NOT NULL",
  ],
  platform_job_attempts: [
    "outcome IN ('running', 'succeeded', 'retry_scheduled', 'cancelled', 'dead_letter', 'abandoned')",
  ],
  platform_events: [
    "payload_format IN ('encrypted', 'reference')",
    'UNIQUE (stream_id, stream_sequence)',
  ],
  platform_blob_quota_usage: [
    'CHECK(stored_bytes >= 0)',
    'CHECK(reserved_bytes >= 0)',
  ],
  platform_blob_quota_reservations: [
    'CHECK(reserved_bytes >= 0)',
    'CHECK(consumed_bytes >= 0)',
  ],
  platform_blob_quota_objects: ['CHECK(stored_bytes >= 0)'],
  plugin_definitions: ['approved_by_user_id IS NULL AND approved_at IS NULL'],
  platform_resource_deletion_tombstones: [
    "resource_type IN ('document', 'generated-media', 'persona')",
    'CHECK(deletion_incarnation > 0)',
  ],
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replace(/"/g, '""')}"`;

const normalizeSql = (sql: string): string =>
  sql
    .toLowerCase()
    .replace(/["`]/g, '')
    .replace(/\[/g, '')
    .replace(/\]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),>])\s*/g, '$1')
    .trim();

const normalizeSchemaObjectSql = (sql: string): string =>
  sql
    .trim()
    .replace(/^CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+/, 'CREATE $1 ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),>])\s*/g, '$1');

interface CanonicalSchemaObject {
  type: 'table' | 'index';
  name: string;
  table: string;
  sql: string;
}

const CANONICAL_PLATFORM_VECTOR_SCHEMA_OBJECTS: readonly CanonicalSchemaObject[] =
  PLATFORM_VECTOR_SCHEMA_SQL.split(';')
    .map(statement => statement.trim())
    .filter(Boolean)
    .map(statement => {
      const declaration =
        /^CREATE\s+(TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/i.exec(
          statement
        );
      if (!declaration) {
        throw new Error('Invalid canonical platform vector schema statement');
      }
      const type = declaration[1]?.toLowerCase() as 'table' | 'index';
      const name = declaration[2] as string;
      const indexTarget =
        type === 'index'
          ? /\bON\s+([A-Za-z0-9_]+)/i.exec(statement)?.[1]
          : undefined;
      if (type === 'index' && !indexTarget) {
        throw new Error('Invalid canonical platform vector index statement');
      }
      return Object.freeze({
        type,
        name,
        table: indexTarget ?? name,
        sql: normalizeSchemaObjectSql(statement),
      });
    });

/**
 * Compare migration v2's complete declared schema identity, not only its
 * columns. This covers column definitions, keys, foreign keys, checks, and
 * every explicit index while rejecting additional indexes or triggers on the
 * migration-owned tables.
 */
const collectPlatformVectorSchemaIdentityMismatches = (
  database: Database.Database
): string[] => {
  const expected = new Map(
    CANONICAL_PLATFORM_VECTOR_SCHEMA_OBJECTS.map(item => [item.name, item])
  );
  const ownedTables = new Set(
    CANONICAL_PLATFORM_VECTOR_SCHEMA_OBJECTS.filter(
      item => item.type === 'table'
    ).map(item => item.name)
  );
  const actual = (
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
           FROM sqlite_master
          WHERE sql IS NOT NULL
          ORDER BY type, name`
      )
      .all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string;
    }>
  ).filter(
    item =>
      expected.has(item.name) ||
      (ownedTables.has(item.tbl_name) &&
        (item.type === 'index' || item.type === 'trigger'))
  );
  const actualByName = new Map(actual.map(item => [item.name, item]));
  const mismatches: string[] = [];

  for (const item of expected.values()) {
    const observed = actualByName.get(item.name);
    if (!observed) {
      mismatches.push(`${item.name} is missing`);
      continue;
    }
    if (
      observed.type !== item.type ||
      observed.tbl_name !== item.table ||
      normalizeSchemaObjectSql(observed.sql) !== item.sql
    ) {
      mismatches.push(`${item.name} does not match its canonical definition`);
    }
  }
  for (const item of actual) {
    if (!expected.has(item.name)) {
      mismatches.push(`${item.name} is not part of migration v2`);
    }
  }
  return mismatches;
};

const sameColumns = (
  actual: readonly string[],
  expected: readonly string[]
): boolean =>
  actual.length === expected.length &&
  actual.every((column, index) => column === expected[index]);

const tableExists = (database: Database.Database, table: string): boolean =>
  Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table)
  );

const indexColumns = (
  database: Database.Database,
  indexName: string
): string[] =>
  (
    database
      .prepare(`PRAGMA index_info(${quoteIdentifier(indexName)})`)
      .all() as Array<{ seqno: number; name: string }>
  )
    .sort((left, right) => left.seqno - right.seqno)
    .map(row => row.name);

const collectMissingColumns = (
  database: Database.Database,
  requiredSchema: RequiredSchema
): string[] => {
  const missing: string[] = [];
  for (const [table, requiredColumns] of Object.entries(requiredSchema)) {
    if (!tableExists(database, table)) {
      missing.push(`${table} (table)`);
      continue;
    }

    const columns = new Set(
      (
        database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map(column => column.name)
    );
    for (const column of requiredColumns) {
      if (!columns.has(column)) missing.push(`${table}.${column}`);
    }
  }

  return missing;
};

const collectMissingStructuralInvariants = (
  database: Database.Database,
  includeRequiredIndexes = true
): string[] => {
  const missing: string[] = [];

  for (const [table, expectedColumns] of Object.entries(
    REQUIRED_PRIMARY_KEYS
  )) {
    if (!tableExists(database, table)) continue;
    const actualColumns = (
      database
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all() as Array<{ name: string; pk: number }>
    )
      .filter(column => column.pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(column => column.name);
    if (!sameColumns(actualColumns, expectedColumns)) {
      missing.push(`${table} primary key (${expectedColumns.join(', ')})`);
    }
  }

  for (const [table, expectedKeys] of Object.entries(REQUIRED_UNIQUE_KEYS)) {
    if (!tableExists(database, table)) continue;
    const indexes = database
      .prepare(`PRAGMA index_list(${quoteIdentifier(table)})`)
      .all() as Array<{ name: string; unique: number }>;
    const uniqueColumns = indexes
      .filter(index => index.unique === 1)
      .map(index => indexColumns(database, index.name));
    for (const expectedColumns of expectedKeys) {
      if (
        !uniqueColumns.some(columns => sameColumns(columns, expectedColumns))
      ) {
        missing.push(`${table} unique (${expectedColumns.join(', ')})`);
      }
    }
  }

  for (const required of REQUIRED_FOREIGN_KEYS) {
    if (!tableExists(database, required.table)) continue;
    const rows = database
      .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(required.table)})`)
      .all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const grouped = new Map<number, typeof rows>();
    for (const row of rows) {
      const group = grouped.get(row.id) ?? [];
      group.push(row);
      grouped.set(row.id, group);
    }
    const found = [...grouped.values()].some(group => {
      const ordered = [...group].sort((left, right) => left.seq - right.seq);
      return (
        ordered[0]?.table === required.referencedTable &&
        ordered[0]?.on_delete.toUpperCase() === required.onDelete &&
        sameColumns(
          ordered.map(row => row.from),
          required.columns
        ) &&
        sameColumns(
          ordered.map(row => row.to),
          required.referencedColumns
        )
      );
    });
    if (!found) {
      missing.push(
        `${required.table} foreign key (${required.columns.join(', ')}) -> ` +
          `${required.referencedTable} (${required.referencedColumns.join(', ')}) ` +
          `on delete ${required.onDelete}`
      );
    }
  }

  for (const required of includeRequiredIndexes ? REQUIRED_INDEXES : []) {
    if (!tableExists(database, required.table)) continue;
    const row = database
      .prepare(
        "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = ?"
      )
      .get(required.name) as
      { tbl_name: string; sql: string | null } | undefined;
    const indexList = database
      .prepare(`PRAGMA index_list(${quoteIdentifier(required.table)})`)
      .all() as Array<{ name: string; unique: number }>;
    const listEntry = indexList.find(index => index.name === required.name);
    if (
      !row ||
      row.tbl_name !== required.table ||
      !listEntry ||
      !sameColumns(indexColumns(database, required.name), required.columns) ||
      (required.unique === true && listEntry.unique !== 1) ||
      (required.sqlFragment !== undefined &&
        !normalizeSql(row.sql ?? '').includes(
          normalizeSql(required.sqlFragment)
        ))
    ) {
      missing.push(`index ${required.name} (${required.columns.join(', ')})`);
    }
  }

  for (const [table, fragments] of Object.entries(
    REQUIRED_TABLE_SQL_FRAGMENTS
  )) {
    if (!tableExists(database, table)) continue;
    const row = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(table) as { sql: string | null } | undefined;
    const normalized = normalizeSql(row?.sql ?? '');
    for (const fragment of fragments) {
      if (!normalized.includes(normalizeSql(fragment))) {
        missing.push(`${table} constraint ${fragment}`);
      }
    }
  }

  return missing;
};

const collectMissingSchema = (database: Database.Database): string[] => [
  ...collectMissingColumns(database, REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database),
  ...collectMissingIdentityAccountRetirementSchema(database),
  ...collectMissingWorkPreviewUpstreamSchema(database),
  ...collectMissingDurableEventIdempotencySchema(database),
  ...collectMissingResourceDeletionLifecycleSchema(database),
];

const collectMissingMigrationLedgerSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, {
    [MIGRATION_TABLE]: ['version', 'name', 'checksum', 'applied_at'],
  }),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes(MIGRATION_TABLE)
  ),
];

const collectMissingLegacySchema = (database: Database.Database): string[] => [
  ...collectMissingColumns(database, LEGACY_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      !item.includes('platform_') &&
      !item.includes('idx_users_email_lookup') &&
      !item.includes('idx_voice_profiles_name_lookup')
  ),
];

const collectMissingIdentityEmailLookupSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, IDENTITY_EMAIL_LOOKUP_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('idx_users_email_lookup')
  ),
];

const collectMissingPlatformVectorSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, PLATFORM_VECTOR_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('platform_vector')
  ),
];

const collectMissingDurableJobsEventsSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, DURABLE_JOBS_EVENTS_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('platform_job') ||
      item.includes('platform_event') ||
      item.includes('durable job')
  ),
];

const collectMissingBlobReferenceSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, BLOB_REFERENCE_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('platform_blob_reference')
  ),
];

const collectMissingBlobQuotaSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, BLOB_QUOTA_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('platform_blob_quota')
  ),
];

const collectMissingVoiceProfileNameLookupSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, VOICE_PROFILE_NAME_LOOKUP_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('idx_voice_profiles_name_lookup')
  ),
];

const collectMissingPluginDefinitionSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, PLUGIN_DEFINITION_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('plugin_definition')
  ),
];

const collectMissingWorkPreviewUpstreamSchema = (
  database: Database.Database
): string[] =>
  collectMissingColumns(database, WORK_PREVIEW_UPSTREAM_REQUIRED_SCHEMA);

const collectMissingDurableEventIdempotencySchema = (
  database: Database.Database
): string[] =>
  collectMissingColumns(database, DURABLE_EVENT_IDEMPOTENCY_REQUIRED_SCHEMA);

const collectMissingResourceDeletionLifecycleSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(
    database,
    RESOURCE_DELETION_LIFECYCLE_REQUIRED_SCHEMA
  ),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('platform_resource_deletion_tombstones')
  ),
];

const collectMissingIdentityAccountRetirementSchema = (
  database: Database.Database
): string[] => {
  const row = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'"
    )
    .get() as { sql: string | null } | undefined;
  const normalized = normalizeSql(row?.sql ?? '');
  return normalized.includes(
    normalizeSql("account_status IN ('pending', 'active', 'retiring')")
  )
    ? []
    : ['users account_status retiring constraint'];
};

function collectMissingSchemaAtVersion(
  database: Database.Database,
  version: number
): string[] {
  if (version <= 0) return collectMissingLegacyBootstrapSchema(database);
  return [
    ...collectMissingLegacySchema(database),
    ...(version >= 2 ? collectMissingPlatformVectorSchema(database) : []),
    ...(version >= 3 ? collectMissingDurableJobsEventsSchema(database) : []),
    ...(version >= 4 ? collectMissingIdentityEmailLookupSchema(database) : []),
    ...(version >= 5 ? collectMissingBlobReferenceSchema(database) : []),
    ...(version >= 6
      ? collectMissingVoiceProfileNameLookupSchema(database)
      : []),
    ...(version >= 7 ? collectMissingPluginDefinitionSchema(database) : []),
    ...(version >= 8 ? collectMissingBlobQuotaSchema(database) : []),
    ...(version >= 9
      ? collectMissingIdentityAccountRetirementSchema(database)
      : []),
    ...(version >= 10 ? collectMissingWorkPreviewUpstreamSchema(database) : []),
    ...(version >= 11
      ? collectMissingDurableEventIdempotencySchema(database)
      : []),
    ...(version >= 12
      ? collectMissingResourceDeletionLifecycleSchema(database)
      : []),
  ];
}

const collectMissingLegacyBootstrapSchema = (
  database: Database.Database
): string[] => {
  const knownTables = Object.keys(LEGACY_REQUIRED_SCHEMA).filter(table =>
    tableExists(database, table)
  );
  if (knownTables.length === 0) return [];

  const missing: string[] = [];
  for (const table of LEGACY_BOOTSTRAP_CORE_TABLES) {
    if (!tableExists(database, table)) missing.push(`${table} (table)`);
  }

  const existingHistoricalSchema = Object.fromEntries(
    knownTables.map(table => {
      const additive = new Set(LEGACY_ADDITIVE_COLUMNS[table] ?? []);
      return [
        table,
        LEGACY_REQUIRED_SCHEMA[
          table as keyof typeof LEGACY_REQUIRED_SCHEMA
        ].filter(column => !additive.has(column)),
      ];
    })
  );
  missing.push(
    ...collectMissingColumns(database, existingHistoricalSchema),
    // Inline bootstrap safely recreates named indexes. Keys, foreign keys,
    // uniqueness, and table constraints cannot be repaired additively and
    // therefore must already be trustworthy.
    ...collectMissingStructuralInvariants(database, false).filter(
      item => !item.includes(MIGRATION_TABLE)
    )
  );
  return [...new Set(missing)];
};

const validateCurrentSchema = (database: Database.Database): void => {
  const missing = collectMissingSchema(database);
  if (missing.length > 0) {
    throw new Error(
      `SQLite schema is incomplete; missing ${missing.slice(0, 20).join(', ')}${
        missing.length > 20 ? ` and ${missing.length - 20} more` : ''
      }`
    );
  }
};

// Released ledger checksums are immutable protocol constants. In particular,
// v1 must never change when the current required schema grows.
const BASELINE_MIGRATION_CHECKSUM =
  '6027d48757e31a6d2a65819c46a5b641bfd9a8bde50628757e2d682ec3e320bf';
const PLATFORM_VECTOR_MIGRATION_CHECKSUM =
  '633f4d535c207fb212764f4fddf43536678a3f02e8ccad52628b7223d17b00d5';
const LEGACY_PLATFORM_VECTOR_MIGRATION_CHECKSUM = 'VECTOR_CHECKSUM_TO_FREEZE';
const DURABLE_JOBS_EVENTS_MIGRATION_CHECKSUM =
  'dbc2cfa903c0ab173acc2e29f9aa576b7ba744816fb819492271c39a4fbd23de';
const IDENTITY_EMAIL_LOOKUP_MIGRATION_CHECKSUM =
  'abac261ef3848667aa3ad5dbb47c123b119cadbc0738c167c9b9d35b057a43a0';
const BLOB_REFERENCE_MIGRATION_CHECKSUM =
  '84a2c0cf783c81f46e90c73ae2e62ca80b89669e672767f94af7ea5d37098b79';
const VOICE_PROFILE_NAME_LOOKUP_MIGRATION_CHECKSUM =
  '6162d4feb454f812ea1ddf88c472943f1fc07da5933c29986d4b8b27d6156df6';
const PLUGIN_DEFINITION_MIGRATION_CHECKSUM =
  '7092b4bb02ad71be4ef7d6106ed5bab6d5b76e9ec8d98f36f7a8a6c3a70c84c6';
const BLOB_QUOTA_MIGRATION_CHECKSUM =
  'c6dd6ff729b92dc935aacd5ea236bbbf6f8f455999abd3ab8f687457ec0ca998';
const IDENTITY_ACCOUNT_RETIREMENT_MIGRATION_CHECKSUM =
  '72c57042dd74cba8b1b22395bfe7942e62e269a0041706711094565fb6860657';
const WORK_PREVIEW_UPSTREAM_MIGRATION_CHECKSUM =
  'aa2023e736da5a2b63ab2e39c378a3c43fc6f40be9318eec1397dff83c4a9358';
const DURABLE_EVENT_IDEMPOTENCY_MIGRATION_CHECKSUM =
  'fe9aee7dc21dc4ca6a5bdcd0fcd5788104501f68bc2c72e83faf9b6ce6514d44';
const RESOURCE_DELETION_LIFECYCLE_MIGRATION_CHECKSUM =
  'a72e862afe109daf68b7ec8e445ef359bc3550a5ac8973d135cf7a18eb5bf1cc';

const MIGRATIONS: readonly SQLiteMigration[] = [
  {
    version: 1,
    name: 'adopt-current-schema',
    checksum: BASELINE_MIGRATION_CHECKSUM,
    apply(database) {
      ensurePersonaPersistence(database);
      const missing = collectMissingLegacySchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 2,
    name: 'platform-vector-storage',
    checksum: PLATFORM_VECTOR_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(PLATFORM_VECTOR_SCHEMA_SQL);
      const missing = collectMissingPlatformVectorSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite vector schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 3,
    name: 'durable-jobs-events',
    checksum: DURABLE_JOBS_EVENTS_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(DURABLE_JOBS_EVENTS_SCHEMA_SQL);
      const missing = collectMissingDurableJobsEventsSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite durable jobs schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 4,
    name: 'identity-email-lookup',
    checksum: IDENTITY_EMAIL_LOOKUP_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(database, 'users', 'email_lookup', 'TEXT');
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lookup
          ON users(email_lookup)
          WHERE email_lookup IS NOT NULL;
      `);
      const missing = collectMissingIdentityEmailLookupSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite identity email lookup schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 5,
    name: 'blob-references',
    checksum: BLOB_REFERENCE_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(SQLITE_BLOB_REFERENCE_SCHEMA_SQL);
      const missing = collectMissingBlobReferenceSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite blob reference schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 6,
    name: 'voice-profile-name-lookup',
    checksum: VOICE_PROFILE_NAME_LOOKUP_MIGRATION_CHECKSUM,
    apply(database) {
      // Existing names are encrypted with per-record authenticated data, so
      // the adapter backfills their keyed lookup after migrations complete.
      addColumnIfMissing(database, 'voice_profiles', 'name_lookup', 'TEXT');
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_profiles_name_lookup
          ON voice_profiles(user_id, plugin_id, model, name_lookup)
          WHERE name_lookup IS NOT NULL;
      `);
      const missing = collectMissingVoiceProfileNameLookupSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite voice profile lookup schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 7,
    name: 'shared-plugin-definitions',
    checksum: PLUGIN_DEFINITION_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(PLUGIN_DEFINITION_SCHEMA_SQL);
      const missing = collectMissingPluginDefinitionSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite plugin definition schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 8,
    name: 'blob-quotas',
    checksum: BLOB_QUOTA_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(SQLITE_BLOB_QUOTA_SCHEMA_SQL);
      const missing = collectMissingBlobQuotaSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite blob quota schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 9,
    name: 'identity-account-retirement',
    checksum: IDENTITY_ACCOUNT_RETIREMENT_MIGRATION_CHECKSUM,
    requiresForeignKeysDisabled: true,
    apply(database) {
      database.exec(IDENTITY_ACCOUNT_RETIREMENT_SCHEMA_SQL);
      database.exec(`
        INSERT INTO users__retiring_v9 (
          id, username, email, email_lookup, password_hash, role,
          account_status, approved_at, approved_by, avatar, created_at,
          updated_at
        )
        SELECT id, username, email, email_lookup, password_hash, role,
               account_status, approved_at, approved_by, avatar, created_at,
               updated_at
          FROM users;
        DROP TABLE users;
        ALTER TABLE users__retiring_v9 RENAME TO users;
        CREATE UNIQUE INDEX idx_users_email_lookup
          ON users(email_lookup)
          WHERE email_lookup IS NOT NULL;
      `);
      const missing = collectMissingIdentityAccountRetirementSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite account retirement schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 10,
    name: 'work-preview-upstream',
    checksum: WORK_PREVIEW_UPSTREAM_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(
        database,
        'work_tasks',
        'preview_upstream_host',
        `TEXT CHECK (
          preview_upstream_host IS NULL
          OR length(preview_upstream_host) BETWEEN 1 AND 253
        )`
      );
      addColumnIfMissing(
        database,
        'work_tasks',
        'preview_upstream_port',
        `INTEGER CHECK (
          preview_upstream_port IS NULL
          OR preview_upstream_port BETWEEN 1 AND 65535
        )`
      );
      const missing = collectMissingWorkPreviewUpstreamSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite Work preview upstream schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 11,
    name: 'durable-event-idempotency',
    checksum: DURABLE_EVENT_IDEMPOTENCY_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(
        database,
        'platform_events',
        'request_fingerprint',
        `TEXT NOT NULL
          DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
          CHECK (
            length(request_fingerprint) = 64
            AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
          )`
      );
      const missing = collectMissingDurableEventIdempotencySchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite durable event idempotency schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 12,
    name: 'resource-deletion-lifecycle',
    checksum: RESOURCE_DELETION_LIFECYCLE_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(RESOURCE_DELETION_LIFECYCLE_SCHEMA_SQL);
      const missing = collectMissingResourceDeletionLifecycleSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite resource deletion lifecycle schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
];

/** Public, read-only migration identities for adapters and conformance tests. */
export const SQLITE_MIGRATION_CONTRACT = Object.freeze(
  MIGRATIONS.map(migration =>
    Object.freeze({
      version: migration.version,
      name: migration.name,
      checksum: migration.checksum,
    })
  )
);

const targetVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
const minimumSupportedVersion = 1;

const readAppliedMigrations = (
  database: Database.Database
): AppliedMigrationRow[] =>
  database
    .prepare(
      `SELECT version, name, checksum
       FROM ${MIGRATION_TABLE}
       ORDER BY version ASC`
    )
    .all() as AppliedMigrationRow[];

const validateAppliedMigrations = (
  applied: readonly AppliedMigrationRow[],
  options: { allowLegacyPlatformVectorChecksum?: boolean } = {}
): AppliedMigrationValidation => {
  const currentVersion = applied[applied.length - 1]?.version ?? 0;
  let legacyPlatformVectorChecksumRepairRequired = false;
  if (currentVersion > targetVersion) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than supported version ${targetVersion}`
    );
  }

  for (const [index, row] of applied.entries()) {
    if (row.version !== index + 1) {
      throw new Error(
        `Database migration sequence has a gap before version ${row.version}`
      );
    }
    const expected = MIGRATIONS.find(item => item.version === row.version);
    if (!expected) {
      throw new Error(`Unknown database migration version ${row.version}`);
    }
    if (row.name !== expected.name) {
      throw new Error(
        `Database migration ${row.version} name mismatch: expected ${expected.name}`
      );
    }
    if (row.checksum !== expected.checksum) {
      if (
        options.allowLegacyPlatformVectorChecksum === true &&
        row.version === 2 &&
        row.name === 'platform-vector-storage' &&
        row.checksum === LEGACY_PLATFORM_VECTOR_MIGRATION_CHECKSUM
      ) {
        legacyPlatformVectorChecksumRepairRequired = true;
        continue;
      }
      throw new Error(
        `Database migration ${row.version} checksum mismatch for ${row.name}`
      );
    }
  }
  return {
    currentVersion,
    legacyPlatformVectorChecksumRepairRequired,
  };
};

const validateAppliedMigrationsForLiveRepair = (
  database: Database.Database,
  applied: readonly AppliedMigrationRow[]
): AppliedMigrationValidation => {
  const validation = validateAppliedMigrations(applied, {
    allowLegacyPlatformVectorChecksum: true,
  });
  if (validation.legacyPlatformVectorChecksumRepairRequired) {
    const mismatches = collectPlatformVectorSchemaIdentityMismatches(database);
    if (mismatches.length > 0) {
      throw new Error(
        'Database migration 2 legacy checksum cannot be repaired because ' +
          `the platform vector schema is not canonical: ${mismatches.join(', ')}`
      );
    }
  }
  return validation;
};

/**
 * Fail closed unless checksummed migration v2 installed the complete vector
 * schema. Storage adapters must never create application tables themselves.
 */
export function assertPlatformVectorMigrationReady(
  database: Database.Database
): void {
  if (!tableExists(database, MIGRATION_TABLE)) {
    throw new Error('The SQLite migration ledger is missing');
  }
  const { currentVersion } = validateAppliedMigrations(
    readAppliedMigrations(database)
  );
  if (currentVersion < 2) {
    throw new Error(
      'Platform vector storage requires SQLite migration version 2'
    );
  }
  const missing = collectMissingPlatformVectorSchema(database);
  if (missing.length > 0) {
    throw new Error(
      `SQLite vector schema is incomplete; missing ${missing.join(', ')}`
    );
  }
}

/** Fail closed unless checksummed migration v3 installed durable job state. */
export function assertDurableJobMigrationReady(
  database: Database.Database
): void {
  if (!tableExists(database, MIGRATION_TABLE)) {
    throw new Error('The SQLite migration ledger is missing');
  }
  const { currentVersion } = validateAppliedMigrations(
    readAppliedMigrations(database)
  );
  if (currentVersion < 11) {
    throw new Error('Durable jobs require SQLite migration version 11');
  }
  const missing = [
    ...collectMissingDurableJobsEventsSchema(database),
    ...collectMissingDurableEventIdempotencySchema(database),
  ];
  if (missing.length > 0) {
    throw new Error(
      `SQLite durable jobs schema is incomplete; missing ${missing.join(', ')}`
    );
  }
}

/**
 * Inspect an open SQLite database without changing it. Recovery and health
 * checks use the same contract and checksums as the startup coordinator.
 */
export function inspectSQLiteSchema(
  database: Database.Database
): SQLiteSchemaInspection {
  const missingSchema = collectMissingSchema(database);
  const ledgerPresent = Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(MIGRATION_TABLE)
  );
  if (!ledgerPresent) {
    const missingBootstrap = collectMissingLegacyBootstrapSchema(database);
    const canBootstrap = missingBootstrap.length === 0;
    return {
      dialect: 'sqlite',
      status: canBootstrap ? 'uninitialized' : 'incompatible',
      compatible: false,
      ledgerPresent: false,
      currentVersion: 0,
      targetVersion,
      minimumSupportedVersion,
      missing: missingSchema,
      appliedMigrations: [],
      reason: canBootstrap
        ? 'Migration ledger has not been adopted'
        : `SQLite ledgerless schema is incompatible; missing ${missingBootstrap.join(', ')}`,
    };
  }

  const missingLedger = collectMissingMigrationLedgerSchema(database);
  const missing = [...missingLedger, ...missingSchema];
  if (missingLedger.length > 0) {
    return {
      dialect: 'sqlite',
      status: 'incompatible',
      compatible: false,
      ledgerPresent: true,
      currentVersion: 0,
      targetVersion,
      minimumSupportedVersion,
      missing,
      appliedMigrations: [],
      reason: `SQLite migration ledger is incompatible; missing ${missingLedger.join(', ')}`,
    };
  }

  let applied: AppliedMigrationRow[];
  try {
    applied = readAppliedMigrations(database);
  } catch (error) {
    return {
      dialect: 'sqlite',
      status: 'incompatible',
      compatible: false,
      ledgerPresent: true,
      currentVersion: 0,
      targetVersion,
      minimumSupportedVersion,
      missing,
      appliedMigrations: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const appliedMigrations = applied.map(row => {
    const expected = MIGRATIONS.find(item => item.version === row.version);
    return {
      ...row,
      checksumMatches:
        expected?.name === row.name && expected.checksum === row.checksum,
    };
  });
  const currentVersion = applied[applied.length - 1]?.version ?? 0;
  let reason: string | undefined;
  let canMigrate = false;
  if (currentVersion > targetVersion) {
    reason = `Database schema version ${currentVersion} is newer than supported version ${targetVersion}`;
  } else {
    const invalid = appliedMigrations.find(
      (row, index) => row.version !== index + 1 || !row.checksumMatches
    );
    if (invalid) {
      try {
        const validation = validateAppliedMigrationsForLiveRepair(
          database,
          applied
        );
        const requiredAtCurrentVersion = collectMissingSchemaAtVersion(
          database,
          validation.currentVersion
        );
        if (
          validation.legacyPlatformVectorChecksumRepairRequired &&
          requiredAtCurrentVersion.length === 0
        ) {
          reason =
            'Database migration 2 uses a recognized historical checksum and requires canonical repair';
          canMigrate = true;
        } else {
          reason = `Database migration ${invalid.version} ledger entry does not match the application migration`;
        }
      } catch {
        reason = `Database migration ${invalid.version} ledger entry does not match the application migration`;
      }
    } else if (currentVersion < targetVersion) {
      const requiredAtCurrentVersion = collectMissingSchemaAtVersion(
        database,
        currentVersion
      );
      if (requiredAtCurrentVersion.length === 0) {
        reason = `Database schema version ${currentVersion} requires migration to version ${targetVersion}`;
        canMigrate = true;
      } else {
        reason =
          `SQLite schema is incompatible at migration version ${currentVersion}; ` +
          `missing ${requiredAtCurrentVersion.join(', ')}`;
      }
    } else if (missing.length > 0) {
      reason = `SQLite schema is incomplete; missing ${missing.join(', ')}`;
    }
  }
  const compatible = reason === undefined;
  return {
    dialect: 'sqlite',
    status: compatible
      ? 'compatible'
      : canMigrate
        ? 'migrating'
        : 'incompatible',
    compatible,
    ledgerPresent: true,
    currentVersion,
    targetVersion,
    minimumSupportedVersion,
    missing,
    appliedMigrations,
    ...(reason ? { reason } : {}),
  };
}

let compatibilityState: SchemaCompatibilityState = {
  dialect: 'sqlite',
  status: 'uninitialized',
  currentVersion: 0,
  targetVersion,
  minimumSupportedVersion,
};

export const getSchemaCompatibilityState = (): SchemaCompatibilityState => ({
  ...compatibilityState,
});

const updateIncompatible = (
  currentVersion: number,
  error: unknown
): SchemaCompatibilityState => {
  const reason = error instanceof Error ? error.message : String(error);
  compatibilityState = {
    dialect: 'sqlite',
    status: 'incompatible',
    currentVersion,
    targetVersion,
    minimumSupportedVersion,
    reason,
  };
  return getSchemaCompatibilityState();
};

export const recordSQLiteSchemaFailure = (
  error: unknown
): SchemaCompatibilityState =>
  updateIncompatible(compatibilityState.currentVersion, error);

/**
 * Validate an existing migration ledger without changing the database. This
 * must run before historical inline initialization so an unsupported or
 * tampered database cannot be partially upgraded before startup fails.
 */
export function preflightSQLiteMigrationLedger(
  database: Database.Database
): SchemaCompatibilityState {
  if (!tableExists(database, MIGRATION_TABLE)) {
    compatibilityState = {
      dialect: 'sqlite',
      status: 'uninitialized',
      currentVersion: 0,
      targetVersion,
      minimumSupportedVersion,
    };
    return getSchemaCompatibilityState();
  }

  const missingLedger = collectMissingMigrationLedgerSchema(database);
  if (missingLedger.length > 0) {
    const error = new Error(
      `SQLite migration ledger is incompatible; missing ${missingLedger.join(', ')}`
    );
    updateIncompatible(0, error);
    throw error;
  }
  const applied = readAppliedMigrations(database);
  const observedVersion = applied[applied.length - 1]?.version ?? 0;
  try {
    const { currentVersion, legacyPlatformVectorChecksumRepairRequired } =
      validateAppliedMigrationsForLiveRepair(database, applied);
    const missing = collectMissingSchemaAtVersion(database, currentVersion);
    if (missing.length > 0) {
      throw new Error(
        `SQLite schema is incompatible at migration version ${currentVersion}; ` +
          `missing ${missing.slice(0, 20).join(', ')}${
            missing.length > 20 ? ` and ${missing.length - 20} more` : ''
          }`
      );
    }
    compatibilityState = {
      dialect: 'sqlite',
      status:
        currentVersion === targetVersion &&
        !legacyPlatformVectorChecksumRepairRequired
          ? 'compatible'
          : 'migrating',
      currentVersion,
      targetVersion,
      minimumSupportedVersion,
    };
    return getSchemaCompatibilityState();
  } catch (error) {
    updateIncompatible(observedVersion, error);
    throw error;
  }
}

/**
 * Read-only compatibility check for the pre-ledger bootstrap boundary. It
 * accepts a fresh database and supported additive legacy shapes, but rejects
 * structural damage that the atomic inline migration cannot safely repair.
 */
export function preflightSQLiteBootstrapSchema(
  database: Database.Database
): SchemaCompatibilityState {
  if (tableExists(database, MIGRATION_TABLE)) {
    return preflightSQLiteMigrationLedger(database);
  }

  const missing = collectMissingLegacyBootstrapSchema(database);
  if (missing.length > 0) {
    const error = new Error(
      `SQLite ledgerless schema is incompatible; missing ${missing
        .slice(0, 20)
        .join(', ')}${
        missing.length > 20 ? ` and ${missing.length - 20} more` : ''
      }`
    );
    updateIncompatible(0, error);
    throw error;
  }

  compatibilityState = {
    dialect: 'sqlite',
    status: 'uninitialized',
    currentVersion: 0,
    targetVersion,
    minimumSupportedVersion,
  };
  return getSchemaCompatibilityState();
}

/**
 * Adopt the legacy inline schema into a numbered, checksummed migration ledger.
 * Every subsequent startup verifies both the ledger and the required schema.
 */
export function runSQLiteMigrationCoordinator(
  database: Database.Database
): SchemaCompatibilityState {
  let currentVersion = 0;
  compatibilityState = {
    dialect: 'sqlite',
    status: 'migrating',
    currentVersion,
    targetVersion,
    minimumSupportedVersion,
  };

  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);

    const applied = readAppliedMigrations(database);
    currentVersion = applied[applied.length - 1]?.version ?? 0;
    const validation = validateAppliedMigrationsForLiveRepair(
      database,
      applied
    );
    currentVersion = validation.currentVersion;
    const missingAtCurrentVersion = collectMissingSchemaAtVersion(
      database,
      currentVersion
    );
    if (missingAtCurrentVersion.length > 0) {
      throw new Error(
        `SQLite schema is incompatible at migration version ${currentVersion}; ` +
          `missing ${missingAtCurrentVersion.slice(0, 20).join(', ')}${
            missingAtCurrentVersion.length > 20
              ? ` and ${missingAtCurrentVersion.length - 20} more`
              : ''
          }`
      );
    }
    if (validation.legacyPlatformVectorChecksumRepairRequired) {
      database.transaction(() => {
        const repairValidation = validateAppliedMigrationsForLiveRepair(
          database,
          readAppliedMigrations(database)
        );
        if (
          !repairValidation.legacyPlatformVectorChecksumRepairRequired ||
          repairValidation.currentVersion !== currentVersion
        ) {
          throw new Error(
            'Database migration ledger changed during legacy checksum repair'
          );
        }
        const repairMissing = collectMissingSchemaAtVersion(
          database,
          repairValidation.currentVersion
        );
        if (repairMissing.length > 0) {
          throw new Error(
            `SQLite schema is incompatible at migration version ${repairValidation.currentVersion}; ` +
              `missing ${repairMissing.slice(0, 20).join(', ')}${
                repairMissing.length > 20
                  ? ` and ${repairMissing.length - 20} more`
                  : ''
              }`
          );
        }
        const result = database
          .prepare(
            `UPDATE ${MIGRATION_TABLE}
                SET checksum = ?
              WHERE version = 2
                AND name = 'platform-vector-storage'
                AND checksum = ?`
          )
          .run(
            PLATFORM_VECTOR_MIGRATION_CHECKSUM,
            LEGACY_PLATFORM_VECTOR_MIGRATION_CHECKSUM
          );
        if (result.changes !== 1) {
          throw new Error(
            'Database migration 2 changed during legacy checksum repair'
          );
        }
        const repairedValidation = validateAppliedMigrations(
          readAppliedMigrations(database)
        );
        if (repairedValidation.currentVersion !== currentVersion) {
          throw new Error(
            'Database migration ledger changed during legacy checksum repair'
          );
        }
      })();
    }
    compatibilityState = {
      ...compatibilityState,
      currentVersion,
    };

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      if (migration.version !== currentVersion + 1) {
        throw new Error(
          `Database migration sequence has a gap after version ${currentVersion}`
        );
      }

      const applyMigration = (): void => {
        migration.apply(database);
        database
          .prepare(
            `INSERT INTO ${MIGRATION_TABLE}
               (version, name, checksum, applied_at)
             VALUES (?, ?, ?, ?)`
          )
          .run(
            migration.version,
            migration.name,
            migration.checksum,
            Date.now()
          );
      };
      if (migration.requiresForeignKeysDisabled) {
        const foreignKeysEnabled = database.pragma('foreign_keys', {
          simple: true,
        }) as number;
        database.pragma('foreign_keys = OFF');
        try {
          database.transaction(() => {
            applyMigration();
            const violations = database.pragma(
              'foreign_key_check'
            ) as unknown[];
            if (violations.length > 0) {
              throw new Error(
                'SQLite account retirement migration left foreign-key violations'
              );
            }
          })();
        } finally {
          database.pragma(
            `foreign_keys = ${foreignKeysEnabled === 1 ? 'ON' : 'OFF'}`
          );
        }
      } else {
        database.transaction(applyMigration)();
      }
      currentVersion = migration.version;
    }

    validateCurrentSchema(database);
    compatibilityState = {
      dialect: 'sqlite',
      status: 'compatible',
      currentVersion,
      targetVersion,
      minimumSupportedVersion,
    };
    return getSchemaCompatibilityState();
  } catch (error) {
    updateIncompatible(currentVersion, error);
    throw error;
  }
}
