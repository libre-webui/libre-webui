/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

export const POSTGRES_PLUGIN_DEFINITION_SQL = `
CREATE TABLE plugin_definitions (
  plugin_id text PRIMARY KEY
    CHECK (plugin_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  definition_json text NOT NULL,
  definition_fingerprint char(64) NOT NULL
    CHECK (definition_fingerprint ~ '^[0-9a-f]{64}$'),
  approved_by_user_id text,
  approved_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (
    (approved_by_user_id IS NULL AND approved_at IS NULL)
    OR
    (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX idx_plugin_definitions_updated
  ON plugin_definitions(updated_at DESC, plugin_id);
`;

const version = 7;
const name = 'shared-plugin-definitions';

export const POSTGRES_PLUGIN_DEFINITION_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_PLUGIN_DEFINITION_SQL}`)
      .digest('hex'),
    sql: POSTGRES_PLUGIN_DEFINITION_SQL,
    rollbackPlan:
      'Stop all replicas, export plugin definitions and their approval fingerprints, remove custom provider use, then drop plugin_definitions. Bundled read-only definitions remain available after application downgrade.',
    minimumCompatibleVersion: 7,
  });
