/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import type { PostgresMigration } from '../../persistence/postgresMigrationTypes.js';

const version = 11;
const name = 'work-message-content-json';
const sql = `
UPDATE work_messages
   SET content = to_json(content)::text;

ALTER TABLE work_messages
  ADD CONSTRAINT work_messages_content_json_string_check
  CHECK (json_typeof(content::json) = 'string');
`;

export const POSTGRES_WORK_MESSAGE_CONTENT_MIGRATION: PostgresMigration = {
  version,
  name,
  checksum: crypto
    .createHash('sha256')
    .update(`${version}\n${name}\n${sql}`)
    .digest('hex'),
  sql,
  rollbackPlan:
    'Stop every Libre replica and worker, restore the verified pre-upgrade PostgreSQL backup, and deploy the matching older release. An in-place downgrade requires strict JSON-string decoding of every work_messages.content row and is intentionally unsupported.',
  minimumCompatibleVersion: 11,
};
