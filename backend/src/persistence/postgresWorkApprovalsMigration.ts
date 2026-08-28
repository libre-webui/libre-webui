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
 * Work action approvals (A5): side-effecting agent actions can pause for a
 * human decision. `work_policies.approvals_required` lets an administrator
 * force review for every task under a policy; `work_tasks.approvals_enabled`
 * is the per-agent opt-in. Null on both means off — the pre-migration
 * behavior. `work_approvals` holds pending/resolved decisions so any replica
 * can decide; `work_approval_rules` holds per-task "always allow" scopes
 * created from Always-allow decisions.
 */
export const POSTGRES_WORK_APPROVALS_SQL = `ALTER TABLE work_policies ADD COLUMN approvals_required smallint CHECK (approvals_required IS NULL OR approvals_required IN (0, 1));
ALTER TABLE work_tasks ADD COLUMN approvals_enabled smallint CHECK (approvals_enabled IS NULL OR approvals_enabled IN (0, 1));
CREATE TABLE work_approvals (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL,
  summary text,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  scope text NOT NULL CHECK (scope IN ('once', 'always')),
  created_at bigint NOT NULL,
  resolved_at bigint,
  expires_at bigint NOT NULL
);
CREATE INDEX idx_work_approvals_task ON work_approvals(task_id, status, created_at);
CREATE TABLE work_approval_rules (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  pattern text,
  created_at bigint NOT NULL
);
CREATE INDEX idx_work_approval_rules_task ON work_approval_rules(task_id);`;

const version = 27;
const name = 'work-approvals';

export const POSTGRES_WORK_APPROVALS_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_WORK_APPROVALS_SQL}`)
      .digest('hex'),
    sql: POSTGRES_WORK_APPROVALS_SQL,
    rollbackPlan:
      'DROP TABLE work_approval_rules; DROP TABLE work_approvals; ' +
      'ALTER TABLE work_tasks DROP COLUMN approvals_enabled; ' +
      'ALTER TABLE work_policies DROP COLUMN approvals_required; delete ' +
      'ledger row 27. Every task reverts to running side-effecting actions ' +
      'without review, the pre-migration behavior.',
    minimumCompatibleVersion: 27,
  });
