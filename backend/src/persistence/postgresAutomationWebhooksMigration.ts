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
 * Inbound webhook firing for automations: the SHA-256 of a per-automation
 * secret. Null (the pre-migration state for every row) means the webhook
 * endpoint refuses to fire that automation.
 */
export const POSTGRES_AUTOMATION_WEBHOOKS_SQL = `ALTER TABLE automations ADD COLUMN webhook_secret_hash text;`;

const version = 28;
const name = 'automation-webhooks';

export const POSTGRES_AUTOMATION_WEBHOOKS_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_AUTOMATION_WEBHOOKS_SQL}`)
      .digest('hex'),
    sql: POSTGRES_AUTOMATION_WEBHOOKS_SQL,
    rollbackPlan:
      'ALTER TABLE automations DROP COLUMN webhook_secret_hash; delete ' +
      'ledger row 28. Every automation reverts to schedule-only firing, ' +
      'the pre-migration behavior.',
    minimumCompatibleVersion: 28,
  });
