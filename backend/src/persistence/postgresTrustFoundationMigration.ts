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
 * Trust-foundation schema: groups, resource grants, auth sessions, API
 * tokens, OAuth identities, and the append-only security audit log.
 */
export const POSTGRES_TRUST_FOUNDATION_SQL = `CREATE TABLE user_groups (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
  description text,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE user_group_members (
  group_id text NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by text,
  added_at bigint NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_user_group_members_user
  ON user_group_members(user_id, group_id);

CREATE TABLE resource_grants (
  id text PRIMARY KEY,
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 64),
  resource_id text NOT NULL CHECK (length(resource_id) BETWEEN 1 AND 256),
  owner_user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id text NOT NULL,
  permission text NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
  created_by text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (resource_type, resource_id, principal_type, principal_id)
);

CREATE INDEX idx_resource_grants_resource
  ON resource_grants(resource_type, resource_id);

CREATE INDEX idx_resource_grants_principal
  ON resource_grants(principal_type, principal_id);

CREATE TABLE auth_sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  ip_hash text,
  user_agent text,
  created_at bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  revoked_by text
);

CREATE INDEX idx_auth_sessions_user
  ON auth_sessions(user_id, last_seen_at);

CREATE INDEX idx_auth_sessions_expires
  ON auth_sessions(expires_at);

CREATE TABLE api_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  scopes text NOT NULL,
  created_at bigint NOT NULL,
  expires_at bigint,
  last_used_at bigint,
  revoked_at bigint
);

CREATE INDEX idx_api_tokens_user
  ON api_tokens(user_id, created_at);

CREATE TABLE oauth_identities (
  provider text NOT NULL,
  subject text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (provider, subject)
);

CREATE INDEX idx_oauth_identities_user
  ON oauth_identities(user_id);

CREATE TABLE security_audit_events (
  id text PRIMARY KEY,
  occurred_at bigint NOT NULL,
  actor_user_id text,
  actor_kind text NOT NULL,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
  target_type text,
  target_id text,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failure')),
  request_id text,
  ip_hash text,
  details text
);

CREATE INDEX idx_security_audit_occurred
  ON security_audit_events(occurred_at, id);

CREATE INDEX idx_security_audit_actor
  ON security_audit_events(actor_user_id, occurred_at);

CREATE INDEX idx_security_audit_action
  ON security_audit_events(action, occurred_at);`;

const version = 13;
const name = 'trust-foundation';

export const POSTGRES_TRUST_FOUNDATION_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_TRUST_FOUNDATION_SQL}`)
      .digest('hex'),
    sql: POSTGRES_TRUST_FOUNDATION_SQL,
    rollbackPlan:
      'DROP TABLE security_audit_events, oauth_identities, api_tokens, ' +
      'auth_sessions, resource_grants, user_group_members, user_groups; ' +
      'delete ledger row 13. Existing bearer tokens keep working because ' +
      'sid-less JWTs remain accepted; issued API tokens stop resolving.',
    minimumCompatibleVersion: 13,
  });
