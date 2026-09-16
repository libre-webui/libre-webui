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
 * Per-skill approval gating. `approval_policy` is `'always'` (every covered
 * tool call needs an explicit approval) or null/`'inherit'` (the skill defers
 * to the run's own approval setting); `approval_tools` is a JSON array of tool
 * names the policy applies to. Null on every pre-migration row means the skill
 * inherits the run's approval setting, the pre-migration behavior.
 */
export const POSTGRES_SKILL_APPROVALS_SQL = `ALTER TABLE skills ADD COLUMN approval_policy text; ALTER TABLE skills ADD COLUMN approval_tools text;`;

const version = 29;
const name = 'skill-approvals';

export const POSTGRES_SKILL_APPROVALS_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_SKILL_APPROVALS_SQL}`)
      .digest('hex'),
    sql: POSTGRES_SKILL_APPROVALS_SQL,
    rollbackPlan:
      'ALTER TABLE skills DROP COLUMN approval_policy, DROP COLUMN ' +
      'approval_tools; delete ledger row 29. Every skill reverts to ' +
      "inheriting the run's approval setting, the pre-migration behavior.",
    minimumCompatibleVersion: 29,
  });
