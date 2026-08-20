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
 * Companion files bundled with a skill (the SKILL.md folder layout):
 * reference documents, templates, and script sources the model can read on
 * demand through the read_skill_file tool.
 */
export const POSTGRES_SKILL_FILES_SQL = `CREATE TABLE skill_files (
  id text PRIMARY KEY,
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL,
  size integer NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (skill_id, path)
);

CREATE INDEX idx_skill_files_skill
  ON skill_files(skill_id);`;

const version = 16;
const name = 'skill-files';

export const POSTGRES_SKILL_FILES_MIGRATION: PostgresMigration = Object.freeze({
  version,
  name,
  checksum: createHash('sha256')
    .update(`${version}\n${name}\n${POSTGRES_SKILL_FILES_SQL}`)
    .digest('hex'),
  sql: POSTGRES_SKILL_FILES_SQL,
  rollbackPlan:
    'DROP TABLE skill_files; delete ledger row 16. Skills keep working; ' +
    'their bundled companion files stop existing and the read_skill_file ' +
    'tool reports an empty inventory.',
  minimumCompatibleVersion: 16,
});
