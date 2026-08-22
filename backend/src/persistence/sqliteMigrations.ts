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

const TRUST_FOUNDATION_REQUIRED_SCHEMA = {
  user_groups: [
    'id',
    'name',
    'description',
    'created_by',
    'created_at',
    'updated_at',
  ],
  user_group_members: ['group_id', 'user_id', 'added_by', 'added_at'],
  resource_grants: [
    'id',
    'resource_type',
    'resource_id',
    'owner_user_id',
    'principal_type',
    'principal_id',
    'permission',
    'created_by',
    'created_at',
  ],
  auth_sessions: [
    'id',
    'user_id',
    'kind',
    'ip_hash',
    'user_agent',
    'created_at',
    'last_seen_at',
    'expires_at',
    'revoked_at',
    'revoked_by',
  ],
  api_tokens: [
    'id',
    'user_id',
    'name',
    'token_hash',
    'token_prefix',
    'scopes',
    'created_at',
    'expires_at',
    'last_used_at',
    'revoked_at',
  ],
  oauth_identities: [
    'provider',
    'subject',
    'user_id',
    'email',
    'created_at',
    'updated_at',
  ],
  security_audit_events: [
    'id',
    'occurred_at',
    'actor_user_id',
    'actor_kind',
    'action',
    'target_type',
    'target_id',
    'result',
    'request_id',
    'ip_hash',
    'details',
  ],
} as const;

const PERSONAL_AUTOMATIONS_REQUIRED_SCHEMA = {
  calendar_events: [
    'id',
    'user_id',
    'title',
    'notes',
    'start_at',
    'end_at',
    'all_day',
    'recurrence',
    'created_at',
    'updated_at',
  ],
  automations: [
    'id',
    'user_id',
    'name',
    'instructions',
    'triggers',
    'provider',
    'model',
    'notify',
    'status',
    'next_run_at',
    'last_run_at',
    'created_at',
    'updated_at',
  ],
  automation_runs: [
    'id',
    'automation_id',
    'user_id',
    'scheduled_for',
    'started_at',
    'finished_at',
    'status',
    'session_id',
    'assistant_message_id',
    'error',
    'seen_at',
    'created_at',
  ],
} as const;

const AGENT_FOUNDATION_REQUIRED_SCHEMA = {
  personas: ['bindings'],
  tool_servers: [
    'id',
    'user_id',
    'name',
    'description',
    'kind',
    'base_url',
    'spec',
    'spec_digest',
    'spec_revision',
    'auth_mode',
    'auth_header',
    'access_mode',
    'enabled',
    'timeout_ms',
    'max_response_bytes',
    'created_at',
    'updated_at',
  ],
  tool_server_tools: [
    'id',
    'server_id',
    'name',
    'description',
    'params_schema',
    'detail',
    'side_effect',
    'enabled',
    'created_at',
    'updated_at',
  ],
  tool_server_credentials: [
    'id',
    'server_id',
    'user_id',
    'secret',
    'created_at',
    'updated_at',
  ],
  tool_approvals: [
    'id',
    'user_id',
    'session_id',
    'server_id',
    'tool_name',
    'call_id',
    'arguments_digest',
    'scope',
    'status',
    'created_at',
    'resolved_at',
    'expires_at',
  ],
  prompts: [
    'id',
    'user_id',
    'slug',
    'title',
    'description',
    'content',
    'variables',
    'tags',
    'version',
    'created_at',
    'updated_at',
  ],
  prompt_versions: [
    'id',
    'prompt_id',
    'version',
    'content',
    'variables',
    'created_at',
  ],
  skills: [
    'id',
    'user_id',
    'slug',
    'name',
    'description',
    'instructions',
    'enabled',
    'version',
    'created_at',
    'updated_at',
  ],
  skill_versions: ['id', 'skill_id', 'version', 'instructions', 'created_at'],
} as const;

const SKILL_FILES_REQUIRED_SCHEMA = {
  skill_files: [
    'id',
    'skill_id',
    'path',
    'content',
    'size',
    'created_at',
    'updated_at',
  ],
} as const;

const NOTES_V2_REQUIRED_SCHEMA = {
  notes: ['pinned'],
  note_revisions: ['id', 'note_id', 'title', 'content', 'created_at'],
  note_attachments: [
    'id',
    'note_id',
    'blob_id',
    'filename',
    'content_type',
    'size',
    'created_at',
  ],
} as const;

const TEAM_COLLABORATION_REQUIRED_SCHEMA = {
  calendar_events: [
    'calendar_id',
    'reminder_minutes',
    'last_reminded_occurrence',
  ],
  calendars: ['id', 'user_id', 'name', 'color', 'created_at', 'updated_at'],
  channels: [
    'id',
    'type',
    'name',
    'description',
    'dm_key',
    'created_by',
    'created_at',
    'updated_at',
    'archived_at',
  ],
  channel_members: [
    'channel_id',
    'user_id',
    'role',
    'joined_at',
    'last_read_at',
  ],
  channel_messages: [
    'id',
    'channel_id',
    'user_id',
    'parent_id',
    'author_kind',
    'model',
    'content',
    'metadata',
    'created_at',
    'updated_at',
    'edited_at',
    'deleted_at',
    'pinned_at',
    'pinned_by',
  ],
  channel_reactions: ['id', 'message_id', 'user_id', 'emoji', 'created_at'],
  channel_attachments: [
    'id',
    'message_id',
    'channel_id',
    'blob_id',
    'filename',
    'content_type',
    'size',
    'created_by',
    'created_at',
  ],
  notifications: [
    'id',
    'user_id',
    'type',
    'title',
    'body',
    'href',
    'source_key',
    'created_at',
    'read_at',
  ],
  webhook_targets: [
    'id',
    'name',
    'url',
    'secret',
    'events',
    'enabled',
    'created_by',
    'created_at',
    'updated_at',
  ],
} as const;

const MEDIA_ENTERPRISE_OPS_REQUIRED_SCHEMA = {
  voice_profiles: [
    'consent_expires_at',
    'revoked_at',
    'transfer_count',
    'last_transfer_at',
  ],
  model_tariffs: [
    'id',
    'plugin_id',
    'model',
    'input_per_million',
    'output_per_million',
    'unit_price',
    'currency',
    'effective_from',
    'created_by',
    'created_at',
  ],
  usage_budgets: [
    'id',
    'name',
    'principal_type',
    'principal_id',
    'period',
    'amount_usd',
    'mode',
    'created_by',
    'created_at',
    'updated_at',
  ],
  message_feedback: [
    'id',
    'user_id',
    'session_id',
    'message_id',
    'rating',
    'tags',
    'comment',
    'model',
    'plugin_id',
    'snapshot',
    'created_at',
    'updated_at',
  ],
  arena_votes: [
    'id',
    'user_id',
    'compare_group',
    'model_a',
    'model_b',
    'winner',
    'created_at',
  ],
  eval_sets: [
    'id',
    'user_id',
    'name',
    'description',
    'items',
    'created_at',
    'updated_at',
  ],
  eval_runs: [
    'id',
    'set_id',
    'user_id',
    'label',
    'plugin_id',
    'model',
    'status',
    'results',
    'error',
    'created_at',
    'updated_at',
    'completed_at',
  ],
} as const;

const MFA_PUSH_RECOVERY_REQUIRED_SCHEMA = {
  user_mfa: [
    'user_id',
    'totp_secret',
    'activated_at',
    'last_used_step',
    'created_at',
    'updated_at',
  ],
  mfa_recovery_codes: ['id', 'user_id', 'code_lookup', 'created_at', 'used_at'],
  webauthn_credentials: [
    'id',
    'user_id',
    'credential_lookup',
    'credential_data',
    'name',
    'sign_count',
    'created_at',
    'last_used_at',
  ],
  push_subscriptions: [
    'id',
    'user_id',
    'session_id',
    'endpoint_lookup',
    'subscription',
    'user_agent',
    'created_at',
    'last_used_at',
  ],
  recovery_drills: [
    'id',
    'status',
    'origin',
    'started_at',
    'finished_at',
    'snapshot_bytes',
    'rpo_seconds',
    'restore_ms',
    'error',
    'report',
    'created_by',
    'created_at',
  ],
} as const;

const AUTOMATION_WORK_TARGET_REQUIRED_SCHEMA = {
  automations: ['target', 'work_policy_id'],
  automation_runs: ['work_task_id'],
} as const;

const WORK_COMPUTER_REQUIRED_SCHEMA = {
  work_policies: ['gui_enabled'],
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

export const DURABLE_EVENT_REPLAY_INDEX_SCHEMA_SQL = `
  CREATE INDEX IF NOT EXISTS idx_platform_events_stream_subject_cursor
    ON platform_events(stream_id, subject_id, global_cursor);
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

export const TRUST_FOUNDATION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS user_groups (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    description TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_group_members (
    group_id TEXT NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_group_members_user
    ON user_group_members(user_id, group_id);

  CREATE TABLE IF NOT EXISTS resource_grants (
    id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 64),
    resource_id TEXT NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
    principal_id TEXT NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (resource_type, resource_id, principal_type, principal_id)
  );

  CREATE INDEX IF NOT EXISTS idx_resource_grants_resource
    ON resource_grants(resource_type, resource_id);

  CREATE INDEX IF NOT EXISTS idx_resource_grants_principal
    ON resource_grants(principal_type, principal_id);

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ip_hash TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_user
    ON auth_sessions(user_id, last_seen_at);

  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires
    ON auth_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
    token_hash TEXT UNIQUE NOT NULL,
    token_prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_api_tokens_user
    ON api_tokens(user_id, created_at);

  CREATE TABLE IF NOT EXISTS oauth_identities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );

  CREATE INDEX IF NOT EXISTS idx_oauth_identities_user
    ON oauth_identities(user_id);

  CREATE TABLE IF NOT EXISTS security_audit_events (
    id TEXT PRIMARY KEY,
    occurred_at INTEGER NOT NULL,
    actor_user_id TEXT,
    actor_kind TEXT NOT NULL,
    action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    target_type TEXT,
    target_id TEXT,
    result TEXT NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
    request_id TEXT,
    ip_hash TEXT,
    details TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_security_audit_occurred
    ON security_audit_events(occurred_at, id);

  CREATE INDEX IF NOT EXISTS idx_security_audit_actor
    ON security_audit_events(actor_user_id, occurred_at);

  CREATE INDEX IF NOT EXISTS idx_security_audit_action
    ON security_audit_events(action, occurred_at);
`;

export const PERSONAL_AUTOMATIONS_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    notes TEXT,
    start_at INTEGER NOT NULL,
    end_at INTEGER,
    all_day INTEGER NOT NULL DEFAULT 0,
    recurrence TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_calendar_events_owner_start
    ON calendar_events(user_id, start_at);

  CREATE TABLE IF NOT EXISTS automations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL,
    triggers TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    notify TEXT NOT NULL CHECK (notify IN ('app', 'off')),
    status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
    next_run_at INTEGER,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_automations_owner
    ON automations(user_id, updated_at);

  CREATE INDEX IF NOT EXISTS idx_automations_due
    ON automations(status, next_run_at);

  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    status TEXT NOT NULL
      CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    session_id TEXT,
    assistant_message_id TEXT,
    error TEXT,
    seen_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
    ON automation_runs(automation_id, scheduled_for);

  CREATE INDEX IF NOT EXISTS idx_automation_runs_owner_time
    ON automation_runs(user_id, scheduled_for);
`;

export const AGENT_FOUNDATION_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS tool_servers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('openapi', 'mcp')),
    base_url TEXT NOT NULL,
    spec TEXT,
    spec_digest TEXT,
    spec_revision INTEGER NOT NULL DEFAULT 1,
    auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer', 'header')),
    auth_header TEXT,
    access_mode TEXT NOT NULL
      CHECK (access_mode IN ('admins-only', 'all-users', 'granted')),
    enabled INTEGER NOT NULL DEFAULT 1,
    timeout_ms INTEGER NOT NULL,
    max_response_bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tool_servers_updated
    ON tool_servers(updated_at);

  CREATE TABLE IF NOT EXISTS tool_server_tools (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES tool_servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    params_schema TEXT,
    detail TEXT,
    side_effect INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (server_id, name)
  );

  CREATE TABLE IF NOT EXISTS tool_server_credentials (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES tool_servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (server_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS tool_approvals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    server_id TEXT REFERENCES tool_servers(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    call_id TEXT,
    arguments_digest TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('once', 'session', 'always')),
    status TEXT NOT NULL
      CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    expires_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_tool_approvals_owner
    ON tool_approvals(user_id, status, created_at);

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    variables TEXT,
    tags TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, slug)
  );

  CREATE INDEX IF NOT EXISTS idx_prompts_owner
    ON prompts(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS prompt_versions (
    id TEXT PRIMARY KEY,
    prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    content TEXT NOT NULL,
    variables TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (prompt_id, version)
  );

  CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, slug)
  );

  CREATE INDEX IF NOT EXISTS idx_skills_owner
    ON skills(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS skill_versions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    instructions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (skill_id, version)
  );
`;

export const AGENT_FOUNDATION_SCHEMA_SQL = `
  ALTER TABLE personas ADD COLUMN bindings TEXT;
${AGENT_FOUNDATION_TABLES_SQL}`;

export const SKILL_FILES_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS skill_files (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (skill_id, path)
  );

  CREATE INDEX IF NOT EXISTS idx_skill_files_skill
    ON skill_files(skill_id);
`;

export const NOTES_V2_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS note_revisions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_revisions_note
    ON note_revisions(note_id, created_at);

  CREATE TABLE IF NOT EXISTS note_attachments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_attachments_note
    ON note_attachments(note_id);
`;

export const NOTES_V2_SCHEMA_SQL = `
  ALTER TABLE notes ADD COLUMN pinned INTEGER DEFAULT 0;

  CREATE TABLE IF NOT EXISTS note_revisions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_revisions_note
    ON note_revisions(note_id, created_at);

  CREATE TABLE IF NOT EXISTS note_attachments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_note_attachments_note
    ON note_attachments(note_id);
`;

export const TEAM_COLLABORATION_TABLES_SQL = `
  CREATE INDEX IF NOT EXISTS idx_calendar_scoped_events
    ON calendar_events(calendar_id)
    WHERE calendar_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS calendars (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_calendars_owner
    ON calendars(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('public', 'private', 'dm')),
    name TEXT NOT NULL,
    description TEXT,
    dm_key TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm_key
    ON channels(dm_key)
    WHERE dm_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS channel_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at INTEGER NOT NULL,
    last_read_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_channel_members_user
    ON channel_members(user_id);

  CREATE TABLE IF NOT EXISTS channel_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT,
    parent_id TEXT,
    author_kind TEXT NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'model')),
    model TEXT,
    content TEXT NOT NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    pinned_at INTEGER,
    pinned_by TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_channel_messages_timeline
    ON channel_messages(channel_id, created_at, id);

  CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
    ON channel_messages(parent_id)
    WHERE parent_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS channel_reactions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (message_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS channel_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    blob_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_channel_attachments_message
    ON channel_attachments(message_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    href TEXT,
    source_key TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_user
    ON notifications(user_id, created_at);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
    ON notifications(user_id, source_key)
    WHERE source_key IS NOT NULL;

  CREATE TABLE IF NOT EXISTS webhook_targets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    secret TEXT,
    events TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export const TEAM_COLLABORATION_SCHEMA_SQL = `
  ALTER TABLE calendar_events ADD COLUMN calendar_id TEXT;
  ALTER TABLE calendar_events ADD COLUMN reminder_minutes INTEGER;
  ALTER TABLE calendar_events ADD COLUMN last_reminded_occurrence INTEGER;
${TEAM_COLLABORATION_TABLES_SQL}`;

export const MEDIA_ENTERPRISE_OPS_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS model_tariffs (
    id TEXT PRIMARY KEY,
    plugin_id TEXT NOT NULL,
    model TEXT,
    input_per_million REAL,
    output_per_million REAL,
    unit_price REAL,
    currency TEXT NOT NULL DEFAULT 'USD',
    effective_from INTEGER NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_model_tariffs_lookup
    ON model_tariffs(plugin_id, model, effective_from);

  CREATE TABLE IF NOT EXISTS usage_budgets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('instance', 'user', 'group')),
    principal_id TEXT,
    period TEXT NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
    amount_usd REAL NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('observe', 'soft', 'hard')),
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_budgets_principal
    ON usage_budgets(principal_type, principal_id);

  CREATE TABLE IF NOT EXISTS message_feedback (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
    tags TEXT,
    comment TEXT,
    model TEXT,
    plugin_id TEXT,
    snapshot TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (user_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_message_feedback_owner
    ON message_feedback(user_id, created_at);

  CREATE TABLE IF NOT EXISTS arena_votes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    compare_group TEXT NOT NULL,
    model_a TEXT NOT NULL,
    model_b TEXT NOT NULL,
    winner TEXT NOT NULL CHECK (winner IN ('a', 'b', 'tie', 'both-bad')),
    created_at INTEGER NOT NULL,
    UNIQUE (user_id, compare_group)
  );

  CREATE INDEX IF NOT EXISTS idx_arena_votes_order
    ON arena_votes(created_at, id);

  CREATE TABLE IF NOT EXISTS eval_sets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    items TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_eval_sets_owner
    ON eval_sets(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT,
    plugin_id TEXT,
    model TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
    results TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_eval_runs_owner
    ON eval_runs(user_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_eval_runs_parent
    ON eval_runs(set_id);
`;

export const MEDIA_ENTERPRISE_OPS_SCHEMA_SQL = `
  ALTER TABLE voice_profiles ADD COLUMN consent_expires_at INTEGER;
  ALTER TABLE voice_profiles ADD COLUMN revoked_at INTEGER;
  ALTER TABLE voice_profiles ADD COLUMN transfer_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE voice_profiles ADD COLUMN last_transfer_at INTEGER;
${MEDIA_ENTERPRISE_OPS_TABLES_SQL}`;

export const MFA_PUSH_RECOVERY_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS user_mfa (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    totp_secret TEXT NOT NULL,
    activated_at INTEGER,
    last_used_step INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_lookup TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user
    ON mfa_recovery_codes(user_id);

  CREATE TABLE IF NOT EXISTS webauthn_credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential_lookup TEXT NOT NULL UNIQUE,
    credential_data TEXT NOT NULL,
    name TEXT,
    sign_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
    ON webauthn_credentials(user_id);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT,
    endpoint_lookup TEXT NOT NULL UNIQUE,
    subscription TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
    ON push_subscriptions(user_id);

  CREATE TABLE IF NOT EXISTS recovery_drills (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
    origin TEXT NOT NULL CHECK (origin IN ('scheduled', 'manual')),
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    snapshot_bytes INTEGER,
    rpo_seconds INTEGER,
    restore_ms INTEGER,
    error TEXT,
    report TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_recovery_drills_started
    ON recovery_drills(started_at);
`;

// No CHECK on target: SQLite cannot DROP a column referenced by an inline
// CHECK, which would make the documented rollback impossible. The service
// layer normalizes the value; PostgreSQL keeps a real constraint.
export const AUTOMATION_WORK_TARGET_SCHEMA_SQL = `
  ALTER TABLE automations ADD COLUMN target TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE automations ADD COLUMN work_policy_id TEXT;
  ALTER TABLE automation_runs ADD COLUMN work_task_id TEXT;
`;

export const WORK_COMPUTER_SCHEMA_SQL = `
  ALTER TABLE work_policies ADD COLUMN gui_enabled INTEGER;
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
  legacyDurableEventReplayIndexChecksumRepairRequired: boolean;
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
  user_groups: ['id'],
  user_group_members: ['group_id', 'user_id'],
  resource_grants: ['id'],
  auth_sessions: ['id'],
  api_tokens: ['id'],
  oauth_identities: ['provider', 'subject'],
  security_audit_events: ['id'],
  calendar_events: ['id'],
  automations: ['id'],
  automation_runs: ['id'],
  tool_servers: ['id'],
  tool_server_tools: ['id'],
  tool_server_credentials: ['id'],
  tool_approvals: ['id'],
  prompts: ['id'],
  prompt_versions: ['id'],
  skills: ['id'],
  skill_versions: ['id'],
  skill_files: ['id'],
  note_revisions: ['id'],
  note_attachments: ['id'],
  calendars: ['id'],
  channels: ['id'],
  channel_members: ['channel_id', 'user_id'],
  channel_messages: ['id'],
  channel_reactions: ['id'],
  channel_attachments: ['id'],
  notifications: ['id'],
  webhook_targets: ['id'],
  model_tariffs: ['id'],
  usage_budgets: ['id'],
  message_feedback: ['id'],
  arena_votes: ['id'],
  eval_sets: ['id'],
  eval_runs: ['id'],
  user_mfa: ['user_id'],
  mfa_recovery_codes: ['id'],
  webauthn_credentials: ['id'],
  push_subscriptions: ['id'],
  recovery_drills: ['id'],
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
  user_groups: [['name']],
  resource_grants: [
    ['resource_type', 'resource_id', 'principal_type', 'principal_id'],
  ],
  api_tokens: [['token_hash']],
  tool_server_tools: [['server_id', 'name']],
  tool_server_credentials: [['server_id', 'user_id']],
  prompts: [['user_id', 'slug']],
  prompt_versions: [['prompt_id', 'version']],
  skills: [['user_id', 'slug']],
  skill_versions: [['skill_id', 'version']],
  skill_files: [['skill_id', 'path']],
  message_feedback: [['user_id', 'message_id']],
  arena_votes: [['user_id', 'compare_group']],
  mfa_recovery_codes: [['code_lookup']],
  webauthn_credentials: [['credential_lookup']],
  push_subscriptions: [['endpoint_lookup']],
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
  {
    table: 'user_group_members',
    columns: ['group_id'],
    referencedTable: 'user_groups',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'user_group_members',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'resource_grants',
    columns: ['owner_user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'auth_sessions',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'api_tokens',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'oauth_identities',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'calendar_events',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'automations',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'automation_runs',
    columns: ['automation_id'],
    referencedTable: 'automations',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'automation_runs',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'tool_servers',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'tool_server_tools',
    columns: ['server_id'],
    referencedTable: 'tool_servers',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'tool_server_credentials',
    columns: ['server_id'],
    referencedTable: 'tool_servers',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'tool_server_credentials',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'tool_approvals',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'tool_approvals',
    columns: ['session_id'],
    referencedTable: 'sessions',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'prompts',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'prompt_versions',
    columns: ['prompt_id'],
    referencedTable: 'prompts',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'skills',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'skill_versions',
    columns: ['skill_id'],
    referencedTable: 'skills',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'skill_files',
    columns: ['skill_id'],
    referencedTable: 'skills',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'note_revisions',
    columns: ['note_id'],
    referencedTable: 'notes',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'note_attachments',
    columns: ['note_id'],
    referencedTable: 'notes',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'calendars',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'channel_members',
    columns: ['channel_id'],
    referencedTable: 'channels',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'channel_members',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'channel_messages',
    columns: ['channel_id'],
    referencedTable: 'channels',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'channel_reactions',
    columns: ['message_id'],
    referencedTable: 'channel_messages',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'channel_attachments',
    columns: ['message_id'],
    referencedTable: 'channel_messages',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'notifications',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'message_feedback',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'arena_votes',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'eval_sets',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'eval_runs',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'eval_runs',
    columns: ['set_id'],
    referencedTable: 'eval_sets',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'user_mfa',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'mfa_recovery_codes',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'webauthn_credentials',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
    onDelete: 'CASCADE',
  },
  {
    table: 'push_subscriptions',
    columns: ['user_id'],
    referencedTable: 'users',
    referencedColumns: ['id'],
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
    name: 'idx_platform_events_stream_subject_cursor',
    table: 'platform_events',
    columns: ['stream_id', 'subject_id', 'global_cursor'],
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
  {
    name: 'idx_user_group_members_user',
    table: 'user_group_members',
    columns: ['user_id', 'group_id'],
  },
  {
    name: 'idx_resource_grants_resource',
    table: 'resource_grants',
    columns: ['resource_type', 'resource_id'],
  },
  {
    name: 'idx_resource_grants_principal',
    table: 'resource_grants',
    columns: ['principal_type', 'principal_id'],
  },
  {
    name: 'idx_auth_sessions_user',
    table: 'auth_sessions',
    columns: ['user_id', 'last_seen_at'],
  },
  {
    name: 'idx_auth_sessions_expires',
    table: 'auth_sessions',
    columns: ['expires_at'],
  },
  {
    name: 'idx_api_tokens_user',
    table: 'api_tokens',
    columns: ['user_id', 'created_at'],
  },
  {
    name: 'idx_oauth_identities_user',
    table: 'oauth_identities',
    columns: ['user_id'],
  },
  {
    name: 'idx_security_audit_occurred',
    table: 'security_audit_events',
    columns: ['occurred_at', 'id'],
  },
  {
    name: 'idx_security_audit_actor',
    table: 'security_audit_events',
    columns: ['actor_user_id', 'occurred_at'],
  },
  {
    name: 'idx_security_audit_action',
    table: 'security_audit_events',
    columns: ['action', 'occurred_at'],
  },
  {
    name: 'idx_calendar_events_owner_start',
    table: 'calendar_events',
    columns: ['user_id', 'start_at'],
  },
  {
    name: 'idx_automations_owner',
    table: 'automations',
    columns: ['user_id', 'updated_at'],
  },
  {
    name: 'idx_automations_due',
    table: 'automations',
    columns: ['status', 'next_run_at'],
  },
  {
    name: 'idx_automation_runs_automation',
    table: 'automation_runs',
    columns: ['automation_id', 'scheduled_for'],
  },
  {
    name: 'idx_automation_runs_owner_time',
    table: 'automation_runs',
    columns: ['user_id', 'scheduled_for'],
  },
  {
    name: 'idx_tool_servers_updated',
    table: 'tool_servers',
    columns: ['updated_at'],
  },
  {
    name: 'idx_tool_approvals_owner',
    table: 'tool_approvals',
    columns: ['user_id', 'status', 'created_at'],
  },
  {
    name: 'idx_prompts_owner',
    table: 'prompts',
    columns: ['user_id', 'updated_at'],
  },
  {
    name: 'idx_skills_owner',
    table: 'skills',
    columns: ['user_id', 'updated_at'],
  },
  {
    name: 'idx_skill_files_skill',
    table: 'skill_files',
    columns: ['skill_id'],
  },
  {
    name: 'idx_note_revisions_note',
    table: 'note_revisions',
    columns: ['note_id', 'created_at'],
  },
  {
    name: 'idx_note_attachments_note',
    table: 'note_attachments',
    columns: ['note_id'],
  },
  {
    name: 'idx_calendar_scoped_events',
    table: 'calendar_events',
    columns: ['calendar_id'],
    sqlFragment: 'WHERE calendar_id IS NOT NULL',
  },
  {
    name: 'idx_calendars_owner',
    table: 'calendars',
    columns: ['user_id', 'updated_at'],
  },
  {
    name: 'idx_channels_dm_key',
    table: 'channels',
    columns: ['dm_key'],
    unique: true,
    sqlFragment: 'WHERE dm_key IS NOT NULL',
  },
  {
    name: 'idx_channel_members_user',
    table: 'channel_members',
    columns: ['user_id'],
  },
  {
    name: 'idx_channel_messages_timeline',
    table: 'channel_messages',
    columns: ['channel_id', 'created_at', 'id'],
  },
  {
    name: 'idx_channel_messages_thread',
    table: 'channel_messages',
    columns: ['parent_id'],
  },
  {
    name: 'idx_channel_attachments_message',
    table: 'channel_attachments',
    columns: ['message_id'],
  },
  {
    name: 'idx_notifications_user',
    table: 'notifications',
    columns: ['user_id', 'created_at'],
  },
  {
    name: 'idx_notifications_dedupe',
    table: 'notifications',
    columns: ['user_id', 'source_key'],
    unique: true,
    sqlFragment: 'WHERE source_key IS NOT NULL',
  },
  {
    name: 'idx_model_tariffs_lookup',
    table: 'model_tariffs',
    columns: ['plugin_id', 'model', 'effective_from'],
  },
  {
    name: 'idx_usage_budgets_principal',
    table: 'usage_budgets',
    columns: ['principal_type', 'principal_id'],
  },
  {
    name: 'idx_message_feedback_owner',
    table: 'message_feedback',
    columns: ['user_id', 'created_at'],
  },
  {
    name: 'idx_arena_votes_order',
    table: 'arena_votes',
    columns: ['created_at', 'id'],
  },
  {
    name: 'idx_eval_sets_owner',
    table: 'eval_sets',
    columns: ['user_id', 'updated_at'],
  },
  {
    name: 'idx_eval_runs_owner',
    table: 'eval_runs',
    columns: ['user_id', 'created_at'],
  },
  {
    name: 'idx_eval_runs_parent',
    table: 'eval_runs',
    columns: ['set_id'],
  },
  {
    name: 'idx_mfa_recovery_codes_user',
    table: 'mfa_recovery_codes',
    columns: ['user_id'],
  },
  {
    name: 'idx_webauthn_credentials_user',
    table: 'webauthn_credentials',
    columns: ['user_id'],
  },
  {
    name: 'idx_push_subscriptions_user',
    table: 'push_subscriptions',
    columns: ['user_id'],
  },
  {
    name: 'idx_recovery_drills_started',
    table: 'recovery_drills',
    columns: ['started_at'],
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
  resource_grants: [
    "principal_type IN ('user', 'group')",
    "permission IN ('read', 'write', 'admin')",
  ],
  security_audit_events: ["result IN ('success', 'denied', 'failure')"],
  tool_servers: [
    "kind IN ('openapi', 'mcp')",
    "auth_mode IN ('none', 'bearer', 'header')",
    "access_mode IN ('admins-only', 'all-users', 'granted')",
  ],
  tool_approvals: [
    "scope IN ('once', 'session', 'always')",
    "status IN ('pending', 'approved', 'denied', 'expired')",
  ],
  channels: ["type IN ('public', 'private', 'dm')"],
  channel_members: ["role IN ('owner', 'member')"],
  channel_messages: ["author_kind IN ('user', 'model')"],
  channel_reactions: ['UNIQUE (message_id, user_id, emoji)'],
  webhook_targets: ['enabled IN (0, 1)'],
  usage_budgets: [
    "principal_type IN ('instance', 'user', 'group')",
    "period IN ('daily', 'weekly', 'monthly')",
    "mode IN ('observe', 'soft', 'hard')",
  ],
  message_feedback: ['rating IN (-1, 1)', 'UNIQUE (user_id, message_id)'],
  arena_votes: [
    "winner IN ('a', 'b', 'tie', 'both-bad')",
    'UNIQUE (user_id, compare_group)',
  ],
  eval_runs: [
    "status IN ('queued', 'running', 'completed', 'failed', 'cancelled')",
  ],
  recovery_drills: [
    "status IN ('running', 'passed', 'failed')",
    "origin IN ('scheduled', 'manual')",
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

const CANONICAL_DURABLE_EVENT_REPLAY_INDEX_SQL = normalizeSchemaObjectSql(
  DURABLE_EVENT_REPLAY_INDEX_SCHEMA_SQL.trim().replace(/;$/, '')
);

const collectDurableEventReplayIndexIdentityMismatches = (
  database: Database.Database
): string[] => {
  const observed = database
    .prepare(
      `SELECT type, tbl_name, sql
         FROM sqlite_master
        WHERE name = 'idx_platform_events_stream_subject_cursor'`
    )
    .get() as
    { type: string; tbl_name: string; sql: string | null } | undefined;
  if (!observed) {
    return ['idx_platform_events_stream_subject_cursor is missing'];
  }
  if (
    observed.type !== 'index' ||
    observed.tbl_name !== 'platform_events' ||
    observed.sql === null ||
    normalizeSchemaObjectSql(observed.sql) !==
      CANONICAL_DURABLE_EVENT_REPLAY_INDEX_SQL
  ) {
    return [
      'idx_platform_events_stream_subject_cursor does not match its canonical definition',
    ];
  }
  return [];
};

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
  ...collectMissingTrustFoundationSchema(database),
  ...collectMissingPersonalAutomationsSchema(database),
  ...collectMissingAgentFoundationSchema(database),
  ...collectMissingSkillFilesSchema(database),
  ...collectMissingNotesV2Schema(database),
  ...collectMissingTeamCollaborationSchema(database),
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
      !item.includes('idx_voice_profiles_name_lookup') &&
      !item.includes('idx_calendar_scoped_events')
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
      (item.includes('platform_event') &&
        !item.includes('idx_platform_events_stream_subject_cursor')) ||
      item.includes('durable job')
  ),
];

const collectMissingDurableEventReplayIndexSchema = (
  database: Database.Database
): string[] =>
  collectMissingStructuralInvariants(database).filter(item =>
    item.includes('idx_platform_events_stream_subject_cursor')
  );

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

const collectMissingTrustFoundationSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, TRUST_FOUNDATION_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('user_group') ||
      item.includes('resource_grants') ||
      item.includes('auth_sessions') ||
      item.includes('api_tokens') ||
      item.includes('oauth_identities') ||
      item.includes('security_audit')
  ),
];

const collectMissingPersonalAutomationsSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, PERSONAL_AUTOMATIONS_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('calendar_events') ||
      item.includes('automations') ||
      item.includes('automation_runs')
  ),
];

const collectMissingAgentFoundationSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, AGENT_FOUNDATION_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('tool_server') ||
      item.includes('tool_approvals') ||
      item.includes('prompt') ||
      item.includes('skill')
  ),
];

const collectMissingSkillFilesSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, SKILL_FILES_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(item =>
    item.includes('skill_files')
  ),
];

const collectMissingNotesV2Schema = (database: Database.Database): string[] => [
  ...collectMissingColumns(database, NOTES_V2_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item => item.includes('note_revisions') || item.includes('note_attachments')
  ),
];

const collectMissingTeamCollaborationSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, TEAM_COLLABORATION_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('channel') ||
      item.includes('notifications') ||
      item.includes('webhook_targets') ||
      item.includes('calendars') ||
      item.includes('idx_calendar_scoped_events')
  ),
];

const collectMissingMediaEnterpriseOpsSchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, MEDIA_ENTERPRISE_OPS_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('model_tariffs') ||
      item.includes('usage_budgets') ||
      item.includes('message_feedback') ||
      item.includes('arena_votes') ||
      item.includes('eval_sets') ||
      item.includes('eval_runs')
  ),
];

const collectMissingMfaPushRecoverySchema = (
  database: Database.Database
): string[] => [
  ...collectMissingColumns(database, MFA_PUSH_RECOVERY_REQUIRED_SCHEMA),
  ...collectMissingStructuralInvariants(database).filter(
    item =>
      item.includes('user_mfa') ||
      item.includes('mfa_recovery_codes') ||
      item.includes('webauthn_credentials') ||
      item.includes('push_subscriptions') ||
      item.includes('recovery_drills')
  ),
];

const collectMissingAutomationWorkTargetSchema = (
  database: Database.Database
): string[] =>
  collectMissingColumns(database, AUTOMATION_WORK_TARGET_REQUIRED_SCHEMA);

const collectMissingWorkComputerSchema = (
  database: Database.Database
): string[] => collectMissingColumns(database, WORK_COMPUTER_REQUIRED_SCHEMA);

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
    ...(version >= 13
      ? collectMissingDurableEventReplayIndexSchema(database)
      : []),
    ...(version >= 14 ? collectMissingTrustFoundationSchema(database) : []),
    ...(version >= 15 ? collectMissingPersonalAutomationsSchema(database) : []),
    ...(version >= 16 ? collectMissingAgentFoundationSchema(database) : []),
    ...(version >= 17 ? collectMissingSkillFilesSchema(database) : []),
    ...(version >= 18 ? collectMissingNotesV2Schema(database) : []),
    ...(version >= 19 ? collectMissingTeamCollaborationSchema(database) : []),
    ...(version >= 20 ? collectMissingMediaEnterpriseOpsSchema(database) : []),
    ...(version >= 21 ? collectMissingMfaPushRecoverySchema(database) : []),
    ...(version >= 22
      ? collectMissingAutomationWorkTargetSchema(database)
      : []),
    ...(version >= 23 ? collectMissingWorkComputerSchema(database) : []),
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
const DURABLE_EVENT_REPLAY_INDEX_MIGRATION_CHECKSUM =
  '7d6b769ceadd08791c77ac5c5a1d7bd61a63d87cac87da56ae847c4067cacdad';
const TRUST_FOUNDATION_MIGRATION_CHECKSUM =
  'c5a73245de3cd3e37db8877c8457c975d789f98c1c71ae1e4fc891ba09e8de5a';
const LEGACY_DURABLE_EVENT_REPLAY_INDEX_MIGRATION_CHECKSUM =
  'DURABLE_EVENT_REPLAY_INDEX_CHECKSUM_TO_FREEZE';
const PERSONAL_AUTOMATIONS_MIGRATION_CHECKSUM =
  '5bfb4a1789480a3cacc09c5a4359a4e77b82b0edafa80f6d78cde73e57ddc70b';
const AGENT_FOUNDATION_MIGRATION_CHECKSUM =
  '7e3a346fae66c073aac800aa45847999a4300b2f17eb3eaf9ed6351e891e2941';
const SKILL_FILES_MIGRATION_CHECKSUM =
  '584e1f9bca79eb5974f997088636d74d7f2c1e5fd816fcd0f6cf74ec30aea161';
const NOTES_V2_MIGRATION_CHECKSUM =
  '05a6758ab2b2a54f9097a5d5604a2bd57e085f1dd16816b5dc96d1eb7a41a399';
const TEAM_COLLABORATION_MIGRATION_CHECKSUM =
  '1cf021c941cfd9207a82e794e58d7553ae24a35b3f8f8a84bb4a0e06d0d77443';
const MEDIA_ENTERPRISE_OPS_MIGRATION_CHECKSUM =
  'c6bc6d98518f7a279ad7109cfdfcd8a75fbf7e3e157c50bca98142b50ac0f38b';
const MFA_PUSH_RECOVERY_MIGRATION_CHECKSUM =
  '9b2cdc08d2316877af091587113c749aed4b224d6ee12e72626b830da5447005';
const WORK_COMPUTER_MIGRATION_CHECKSUM =
  'b86fa1e6cb13bd76129db93043007cf7dd6888b85bd0139dfc34dbe394069867';
const AUTOMATION_WORK_TARGET_MIGRATION_CHECKSUM =
  'e5fb43e9bf42ab206dce74bfd867d5001754983c7a3cef30b811c4d4da54d1a9';

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
  {
    version: 13,
    name: 'durable-event-replay-index',
    checksum: DURABLE_EVENT_REPLAY_INDEX_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(DURABLE_EVENT_REPLAY_INDEX_SCHEMA_SQL);
      const missing = collectMissingDurableEventReplayIndexSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite durable event replay index is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 14,
    name: 'trust-foundation',
    checksum: TRUST_FOUNDATION_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(TRUST_FOUNDATION_SCHEMA_SQL);
      const missing = collectMissingTrustFoundationSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite trust foundation schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 15,
    name: 'personal-automations',
    checksum: PERSONAL_AUTOMATIONS_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(PERSONAL_AUTOMATIONS_SCHEMA_SQL);
      const missing = collectMissingPersonalAutomationsSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite personal automations schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 16,
    name: 'agent-foundation',
    checksum: AGENT_FOUNDATION_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(database, 'personas', 'bindings', 'TEXT');
      database.exec(AGENT_FOUNDATION_TABLES_SQL);
      const missing = collectMissingAgentFoundationSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite agent foundation schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 17,
    name: 'skill-files',
    checksum: SKILL_FILES_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(SKILL_FILES_SCHEMA_SQL);
      const missing = collectMissingSkillFilesSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite skill files schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 18,
    name: 'notes-v2',
    checksum: NOTES_V2_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(database, 'notes', 'pinned', 'INTEGER DEFAULT 0');
      database.exec(NOTES_V2_TABLES_SQL);
      const missing = collectMissingNotesV2Schema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite notes v2 schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 19,
    name: 'team-collaboration',
    checksum: TEAM_COLLABORATION_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(database, 'calendar_events', 'calendar_id', 'TEXT');
      addColumnIfMissing(
        database,
        'calendar_events',
        'reminder_minutes',
        'INTEGER'
      );
      addColumnIfMissing(
        database,
        'calendar_events',
        'last_reminded_occurrence',
        'INTEGER'
      );
      database.exec(TEAM_COLLABORATION_TABLES_SQL);
      const missing = collectMissingTeamCollaborationSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite team collaboration schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 20,
    name: 'media-enterprise-ops',
    checksum: MEDIA_ENTERPRISE_OPS_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(
        database,
        'voice_profiles',
        'consent_expires_at',
        'INTEGER'
      );
      addColumnIfMissing(database, 'voice_profiles', 'revoked_at', 'INTEGER');
      addColumnIfMissing(
        database,
        'voice_profiles',
        'transfer_count',
        'INTEGER NOT NULL DEFAULT 0'
      );
      addColumnIfMissing(
        database,
        'voice_profiles',
        'last_transfer_at',
        'INTEGER'
      );
      database.exec(MEDIA_ENTERPRISE_OPS_TABLES_SQL);
      const missing = collectMissingMediaEnterpriseOpsSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite media enterprise ops schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 21,
    name: 'mfa-push-recovery',
    checksum: MFA_PUSH_RECOVERY_MIGRATION_CHECKSUM,
    apply(database) {
      database.exec(MFA_PUSH_RECOVERY_TABLES_SQL);
      const missing = collectMissingMfaPushRecoverySchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite mfa/push/recovery schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 22,
    name: 'automation-work-target',
    checksum: AUTOMATION_WORK_TARGET_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(
        database,
        'automations',
        'target',
        "TEXT NOT NULL DEFAULT 'chat'"
      );
      addColumnIfMissing(database, 'automations', 'work_policy_id', 'TEXT');
      addColumnIfMissing(database, 'automation_runs', 'work_task_id', 'TEXT');
      const missing = collectMissingAutomationWorkTargetSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite automation work-target schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
  {
    version: 23,
    name: 'work-computer',
    checksum: WORK_COMPUTER_MIGRATION_CHECKSUM,
    apply(database) {
      addColumnIfMissing(database, 'work_policies', 'gui_enabled', 'INTEGER');
      const missing = collectMissingWorkComputerSchema(database);
      if (missing.length > 0) {
        throw new Error(
          `SQLite work computer schema is incomplete; missing ${missing.join(', ')}`
        );
      }
    },
  },
];

/**
 * Whether a pending migration needs foreign-key enforcement suspended before
 * its surrounding transaction begins. SQLite ignores `PRAGMA foreign_keys`
 * changes while a transaction is active, so bootstrap must establish this
 * connection state before opening its atomic schema transaction.
 */
export const sqliteMigrationsRequireForeignKeysDisabledAfter = (
  currentVersion: number
): boolean =>
  MIGRATIONS.some(
    migration =>
      migration.version > currentVersion &&
      migration.requiresForeignKeysDisabled === true
  );

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
  options: {
    allowLegacyPlatformVectorChecksum?: boolean;
    allowLegacyDurableEventReplayIndexChecksum?: boolean;
  } = {}
): AppliedMigrationValidation => {
  const currentVersion = applied[applied.length - 1]?.version ?? 0;
  let legacyPlatformVectorChecksumRepairRequired = false;
  let legacyDurableEventReplayIndexChecksumRepairRequired = false;
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
      if (
        options.allowLegacyDurableEventReplayIndexChecksum === true &&
        row.version === 13 &&
        row.name === 'durable-event-replay-index' &&
        row.checksum === LEGACY_DURABLE_EVENT_REPLAY_INDEX_MIGRATION_CHECKSUM
      ) {
        legacyDurableEventReplayIndexChecksumRepairRequired = true;
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
    legacyDurableEventReplayIndexChecksumRepairRequired,
  };
};

const validateAppliedMigrationsForLiveRepair = (
  database: Database.Database,
  applied: readonly AppliedMigrationRow[]
): AppliedMigrationValidation => {
  const validation = validateAppliedMigrations(applied, {
    allowLegacyPlatformVectorChecksum: true,
    allowLegacyDurableEventReplayIndexChecksum: true,
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
  if (validation.legacyDurableEventReplayIndexChecksumRepairRequired) {
    const mismatches =
      collectDurableEventReplayIndexIdentityMismatches(database);
    if (mismatches.length > 0) {
      throw new Error(
        'Database migration 13 legacy checksum cannot be repaired because ' +
          `the durable event replay index is not canonical: ${mismatches.join(', ')}`
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
          (validation.legacyPlatformVectorChecksumRepairRequired ||
            validation.legacyDurableEventReplayIndexChecksumRepairRequired) &&
          requiredAtCurrentVersion.length === 0
        ) {
          reason = `Database migration ${invalid.version} uses a recognized historical checksum and requires canonical repair`;
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
    const {
      currentVersion,
      legacyPlatformVectorChecksumRepairRequired,
      legacyDurableEventReplayIndexChecksumRepairRequired,
    } = validateAppliedMigrationsForLiveRepair(database, applied);
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
        !legacyPlatformVectorChecksumRepairRequired &&
        !legacyDurableEventReplayIndexChecksumRepairRequired
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
    if (
      database.inTransaction &&
      database.pragma('foreign_keys', { simple: true }) === 1 &&
      sqliteMigrationsRequireForeignKeysDisabledAfter(currentVersion)
    ) {
      throw new Error(
        'SQLite migration requires foreign keys to be disabled before its transaction begins'
      );
    }
    if (
      validation.legacyPlatformVectorChecksumRepairRequired ||
      validation.legacyDurableEventReplayIndexChecksumRepairRequired
    ) {
      database.transaction(() => {
        const repairValidation = validateAppliedMigrationsForLiveRepair(
          database,
          readAppliedMigrations(database)
        );
        if (
          repairValidation.currentVersion !== currentVersion ||
          repairValidation.legacyPlatformVectorChecksumRepairRequired !==
            validation.legacyPlatformVectorChecksumRepairRequired ||
          repairValidation.legacyDurableEventReplayIndexChecksumRepairRequired !==
            validation.legacyDurableEventReplayIndexChecksumRepairRequired
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
        if (repairValidation.legacyPlatformVectorChecksumRepairRequired) {
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
        }
        if (
          repairValidation.legacyDurableEventReplayIndexChecksumRepairRequired
        ) {
          const result = database
            .prepare(
              `UPDATE ${MIGRATION_TABLE}
                  SET checksum = ?
                WHERE version = 13
                  AND name = 'durable-event-replay-index'
                  AND checksum = ?`
            )
            .run(
              DURABLE_EVENT_REPLAY_INDEX_MIGRATION_CHECKSUM,
              LEGACY_DURABLE_EVENT_REPLAY_INDEX_MIGRATION_CHECKSUM
            );
          if (result.changes !== 1) {
            throw new Error(
              'Database migration 13 changed during legacy checksum repair'
            );
          }
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
        if (database.pragma('foreign_keys', { simple: true }) !== 0) {
          throw new Error(
            'SQLite migration requires foreign keys to be disabled before its transaction begins'
          );
        }
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
