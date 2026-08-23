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
 * Per-policy takeover gating: a Work Computer policy may disable human
 * takeover of the screen. Null (and 1) allow takeover — the pre-migration
 * behavior; 0 disables it for tasks under the policy.
 */
export const POSTGRES_WORK_TAKEOVER_SQL = `ALTER TABLE work_policies ADD COLUMN takeover_enabled smallint CHECK (takeover_enabled IS NULL OR takeover_enabled IN (0, 1));`;

const version = 23;
const name = 'work-takeover';

export const POSTGRES_WORK_TAKEOVER_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_WORK_TAKEOVER_SQL}`)
      .digest('hex'),
    sql: POSTGRES_WORK_TAKEOVER_SQL,
    rollbackPlan:
      'ALTER TABLE work_policies DROP COLUMN takeover_enabled; delete ' +
      'ledger row 23. Every policy reverts to takeover allowed, the ' +
      'pre-migration behavior.',
    minimumCompatibleVersion: 23,
  });
