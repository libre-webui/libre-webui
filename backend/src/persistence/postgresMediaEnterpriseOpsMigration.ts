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

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

/**
 * Media and enterprise-operations schema: voice-profile consent lifecycle
 * (expiry, revocation, provider-transfer receipts), versioned provider
 * tariffs, usage budgets, message feedback with topic tags, blind arena
 * votes, and reusable evaluation sets with reproducible runs.
 */
// CHECK expressions use the exact form PostgreSQL reconstructs in
// pg_get_constraintdef, so the schema inspector's declared and actual
// constraint texts normalize identically.
export const POSTGRES_MEDIA_ENTERPRISE_OPS_SQL = `ALTER TABLE voice_profiles ADD COLUMN consent_expires_at bigint;
ALTER TABLE voice_profiles ADD COLUMN revoked_at bigint;
ALTER TABLE voice_profiles ADD COLUMN transfer_count bigint NOT NULL DEFAULT 0;
ALTER TABLE voice_profiles ADD COLUMN last_transfer_at bigint;

CREATE TABLE model_tariffs (
  id text PRIMARY KEY,
  plugin_id text NOT NULL,
  model text,
  input_per_million double precision,
  output_per_million double precision,
  unit_price double precision,
  currency text NOT NULL DEFAULT 'USD',
  effective_from bigint NOT NULL,
  created_by text,
  created_at bigint NOT NULL
);

CREATE INDEX idx_model_tariffs_lookup
  ON model_tariffs(plugin_id, model, effective_from);

CREATE TABLE usage_budgets (
  id text PRIMARY KEY,
  name text NOT NULL,
  principal_type text NOT NULL CHECK (principal_type IN ('instance', 'user', 'group')),
  principal_id text,
  period text NOT NULL CHECK (period IN ('daily', 'weekly', 'monthly')),
  amount_usd double precision NOT NULL,
  mode text NOT NULL CHECK (mode IN ('observe', 'soft', 'hard')),
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_usage_budgets_principal
  ON usage_budgets(principal_type, principal_id);

CREATE TABLE message_feedback (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  message_id text NOT NULL,
  rating bigint NOT NULL CHECK (rating IN (-1, 1)),
  tags text,
  comment text,
  model text,
  plugin_id text,
  snapshot text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, message_id)
);

CREATE INDEX idx_message_feedback_owner
  ON message_feedback(user_id, created_at);

CREATE TABLE arena_votes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  compare_group text NOT NULL,
  model_a text NOT NULL,
  model_b text NOT NULL,
  winner text NOT NULL CHECK (winner IN ('a', 'b', 'tie', 'both-bad')),
  created_at bigint NOT NULL,
  UNIQUE (user_id, compare_group)
);

CREATE INDEX idx_arena_votes_order
  ON arena_votes(created_at, id);

CREATE TABLE eval_sets (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  items text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_eval_sets_owner
  ON eval_sets(user_id, updated_at);

CREATE TABLE eval_runs (
  id text PRIMARY KEY,
  set_id text NOT NULL REFERENCES eval_sets(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  plugin_id text,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  results text,
  error text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  completed_at bigint
);

CREATE INDEX idx_eval_runs_owner
  ON eval_runs(user_id, created_at);

CREATE INDEX idx_eval_runs_parent
  ON eval_runs(set_id);`;

const version = 19;
const name = 'media-enterprise-ops';

export const POSTGRES_MEDIA_ENTERPRISE_OPS_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_MEDIA_ENTERPRISE_OPS_SQL}`)
      .digest('hex'),
    sql: POSTGRES_MEDIA_ENTERPRISE_OPS_SQL,
    rollbackPlan:
      'DROP TABLE eval_runs, eval_sets, arena_votes, message_feedback, ' +
      'usage_budgets, model_tariffs; ALTER TABLE voice_profiles ' +
      'DROP COLUMN consent_expires_at, DROP COLUMN revoked_at, ' +
      'DROP COLUMN transfer_count, DROP COLUMN last_transfer_at; ' +
      'delete ledger row 19. Voice profiles fall back to permanent consent, ' +
      'and tariffs, budgets, feedback, arena votes, and evaluations stop ' +
      'existing.',
    minimumCompatibleVersion: 19,
  });
