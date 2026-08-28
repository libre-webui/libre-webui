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
 * Agent identity on Work tasks: a task the user "hired" as a persistent
 * agent links a persona (persona_id), carries a one-line status blurb
 * persisted at run completion, and is flagged is_agent so the client can
 * pin it above ad-hoc tasks. Null is_agent (and 0) means an ad-hoc task —
 * the pre-migration behavior for every existing row.
 */
export const POSTGRES_AGENT_IDENTITY_SQL = `ALTER TABLE work_tasks ADD COLUMN persona_id text;
ALTER TABLE work_tasks ADD COLUMN status_blurb text;
ALTER TABLE work_tasks ADD COLUMN is_agent smallint CHECK (is_agent IS NULL OR is_agent IN (0, 1));`;

const version = 24;
const name = 'agent-identity';

export const POSTGRES_AGENT_IDENTITY_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_AGENT_IDENTITY_SQL}`)
      .digest('hex'),
    sql: POSTGRES_AGENT_IDENTITY_SQL,
    rollbackPlan:
      'ALTER TABLE work_tasks DROP COLUMN persona_id; ALTER TABLE ' +
      'work_tasks DROP COLUMN status_blurb; ALTER TABLE work_tasks DROP ' +
      'COLUMN is_agent; delete ledger row 24. Every task reverts to an ' +
      'ad-hoc task without a persona link, the pre-migration behavior.',
    minimumCompatibleVersion: 24,
  });
