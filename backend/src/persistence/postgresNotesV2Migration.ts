/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

export const POSTGRES_NOTES_V2_SQL = `ALTER TABLE notes ADD COLUMN pinned smallint NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));

CREATE TABLE note_revisions (
  id text PRIMARY KEY,
  note_id text NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX idx_note_revisions_note
  ON note_revisions(note_id, created_at);

CREATE TABLE note_attachments (
  id text PRIMARY KEY,
  note_id text NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  blob_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  created_at bigint NOT NULL
);

CREATE INDEX idx_note_attachments_note
  ON note_attachments(note_id);`;

const version = 17;
const name = 'notes-v2';

export const POSTGRES_NOTES_V2_MIGRATION: PostgresMigration = Object.freeze({
  version,
  name,
  checksum: createHash('sha256')
    .update(`${version}\n${name}\n${POSTGRES_NOTES_V2_SQL}`)
    .digest('hex'),
  sql: POSTGRES_NOTES_V2_SQL,
  rollbackPlan:
    'DROP TABLE note_attachments; DROP TABLE note_revisions; ' +
    'ALTER TABLE notes DROP COLUMN pinned; delete ledger row 17. Notes keep ' +
    'working; revision history, attachments, and pinning stop existing.',
  minimumCompatibleVersion: 17,
});
