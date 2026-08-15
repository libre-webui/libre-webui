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

/**
 * This table is deliberately backend-neutral. It is the durable link between
 * an application resource and a private blob; physical S3 keys and local paths
 * never cross this boundary.
 */
export const SQLITE_BLOB_REFERENCE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS platform_blob_references (
    blob_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(resource_type, resource_id, purpose)
  );

  CREATE INDEX IF NOT EXISTS idx_platform_blob_references_owner
    ON platform_blob_references(owner_user_id, purpose, created_at);
  CREATE INDEX IF NOT EXISTS idx_platform_blob_references_resource
    ON platform_blob_references(resource_type, resource_id);
`;

/** Added after the immutable v5 blob-reference protocol. */
export const SQLITE_BLOB_QUOTA_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS platform_blob_quota_usage (
    owner_user_id TEXT PRIMARY KEY,
    stored_bytes INTEGER NOT NULL DEFAULT 0 CHECK(stored_bytes >= 0),
    reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS platform_blob_quota_reservations (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes >= 0),
    consumed_bytes INTEGER NOT NULL CHECK(consumed_bytes >= 0),
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_platform_blob_quota_reservations_expiry
    ON platform_blob_quota_reservations(expires_at, id);
  CREATE INDEX IF NOT EXISTS idx_platform_blob_quota_reservations_owner
    ON platform_blob_quota_reservations(owner_user_id, expires_at);

  CREATE TABLE IF NOT EXISTS platform_blob_quota_objects (
    blob_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    stored_bytes INTEGER NOT NULL CHECK(stored_bytes >= 0),
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_platform_blob_quota_objects_owner
    ON platform_blob_quota_objects(owner_user_id, purpose, created_at);
`;

export const POSTGRES_BLOB_SCHEMA_SQL = `
  CREATE TABLE platform_blob_objects (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    encrypted_bytes BIGINT NOT NULL CHECK (encrypted_bytes >= 0),
    plaintext_bytes BIGINT NOT NULL CHECK (plaintext_bytes >= 0),
    plaintext_sha256 TEXT NOT NULL CHECK (plaintext_sha256 ~ '^[0-9a-f]{64}$'),
    ciphertext_sha256 TEXT NOT NULL CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
    wrapped_data_key JSONB NOT NULL,
    metadata_iv BYTEA NOT NULL,
    metadata_tag BYTEA NOT NULL,
    encrypted_metadata BYTEA NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready', 'deleting')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE INDEX idx_platform_blob_objects_owner
    ON platform_blob_objects(owner_user_id, purpose, created_at);
  CREATE INDEX idx_platform_blob_objects_state
    ON platform_blob_objects(state, updated_at);

  CREATE TABLE platform_generated_media (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video')),
    encrypted_prompt TEXT NOT NULL,
    model TEXT NOT NULL,
    plugin_id TEXT,
    blob_id TEXT NOT NULL REFERENCES platform_blob_objects(id) ON DELETE RESTRICT,
    mime_type TEXT NOT NULL,
    size_label TEXT,
    quality TEXT,
    encrypted_metadata TEXT,
    created_at BIGINT NOT NULL
  );

  CREATE INDEX idx_platform_generated_media_user
    ON platform_generated_media(user_id, kind, created_at DESC);
  CREATE INDEX idx_platform_generated_media_blob
    ON platform_generated_media(blob_id);

  CREATE TABLE platform_blob_references (
    blob_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    UNIQUE(resource_type, resource_id, purpose)
  );

  CREATE INDEX idx_platform_blob_references_owner
    ON platform_blob_references(owner_user_id, purpose, created_at);
  CREATE INDEX idx_platform_blob_references_resource
    ON platform_blob_references(resource_type, resource_id);

  CREATE TABLE platform_blob_quota_usage (
    owner_user_id TEXT PRIMARY KEY,
    stored_bytes BIGINT NOT NULL DEFAULT 0 CHECK(stored_bytes >= 0),
    reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK(reserved_bytes >= 0),
    updated_at BIGINT NOT NULL
  );

  CREATE TABLE platform_blob_quota_reservations (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    reserved_bytes BIGINT NOT NULL CHECK(reserved_bytes >= 0),
    consumed_bytes BIGINT NOT NULL CHECK(consumed_bytes >= 0),
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE INDEX idx_platform_blob_quota_reservations_expiry
    ON platform_blob_quota_reservations(expires_at, id);
  CREATE INDEX idx_platform_blob_quota_reservations_owner
    ON platform_blob_quota_reservations(owner_user_id, expires_at);

  CREATE TABLE platform_blob_quota_objects (
    blob_id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    stored_bytes BIGINT NOT NULL CHECK(stored_bytes >= 0),
    created_at BIGINT NOT NULL
  );

  CREATE INDEX idx_platform_blob_quota_objects_owner
    ON platform_blob_quota_objects(owner_user_id, purpose, created_at);

  CREATE TABLE platform_media_generation_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider_job_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    model TEXT NOT NULL,
    encrypted_prompt TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
    encrypted_options TEXT,
    gallery_id TEXT REFERENCES platform_generated_media(id) ON DELETE SET NULL,
    encrypted_error TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  CREATE UNIQUE INDEX idx_platform_media_jobs_provider
    ON platform_media_generation_jobs(user_id, plugin_id, provider_job_id);
  CREATE INDEX idx_platform_media_jobs_user_status
    ON platform_media_generation_jobs(user_id, status, updated_at DESC);
`;

export const POSTGRES_VECTOR_SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS vector;

  CREATE TABLE platform_vector_entries (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK (dimensions > 0 AND dimensions <= 16000),
    embedding_version TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    embedding vector NOT NULL,
    attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (namespace, owner_user_id, id),
    CHECK (vector_dims(embedding) = dimensions),
    CHECK (jsonb_typeof(attributes) = 'object')
  );

  CREATE TABLE platform_vector_acl (
    namespace TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    vector_id TEXT NOT NULL,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
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

  CREATE INDEX idx_platform_vectors_scope
    ON platform_vector_entries(
      namespace,
      model,
      dimensions,
      embedding_version,
      owner_user_id
    );
  CREATE INDEX idx_platform_vectors_resource
    ON platform_vector_entries(namespace, resource_id, owner_user_id);
  CREATE INDEX idx_platform_vectors_attributes
    ON platform_vector_entries USING GIN(attributes jsonb_path_ops);
  CREATE INDEX idx_platform_vector_acl_principal
    ON platform_vector_acl(
      principal_type,
      principal_id,
      namespace,
      owner_user_id,
      vector_id
    );

  CREATE TABLE platform_persona_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    encrypted_content TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    encrypted_context TEXT,
    importance_score DOUBLE PRECISION NOT NULL DEFAULT 0.5
      CHECK(importance_score >= 0 AND importance_score <= 1),
    memory_type TEXT NOT NULL DEFAULT 'general'
      CHECK(memory_type IN ('fact', 'preference', 'experience', 'emotional', 'context', 'instruction', 'general')),
    access_count BIGINT NOT NULL DEFAULT 0 CHECK(access_count >= 0),
    last_accessed BIGINT,
    decay_factor DOUBLE PRECISION NOT NULL DEFAULT 1.0
      CHECK(decay_factor >= 0 AND decay_factor <= 1),
    encrypted_consolidated_from TEXT
  );

  CREATE INDEX idx_platform_persona_memories_owner
    ON platform_persona_memories(user_id, persona_id, timestamp DESC);
  CREATE INDEX idx_platform_persona_memories_core
    ON platform_persona_memories(user_id, persona_id, memory_type, importance_score DESC);

  CREATE TABLE platform_persona_states (
    persona_id TEXT PRIMARY KEY REFERENCES personas(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    encrypted_runtime_state TEXT NOT NULL,
    encrypted_mutation_log TEXT NOT NULL,
    last_updated BIGINT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
  );

  CREATE INDEX idx_platform_persona_states_user
    ON platform_persona_states(user_id, last_updated DESC);
`;

export interface StoragePostgresMigration {
  version: number;
  name: string;
  checksum: string;
  sql: string;
  rollbackPlan: string;
  minimumCompatibleVersion: number;
}

/** Checksums are immutable release artifacts: SHA-256(version\nname\nsql). */
export const POSTGRES_BLOB_MIGRATION: StoragePostgresMigration = {
  version: 2,
  name: 'platform-blob-store',
  checksum: '6e12b6cc4b98de8a75c65f44b98d66502a70d32c8cd03c732e7e74bdeeced363',
  sql: POSTGRES_BLOB_SCHEMA_SQL,
  rollbackPlan:
    'Stop writers, verify no platform_blob_references remain, delete S3 objects from the signed inventory, then drop platform_blob_references and platform_blob_objects.',
  minimumCompatibleVersion: 1,
};

export const POSTGRES_VECTOR_MIGRATION: StoragePostgresMigration = {
  version: 3,
  name: 'platform-vector-store',
  checksum: 'b1a55a08a1efe15860c893446bb55741a68ee22763bddbc508c887347207a521',
  sql: POSTGRES_VECTOR_SCHEMA_SQL,
  rollbackPlan:
    'Stop vector writers, export the rebuild inventory, drop platform_vector_acl and platform_vector_entries, and retain source content for deterministic re-embedding.',
  minimumCompatibleVersion: 1,
};
