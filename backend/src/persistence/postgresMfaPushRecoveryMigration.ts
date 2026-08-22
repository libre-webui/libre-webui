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
 * Account-security and client-delivery schema: TOTP multi-factor state with
 * one-time recovery codes, WebAuthn passkey credentials, browser Web Push
 * subscriptions, and the verified recovery-drill history.
 */
// CHECK expressions use the exact form PostgreSQL reconstructs in
// pg_get_constraintdef, so the schema inspector's declared and actual
// constraint texts normalize identically.
export const POSTGRES_MFA_PUSH_RECOVERY_SQL = `CREATE TABLE user_mfa (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  totp_secret text NOT NULL,
  activated_at bigint,
  last_used_step bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE mfa_recovery_codes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_lookup text NOT NULL UNIQUE,
  created_at bigint NOT NULL,
  used_at bigint
);

CREATE INDEX idx_mfa_recovery_codes_user
  ON mfa_recovery_codes(user_id);

CREATE TABLE webauthn_credentials (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_lookup text NOT NULL UNIQUE,
  credential_data text NOT NULL,
  name text,
  sign_count bigint NOT NULL DEFAULT 0,
  created_at bigint NOT NULL,
  last_used_at bigint
);

CREATE INDEX idx_webauthn_credentials_user
  ON webauthn_credentials(user_id);

CREATE TABLE push_subscriptions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text,
  endpoint_lookup text NOT NULL UNIQUE,
  subscription text NOT NULL,
  user_agent text,
  created_at bigint NOT NULL,
  last_used_at bigint
);

CREATE INDEX idx_push_subscriptions_user
  ON push_subscriptions(user_id);

CREATE TABLE recovery_drills (
  id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('running', 'passed', 'failed')),
  origin text NOT NULL CHECK (origin IN ('scheduled', 'manual')),
  started_at bigint NOT NULL,
  finished_at bigint,
  snapshot_bytes bigint,
  rpo_seconds bigint,
  restore_ms bigint,
  error text,
  report text,
  created_by text,
  created_at bigint NOT NULL
);

CREATE INDEX idx_recovery_drills_started
  ON recovery_drills(started_at);`;

const version = 20;
const name = 'mfa-push-recovery';
// This is an integrity checksum of public schema DDL, not a password hash.
const checksum = createHash('sha256')
  // codeql[js/insufficient-password-hash]
  .update(`${version}\n${name}\n${POSTGRES_MFA_PUSH_RECOVERY_SQL}`)
  .digest('hex');

export const POSTGRES_MFA_PUSH_RECOVERY_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum,
    sql: POSTGRES_MFA_PUSH_RECOVERY_SQL,
    rollbackPlan:
      'DROP TABLE recovery_drills, push_subscriptions, ' +
      'webauthn_credentials, mfa_recovery_codes, user_mfa; delete ledger ' +
      'row 20. Accounts fall back to password-only sign-in, browser push ' +
      'subscriptions are forgotten, and the recovery-drill history stops ' +
      'existing.',
    minimumCompatibleVersion: 20,
  });
