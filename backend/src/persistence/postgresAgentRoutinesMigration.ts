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
 * Agent routines: a Work-targeted automation may bind to an existing Work
 * task (an agent), in which case every fire starts a run inside that task's
 * workspace and conversation instead of creating a fresh task. Null keeps
 * the pre-migration behavior of one new task per fire.
 */
export const POSTGRES_AGENT_ROUTINES_SQL = `ALTER TABLE automations ADD COLUMN work_task_id text;`;

const version = 25;
const name = 'agent-routines';

export const POSTGRES_AGENT_ROUTINES_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_AGENT_ROUTINES_SQL}`)
      .digest('hex'),
    sql: POSTGRES_AGENT_ROUTINES_SQL,
    rollbackPlan:
      'ALTER TABLE automations DROP COLUMN work_task_id; delete ledger ' +
      'row 25. Every Work automation reverts to creating a fresh task per ' +
      'fire, the pre-migration behavior.',
    minimumCompatibleVersion: 25,
  });
