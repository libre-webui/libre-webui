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
  type DurableChatCancellationDecision,
  type DurableChatCompletionMessage,
  type DurableJobActorFilter,
  type DurableJobCancellationSummary,
  type DurableJobAttemptMetadata,
  type DurableJobLease,
  type DurableJobListOptions,
  type DurableJobMetadata,
  type DurableResourceDeletionOccurrence,
  type DurableJobState,
} from './durableJobTypes.js';
import {
  DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX,
  OWNER_DELETE_CONTENT_JOB_TYPE,
  OWNER_DELETE_CONTENT_RECOVERABLE_ERROR_CODES,
  RESOURCE_DELETE_JOB_TYPE,
  RESOURCE_DELETE_RECOVERABLE_ERROR_CODES,
} from './domainJobContracts.js';

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
  requestFingerprint: string;
  streamId: string;
  eventType: string;
  subjectId: string;
  actorUserId: string | null;
  payload: StoredDurablePayload;
  occurredAt: number;
}

export interface PreparedDurableChatCompletion {
  lease: {
    jobId: string;
    workerId: string;
    leaseToken: number;
  };
  actorUserId: string;
  sessionId: string;
  expectedJobType: string;
  expectedIdempotencyScope: string;
  expectedIdempotencyKeyHash: string;
  cancellationEventId: string;
  message: DurableChatCompletionMessage;
  event: PreparedDurableEventAppend;
  beforeCommit?: () => void | Promise<void>;
}

export interface PreparedDurableChatCancellation {
  actorUserId: string;
  idempotencyScope: string;
  idempotencyKeyHash: string;
  doneEventId: string;
  event: PreparedDurableEventAppend;
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
  request_fingerprint: string;
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

export interface StoredLifecycleRecoveryCandidate {
  id: string;
  jobType: string;
  actorUserId: string;
  payload: StoredDurablePayload;
  priority: number;
  updatedAt: number;
}

export interface DurableJobClaimResult {
  lease: DurableJobLease | null;
  terminalLifecycleJobIds: string[];
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
    const existing = this.database
      .prepare(
        `SELECT global_cursor, request_fingerprint
           FROM platform_events WHERE event_id = ?`
      )
      .get(input.eventId) as
      { global_cursor: number; request_fingerprint: string } | undefined;
    if (existing) {
      if (existing.request_fingerprint !== input.requestFingerprint) {
        throw new DurableJobError(
          'conflict',
          'Durable event identity was reused for different content'
        );
      }
      return existing.global_cursor;
    }
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
           (event_id, request_fingerprint, stream_id, stream_sequence, event_type, subject_id,
            actor_user_id, payload_format, payload, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.eventId,
        input.requestFingerprint,
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
      requestFingerprint: crypto
        .createHash('sha256')
        .update(`${job.id}\n${eventType}\n${occurredAt}`)
        .digest('hex'),
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

  requestChatCancellation(
    input: PreparedDurableChatCancellation
  ): DurableChatCancellationDecision {
    return this.immediate(() => {
      const completion = this.database
        .prepare(
          `SELECT global_cursor FROM platform_events
            WHERE event_id = ? AND stream_id = ?
              AND event_type = 'chat.done.v1'
              AND subject_id = ? AND actor_user_id = ?`
        )
        .get(
          input.doneEventId,
          input.event.streamId,
          input.event.subjectId,
          input.actorUserId
        ) as { global_cursor: number } | undefined;
      if (completion) {
        return {
          outcome: 'completion-won',
          cursor: completion.global_cursor,
          job: null,
        };
      }

      const cursor = this.appendEventInTransaction(input.event);
      const job = this.database
        .prepare(
          `SELECT * FROM platform_jobs
            WHERE actor_user_id = ? AND idempotency_scope = ?
              AND idempotency_key_hash = ?`
        )
        .get(
          input.actorUserId,
          input.idempotencyScope,
          input.idempotencyKeyHash
        ) as JobRow | undefined;
      return {
        outcome: 'cancellation-recorded',
        cursor,
        job: job
          ? this.requestCancellationInTransaction(
              job.id,
              input.actorUserId,
              'user-requested'
            )
          : null,
      };
    });
  }

  /**
   * Linearize the assistant row and its terminal event under the durable job
   * fence. A worker crash can therefore expose both effects or neither.
   */
  publishChatCompletion(input: PreparedDurableChatCompletion): number {
    return this.immediate(() => {
      const timestamp = this.now();
      const job = this.findRow(input.lease.jobId);
      if (!job) {
        throw new DurableJobError('lease-lost', 'Durable job lease was lost');
      }
      if (
        job.actor_user_id !== input.actorUserId ||
        job.job_type !== input.expectedJobType ||
        job.idempotency_scope !== input.expectedIdempotencyScope ||
        job.idempotency_key_hash !== input.expectedIdempotencyKeyHash
      ) {
        throw new DurableJobError(
          'conflict',
          'Chat completion does not match its durable job'
        );
      }
      if (job.cancellation_requested_at !== null) {
        throw new DurableJobError('cancelled', 'Durable job was cancelled');
      }
      if (
        job.state !== 'running' ||
        job.lease_owner !== input.lease.workerId ||
        job.lease_token !== input.lease.leaseToken ||
        job.lease_expires_at === null ||
        job.lease_expires_at <= timestamp
      ) {
        throw new DurableJobError('lease-lost', 'Durable job lease was lost');
      }

      const session = this.database
        .prepare('SELECT user_id FROM sessions WHERE id = ?')
        .get(input.sessionId) as { user_id: string } | undefined;
      if (!session || session.user_id !== input.actorUserId) {
        throw new DurableJobError(
          'conflict',
          'Chat completion session is unavailable'
        );
      }
      if (input.message.sessionId !== input.sessionId) {
        throw new DurableJobError(
          'conflict',
          'Chat completion message does not match its session'
        );
      }

      const cancellation = this.database
        .prepare(
          `SELECT 1 FROM platform_events
            WHERE event_id = ? AND stream_id = ?
              AND event_type = 'chat.cancel-requested.v1'
              AND subject_id = ? AND actor_user_id = ?`
        )
        .get(
          input.cancellationEventId,
          input.event.streamId,
          input.message.id,
          input.actorUserId
        );
      if (cancellation) {
        throw new DurableJobError('cancelled', 'Durable job was cancelled');
      }

      const existingEvent = this.database
        .prepare('SELECT 1 FROM platform_events WHERE event_id = ?')
        .get(input.event.eventId);
      const existingMessage = this.database
        .prepare(
          'SELECT role FROM session_messages WHERE id = ? AND session_id = ?'
        )
        .get(input.message.id, input.sessionId) as { role: string } | undefined;
      if (existingEvent) {
        if (!existingMessage || existingMessage.role !== 'assistant') {
          throw new DurableJobError(
            'storage-error',
            'Durable chat completion event has no assistant message'
          );
        }
        return this.appendEventInTransaction(input.event);
      }
      if (existingMessage) {
        throw new DurableJobError(
          'conflict',
          'Assistant message identity already exists without completion'
        );
      }

      let branchIndex = 0;
      if (input.message.parentId) {
        const branchRoot = this.database
          .prepare(
            `SELECT role FROM session_messages
              WHERE id = ? AND session_id = ?`
          )
          .get(input.message.parentId, input.sessionId) as
          { role: string } | undefined;
        if (branchRoot?.role !== 'assistant') {
          throw new DurableJobError(
            'conflict',
            'Chat completion branch root is unavailable'
          );
        }
        const branch = this.database
          .prepare(
            `SELECT COALESCE(MAX(branch_index), 0) + 1 AS next_index
               FROM session_messages
              WHERE session_id = ? AND (id = ? OR parent_id = ?)`
          )
          .get(
            input.sessionId,
            input.message.parentId,
            input.message.parentId
          ) as { next_index: number };
        branchIndex = branch.next_index;
        this.database
          .prepare(
            `UPDATE session_messages SET is_active = 0
              WHERE session_id = ? AND (id = ? OR parent_id = ?)`
          )
          .run(input.sessionId, input.message.parentId, input.message.parentId);
      }
      const position = this.database
        .prepare(
          `SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index
             FROM session_messages WHERE session_id = ?`
        )
        .get(input.sessionId) as { next_index: number };
      this.database
        .prepare(
          `INSERT INTO session_messages
             (id, session_id, role, content, thinking, timestamp, message_index,
              model, provider_metadata, images, statistics, artifacts,
              parent_id, branch_index, is_active, rating)
           VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.message.id,
          input.sessionId,
          input.message.content,
          input.message.thinking,
          input.message.timestamp,
          position.next_index,
          input.message.model,
          input.message.providerMetadata,
          input.message.images,
          input.message.statistics,
          input.message.artifacts,
          input.message.parentId,
          branchIndex,
          input.message.parentId ? 1 : input.message.isActive,
          input.message.rating
        );
      this.database
        .prepare(
          `UPDATE sessions SET updated_at = MAX(updated_at, ?)
            WHERE id = ? AND user_id = ?`
        )
        .run(timestamp, input.sessionId, input.actorUserId);
      const completionCursor = this.appendEventInTransaction(input.event);
      if (this.finishAttempt(job, 'succeeded', timestamp) !== 1) {
        throw new DurableJobError('lease-lost', 'Durable job attempt was lost');
      }
      const resultReference = `chat-message:${input.message.id}`;
      const terminal = this.database
        .prepare(
          `UPDATE platform_jobs
              SET state = 'succeeded', result_reference = ?,
                  lease_owner = NULL, lease_expires_at = NULL,
                  progress_current = progress_total,
                  progress_message = 'Chat response saved',
                  finished_at = ?, updated_at = ?
            WHERE id = ? AND state = 'running' AND lease_owner = ?
              AND lease_token = ? AND lease_expires_at > ?
              AND actor_user_id = ? AND job_type = ?
              AND idempotency_scope = ? AND idempotency_key_hash = ?
              AND cancellation_requested_at IS NULL`
        )
        .run(
          resultReference,
          timestamp,
          timestamp,
          job.id,
          input.lease.workerId,
          input.lease.leaseToken,
          timestamp,
          input.actorUserId,
          input.expectedJobType,
          input.expectedIdempotencyScope,
          input.expectedIdempotencyKeyHash
        );
      if (terminal.changes !== 1) {
        throw new DurableJobError('lease-lost', 'Durable job lease was lost');
      }
      this.appendJobEvent(job, 'job.succeeded', timestamp);
      return completionCursor;
    });
  }

  private finishAttempt(
    job: JobRow,
    outcome: DurableJobAttemptMetadata['outcome'],
    timestamp: number,
    errorCode: string | null = null,
    errorSummary: string | null = null
  ): number {
    return this.database
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
      ).changes;
  }

  private reapExpired(timestamp: number): string[] {
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

    const terminalLifecycleJobIds: string[] = [];
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
      if (
        row.job_type === RESOURCE_DELETE_JOB_TYPE ||
        row.job_type === OWNER_DELETE_CONTENT_JOB_TYPE
      ) {
        terminalLifecycleJobIds.push(row.id);
      }
    }
    return terminalLifecycleJobIds;
  }

  claimWithLifecycleRecovery(
    workerId: string,
    leaseMs: number
  ): DurableJobClaimResult {
    return this.immediate(() => {
      const timestamp = this.now();
      const terminalLifecycleJobIds = this.reapExpired(timestamp);
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
      if (!candidate) return { lease: null, terminalLifecycleJobIds };

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
      if (result.changes !== 1) {
        return { lease: null, terminalLifecycleJobIds };
      }

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
      return { lease: toLease(claimed), terminalLifecycleJobIds };
    });
  }

  claim(workerId: string, leaseMs: number): DurableJobLease | null {
    return this.claimWithLifecycleRecovery(workerId, leaseMs).lease;
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

  private requestCancellationInTransaction(
    id: string,
    actorUserId: string,
    reason: DurableCancellationCode
  ): DurableJobMetadata {
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
  }

  requestCancellation(
    id: string,
    actorUserId: string,
    reason: DurableCancellationCode
  ): DurableJobMetadata {
    return this.immediate(() =>
      this.requestCancellationInTransaction(id, actorUserId, reason)
    );
  }

  requestActorCancellation(
    actorUserId: string,
    reason: DurableCancellationCode,
    filter: DurableJobActorFilter = {}
  ): DurableJobCancellationSummary {
    return this.immediate(() => {
      const clauses = [
        'actor_user_id = ?',
        "state IN ('queued', 'running')",
        'cancellation_requested_at IS NULL',
      ];
      const bindings: string[] = [actorUserId];
      if (filter.jobTypes && filter.jobTypes.length > 0) {
        clauses.push(
          `job_type IN (${filter.jobTypes.map(() => '?').join(', ')})`
        );
        bindings.push(...filter.jobTypes);
      }
      if (filter.excludeJobTypes && filter.excludeJobTypes.length > 0) {
        clauses.push(
          `job_type NOT IN (${filter.excludeJobTypes.map(() => '?').join(', ')})`
        );
        bindings.push(...filter.excludeJobTypes);
      }
      if (filter.idempotencyScopes && filter.idempotencyScopes.length > 0) {
        clauses.push(
          `idempotency_scope IN (${filter.idempotencyScopes.map(() => '?').join(', ')})`
        );
        bindings.push(...filter.idempotencyScopes);
      }
      if (filter.excludeJobIds && filter.excludeJobIds.length > 0) {
        clauses.push(
          `id NOT IN (${filter.excludeJobIds.map(() => '?').join(', ')})`
        );
        bindings.push(...filter.excludeJobIds);
      }
      const rows = this.database
        .prepare(`SELECT * FROM platform_jobs WHERE ${clauses.join(' AND ')}`)
        .all(...bindings) as JobRow[];
      const timestamp = this.now();
      let cancelledQueued = 0;
      let cancellationRequestedRunning = 0;
      for (const row of rows) {
        if (row.state === 'queued') {
          const result = this.database
            .prepare(
              `UPDATE platform_jobs
                  SET state = 'cancelled', cancellation_requested_at = ?,
                      cancellation_reason = ?, finished_at = ?, updated_at = ?
                WHERE id = ? AND state = 'queued'
                  AND cancellation_requested_at IS NULL`
            )
            .run(timestamp, reason, timestamp, timestamp, row.id);
          if (result.changes === 1) {
            cancelledQueued += 1;
            this.appendJobEvent(row, 'job.cancelled', timestamp);
          }
          continue;
        }
        const result = this.database
          .prepare(
            `UPDATE platform_jobs
                SET cancellation_requested_at = ?, cancellation_reason = ?,
                    updated_at = ?
              WHERE id = ? AND state = 'running'
                AND cancellation_requested_at IS NULL`
          )
          .run(timestamp, reason, timestamp, row.id);
        if (result.changes === 1) {
          cancellationRequestedRunning += 1;
          this.appendJobEvent(row, 'job.cancellation-requested', timestamp);
        }
      }
      return { cancelledQueued, cancellationRequestedRunning };
    });
  }

  countActiveForActor(
    actorUserId: string,
    filter: DurableJobActorFilter = {}
  ): number {
    const clauses = ['actor_user_id = ?', "state IN ('queued', 'running')"];
    const bindings: string[] = [actorUserId];
    if (filter.jobTypes && filter.jobTypes.length > 0) {
      clauses.push(
        `job_type IN (${filter.jobTypes.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.jobTypes);
    }
    if (filter.excludeJobTypes && filter.excludeJobTypes.length > 0) {
      clauses.push(
        `job_type NOT IN (${filter.excludeJobTypes.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.excludeJobTypes);
    }
    if (filter.idempotencyScopes && filter.idempotencyScopes.length > 0) {
      clauses.push(
        `idempotency_scope IN (${filter.idempotencyScopes.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.idempotencyScopes);
    }
    if (filter.excludeJobIds && filter.excludeJobIds.length > 0) {
      clauses.push(
        `id NOT IN (${filter.excludeJobIds.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.excludeJobIds);
    }
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_jobs WHERE ${clauses.join(' AND ')}`
      )
      .get(...bindings) as { count: number };
    return row.count;
  }

  countNonSucceededForActor(
    actorUserId: string,
    filter: DurableJobActorFilter = {}
  ): number {
    const clauses = ['actor_user_id = ?', "state <> 'succeeded'"];
    const bindings: string[] = [actorUserId];
    if (filter.jobTypes && filter.jobTypes.length > 0) {
      clauses.push(
        `job_type IN (${filter.jobTypes.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.jobTypes);
    }
    if (filter.excludeJobTypes && filter.excludeJobTypes.length > 0) {
      clauses.push(
        `job_type NOT IN (${filter.excludeJobTypes.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.excludeJobTypes);
    }
    if (filter.idempotencyScopes && filter.idempotencyScopes.length > 0) {
      clauses.push(
        `idempotency_scope IN (${filter.idempotencyScopes.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.idempotencyScopes);
    }
    if (filter.excludeJobIds && filter.excludeJobIds.length > 0) {
      clauses.push(
        `id NOT IN (${filter.excludeJobIds.map(() => '?').join(', ')})`
      );
      bindings.push(...filter.excludeJobIds);
    }
    if (filter.excludeHandledLifecycleJobs) {
      clauses.push(
        `NOT (
          job_type IN (?, ?)
          AND state IN ('cancelled', 'dead_letter')
          AND result_reference LIKE ?
        )`
      );
      bindings.push(
        RESOURCE_DELETE_JOB_TYPE,
        OWNER_DELETE_CONTENT_JOB_TYPE,
        `${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}%`
      );
    }
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM platform_jobs WHERE ${clauses.join(' AND ')}`
      )
      .get(...bindings) as { count: number };
    return row.count;
  }

  getMetadata(id: string): DurableJobMetadata | null {
    const row = this.findRow(id);
    return row ? toMetadata(row) : null;
  }

  listDeletionLifecycleRecoveryCandidates(
    afterId: string,
    limit: number
  ): StoredLifecycleRecoveryCandidate[] {
    const resourceCodes = RESOURCE_DELETE_RECOVERABLE_ERROR_CODES;
    const ownerCodes = OWNER_DELETE_CONTENT_RECOVERABLE_ERROR_CODES;
    const rows = this.database
      .prepare(
        `SELECT jobs.*
           FROM platform_jobs jobs
          JOIN users actor ON actor.id = jobs.actor_user_id
          WHERE jobs.id > ?
            AND jobs.result_reference IS NULL
            AND (
              (
                jobs.job_type = ?
                AND actor.account_status = 'active'
                AND (
                  (jobs.state = 'dead_letter' AND jobs.error_code IN (${resourceCodes.map(() => '?').join(', ')}))
                  OR jobs.state = 'cancelled'
                )
              )
              OR
              (
                jobs.job_type = ?
                AND actor.account_status IN ('active', 'retiring')
                AND (
                  (jobs.state = 'dead_letter' AND jobs.error_code IN (${ownerCodes.map(() => '?').join(', ')}))
                  OR jobs.state = 'cancelled'
                )
              )
            )
          ORDER BY jobs.id ASC
          LIMIT ?`
      )
      .all(
        afterId,
        RESOURCE_DELETE_JOB_TYPE,
        ...resourceCodes,
        OWNER_DELETE_CONTENT_JOB_TYPE,
        ...ownerCodes,
        limit
      ) as JobRow[];
    return rows.map(row => ({
      id: row.id,
      jobType: row.job_type,
      actorUserId: row.actor_user_id,
      payload: { format: row.payload_format, data: row.payload },
      priority: row.priority,
      updatedAt: row.updated_at,
    }));
  }

  getDeletionLifecycleRecoveryCandidate(
    id: string
  ): StoredLifecycleRecoveryCandidate | null {
    const resourceCodes = RESOURCE_DELETE_RECOVERABLE_ERROR_CODES;
    const ownerCodes = OWNER_DELETE_CONTENT_RECOVERABLE_ERROR_CODES;
    const row = this.database
      .prepare(
        `SELECT jobs.*
           FROM platform_jobs jobs
           JOIN users actor ON actor.id = jobs.actor_user_id
          WHERE jobs.id = ?
            AND jobs.result_reference IS NULL
            AND (
              (
                jobs.job_type = ?
                AND actor.account_status = 'active'
                AND (
                  (jobs.state = 'dead_letter' AND jobs.error_code IN (${resourceCodes.map(() => '?').join(', ')}))
                  OR jobs.state = 'cancelled'
                )
              )
              OR
              (
                jobs.job_type = ?
                AND actor.account_status IN ('active', 'retiring')
                AND (
                  (jobs.state = 'dead_letter' AND jobs.error_code IN (${ownerCodes.map(() => '?').join(', ')}))
                  OR jobs.state = 'cancelled'
                )
              )
            )`
      )
      .get(
        id,
        RESOURCE_DELETE_JOB_TYPE,
        ...resourceCodes,
        OWNER_DELETE_CONTENT_JOB_TYPE,
        ...ownerCodes
      ) as JobRow | undefined;
    return row
      ? {
          id: row.id,
          jobType: row.job_type,
          actorUserId: row.actor_user_id,
          payload: { format: row.payload_format, data: row.payload },
          priority: row.priority,
          updatedAt: row.updated_at,
        }
      : null;
  }

  markDeletionLifecycleRecoveryHandled(
    id: string,
    resultReference: string
  ): void {
    this.immediate(() => {
      const updated = this.database
        .prepare(
          `UPDATE platform_jobs
              SET result_reference = ?
            WHERE id = ?
              AND job_type IN (?, ?)
              AND state IN ('cancelled', 'dead_letter')
              AND result_reference IS NULL`
        )
        .run(
          resultReference,
          id,
          RESOURCE_DELETE_JOB_TYPE,
          OWNER_DELETE_CONTENT_JOB_TYPE
        );
      if (updated.changes === 1) return;
      const existing = this.database
        .prepare(
          `SELECT result_reference FROM platform_jobs
            WHERE id = ? AND job_type IN (?, ?)
              AND state IN ('cancelled', 'dead_letter')`
        )
        .get(id, RESOURCE_DELETE_JOB_TYPE, OWNER_DELETE_CONTENT_JOB_TYPE) as
        { result_reference: string | null } | undefined;
      if (
        existing?.result_reference === resultReference ||
        existing?.result_reference?.startsWith(
          DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX
        )
      ) {
        return;
      }
      throw new DurableJobError(
        'storage-error',
        'Deletion lifecycle recovery marker conflicted'
      );
    });
  }

  isPendingResourceDeletion(input: DurableResourceDeletionOccurrence): boolean {
    const table = (() => {
      switch (input.resourceType) {
        case 'document':
          return 'documents';
        case 'generated-media':
          return 'generated_images';
        case 'persona':
          return 'personas';
      }
    })();
    return Boolean(
      this.database
        .prepare(
          `SELECT 1
             FROM platform_resource_deletion_tombstones tombstone
            WHERE tombstone.resource_type = ?
              AND tombstone.resource_id = ?
              AND tombstone.owner_user_id = ?
              AND tombstone.deletion_incarnation = ?
              AND tombstone.deletion_token = ?
              AND tombstone.completed_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM ${table} resource
                 WHERE resource.id = tombstone.resource_id
                   AND resource.user_id = tombstone.owner_user_id
              )`
        )
        .get(
          input.resourceType,
          input.resourceId,
          input.ownerUserId,
          input.deletionIncarnation,
          input.deletionToken
        )
    );
  }

  isOwnerCleanupRequired(targetUserId: string): boolean {
    return !this.database
      .prepare('SELECT 1 FROM users WHERE id = ?')
      .get(targetUserId);
  }

  getByIdempotency(
    actorUserId: string,
    idempotencyScope: string,
    idempotencyKeyHash: string
  ): DurableJobMetadata | null {
    const row = this.database
      .prepare(
        `SELECT * FROM platform_jobs
         WHERE actor_user_id = ?
           AND idempotency_scope = ?
           AND idempotency_key_hash = ?`
      )
      .get(actorUserId, idempotencyScope, idempotencyKeyHash) as
      JobRow | undefined;
    return row ? toMetadata(row) : null;
  }

  listJobs(options: DurableJobListOptions): DurableJobMetadata[] {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    if (options.actorUserId) {
      conditions.push('actor_user_id = ?');
      bindings.push(options.actorUserId);
    }
    if (options.state) {
      conditions.push('state = ?');
      bindings.push(options.state);
    }
    if (options.beforeCreatedAt !== undefined) {
      conditions.push('created_at < ?');
      bindings.push(options.beforeCreatedAt);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM platform_jobs
         ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id ASC
         LIMIT ?`
      )
      .all(...bindings, options.limit ?? 50) as JobRow[];
    return rows.map(toMetadata);
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

  getStoredEvent(eventId: string): StoredDurableEventRow | null {
    return (
      (this.database
        .prepare(
          `SELECT global_cursor AS cursor, event_id, stream_id,
                  stream_sequence, request_fingerprint, event_type, subject_id,
                  actor_user_id, payload_format, payload, occurred_at
             FROM platform_events
            WHERE event_id = ?`
        )
        .get(eventId) as StoredDurableEventRow | undefined) ?? null
    );
  }

  latestStoredEventCursor(streamId: string): number {
    const row = this.database
      .prepare(
        `SELECT global_cursor AS cursor
           FROM platform_events
          WHERE stream_id = ?
          ORDER BY stream_sequence DESC
          LIMIT 1`
      )
      .get(streamId) as { cursor: number } | undefined;
    if (!row) return 0;
    if (!Number.isSafeInteger(row.cursor) || row.cursor < 1) {
      throw new DurableJobError(
        'storage-error',
        'Durable event stream cursor is invalid'
      );
    }
    return row.cursor;
  }

  replayStoredEvents(
    afterCursor: number,
    limit: number,
    options: { streamId?: string; subjectId?: string } = {}
  ): StoredDurableEventRow[] {
    const predicates = ['global_cursor > ?'];
    const parameters: Array<number | string> = [afterCursor];
    if (options.streamId) {
      predicates.push('stream_id = ?');
      parameters.push(options.streamId);
    }
    if (options.subjectId) {
      predicates.push('subject_id = ?');
      parameters.push(options.subjectId);
    }
    parameters.push(limit);
    return this.database
      .prepare(
        `SELECT global_cursor AS cursor, event_id, stream_id, stream_sequence,
                request_fingerprint, event_type, subject_id, actor_user_id,
                payload_format, payload, occurred_at
         FROM platform_events
         WHERE ${predicates.join(' AND ')}
         ORDER BY global_cursor ASC LIMIT ?`
      )
      .all(...parameters) as StoredDurableEventRow[];
  }
}
