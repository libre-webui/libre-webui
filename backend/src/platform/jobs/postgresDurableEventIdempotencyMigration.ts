/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from '../../persistence/postgresMigrationTypes.js';

const version = 9;
const name = 'durable-event-idempotency';

export const POSTGRES_DURABLE_EVENT_IDEMPOTENCY_SQL = `
ALTER TABLE platform_events
  ADD COLUMN request_fingerprint text NOT NULL
  DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
  CHECK (request_fingerprint ~ '^[0-9a-f]{64}$');
`;

export const POSTGRES_DURABLE_EVENT_IDEMPOTENCY_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_DURABLE_EVENT_IDEMPOTENCY_SQL}`)
      .digest('hex'),
    sql: POSTGRES_DURABLE_EVENT_IDEMPOTENCY_SQL,
    rollbackPlan:
      'Stop every app and worker replica, verify no retriable event publishers depend on deterministic identities, then drop platform_events.request_fingerprint. Prefer restoring a verified backup.',
    minimumCompatibleVersion: 9,
  });
