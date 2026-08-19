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
 * Agent-foundation schema: admin-registered OpenAPI/MCP tool servers with
 * per-user credentials and approval policy, a versioned prompt library, a
 * versioned skill workspace, and assistant-profile bindings on personas.
 */
// CHECK expressions use the exact form PostgreSQL reconstructs in
// pg_get_constraintdef, so the schema inspector's declared and actual
// constraint texts normalize identically.
export const POSTGRES_AGENT_FOUNDATION_SQL = `ALTER TABLE personas ADD COLUMN bindings text;

CREATE TABLE tool_servers (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  kind text NOT NULL CHECK (kind IN ('openapi', 'mcp')),
  base_url text NOT NULL,
  spec text,
  spec_digest text,
  spec_revision integer NOT NULL DEFAULT 1,
  auth_mode text NOT NULL CHECK (auth_mode IN ('none', 'bearer', 'header')),
  auth_header text,
  access_mode text NOT NULL
    CHECK (access_mode IN ('admins-only', 'all-users', 'granted')),
  enabled integer NOT NULL DEFAULT 1,
  timeout_ms integer NOT NULL,
  max_response_bytes integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_tool_servers_updated
  ON tool_servers(updated_at);

CREATE TABLE tool_server_tools (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES tool_servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  params_schema text,
  detail text,
  side_effect integer NOT NULL DEFAULT 1,
  enabled integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (server_id, name)
);

CREATE TABLE tool_server_credentials (
  id text PRIMARY KEY,
  server_id text NOT NULL REFERENCES tool_servers(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (server_id, user_id)
);

CREATE TABLE tool_approvals (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text REFERENCES sessions(id) ON DELETE CASCADE,
  server_id text REFERENCES tool_servers(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  call_id text,
  arguments_digest text,
  scope text NOT NULL CHECK (scope IN ('once', 'session', 'always')),
  status text NOT NULL
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at bigint NOT NULL,
  resolved_at bigint,
  expires_at bigint
);

CREATE INDEX idx_tool_approvals_owner
  ON tool_approvals(user_id, status, created_at);

CREATE TABLE prompts (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  description text,
  content text NOT NULL,
  variables text,
  tags text,
  version integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, slug)
);

CREATE INDEX idx_prompts_owner
  ON prompts(user_id, updated_at);

CREATE TABLE prompt_versions (
  id text PRIMARY KEY,
  prompt_id text NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  variables text,
  created_at bigint NOT NULL,
  UNIQUE (prompt_id, version)
);

CREATE TABLE skills (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  version integer NOT NULL DEFAULT 1,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, slug)
);

CREATE INDEX idx_skills_owner
  ON skills(user_id, updated_at);

CREATE TABLE skill_versions (
  id text PRIMARY KEY,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version integer NOT NULL,
  instructions text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (skill_id, version)
);`;

const version = 15;
const name = 'agent-foundation';

export const POSTGRES_AGENT_FOUNDATION_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_AGENT_FOUNDATION_SQL}`)
      .digest('hex'),
    sql: POSTGRES_AGENT_FOUNDATION_SQL,
    rollbackPlan:
      'DROP TABLE skill_versions, skills, prompt_versions, prompts, ' +
      'tool_approvals, tool_server_credentials, tool_server_tools, ' +
      'tool_servers; ALTER TABLE personas DROP COLUMN bindings; delete ' +
      'ledger row 15. Chat tool calls, prompts, and skills stop existing; ' +
      'persona bindings are additive and no other feature reads them.',
    minimumCompatibleVersion: 15,
  });
