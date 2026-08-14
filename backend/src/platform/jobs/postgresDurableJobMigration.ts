/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';

export const POSTGRES_DURABLE_JOBS_EVENTS_SQL = `
CREATE TABLE platform_event_stream_heads (
  stream_id text PRIMARY KEY,
  last_sequence bigint NOT NULL DEFAULT 0 CHECK (last_sequence >= 0)
);

CREATE TABLE platform_jobs (
  id uuid PRIMARY KEY,
  job_type text NOT NULL,
  actor_user_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'cancelled', 'dead_letter')),
  payload_format text NOT NULL CHECK (payload_format IN ('encrypted', 'reference')),
  payload text NOT NULL,
  idempotency_scope text NOT NULL,
  idempotency_key_hash char(64) NOT NULL,
  request_fingerprint char(64) NOT NULL,
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 10),
  available_at bigint NOT NULL,
  lease_owner text,
  lease_token bigint NOT NULL DEFAULT 0 CHECK (lease_token >= 0),
  lease_expires_at bigint,
  cancellation_requested_at bigint,
  cancellation_reason text,
  progress_current bigint NOT NULL DEFAULT 0 CHECK (progress_current >= 0),
  progress_total bigint NOT NULL DEFAULT 100 CHECK (progress_total > 0),
  progress_message text,
  result_reference text,
  error_code text,
  error_summary text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  started_at bigint,
  finished_at bigint,
  UNIQUE (actor_user_id, idempotency_scope, idempotency_key_hash),
  CHECK (progress_current <= progress_total),
  CHECK (
    (state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (state <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE TABLE platform_job_attempts (
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  lease_token bigint NOT NULL CHECK (lease_token > 0),
  worker_id text NOT NULL,
  started_at bigint NOT NULL,
  last_heartbeat_at bigint NOT NULL,
  finished_at bigint,
  outcome text NOT NULL CHECK (outcome IN ('running', 'succeeded', 'retry_scheduled', 'cancelled', 'dead_letter', 'abandoned')),
  error_code text,
  error_summary text,
  PRIMARY KEY (job_id, attempt_number),
  UNIQUE (job_id, lease_token)
);

CREATE TABLE platform_events (
  global_cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  stream_id text NOT NULL REFERENCES platform_event_stream_heads(stream_id) ON DELETE RESTRICT,
  stream_sequence bigint NOT NULL CHECK (stream_sequence > 0),
  event_type text NOT NULL,
  subject_id text NOT NULL,
  actor_user_id text REFERENCES users(id) ON DELETE SET NULL,
  payload_format text NOT NULL CHECK (payload_format IN ('encrypted', 'reference')),
  payload text NOT NULL,
  occurred_at bigint NOT NULL,
  UNIQUE (stream_id, stream_sequence)
);

CREATE INDEX idx_platform_jobs_claim
  ON platform_jobs (priority DESC, available_at ASC, created_at ASC, id ASC)
  WHERE state = 'queued';
CREATE INDEX idx_platform_jobs_expired_leases
  ON platform_jobs (lease_expires_at ASC, id ASC)
  WHERE state = 'running';
CREATE INDEX idx_platform_jobs_actor_created
  ON platform_jobs (actor_user_id, created_at DESC, id);
CREATE INDEX idx_platform_events_stream_cursor
  ON platform_events (stream_id, global_cursor);
CREATE INDEX idx_platform_events_occurred
  ON platform_events (occurred_at, global_cursor);
`;

const name = 'durable-jobs-events';
const version = 4;

/** Composed by the PostgreSQL migration coordinator in version order. */
export const POSTGRES_DURABLE_JOBS_EVENTS_MIGRATION = Object.freeze({
  version,
  name,
  checksum: createHash('sha256')
    .update(`${version}\n${name}\n${POSTGRES_DURABLE_JOBS_EVENTS_SQL}`)
    .digest('hex'),
  sql: POSTGRES_DURABLE_JOBS_EVENTS_SQL,
  rollbackPlan:
    'Stop all workers, verify no queued/running jobs, then drop platform_events, platform_job_attempts, platform_jobs, and platform_event_stream_heads in that order. Application downgrade must precede schema removal.',
  minimumCompatibleVersion: 4,
});
