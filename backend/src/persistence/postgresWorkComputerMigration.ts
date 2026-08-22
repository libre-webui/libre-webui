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
 * Work Computer: a Work policy may enable a GUI session (virtual display,
 * browser, watchable screen) for tasks running under it. Null means off.
 */
export const POSTGRES_WORK_COMPUTER_SQL = `ALTER TABLE work_policies ADD COLUMN gui_enabled smallint CHECK (gui_enabled IS NULL OR gui_enabled IN (0, 1));`;

const version = 22;
const name = 'work-computer';

export const POSTGRES_WORK_COMPUTER_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_WORK_COMPUTER_SQL}`)
      .digest('hex'),
    sql: POSTGRES_WORK_COMPUTER_SQL,
    rollbackPlan:
      'ALTER TABLE work_policies DROP COLUMN gui_enabled; delete ledger ' +
      'row 22. Policies stop offering GUI sessions and every task falls ' +
      'back to the headless sandbox.',
    minimumCompatibleVersion: 22,
  });
