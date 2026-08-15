/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

export const POSTGRES_EXTENSION_PERSISTENCE_SQL = `
CREATE TABLE plugin_credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  api_key text NOT NULL,
  routing_auth_fingerprint char(64),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, plugin_id),
  CHECK (
    routing_auth_fingerprint IS NULL
    OR routing_auth_fingerprint ~ '^[0-9a-f]{64}$'
  )
);

CREATE TABLE plugin_variables (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  variable_name text NOT NULL,
  variable_value text NOT NULL,
  is_encrypted smallint NOT NULL DEFAULT 0 CHECK (is_encrypted IN (0, 1)),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, plugin_id, variable_name)
);

CREATE TABLE plugin_discovered_models (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  models_json text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);

CREATE TABLE plugin_discovered_capability_models (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  capability text NOT NULL
    CHECK (capability IN ('image', 'stt', 'tts', 'audio', 'video')),
  models_json text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (user_id, plugin_id, capability)
);

CREATE TABLE plugin_activations (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  activated_at bigint NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);

CREATE TABLE plugin_definition_approvals (
  plugin_id text PRIMARY KEY,
  definition_fingerprint char(64) NOT NULL
    CHECK (definition_fingerprint ~ '^[0-9a-f]{64}$'),
  source_path text NOT NULL,
  approved_by_user_id text NOT NULL,
  approved_at bigint NOT NULL
);

CREATE TABLE plugin_usage_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  plugin_name text NOT NULL,
  capability text NOT NULL
    CHECK (capability IN ('chat', 'embedding', 'image', 'stt', 'tts', 'audio', 'video')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'error', 'cancelled')),
  prompt_tokens bigint CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
  total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  input_units bigint NOT NULL DEFAULT 0 CHECK (input_units >= 0),
  output_units bigint NOT NULL DEFAULT 0 CHECK (output_units >= 0),
  unit_kind text,
  duration_ms bigint NOT NULL CHECK (duration_ms >= 0),
  created_at bigint NOT NULL
);

CREATE TABLE voice_profiles (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name bytea NOT NULL,
  name_lookup char(64) NOT NULL CHECK (name_lookup ~ '^[0-9a-f]{64}$'),
  plugin_id text NOT NULL,
  model text NOT NULL,
  routing_fingerprint char(64) NOT NULL
    CHECK (routing_fingerprint ~ '^[0-9a-f]{64}$'),
  reference_audio bytea NOT NULL,
  reference_text bytea,
  audio_mime_type text NOT NULL,
  audio_format text NOT NULL CHECK (audio_format IN ('wav', 'mp3', 'flac', 'ogg', 'm4a')),
  audio_size bigint NOT NULL CHECK (audio_size > 0),
  consent_confirmed_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, plugin_id, model, name_lookup)
);

CREATE INDEX idx_plugin_credentials_user ON plugin_credentials(user_id);
CREATE INDEX idx_plugin_credentials_plugin ON plugin_credentials(plugin_id);
CREATE INDEX idx_plugin_variables_user_plugin
  ON plugin_variables(user_id, plugin_id);
CREATE INDEX idx_plugin_discovered_models_plugin
  ON plugin_discovered_models(plugin_id);
CREATE INDEX idx_plugin_discovered_capability_models_plugin
  ON plugin_discovered_capability_models(plugin_id, capability);
CREATE INDEX idx_plugin_activations_plugin ON plugin_activations(plugin_id);
CREATE INDEX idx_plugin_definition_approvals_approver
  ON plugin_definition_approvals(approved_by_user_id);
CREATE INDEX idx_plugin_usage_created ON plugin_usage_events(created_at DESC);
CREATE INDEX idx_plugin_usage_plugin_created
  ON plugin_usage_events(plugin_id, created_at DESC);
CREATE INDEX idx_plugin_usage_model_created
  ON plugin_usage_events(model, created_at DESC);
CREATE INDEX idx_plugin_usage_user_created
  ON plugin_usage_events(user_id, created_at DESC);
CREATE INDEX idx_voice_profiles_user_updated
  ON voice_profiles(user_id, updated_at DESC);
CREATE INDEX idx_voice_profiles_user_route
  ON voice_profiles(user_id, plugin_id, model);
`;

const version = 5;
const name = 'extension-persistence';

export const POSTGRES_EXTENSION_MIGRATION: PostgresMigration = Object.freeze({
  version,
  name,
  checksum: createHash('sha256')
    .update(`${version}\n${name}\n${POSTGRES_EXTENSION_PERSISTENCE_SQL}`)
    .digest('hex'),
  sql: POSTGRES_EXTENSION_PERSISTENCE_SQL,
  rollbackPlan:
    'Stop every app and worker, export credentials/variables/usage/voice inventories with the matching encryption key, remove dependent data, then drop voice_profiles, plugin_usage_events, plugin_definition_approvals, plugin_activations, discovery, variables, and credentials in that order. In-place downgrade is unsupported.',
  minimumCompatibleVersion: 5,
});
