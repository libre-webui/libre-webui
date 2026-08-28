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
 * Per-task seen marker: when the owner last opened the task. The agent
 * sidebar shows an unread indicator when a run finished after this
 * timestamp. Null (every pre-migration row) means never opened, which
 * renders as read — old tasks must not light up on upgrade.
 */
export const POSTGRES_AGENT_SEEN_SQL = `ALTER TABLE work_tasks ADD COLUMN last_seen_at bigint;`;

const version = 26;
const name = 'agent-seen';

export const POSTGRES_AGENT_SEEN_MIGRATION: PostgresMigration = Object.freeze({
  version,
  name,
  checksum: createHash('sha256')
    .update(`${version}\n${name}\n${POSTGRES_AGENT_SEEN_SQL}`)
    .digest('hex'),
  sql: POSTGRES_AGENT_SEEN_SQL,
  rollbackPlan:
    'ALTER TABLE work_tasks DROP COLUMN last_seen_at; delete ledger row ' +
    '26. Unread indicators disappear, the pre-migration behavior.',
  minimumCompatibleVersion: 26,
});
