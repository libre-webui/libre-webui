/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from '../../persistence/postgresMigrationTypes.js';

const version = 8;
const name = 'work-lifecycle-fences';

/**
 * Additive post-v7 lifecycle state. The account constraint is replaced only
 * here so the published v1 descriptor remains immutable. Preview endpoints
 * are private server routing state and never appear in signed client URLs.
 */
export const POSTGRES_WORK_LIFECYCLE_SQL = `
ALTER TABLE users
  DROP CONSTRAINT users_account_status_check;
ALTER TABLE users
  ADD CONSTRAINT users_account_status_check
  CHECK (account_status IN ('pending', 'active', 'retiring'));

ALTER TABLE work_tasks
  ADD COLUMN preview_upstream_host TEXT;
ALTER TABLE work_tasks
  ADD COLUMN preview_upstream_port INTEGER;
ALTER TABLE work_tasks
  ADD CONSTRAINT work_tasks_preview_upstream_check CHECK (
    (preview_upstream_host IS NULL AND preview_upstream_port IS NULL)
    OR
    (
      preview_upstream_host IS NOT NULL
      AND char_length(preview_upstream_host) >= 1
      AND char_length(preview_upstream_host) <= 253
      AND preview_upstream_port BETWEEN 1 AND 65535
    )
  );
`;

export const POSTGRES_WORK_LIFECYCLE_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_WORK_LIFECYCLE_SQL}`)
      .digest('hex'),
    sql: POSTGRES_WORK_LIFECYCLE_SQL,
    rollbackPlan:
      'Stop all app and worker replicas, verify no retiring accounts or active previews remain, restore the active/pending constraint, then drop the two preview upstream columns. Prefer restoring a verified backup.',
    minimumCompatibleVersion: 8,
  });
