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

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { assertDurableJobMigrationReady } from '../../persistence/sqliteMigrations.js';
import {
  DurableJobError,
  type DurableCancellationCode,
  type DurableJobAttemptMetadata,
  type DurableJobLease,
  type DurableJobMetadata,
  type DurableJobState,
} from './durableJobTypes.js';

const EXPIRED_REAP_LIMIT = 100;

export interface StoredDurablePayload {
  format: 'encrypted' | 'reference';
  data: string;
}

export interface PreparedDurableJobEnqueue {
  id: string;
  jobType: string;
  actorUserId: string;
  payload: StoredDurablePayload;
  idempotencyScope: string;
  idempotencyKeyHash: string;
  requestFingerprint: string;
  maxAttempts: number;
  priority: number;
  availableAt: number;
}

export interface PreparedDurableEventAppend {
  eventId: string;
  streamId: string;
  eventType: string;
  subjectId: string;
  actorUserId: string | null;
  payload: StoredDurablePayload;
  occurredAt: number;
}

interface JobRow {
  id: string;
  job_type: string;
  actor_user_id: string;
  state: DurableJobState;
  payload_format: StoredDurablePayload['format'];
  payload: string;
  idempotency_scope: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: number | null;
  cancellation_requested_at: number | null;
  cancellation_reason: string | null;
  progress_current: number;
  progress_total: number;
  progress_message: string | null;
  result_reference: string | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface AttemptRow {
  job_id: string;
  attempt_number: number;
  lease_token: number;
  worker_id: string;
  started_at: number;
  last_heartbeat_at: number;
  finished_at: number | null;
  outcome: DurableJobAttemptMetadata['outcome'];
  error_code: string | null;
  error_summary: string | null;
}

export interface StoredDurableEventRow {
  cursor: number;
  event_id: string;
  stream_id: string;
  stream_sequence: number;
  event_type: string;
  subject_id: string;
  actor_user_id: string | null;
  payload_format: StoredDurablePayload['format'];
  payload: string;
  occurred_at: number;
}

export interface DurableHeartbeatResult {
  owned: boolean;
  cancellationRequested: boolean;
}

const toMetadata = (row: JobRow): DurableJobMetadata => ({
  id: row.id,
  jobType: row.job_type,
  actorUserId: row.actor_user_id,
  state: row.state,
  priority: row.priority,
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  availableAt: row.available_at,
  cancellationRequestedAt: row.cancellation_requested_at,
  progressCurrent: row.progress_current,
  progressTotal: row.progress_total,
  progressMessage: row.progress_message,
  resultReference: row.result_reference,
  errorCode: row.error_code,
  errorSummary: row.error_summary,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

const toLease = (row: JobRow): DurableJobLease => {
  if (
    row.state !== 'running' ||
    row.lease_owner === null ||
    row.lease_expires_at === null
  ) {
    throw new DurableJobError(
      'storage-error',
      'Claimed durable job has an invalid lease'
    );
  }
  return {
    ...toMetadata(row),
    workerId: row.lease_owner,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  };
};

const toAttempt = (row: AttemptRow): DurableJobAttemptMetadata => ({
  jobId: row.job_id,
  attemptNumber: row.attempt_number,
  leaseToken: row.lease_token,
  workerId: row.worker_id,
  startedAt: row.started_at,
  lastHeartbeatAt: row.last_heartbeat_at,
  finishedAt: row.finished_at,
  outcome: row.outcome,
  errorCode: row.error_code,
  errorSummary: row.error_summary,
});

/**
 * SQLite implementation of the durable job and event-log repository.
 *
 * Every state mutation and its event are committed by one IMMEDIATE
 * transaction. Lease tokens only increase, so a reclaimed worker cannot later
 * heartbeat or complete a job with a stale token.
 */
export class SQLiteDurableJobRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly now: () => number = Date.now
  ) {
    assertDurableJobMigrationReady(database);
  }

  private immediate<T>(operation: () => T): T {
    return this.database.transaction(operation).immediate();
  }

  private findRow(id: string): JobRow | undefined {
    return this.database
      .prepare('SELECT * FROM platform_jobs WHERE id = ?')
      .get(id) as JobRow | undefined;
  }

  private appendEventInTransaction(input: PreparedDurableEventAppend): number {
    this.database
      .prepare(
        `INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
         VALUES (?, 0)
         ON CONFLICT(stream_id) DO NOTHING`
      )
      .run(input.streamId);
    this.database
      .prepare(
        `UPDATE platform_event_stream_heads
         SET last_sequence = last_sequence + 1
         WHERE stream_id = ?`
      )
      .run(input.streamId);
    const head = this.database
      .prepare(
        `SELECT last_sequence
         FROM platform_event_stream_heads
         WHERE stream_id = ?`
      )
      .get(input.streamId) as { last_sequence: number } | undefined;
    if (!head || !Number.isSafeInteger(head.last_sequence)) {
      throw new DurableJobError(
        'storage-error',
        'Durable event sequence is unavailable'
      );
    }

    const result = this.database
      .prepare(
        `INSERT INTO platform_events
           (event_id, stream_id, stream_sequence, event_type, subject_id,
            actor_user_id, payload_format, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventId,
        input.streamId,
        head.last_sequence,
        input.eventType,
        input.subjectId,
        input.actorUserId,
        input.payload.format,
        input.payload.data,
        input.occurredAt
      );
    const cursor = Number(result.lastInsertRowid);
    if (!Number.isSafeInteger(cursor)) {
      throw new DurableJobError(
        'storage-error',
        'Durable event cursor exceeded the supported range'
      );
    }
    return cursor;
  }

  private appendJobEvent(
    job: Pick<JobRow, 'id' | 'actor_user_id'>,
    eventType: string,
    occurredAt: number
  ): void {
    this.appendEventInTransaction({
      eventId: crypto.randomUUID(),
      streamId: `job:${job.id}`,
      eventType,
      subjectId: job.id,
      actorUserId: job.actor_user_id,
      payload: { format: 'reference', data: job.id },
      occurredAt,
    });
  }

  enqueue(input: PreparedDurableJobEnqueue): DurableJobMetadata {
    return this.immediate(() => {
      const existing = this.database
        .prepare(
          `SELECT * FROM platform_jobs
           WHERE actor_user_id = ?
             AND idempotency_scope = ?
             AND idempotency_key_hash = ?`
        )
        .get(
          input.actorUserId,
          input.idempotencyScope,
          input.idempotencyKeyHash
        ) as JobRow | undefined;
      if (existing) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new DurableJobError(
            'conflict',
            'The idempotency key is already bound to a different request'
          );
        }
        return toMetadata(existing);
      }

      const timestamp = this.now();
      this.database
        .prepare(
          `INSERT INTO platform_jobs
             (id, job_type, actor_user_id, state, payload_format, payload,
              idempotency_scope, idempotency_key_hash, request_fingerprint,
              priority, attempt_count, max_attempts, available_at,
              lease_token, progress_current, progress_total, created_at,
              updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 100,
                   ?, ?)`
        )
        .run(
          input.id,
          input.jobType,
          input.actorUserId,
          input.payload.format,
          input.payload.data,
          input.idempotencyScope,
          input.idempotencyKeyHash,
          input.requestFingerprint,
          input.priority,
          input.maxAttempts,
          input.availableAt,
          timestamp,
          timestamp
        );
      const row = this.findRow(input.id);
      if (!row) {
        throw new DurableJobError(
          'storage-error',
          'Durable job insert was not visible'
        );
      }
      this.appendJobEvent(row, 'job.queued', timestamp);
      return toMetadata(row);
    });
  }

  appendEvent(input: PreparedDurableEventAppend): number {
    return this.immediate(() => this.appendEventInTransaction(input));
  }

  private finishAttempt(
    job: JobRow,
    outcome: DurableJobAttemptMetadata['outcome'],
    timestamp: number,
    errorCode: string | null = null,
    errorSummary: string | null = null
  ): void {
    this.database
      .prepare(
        `UPDATE platform_job_attempts
         SET last_heartbeat_at = ?, finished_at = ?, outcome = ?,
             error_code = ?, error_summary = ?
         WHERE job_id = ? AND attempt_number = ? AND lease_token = ?
           AND outcome = 'running'`
      )
      .run(
        timestamp,
        timestamp,
        outcome,
        errorCode,
        errorSummary,
        job.id,
        job.attempt_count,
        job.lease_token
      );
  }

  private reapExpired(timestamp: number): void {
    const rows = this.database
      .prepare(
        `SELECT * FROM platform_jobs
         WHERE state = 'running'
           AND lease_expires_at <= ?
           AND (cancellation_requested_at IS NOT NULL
                OR attempt_count >= max_attempts)
         ORDER BY lease_expires_at ASC, id ASC
         LIMIT ?`
      )
      .all(timestamp, EXPIRED_REAP_LIMIT) as JobRow[];

    for (const row of rows) {
      const cancelled = row.cancellation_requested_at !== null;
      const state: DurableJobState = cancelled ? 'cancelled' : 'dead_letter';
      const errorCode = cancelled ? null : 'lease-expired';
      const errorSummary = cancelled
        ? null
        : 'The worker lease expired at the retry ceiling';
      this.database
        .prepare(
          `UPDATE platform_jobs
           SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
               finished_at = ?, updated_at = ?, error_code = ?,
               error_summary = ?
           WHERE id = ? AND state = 'running' AND lease_token = ?`
        )
        .run(
          state,
          timestamp,
          timestamp,
          errorCode,
          errorSummary,
          row.id,
          row.lease_token
        );
      this.finishAttempt(
        row,
        cancelled ? 'cancelled' : 'dead_letter',
        timestamp,
        errorCode,
        errorSummary
      );
      this.appendJobEvent(
        row,
        cancelled ? 'job.cancelled' : 'job.dead-lettered',
        timestamp
      );
    }
  }

  claim(workerId: string, leaseMs: number): DurableJobLease | null {
    return this.immediate(() => {
      const timestamp = this.now();
      this.reapExpired(timestamp);
      const candidate = this.database
        .prepare(
          `SELECT * FROM platform_jobs
           WHERE cancellation_requested_at IS NULL
             AND ((state = 'queued' AND available_at <= ?)
                  OR (state = 'running' AND lease_expires_at <= ?
                      AND attempt_count < max_attempts))
           ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
           LIMIT 1`
        )
        .get(timestamp, timestamp) as JobRow | undefined;
      if (!candidate) return null;

      if (candidate.state === 'running') {
        this.finishAttempt(candidate, 'abandoned', timestamp);
      }
      const nextAttempt = candidate.attempt_count + 1;
      const nextToken = candidate.lease_token + 1;
      const expiresAt = timestamp + leaseMs;
      const result = this.database
        .prepare(
          `UPDATE platform_jobs
           SET state = 'running', attempt_count = ?, lease_owner = ?,
               lease_token = ?, lease_expires_at = ?,
               started_at = COALESCE(started_at, ?), updated_at = ?,
               error_code = NULL, error_summary = NULL
           WHERE id = ? AND lease_token = ?
             AND ((state = 'queued' AND available_at <= ?)
                  OR (state = 'running' AND lease_expires_at <= ?))`
        )
        .run(
          nextAttempt,
          workerId,
          nextToken,
          expiresAt,
          timestamp,
          timestamp,
          candidate.id,
          candidate.lease_token,
          timestamp,
          timestamp
        );
      if (result.changes !== 1) return null;

      this.database
        .prepare(
          `INSERT INTO platform_job_attempts
             (job_id, attempt_number, lease_token, worker_id, started_at,
              last_heartbeat_at, outcome)
           VALUES (?, ?, ?, ?, ?, ?, 'running')`
        )
        .run(
          candidate.id,
          nextAttempt,
          nextToken,
          workerId,
          timestamp,
          timestamp
        );
      const claimed = this.findRow(candidate.id);
      if (!claimed) {
        throw new DurableJobError(
          'storage-error',
          'Claimed durable job disappeared'
        );
      }
      this.appendJobEvent(claimed, 'job.claimed', timestamp);
      return toLease(claimed);
    });
  }

  heartbeat(lease: DurableJobLease, leaseMs: number): DurableHeartbeatResult {
    return this.immediate(() => {
      const timestamp = this.now();
      const expiresAt = timestamp + leaseMs;
      const result = this.database
        .prepare(
          `UPDATE platform_jobs
           SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND lease_owner = ?
             AND lease_token = ? AND lease_expires_at > ?`
        )
        .run(
          expiresAt,
          timestamp,
          lease.id,
          lease.workerId,
          lease.leaseToken,
          timestamp
        );
      if (result.changes !== 1) {
        return { owned: false, cancellationRequested: false };
      }
      this.database
        .prepare(
          `UPDATE platform_job_attempts
           SET last_heartbeat_at = ?
           WHERE job_id = ? AND attempt_number = ? AND lease_token = ?
             AND outcome = 'running'`
        )
        .run(timestamp, lease.id, lease.attemptCount, lease.leaseToken);
      const row = this.findRow(lease.id);
      return {
        owned: true,
        cancellationRequested: row?.cancellation_requested_at !== null,
      };
    });
  }

  updateProgress(
    lease: DurableJobLease,
    current: number,
    total: number,
    message: string | null
  ): void {
    const timestamp = this.now();
    const result = this.database
      .prepare(
        `UPDATE platform_jobs
         SET progress_current = ?, progress_total = ?, progress_message = ?,
             updated_at = ?
         WHERE id = ? AND state = 'running' AND lease_owner = ?
           AND lease_token = ? AND lease_expires_at > ?`
      )
      .run(
        current,
        total,
        message,
        timestamp,
        lease.id,
        lease.workerId,
        lease.leaseToken,
        timestamp
      );
    if (result.changes !== 1) {
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    }
  }

  complete(lease: DurableJobLease, resultReference: string | null): void {
    this.immediate(() => {
      const timestamp = this.now();
      const row = this.findRow(lease.id);
      if (
        !row ||
        row.state !== 'running' ||
        row.lease_owner !== lease.workerId ||
        row.lease_token !== lease.leaseToken ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= timestamp
      ) {
        throw new DurableJobError(
          'lease-lost',
          'The durable job lease was lost'
        );
      }
      const cancelled = row.cancellation_requested_at !== null;
      this.database
        .prepare(
          `UPDATE platform_jobs
           SET state = ?, lease_owner = NULL, lease_expires_at = NULL,
               result_reference = ?, progress_current = progress_total,
               finished_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND lease_owner = ?
             AND lease_token = ? AND lease_expires_at > ?`
        )
        .run(
          cancelled ? 'cancelled' : 'succeeded',
          cancelled ? null : resultReference,
          timestamp,
          timestamp,
          row.id,
          lease.workerId,
          lease.leaseToken,
          timestamp
        );
      this.finishAttempt(row, cancelled ? 'cancelled' : 'succeeded', timestamp);
      this.appendJobEvent(
        row,
        cancelled ? 'job.cancelled' : 'job.succeeded',
        timestamp
      );
    });
  }

  fail(
    lease: DurableJobLease,
    retryable: boolean,
    errorCode: string,
    errorSummary: string,
    nextAvailableAt: number
  ): DurableJobState {
    return this.immediate(() => {
      const timestamp = this.now();
      const row = this.findRow(lease.id);
      if (
        !row ||
        row.state !== 'running' ||
        row.lease_owner !== lease.workerId ||
        row.lease_token !== lease.leaseToken ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= timestamp
      ) {
        throw new DurableJobError(
          'lease-lost',
          'The durable job lease was lost'
        );
      }

      const cancelled = row.cancellation_requested_at !== null;
      const willRetry =
        !cancelled && retryable && row.attempt_count < row.max_attempts;
      const state: DurableJobState = cancelled
        ? 'cancelled'
        : willRetry
          ? 'queued'
          : 'dead_letter';
      const finalErrorCode = cancelled ? null : errorCode;
      const finalErrorSummary = cancelled ? null : errorSummary;
      this.database
        .prepare(
          `UPDATE platform_jobs
           SET state = ?, available_at = ?, lease_owner = NULL,
               lease_expires_at = NULL, error_code = ?, error_summary = ?,
               finished_at = ?, updated_at = ?
           WHERE id = ? AND state = 'running' AND lease_owner = ?
             AND lease_token = ? AND lease_expires_at > ?`
        )
        .run(
          state,
          willRetry ? nextAvailableAt : row.available_at,
          finalErrorCode,
          finalErrorSummary,
          willRetry ? null : timestamp,
          timestamp,
          row.id,
          lease.workerId,
          lease.leaseToken,
          timestamp
        );
      this.finishAttempt(
        row,
        cancelled ? 'cancelled' : willRetry ? 'retry_scheduled' : 'dead_letter',
        timestamp,
        finalErrorCode,
        finalErrorSummary
      );
      this.appendJobEvent(
        row,
        cancelled
          ? 'job.cancelled'
          : willRetry
            ? 'job.retry-scheduled'
            : 'job.dead-lettered',
        timestamp
      );
      return state;
    });
  }

  abandon(lease: DurableJobLease): DurableJobState {
    return this.fail(
      lease,
      true,
      'worker-shutdown',
      'The worker stopped before completing the attempt',
      this.now()
    );
  }

  requestCancellation(
    id: string,
    actorUserId: string,
    reason: DurableCancellationCode
  ): DurableJobMetadata {
    return this.immediate(() => {
      const timestamp = this.now();
      const row = this.findRow(id);
      if (!row || row.actor_user_id !== actorUserId) {
        throw new DurableJobError('not-found', 'Durable job not found');
      }
      if (
        row.state === 'succeeded' ||
        row.state === 'cancelled' ||
        row.state === 'dead_letter'
      ) {
        return toMetadata(row);
      }
      if (row.cancellation_requested_at !== null) return toMetadata(row);

      if (row.state === 'queued') {
        this.database
          .prepare(
            `UPDATE platform_jobs
             SET state = 'cancelled', cancellation_requested_at = ?,
                 cancellation_reason = ?, finished_at = ?, updated_at = ?
             WHERE id = ? AND state = 'queued'`
          )
          .run(timestamp, reason, timestamp, timestamp, id);
        this.appendJobEvent(row, 'job.cancelled', timestamp);
      } else {
        this.database
          .prepare(
            `UPDATE platform_jobs
             SET cancellation_requested_at = ?, cancellation_reason = ?,
                 updated_at = ?
             WHERE id = ? AND state = 'running'`
          )
          .run(timestamp, reason, timestamp, id);
        this.appendJobEvent(row, 'job.cancellation-requested', timestamp);
      }
      const updated = this.findRow(id);
      if (!updated) {
        throw new DurableJobError(
          'storage-error',
          'Cancelled durable job disappeared'
        );
      }
      return toMetadata(updated);
    });
  }

  getMetadata(id: string): DurableJobMetadata | null {
    const row = this.findRow(id);
    return row ? toMetadata(row) : null;
  }

  getStoredPayload(lease: DurableJobLease): StoredDurablePayload {
    const timestamp = this.now();
    const row = this.findRow(lease.id);
    if (
      !row ||
      row.state !== 'running' ||
      row.lease_owner !== lease.workerId ||
      row.lease_token !== lease.leaseToken ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= timestamp
    ) {
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    }
    return { format: row.payload_format, data: row.payload };
  }

  listAttempts(id: string): DurableJobAttemptMetadata[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM platform_job_attempts
           WHERE job_id = ? ORDER BY attempt_number ASC`
        )
        .all(id) as AttemptRow[]
    ).map(toAttempt);
  }

  replayStoredEvents(
    afterCursor: number,
    limit: number,
    streamId?: string
  ): StoredDurableEventRow[] {
    if (streamId) {
      return this.database
        .prepare(
          `SELECT global_cursor AS cursor, event_id, stream_id,
                  stream_sequence, event_type, subject_id, actor_user_id,
                  payload_format, payload, occurred_at
           FROM platform_events
           WHERE global_cursor > ? AND stream_id = ?
           ORDER BY global_cursor ASC LIMIT ?`
        )
        .all(afterCursor, streamId, limit) as StoredDurableEventRow[];
    }
    return this.database
      .prepare(
        `SELECT global_cursor AS cursor, event_id, stream_id, stream_sequence,
                event_type, subject_id, actor_user_id, payload_format,
                payload, occurred_at
         FROM platform_events
         WHERE global_cursor > ?
         ORDER BY global_cursor ASC LIMIT ?`
      )
      .all(afterCursor, limit) as StoredDurableEventRow[];
  }
}
