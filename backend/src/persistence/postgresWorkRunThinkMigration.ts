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
 * A Work run records the reasoning level it was asked to run with: 'true',
 * 'false', 'low', 'medium' or 'high', or NULL for the model default. The
 * column is nullable: existing rows keep their pre-migration meaning.
 */
export const POSTGRES_WORK_RUN_THINK_SQL = `ALTER TABLE work_runs ADD COLUMN think text;`;

const version = 30;
const name = 'work-run-think';

export const POSTGRES_WORK_RUN_THINK_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_WORK_RUN_THINK_SQL}`)
      .digest('hex'),
    sql: POSTGRES_WORK_RUN_THINK_SQL,
    rollbackPlan:
      'ALTER TABLE work_runs DROP COLUMN think; delete ledger row 30. ' +
      'Runs fall back to the model default reasoning level, the ' +
      'pre-migration behavior.',
    minimumCompatibleVersion: 30,
  });
