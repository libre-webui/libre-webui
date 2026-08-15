/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from '../../persistence/postgresMigrationTypes.js';

const version = 12;
const name = 'durable-event-replay-index';

export const POSTGRES_DURABLE_EVENT_REPLAY_INDEX_SQL = `
CREATE INDEX idx_platform_events_stream_subject_cursor
  ON platform_events (stream_id, subject_id, global_cursor);
`;

export const POSTGRES_DURABLE_EVENT_REPLAY_INDEX_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_DURABLE_EVENT_REPLAY_INDEX_SQL}`)
      .digest('hex'),
    sql: POSTGRES_DURABLE_EVENT_REPLAY_INDEX_SQL,
    rollbackPlan:
      'Stop every Libre replica and worker, restore the verified pre-upgrade backup, then deploy the matching older release. Dropping idx_platform_events_stream_subject_cursor in place is safe only after proving no replay workload depends on it.',
    minimumCompatibleVersion: 12,
  });
