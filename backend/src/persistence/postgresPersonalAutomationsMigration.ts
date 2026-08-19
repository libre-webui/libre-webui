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
 * Personal-automations schema: user calendar events plus scheduled
 * automations and their per-run execution history.
 */
// CHECK expressions use the exact form PostgreSQL reconstructs in
// pg_get_constraintdef, so the schema inspector's declared and actual
// constraint texts normalize identically.
export const POSTGRES_PERSONAL_AUTOMATIONS_SQL = `CREATE TABLE calendar_events (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  notes text,
  start_at bigint NOT NULL,
  end_at bigint,
  all_day bigint NOT NULL DEFAULT 0,
  recurrence text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_calendar_events_owner_start
  ON calendar_events(user_id, start_at);

CREATE TABLE automations (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  instructions text NOT NULL,
  triggers text NOT NULL,
  provider text,
  model text,
  notify text NOT NULL CHECK (notify IN ('app', 'off')),
  status text NOT NULL CHECK (status IN ('active', 'paused')),
  next_run_at bigint,
  last_run_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_automations_owner
  ON automations(user_id, updated_at);

CREATE INDEX idx_automations_due
  ON automations(status, next_run_at);

CREATE TABLE automation_runs (
  id text PRIMARY KEY,
  automation_id text NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scheduled_for bigint NOT NULL,
  started_at bigint,
  finished_at bigint,
  status text NOT NULL
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  session_id text,
  assistant_message_id text,
  error text,
  seen_at bigint,
  created_at bigint NOT NULL
);

CREATE INDEX idx_automation_runs_automation
  ON automation_runs(automation_id, scheduled_for);

CREATE INDEX idx_automation_runs_owner_time
  ON automation_runs(user_id, scheduled_for);`;

const version = 14;
const name = 'personal-automations';

export const POSTGRES_PERSONAL_AUTOMATIONS_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_PERSONAL_AUTOMATIONS_SQL}`)
      .digest('hex'),
    sql: POSTGRES_PERSONAL_AUTOMATIONS_SQL,
    rollbackPlan:
      'DROP TABLE automation_runs, automations, calendar_events; delete ' +
      'ledger row 14. No other feature reads these tables; scheduled ' +
      'automations simply stop existing.',
    minimumCompatibleVersion: 14,
  });
