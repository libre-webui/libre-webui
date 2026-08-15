/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from '../../persistence/postgresMigrationTypes.js';

const version = 10;
const name = 'resource-deletion-lifecycle';

export const POSTGRES_RESOURCE_DELETION_LIFECYCLE_SQL = `
CREATE TABLE platform_resource_deletion_tombstones (
  resource_type text NOT NULL
    CHECK (resource_type IN ('document', 'generated-media', 'persona')),
  resource_id text NOT NULL CHECK (
    char_length(resource_id) >= 1 AND char_length(resource_id) <= 256
  ),
  owner_user_id text NOT NULL CHECK (
    char_length(owner_user_id) >= 1 AND char_length(owner_user_id) <= 256
  ),
  deletion_incarnation integer NOT NULL CHECK (deletion_incarnation > 0),
  deletion_token char(64) NOT NULL UNIQUE
    CHECK (deletion_token ~ '^[0-9a-f]{64}$'),
  deleted_at bigint NOT NULL CHECK (deleted_at >= 0),
  completed_at bigint CHECK (completed_at IS NULL OR completed_at >= deleted_at),
  PRIMARY KEY (resource_type, resource_id)
);

CREATE INDEX idx_platform_resource_tombstones_owner
  ON platform_resource_deletion_tombstones(owner_user_id, deleted_at, resource_type, resource_id);
`;

export const POSTGRES_RESOURCE_DELETION_LIFECYCLE_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(
        `${version}\n${name}\n${POSTGRES_RESOURCE_DELETION_LIFECYCLE_SQL}`
      )
      .digest('hex'),
    sql: POSTGRES_RESOURCE_DELETION_LIFECYCLE_SQL,
    rollbackPlan:
      'Stop every app and worker, verify no resource cleanup job is queued or running, and restore a verified backup. Dropping retained tombstones can make deleted identifiers unsafe to reuse.',
    minimumCompatibleVersion: 10,
  });
