/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

/**
 * A Work run keeps its own outcome (reply summary, changed files, how it
 * ended) and a skill can pin tools that always need approval. Every column
 * is nullable: existing rows keep their pre-migration meaning.
 */
export const POSTGRES_WORK_RUN_RESULTS_SQL = `ALTER TABLE work_runs ADD COLUMN summary text;
ALTER TABLE work_runs ADD COLUMN changed_files text;
ALTER TABLE work_runs ADD COLUMN exit_state text;
ALTER TABLE skills ADD COLUMN approval_policy text;
ALTER TABLE skills ADD COLUMN approval_tools text;`;

const version = 29;
const name = 'work-run-results';

export const POSTGRES_WORK_RUN_RESULTS_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_WORK_RUN_RESULTS_SQL}`)
      .digest('hex'),
    sql: POSTGRES_WORK_RUN_RESULTS_SQL,
    rollbackPlan:
      'ALTER TABLE work_runs DROP COLUMN summary, DROP COLUMN changed_files, ' +
      'DROP COLUMN exit_state; ALTER TABLE skills DROP COLUMN approval_policy, ' +
      'DROP COLUMN approval_tools; delete ledger row 29. Runs fall back to the ' +
      'task-level status line and skills to advisory approval text, the ' +
      'pre-migration behavior.',
    minimumCompatibleVersion: 29,
  });
