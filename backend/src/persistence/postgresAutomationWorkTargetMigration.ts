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
 * Automations gain a run target: 'chat' keeps today's scheduled chat
 * sessions, 'work' launches an isolated Work task instead, optionally under
 * a named Work policy. Runs record the task they created.
 */
// CHECK expressions use the exact form PostgreSQL reconstructs in
// pg_get_constraintdef, so the schema inspector's declared and actual
// constraint texts normalize identically.
export const POSTGRES_AUTOMATION_WORK_TARGET_SQL = `ALTER TABLE automations ADD COLUMN target text NOT NULL DEFAULT 'chat' CHECK (target IN ('chat', 'work'));
ALTER TABLE automations ADD COLUMN work_policy_id text;
ALTER TABLE automation_runs ADD COLUMN work_task_id text;`;

const version = 21;
const name = 'automation-work-target';

export const POSTGRES_AUTOMATION_WORK_TARGET_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_AUTOMATION_WORK_TARGET_SQL}`)
      .digest('hex'),
    sql: POSTGRES_AUTOMATION_WORK_TARGET_SQL,
    rollbackPlan:
      'ALTER TABLE automations DROP COLUMN target, DROP COLUMN ' +
      'work_policy_id; ALTER TABLE automation_runs DROP COLUMN ' +
      'work_task_id; delete ledger row 21. Every automation reverts to ' +
      'running as a scheduled chat session.',
    minimumCompatibleVersion: 21,
  });
