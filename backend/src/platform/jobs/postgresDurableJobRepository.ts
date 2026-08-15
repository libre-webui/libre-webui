/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type {
  PostgresDatabase,
  PostgresQueryExecutor,
} from '../../persistence/postgresDatabase.js';
import {
  DurableJobError,
  type DurableCancellationCode,
  type DurableChatCancellationDecision,
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
import type {
  DurableJobClaimResult,
  DurableHeartbeatResult,
  PreparedDurableChatCancellation,
  PreparedDurableChatCompletion,
  PreparedDurableEventAppend,
  PreparedDurableJobEnqueue,
  StoredLifecycleRecoveryCandidate,
  StoredDurableEventRow,
  StoredDurablePayload,
} from './sqliteDurableJobRepository.js';

type PgJobRow = QueryResultRow & {
  id: string;
  job_type: string;
  actor_user_id: string;
  state: DurableJobState;
  payload_format: StoredDurablePayload['format'];
  payload: string;
  idempotency_scope: string;
  idempotency_key_hash: string;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  available_at: string | number;
  lease_owner: string | null;
  lease_token: string | number;
  lease_expires_at: string | number | null;
  cancellation_requested_at: string | number | null;
  progress_current: string | number;
  progress_total: string | number;
  progress_message: string | null;
  result_reference: string | null;
  error_code: string | null;
  error_summary: string | null;
  created_at: string | number;
  updated_at: string | number;
  started_at: string | number | null;
  finished_at: string | number | null;
  request_fingerprint: string;
};

type PgAttemptRow = QueryResultRow & {
  job_id: string;
  attempt_number: number;
  lease_token: string | number;
  worker_id: string;
  started_at: string | number;
  last_heartbeat_at: string | number;
  finished_at: string | number | null;
  outcome: DurableJobAttemptMetadata['outcome'];
  error_code: string | null;
  error_summary: string | null;
};

type PgEventRow = QueryResultRow & {
  cursor: string | number;
  event_id: string;
  request_fingerprint: string;
  stream_id: string;
  stream_sequence: string | number;
  event_type: string;
  subject_id: string;
  actor_user_id: string | null;
  payload_format: StoredDurablePayload['format'];
  payload: string;
  occurred_at: string | number;
};

const integer = (value: string | number, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DurableJobError('storage-error', `Invalid PostgreSQL ${field}`);
  }
  return parsed;
};

const optionalInteger = (
  value: string | number | null,
  field: string
): number | null => (value === null ? null : integer(value, field));

const metadata = (row: PgJobRow): DurableJobMetadata => ({
  id: row.id,
  jobType: row.job_type,
  actorUserId: row.actor_user_id,
  state: row.state,
  priority: row.priority,
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  availableAt: integer(row.available_at, 'available_at'),
  cancellationRequestedAt: optionalInteger(
    row.cancellation_requested_at,
    'cancellation_requested_at'
  ),
  progressCurrent: integer(row.progress_current, 'progress_current'),
  progressTotal: integer(row.progress_total, 'progress_total'),
  progressMessage: row.progress_message,
  resultReference: row.result_reference,
  errorCode: row.error_code,
  errorSummary: row.error_summary,
  createdAt: integer(row.created_at, 'created_at'),
  updatedAt: integer(row.updated_at, 'updated_at'),
  startedAt: optionalInteger(row.started_at, 'started_at'),
  finishedAt: optionalInteger(row.finished_at, 'finished_at'),
});

const lease = (row: PgJobRow): DurableJobLease => {
  if (
    row.state !== 'running' ||
    !row.lease_owner ||
    row.lease_expires_at === null
  ) {
    throw new DurableJobError(
      'storage-error',
      'Claimed PostgreSQL job has an invalid lease'
    );
  }
  return {
    ...metadata(row),
    workerId: row.lease_owner,
    leaseToken: integer(row.lease_token, 'lease_token'),
    leaseExpiresAt: integer(row.lease_expires_at, 'lease_expires_at'),
  };
};

const attempt = (row: PgAttemptRow): DurableJobAttemptMetadata => ({
  jobId: row.job_id,
  attemptNumber: row.attempt_number,
  leaseToken: integer(row.lease_token, 'attempt lease_token'),
  workerId: row.worker_id,
  startedAt: integer(row.started_at, 'attempt started_at'),
  lastHeartbeatAt: integer(row.last_heartbeat_at, 'attempt last_heartbeat_at'),
  finishedAt: optionalInteger(row.finished_at, 'attempt finished_at'),
  outcome: row.outcome,
  errorCode: row.error_code,
  errorSummary: row.error_summary,
});

/** Async PostgreSQL durable queue with row locks and SKIP LOCKED claiming. */
export class PostgresDurableJobRepository {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly now: () => number = Date.now
  ) {}

  private async find(
    executor: PostgresQueryExecutor,
    id: string,
    lock = false
  ): Promise<PgJobRow | undefined> {
    const result = await executor.query<PgJobRow>(
      `SELECT * FROM platform_jobs WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
      [id]
    );
    return result.rows[0];
  }

  private async appendEvent(
    executor: PostgresQueryExecutor,
    input: PreparedDurableEventAppend
  ): Promise<number> {
    // A transaction-scoped lock closes the absent-row race: a UNIQUE key
    // cannot lock a row that does not exist yet. All replicas serialize the
    // stable event identity before inspecting or advancing a stream head.
    await executor.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      [input.eventId]
    );
    const existing = await executor.query<{
      global_cursor: string | number;
      request_fingerprint: string;
    }>(
      `SELECT global_cursor, request_fingerprint
         FROM platform_events WHERE event_id = $1`,
      [input.eventId]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== input.requestFingerprint) {
        throw new DurableJobError(
          'conflict',
          'Durable event identity was reused for different content'
        );
      }
      return integer(existing.rows[0].global_cursor, 'event cursor');
    }
    await executor.query(
      `INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
       VALUES ($1, 0) ON CONFLICT (stream_id) DO NOTHING`,
      [input.streamId]
    );
    const head = await executor.query<{ last_sequence: string | number }>(
      `UPDATE platform_event_stream_heads
          SET last_sequence = last_sequence + 1
        WHERE stream_id = $1
        RETURNING last_sequence`,
      [input.streamId]
    );
    const sequence = head.rows[0]
      ? integer(head.rows[0].last_sequence, 'event stream sequence')
      : null;
    if (sequence === null) {
      throw new DurableJobError(
        'storage-error',
        'PostgreSQL event stream head is unavailable'
      );
    }
    const inserted = await executor.query<{ global_cursor: string | number }>(
      `INSERT INTO platform_events
         (event_id, request_fingerprint, stream_id, stream_sequence, event_type, subject_id,
          actor_user_id, payload_format, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING global_cursor`,
      [
        input.eventId,
        input.requestFingerprint,
        input.streamId,
        sequence,
        input.eventType,
        input.subjectId,
        input.actorUserId,
        input.payload.format,
        input.payload.data,
        input.occurredAt,
      ]
    );
    if (!inserted.rows[0]) {
      throw new DurableJobError(
        'storage-error',
        'PostgreSQL event append returned no cursor'
      );
    }
    return integer(inserted.rows[0].global_cursor, 'event cursor');
  }

  private appendJobEvent(
    executor: PostgresQueryExecutor,
    job: Pick<PgJobRow, 'id' | 'actor_user_id'>,
    eventType: string,
    occurredAt: number
  ): Promise<number> {
    return this.appendEvent(executor, {
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

  async enqueue(input: PreparedDurableJobEnqueue): Promise<DurableJobMetadata> {
    return this.database.transaction(client =>
      this.enqueueWithExecutor(client, input)
    );
  }

  /** Enqueue inside an owning domain transaction/outbox boundary. */
  async enqueueWithExecutor(
    executor: PostgresQueryExecutor,
    input: PreparedDurableJobEnqueue
  ): Promise<DurableJobMetadata> {
    // PostgreSQL cannot row-lock a key that does not exist yet. Serialize the
    // absent-row decision with a transaction-scoped advisory lock so two
    // replicas using the same idempotency tuple cannot race into the unique
    // constraint. A 64-bit hash collision only reduces concurrency; the
    // exact tuple and fingerprint checks below still determine correctness.
    await executor.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [
        `${Buffer.byteLength(input.actorUserId, 'utf8')}:${input.actorUserId}` +
          `${Buffer.byteLength(input.idempotencyScope, 'utf8')}:${input.idempotencyScope}` +
          `${input.idempotencyKeyHash.length}:${input.idempotencyKeyHash}`,
      ]
    );
    const existing = await executor.query<PgJobRow>(
      `SELECT * FROM platform_jobs
          WHERE actor_user_id = $1 AND idempotency_scope = $2
            AND idempotency_key_hash = $3
          FOR UPDATE`,
      [input.actorUserId, input.idempotencyScope, input.idempotencyKeyHash]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_fingerprint !== input.requestFingerprint) {
        throw new DurableJobError(
          'conflict',
          'The idempotency key is already bound to a different request'
        );
      }
      return metadata(existing.rows[0]);
    }
    const timestamp = this.now();
    const inserted = await executor.query<PgJobRow>(
      `INSERT INTO platform_jobs
           (id, job_type, actor_user_id, state, payload_format, payload,
            idempotency_scope, idempotency_key_hash, request_fingerprint,
            priority, attempt_count, max_attempts, available_at, lease_token,
            progress_current, progress_total, created_at, updated_at)
         VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, 0, $10,
                 $11, 0, 0, 100, $12, $12)
         RETURNING *`,
      [
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
      ]
    );
    const row = inserted.rows[0];
    if (!row)
      throw new DurableJobError(
        'storage-error',
        'PostgreSQL job insert returned no row'
      );
    await this.appendJobEvent(executor, row, 'job.queued', timestamp);
    return metadata(row);
  }

  async appendEventTransaction(
    input: PreparedDurableEventAppend
  ): Promise<number> {
    try {
      return await this.database.transaction(client =>
        this.appendEvent(client, input)
      );
    } catch (error) {
      // Resolve COMMIT-with-lost-acknowledgement on a new pooled connection.
      // The deterministic identity/fingerprint proves this exact event rather
      // than blindly appending a second logical occurrence.
      try {
        const existing = await this.database.query<{
          global_cursor: string | number;
          request_fingerprint: string;
        }>(
          `SELECT global_cursor, request_fingerprint
             FROM platform_events WHERE event_id = $1`,
          [input.eventId]
        );
        if (existing.rows[0]) {
          if (
            existing.rows[0].request_fingerprint !== input.requestFingerprint
          ) {
            throw new DurableJobError(
              'conflict',
              'Durable event identity was reused for different content'
            );
          }
          return integer(existing.rows[0].global_cursor, 'event cursor');
        }
      } catch (resolutionError) {
        if (resolutionError instanceof DurableJobError) throw resolutionError;
      }
      throw error;
    }
  }

  async requestChatCancellation(
    input: PreparedDurableChatCancellation
  ): Promise<DurableChatCancellationDecision> {
    try {
      return await this.database.transaction(async client => {
        await client.query(
          `INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
           VALUES ($1, 0) ON CONFLICT (stream_id) DO NOTHING`,
          [input.event.streamId]
        );
        await client.query(
          `SELECT last_sequence FROM platform_event_stream_heads
            WHERE stream_id = $1 FOR UPDATE`,
          [input.event.streamId]
        );
        const completion = await client.query<{
          global_cursor: string | number;
        }>(
          `SELECT global_cursor FROM platform_events
            WHERE event_id = $1 AND stream_id = $2
              AND event_type = 'chat.done.v1'
              AND subject_id = $3 AND actor_user_id = $4`,
          [
            input.doneEventId,
            input.event.streamId,
            input.event.subjectId,
            input.actorUserId,
          ]
        );
        if (completion.rows[0]) {
          return {
            outcome: 'completion-won',
            cursor: integer(completion.rows[0].global_cursor, 'event cursor'),
            job: null,
          };
        }

        const cursor = await this.appendEvent(client, input.event);
        const naturalJob = await client.query<PgJobRow>(
          `SELECT * FROM platform_jobs
            WHERE actor_user_id = $1 AND idempotency_scope = $2
              AND idempotency_key_hash = $3 FOR UPDATE`,
          [input.actorUserId, input.idempotencyScope, input.idempotencyKeyHash]
        );
        return {
          outcome: 'cancellation-recorded',
          cursor,
          job: naturalJob.rows[0]
            ? await this.requestCancellationWithExecutor(
                client,
                naturalJob.rows[0].id,
                input.actorUserId,
                'user-requested'
              )
            : null,
        };
      });
    } catch (error) {
      // Resolve an exact decision whose COMMIT acknowledgement was lost.
      try {
        const cancellation = await this.database.query<{
          global_cursor: string | number;
          request_fingerprint: string;
        }>(
          `SELECT global_cursor, request_fingerprint FROM platform_events
            WHERE event_id = $1 AND stream_id = $2
              AND event_type = 'chat.cancel-requested.v1'
              AND subject_id = $3 AND actor_user_id = $4`,
          [
            input.event.eventId,
            input.event.streamId,
            input.event.subjectId,
            input.actorUserId,
          ]
        );
        if (cancellation.rows[0]) {
          if (
            cancellation.rows[0].request_fingerprint !==
            input.event.requestFingerprint
          ) {
            throw new DurableJobError(
              'conflict',
              'Chat cancellation identity was reused'
            );
          }
          const job = await this.database.query<PgJobRow>(
            `SELECT * FROM platform_jobs
              WHERE actor_user_id = $1 AND idempotency_scope = $2
                AND idempotency_key_hash = $3`,
            [
              input.actorUserId,
              input.idempotencyScope,
              input.idempotencyKeyHash,
            ]
          );
          return {
            outcome: 'cancellation-recorded',
            cursor: integer(cancellation.rows[0].global_cursor, 'event cursor'),
            job: job.rows[0] ? metadata(job.rows[0]) : null,
          };
        }
        const completion = await this.database.query<{
          global_cursor: string | number;
        }>(
          `SELECT global_cursor FROM platform_events
            WHERE event_id = $1 AND stream_id = $2
              AND event_type = 'chat.done.v1'
              AND subject_id = $3 AND actor_user_id = $4`,
          [
            input.doneEventId,
            input.event.streamId,
            input.event.subjectId,
            input.actorUserId,
          ]
        );
        if (completion.rows[0]) {
          return {
            outcome: 'completion-won',
            cursor: integer(completion.rows[0].global_cursor, 'event cursor'),
            job: null,
          };
        }
      } catch (resolutionError) {
        if (resolutionError instanceof DurableJobError) throw resolutionError;
      }
      throw error;
    }
  }

  private async publishChatCompletionWithExecutor(
    executor: PostgresQueryExecutor,
    input: PreparedDurableChatCompletion
  ): Promise<number> {
    // Lock order is stream decision -> job lease -> chat session. Enqueue and
    // cancellation use the same prefix, so no path can invert head and job.
    await executor.query(
      `INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
       VALUES ($1, 0) ON CONFLICT (stream_id) DO NOTHING`,
      [input.event.streamId]
    );
    await executor.query(
      `SELECT last_sequence FROM platform_event_stream_heads
        WHERE stream_id = $1 FOR UPDATE`,
      [input.event.streamId]
    );
    const cancellation = await executor.query(
      `SELECT 1 FROM platform_events
        WHERE event_id = $1 AND stream_id = $2
          AND event_type = 'chat.cancel-requested.v1'
          AND subject_id = $3 AND actor_user_id = $4`,
      [
        input.cancellationEventId,
        input.event.streamId,
        input.message.id,
        input.actorUserId,
      ]
    );
    if (cancellation.rows[0]) {
      throw new DurableJobError('cancelled', 'Durable job was cancelled');
    }

    const job = await this.find(executor, input.lease.jobId, true);
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
    const assertLease = (timestamp: number): void => {
      if (job.cancellation_requested_at !== null) {
        throw new DurableJobError('cancelled', 'Durable job was cancelled');
      }
      if (
        job.state !== 'running' ||
        job.lease_owner !== input.lease.workerId ||
        integer(job.lease_token, 'lease_token') !== input.lease.leaseToken ||
        job.lease_expires_at === null ||
        integer(job.lease_expires_at, 'lease_expires_at') <= timestamp
      ) {
        throw new DurableJobError('lease-lost', 'Durable job lease was lost');
      }
    };
    assertLease(this.now());

    const session = await executor.query<{ user_id: string }>(
      'SELECT user_id FROM sessions WHERE id = $1 FOR UPDATE',
      [input.sessionId]
    );
    if (
      !session.rows[0] ||
      session.rows[0].user_id !== input.actorUserId ||
      input.message.sessionId !== input.sessionId
    ) {
      throw new DurableJobError(
        'conflict',
        'Chat completion session is unavailable'
      );
    }
    // The session lock can wait behind another chat mutation while this
    // transaction holds the job row, preventing its heartbeat from extending.
    // Never authorize publication with the pre-wait lease sample.
    assertLease(this.now());

    const existingEvent = await executor.query(
      'SELECT 1 FROM platform_events WHERE event_id = $1',
      [input.event.eventId]
    );
    const existingMessage = await executor.query<{ role: string }>(
      `SELECT role FROM session_messages
        WHERE id = $1 AND session_id = $2`,
      [input.message.id, input.sessionId]
    );
    if (existingEvent.rows[0]) {
      if (existingMessage.rows[0]?.role !== 'assistant') {
        throw new DurableJobError(
          'storage-error',
          'Durable chat completion event has no assistant message'
        );
      }
      return this.appendEvent(executor, input.event);
    }
    if (existingMessage.rows[0]) {
      throw new DurableJobError(
        'conflict',
        'Assistant message identity already exists without completion'
      );
    }

    let branchIndex = 0;
    if (input.message.parentId) {
      const branchRoot = await executor.query<{ role: string }>(
        `SELECT role FROM session_messages
          WHERE id = $1 AND session_id = $2`,
        [input.message.parentId, input.sessionId]
      );
      if (branchRoot.rows[0]?.role !== 'assistant') {
        throw new DurableJobError(
          'conflict',
          'Chat completion branch root is unavailable'
        );
      }
      const branch = await executor.query<{ next_index: string | number }>(
        `SELECT COALESCE(MAX(branch_index), 0) + 1 AS next_index
           FROM session_messages
          WHERE session_id = $1 AND (id = $2 OR parent_id = $2)`,
        [input.sessionId, input.message.parentId]
      );
      if (!branch.rows[0]) {
        throw new DurableJobError(
          'storage-error',
          'Chat branch index is unavailable'
        );
      }
      branchIndex = integer(branch.rows[0].next_index, 'branch index');
    }
    const position = await executor.query<{ next_index: string | number }>(
      `SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index
         FROM session_messages WHERE session_id = $1`,
      [input.sessionId]
    );
    if (!position.rows[0]) {
      throw new DurableJobError(
        'storage-error',
        'Chat message position is unavailable'
      );
    }
    // Re-sample immediately before the first publication side effect. The same
    // fresh fence is carried through the terminal job UPDATE below.
    const timestamp = this.now();
    assertLease(timestamp);
    if (input.message.parentId) {
      await executor.query(
        `UPDATE session_messages SET is_active = 0
          WHERE session_id = $1 AND (id = $2 OR parent_id = $2)`,
        [input.sessionId, input.message.parentId]
      );
    }
    await executor.query(
      `INSERT INTO session_messages
         (id, session_id, role, content, thinking, timestamp, message_index,
          model, provider_metadata, images, statistics, artifacts,
          parent_id, branch_index, is_active, rating)
       VALUES ($1, $2, 'assistant', $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15)`,
      [
        input.message.id,
        input.sessionId,
        input.message.content,
        input.message.thinking,
        input.message.timestamp,
        integer(position.rows[0].next_index, 'message index'),
        input.message.model,
        input.message.providerMetadata,
        input.message.images,
        input.message.statistics,
        input.message.artifacts,
        input.message.parentId,
        branchIndex,
        input.message.parentId ? 1 : input.message.isActive,
        input.message.rating,
      ]
    );
    await executor.query(
      `UPDATE sessions SET updated_at = GREATEST(updated_at, $1)
        WHERE id = $2 AND user_id = $3`,
      [timestamp, input.sessionId, input.actorUserId]
    );
    const completionCursor = await this.appendEvent(executor, input.event);
    // Message and event writes can themselves wait. Re-sample before the
    // attempt/job terminal fence; throwing here rolls every prior write back.
    const terminalTimestamp = this.now();
    assertLease(terminalTimestamp);
    if (
      (await this.finishAttempt(
        executor,
        job,
        'succeeded',
        terminalTimestamp
      )) !== 1
    ) {
      throw new DurableJobError('lease-lost', 'Durable job attempt was lost');
    }
    const resultReference = `chat-message:${input.message.id}`;
    const terminal = await executor.query(
      `UPDATE platform_jobs
          SET state = 'succeeded', result_reference = $1,
              lease_owner = NULL, lease_expires_at = NULL,
              progress_current = progress_total,
              progress_message = 'Chat response saved',
              finished_at = $2, updated_at = $2
        WHERE id = $3 AND state = 'running' AND lease_owner = $4
          AND lease_token = $5 AND lease_expires_at > $6
          AND actor_user_id = $7 AND job_type = $8
          AND idempotency_scope = $9 AND idempotency_key_hash = $10
          AND cancellation_requested_at IS NULL`,
      [
        resultReference,
        terminalTimestamp,
        job.id,
        input.lease.workerId,
        input.lease.leaseToken,
        terminalTimestamp,
        input.actorUserId,
        input.expectedJobType,
        input.expectedIdempotencyScope,
        input.expectedIdempotencyKeyHash,
      ]
    );
    if (terminal.rowCount !== 1) {
      throw new DurableJobError('lease-lost', 'Durable job lease was lost');
    }
    await this.appendJobEvent(
      executor,
      job,
      'job.succeeded',
      terminalTimestamp
    );
    return completionCursor;
  }

  async publishChatCompletion(
    input: PreparedDurableChatCompletion
  ): Promise<number> {
    try {
      return await this.database.transaction(
        client => this.publishChatCompletionWithExecutor(client, input),
        { beforeCommit: input.beforeCommit }
      );
    } catch (error) {
      // Resolve an exact COMMIT whose acknowledgement was lost. Both rows are
      // required; observing only one would prove an invariant violation.
      try {
        const committed = await this.database.query<{
          global_cursor: string | number;
          request_fingerprint: string;
          role: string;
          state: string;
          result_reference: string | null;
          attempt_outcome: string;
          attempt_finished_at: string | number | null;
        }>(
          `SELECT e.global_cursor, e.request_fingerprint, m.role,
                  j.state, j.result_reference,
                  a.outcome AS attempt_outcome,
                  a.finished_at AS attempt_finished_at
             FROM platform_events e
             JOIN session_messages m
               ON m.id = $2 AND m.session_id = $3
             JOIN platform_jobs j ON j.id = $4
             JOIN platform_job_attempts a
               ON a.job_id = j.id
              AND a.attempt_number = j.attempt_count
              AND a.lease_token = $5
            WHERE e.event_id = $1
              AND j.actor_user_id = $6
              AND j.job_type = $7
              AND j.idempotency_scope = $8
              AND j.idempotency_key_hash = $9`,
          [
            input.event.eventId,
            input.message.id,
            input.sessionId,
            input.lease.jobId,
            input.lease.leaseToken,
            input.actorUserId,
            input.expectedJobType,
            input.expectedIdempotencyScope,
            input.expectedIdempotencyKeyHash,
          ]
        );
        const row = committed.rows[0];
        if (row) {
          if (
            row.request_fingerprint !== input.event.requestFingerprint ||
            row.role !== 'assistant' ||
            row.state !== 'succeeded' ||
            row.result_reference !== `chat-message:${input.message.id}` ||
            row.attempt_outcome !== 'succeeded' ||
            row.attempt_finished_at === null
          ) {
            throw new DurableJobError(
              'conflict',
              'Durable chat completion identity was reused'
            );
          }
          return integer(row.global_cursor, 'event cursor');
        }
      } catch (resolutionError) {
        if (resolutionError instanceof DurableJobError) throw resolutionError;
      }
      throw error;
    }
  }

  async lockChatCancellationDecision(
    executor: PostgresQueryExecutor,
    input: {
      eventId: string;
      streamId: string;
      subjectId: string;
      actorUserId: string;
    }
  ): Promise<boolean> {
    await executor.query(
      `INSERT INTO platform_event_stream_heads (stream_id, last_sequence)
       VALUES ($1, 0) ON CONFLICT (stream_id) DO NOTHING`,
      [input.streamId]
    );
    await executor.query(
      `SELECT last_sequence FROM platform_event_stream_heads
        WHERE stream_id = $1 FOR UPDATE`,
      [input.streamId]
    );
    const cancellation = await executor.query(
      `SELECT 1 FROM platform_events
        WHERE event_id = $1 AND stream_id = $2
          AND event_type = 'chat.cancel-requested.v1'
          AND subject_id = $3 AND actor_user_id = $4`,
      [input.eventId, input.streamId, input.subjectId, input.actorUserId]
    );
    return cancellation.rows[0] !== undefined;
  }

  private async finishAttempt(
    executor: PostgresQueryExecutor,
    row: PgJobRow,
    outcome: DurableJobAttemptMetadata['outcome'],
    timestamp: number,
    errorCode: string | null = null,
    errorSummary: string | null = null
  ): Promise<number> {
    const result = await executor.query(
      `UPDATE platform_job_attempts
          SET last_heartbeat_at = $1, finished_at = $1, outcome = $2,
              error_code = $3, error_summary = $4
        WHERE job_id = $5 AND attempt_number = $6 AND lease_token = $7
          AND outcome = 'running'`,
      [
        timestamp,
        outcome,
        errorCode,
        errorSummary,
        row.id,
        row.attempt_count,
        integer(row.lease_token, 'lease_token'),
      ]
    );
    return result.rowCount ?? 0;
  }

  private async reapExpired(
    executor: PostgresQueryExecutor,
    timestamp: number
  ): Promise<string[]> {
    const expired = await executor.query<PgJobRow>(
      `SELECT * FROM platform_jobs
        WHERE state = 'running' AND lease_expires_at <= $1
          AND (cancellation_requested_at IS NOT NULL OR attempt_count >= max_attempts)
        ORDER BY lease_expires_at ASC, id ASC
        LIMIT 100 FOR UPDATE SKIP LOCKED`,
      [timestamp]
    );
    const terminalLifecycleJobIds: string[] = [];
    for (const row of expired.rows) {
      const cancelled = row.cancellation_requested_at !== null;
      const state: DurableJobState = cancelled ? 'cancelled' : 'dead_letter';
      const code = cancelled ? null : 'lease-expired';
      const summary = cancelled
        ? null
        : 'The worker lease expired at the retry ceiling';
      await executor.query(
        `UPDATE platform_jobs SET state = $1, lease_owner = NULL,
                lease_expires_at = NULL, finished_at = $2, updated_at = $2,
                error_code = $3, error_summary = $4
          WHERE id = $5 AND state = 'running' AND lease_token = $6`,
        [state, timestamp, code, summary, row.id, row.lease_token]
      );
      await this.finishAttempt(
        executor,
        row,
        cancelled ? 'cancelled' : 'dead_letter',
        timestamp,
        code,
        summary
      );
      await this.appendJobEvent(
        executor,
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

  async claimWithLifecycleRecovery(
    workerId: string,
    leaseMs: number
  ): Promise<DurableJobClaimResult> {
    return this.database.transaction(async client => {
      const timestamp = this.now();
      const terminalLifecycleJobIds = await this.reapExpired(client, timestamp);
      const selected = await client.query<PgJobRow>(
        `SELECT * FROM platform_jobs
          WHERE cancellation_requested_at IS NULL
            AND ((state = 'queued' AND available_at <= $1)
              OR (state = 'running' AND lease_expires_at <= $1
                  AND attempt_count < max_attempts))
          ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
          LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [timestamp]
      );
      const candidate = selected.rows[0];
      if (!candidate) return { lease: null, terminalLifecycleJobIds };
      if (candidate.state === 'running') {
        await this.finishAttempt(client, candidate, 'abandoned', timestamp);
      }
      const nextAttempt = candidate.attempt_count + 1;
      const nextToken = integer(candidate.lease_token, 'lease_token') + 1;
      const expiresAt = timestamp + leaseMs;
      const claimed = await client.query<PgJobRow>(
        `UPDATE platform_jobs
            SET state = 'running', attempt_count = $1, lease_owner = $2,
                lease_token = $3, lease_expires_at = $4,
                started_at = COALESCE(started_at, $5), updated_at = $5,
                error_code = NULL, error_summary = NULL
          WHERE id = $6
          RETURNING *`,
        [nextAttempt, workerId, nextToken, expiresAt, timestamp, candidate.id]
      );
      const row = claimed.rows[0];
      if (!row) return { lease: null, terminalLifecycleJobIds };
      await client.query(
        `INSERT INTO platform_job_attempts
           (job_id, attempt_number, lease_token, worker_id, started_at,
            last_heartbeat_at, outcome)
         VALUES ($1, $2, $3, $4, $5, $5, 'running')`,
        [row.id, nextAttempt, nextToken, workerId, timestamp]
      );
      await this.appendJobEvent(client, row, 'job.claimed', timestamp);
      return { lease: lease(row), terminalLifecycleJobIds };
    });
  }

  async claim(
    workerId: string,
    leaseMs: number
  ): Promise<DurableJobLease | null> {
    return (await this.claimWithLifecycleRecovery(workerId, leaseMs)).lease;
  }

  async heartbeat(
    job: DurableJobLease,
    leaseMs: number
  ): Promise<DurableHeartbeatResult> {
    return this.database.transaction(async client => {
      const timestamp = this.now();
      const updated = await client.query<PgJobRow>(
        `UPDATE platform_jobs SET lease_expires_at = $1, updated_at = $2
          WHERE id = $3 AND state = 'running' AND lease_owner = $4
            AND lease_token = $5 AND lease_expires_at > $2
          RETURNING *`,
        [timestamp + leaseMs, timestamp, job.id, job.workerId, job.leaseToken]
      );
      if (!updated.rows[0])
        return { owned: false, cancellationRequested: false };
      await client.query(
        `UPDATE platform_job_attempts SET last_heartbeat_at = $1
          WHERE job_id = $2 AND attempt_number = $3 AND lease_token = $4
            AND outcome = 'running'`,
        [timestamp, job.id, job.attemptCount, job.leaseToken]
      );
      return {
        owned: true,
        cancellationRequested:
          updated.rows[0].cancellation_requested_at !== null,
      };
    });
  }

  /**
   * Read-only ownership and cancellation check. Unlike heartbeat this never
   * extends the lease and never writes, so hot paths can call it per side
   * effect without paying a transaction commit.
   */
  async inspectLease(job: DurableJobLease): Promise<DurableHeartbeatResult> {
    const timestamp = this.now();
    const result = await this.database.query<{
      state: string;
      lease_owner: string | null;
      lease_token: string | null;
      lease_expires_at: string | number | null;
      cancellation_requested_at: string | number | null;
    }>(
      `SELECT state, lease_owner, lease_token, lease_expires_at,
              cancellation_requested_at
         FROM platform_jobs WHERE id = $1`,
      [job.id]
    );
    const row = result.rows[0];
    const owned = Boolean(
      row &&
      row.state === 'running' &&
      row.lease_owner === job.workerId &&
      row.lease_token !== null &&
      Number(row.lease_token) === job.leaseToken &&
      row.lease_expires_at !== null &&
      Number(row.lease_expires_at) > timestamp
    );
    return {
      owned,
      cancellationRequested: owned
        ? row!.cancellation_requested_at !== null
        : false,
    };
  }

  async updateProgress(
    job: DurableJobLease,
    current: number,
    total: number,
    message: string | null
  ): Promise<void> {
    const timestamp = this.now();
    const result = await this.database.query(
      `UPDATE platform_jobs
          SET progress_current = $1, progress_total = $2,
              progress_message = $3, updated_at = $4
        WHERE id = $5 AND state = 'running' AND lease_owner = $6
          AND lease_token = $7 AND lease_expires_at > $4`,
      [current, total, message, timestamp, job.id, job.workerId, job.leaseToken]
    );
    if (result.rowCount !== 1)
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
  }

  private async lockedLease(
    executor: PostgresQueryExecutor,
    job: DurableJobLease,
    timestamp: number
  ): Promise<PgJobRow> {
    const row = await this.find(executor, job.id, true);
    if (
      !row ||
      row.state !== 'running' ||
      row.lease_owner !== job.workerId ||
      integer(row.lease_token, 'lease_token') !== job.leaseToken ||
      row.lease_expires_at === null ||
      integer(row.lease_expires_at, 'lease_expires_at') <= timestamp
    ) {
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    }
    return row;
  }

  async complete(
    job: DurableJobLease,
    resultReference: string | null
  ): Promise<void> {
    await this.database.transaction(async client => {
      const timestamp = this.now();
      const row = await this.lockedLease(client, job, timestamp);
      const cancelled = row.cancellation_requested_at !== null;
      await client.query(
        `UPDATE platform_jobs SET state = $1, lease_owner = NULL,
                lease_expires_at = NULL, result_reference = $2,
                progress_current = progress_total, finished_at = $3,
                updated_at = $3
          WHERE id = $4`,
        [
          cancelled ? 'cancelled' : 'succeeded',
          cancelled ? null : resultReference,
          timestamp,
          row.id,
        ]
      );
      await this.finishAttempt(
        client,
        row,
        cancelled ? 'cancelled' : 'succeeded',
        timestamp
      );
      await this.appendJobEvent(
        client,
        row,
        cancelled ? 'job.cancelled' : 'job.succeeded',
        timestamp
      );
    });
  }

  async fail(
    job: DurableJobLease,
    retryable: boolean,
    errorCode: string,
    errorSummary: string,
    nextAvailableAt: number
  ): Promise<DurableJobState> {
    return this.database.transaction(async client => {
      const timestamp = this.now();
      const row = await this.lockedLease(client, job, timestamp);
      const cancelled = row.cancellation_requested_at !== null;
      const willRetry =
        !cancelled && retryable && row.attempt_count < row.max_attempts;
      const state: DurableJobState = cancelled
        ? 'cancelled'
        : willRetry
          ? 'queued'
          : 'dead_letter';
      await client.query(
        `UPDATE platform_jobs SET state = $1, available_at = $2,
                lease_owner = NULL, lease_expires_at = NULL,
                error_code = $3, error_summary = $4, finished_at = $5,
                updated_at = $6
          WHERE id = $7`,
        [
          state,
          willRetry ? nextAvailableAt : row.available_at,
          cancelled ? null : errorCode,
          cancelled ? null : errorSummary,
          willRetry ? null : timestamp,
          timestamp,
          row.id,
        ]
      );
      await this.finishAttempt(
        client,
        row,
        cancelled ? 'cancelled' : willRetry ? 'retry_scheduled' : 'dead_letter',
        timestamp,
        cancelled ? null : errorCode,
        cancelled ? null : errorSummary
      );
      await this.appendJobEvent(
        client,
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

  abandon(job: DurableJobLease): Promise<DurableJobState> {
    return this.fail(
      job,
      true,
      'worker-shutdown',
      'The worker stopped before completing the attempt',
      this.now()
    );
  }

  async requestCancellationWithExecutor(
    client: PostgresQueryExecutor,
    id: string,
    actorUserId: string,
    reason: DurableCancellationCode
  ): Promise<DurableJobMetadata> {
    const timestamp = this.now();
    const row = await this.find(client, id, true);
    if (!row || row.actor_user_id !== actorUserId) {
      throw new DurableJobError('not-found', 'Durable job not found');
    }
    if (
      ['succeeded', 'cancelled', 'dead_letter'].includes(row.state) ||
      row.cancellation_requested_at !== null
    ) {
      return metadata(row);
    }
    const queued = row.state === 'queued';
    const updated = await client.query<PgJobRow>(
      `UPDATE platform_jobs
            SET state = $1, cancellation_requested_at = $2,
                cancellation_reason = $3, finished_at = $4, updated_at = $2
          WHERE id = $5 RETURNING *`,
      [
        queued ? 'cancelled' : 'running',
        timestamp,
        reason,
        queued ? timestamp : null,
        row.id,
      ]
    );
    await this.appendJobEvent(
      client,
      row,
      queued ? 'job.cancelled' : 'job.cancellation-requested',
      timestamp
    );
    if (!updated.rows[0])
      throw new DurableJobError(
        'storage-error',
        'Cancelled PostgreSQL job disappeared'
      );
    return metadata(updated.rows[0]);
  }

  async requestCancellation(
    id: string,
    actorUserId: string,
    reason: DurableCancellationCode
  ): Promise<DurableJobMetadata> {
    return this.database.transaction(client =>
      this.requestCancellationWithExecutor(client, id, actorUserId, reason)
    );
  }

  async requestActorCancellation(
    actorUserId: string,
    reason: DurableCancellationCode,
    filter: DurableJobActorFilter = {}
  ): Promise<DurableJobCancellationSummary> {
    return this.database.transaction(async client => {
      const parameters: unknown[] = [actorUserId];
      const clauses = [
        'actor_user_id = $1',
        "state IN ('queued', 'running')",
        'cancellation_requested_at IS NULL',
      ];
      if (filter.jobTypes && filter.jobTypes.length > 0) {
        parameters.push([...filter.jobTypes]);
        clauses.push(`job_type = ANY($${parameters.length}::text[])`);
      }
      if (filter.excludeJobTypes && filter.excludeJobTypes.length > 0) {
        parameters.push([...filter.excludeJobTypes]);
        clauses.push(`NOT (job_type = ANY($${parameters.length}::text[]))`);
      }
      if (filter.idempotencyScopes && filter.idempotencyScopes.length > 0) {
        parameters.push([...filter.idempotencyScopes]);
        clauses.push(`idempotency_scope = ANY($${parameters.length}::text[])`);
      }
      if (filter.excludeJobIds && filter.excludeJobIds.length > 0) {
        parameters.push([...filter.excludeJobIds]);
        clauses.push(`NOT (id = ANY($${parameters.length}::text[]))`);
      }
      const selected = await client.query<PgJobRow>(
        `SELECT * FROM platform_jobs
          WHERE ${clauses.join(' AND ')}
          ORDER BY id ASC FOR UPDATE`,
        parameters
      );
      const timestamp = this.now();
      let cancelledQueued = 0;
      let cancellationRequestedRunning = 0;
      for (const row of selected.rows) {
        const queued = row.state === 'queued';
        const updated = await client.query(
          `UPDATE platform_jobs
              SET state = $1, cancellation_requested_at = $2,
                  cancellation_reason = $3, finished_at = $4, updated_at = $2
            WHERE id = $5 AND state = $6
              AND cancellation_requested_at IS NULL`,
          [
            queued ? 'cancelled' : 'running',
            timestamp,
            reason,
            queued ? timestamp : null,
            row.id,
            row.state,
          ]
        );
        if ((updated.rowCount ?? 0) !== 1) continue;
        if (queued) cancelledQueued += 1;
        else cancellationRequestedRunning += 1;
        await this.appendJobEvent(
          client,
          row,
          queued ? 'job.cancelled' : 'job.cancellation-requested',
          timestamp
        );
      }
      return { cancelledQueued, cancellationRequestedRunning };
    });
  }

  async countActiveForActor(
    actorUserId: string,
    filter: DurableJobActorFilter = {}
  ): Promise<number> {
    const parameters: unknown[] = [actorUserId];
    const clauses = ['actor_user_id = $1', "state IN ('queued', 'running')"];
    if (filter.jobTypes && filter.jobTypes.length > 0) {
      parameters.push([...filter.jobTypes]);
      clauses.push(`job_type = ANY($${parameters.length}::text[])`);
    }
    if (filter.excludeJobTypes && filter.excludeJobTypes.length > 0) {
      parameters.push([...filter.excludeJobTypes]);
      clauses.push(`NOT (job_type = ANY($${parameters.length}::text[]))`);
    }
    if (filter.idempotencyScopes && filter.idempotencyScopes.length > 0) {
      parameters.push([...filter.idempotencyScopes]);
      clauses.push(`idempotency_scope = ANY($${parameters.length}::text[])`);
    }
    if (filter.excludeJobIds && filter.excludeJobIds.length > 0) {
      parameters.push([...filter.excludeJobIds]);
      clauses.push(`NOT (id = ANY($${parameters.length}::text[]))`);
    }
    const result = await this.database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM platform_jobs WHERE ${clauses.join(' AND ')}`,
      parameters
    );
    return result.rows[0]
      ? integer(result.rows[0].count, 'active actor job count')
      : 0;
  }

  async countNonSucceededForActor(
    actorUserId: string,
    filter: DurableJobActorFilter = {}
  ): Promise<number> {
    const parameters: unknown[] = [actorUserId];
    const clauses = ['actor_user_id = $1', "state <> 'succeeded'"];
    if (filter.jobTypes && filter.jobTypes.length > 0) {
      parameters.push([...filter.jobTypes]);
      clauses.push(`job_type = ANY($${parameters.length}::text[])`);
    }
    if (filter.excludeJobTypes && filter.excludeJobTypes.length > 0) {
      parameters.push([...filter.excludeJobTypes]);
      clauses.push(`NOT (job_type = ANY($${parameters.length}::text[]))`);
    }
    if (filter.idempotencyScopes && filter.idempotencyScopes.length > 0) {
      parameters.push([...filter.idempotencyScopes]);
      clauses.push(`idempotency_scope = ANY($${parameters.length}::text[])`);
    }
    if (filter.excludeJobIds && filter.excludeJobIds.length > 0) {
      parameters.push([...filter.excludeJobIds]);
      clauses.push(`NOT (id = ANY($${parameters.length}::text[]))`);
    }
    if (filter.excludeHandledLifecycleJobs) {
      parameters.push([
        RESOURCE_DELETE_JOB_TYPE,
        OWNER_DELETE_CONTENT_JOB_TYPE,
      ]);
      const jobTypesParameter = parameters.length;
      parameters.push(`${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}%`);
      clauses.push(
        `NOT (
          job_type = ANY($${jobTypesParameter}::text[])
          AND state = ANY(ARRAY['cancelled', 'dead_letter']::text[])
          AND result_reference LIKE $${parameters.length}
        )`
      );
    }
    const result = await this.database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM platform_jobs WHERE ${clauses.join(' AND ')}`,
      parameters
    );
    return result.rows[0]
      ? integer(result.rows[0].count, 'non-succeeded actor job count')
      : 0;
  }

  async getMetadata(id: string): Promise<DurableJobMetadata | null> {
    const row = await this.find(this.database, id);
    return row ? metadata(row) : null;
  }

  async listDeletionLifecycleRecoveryCandidates(
    afterId: string,
    limit: number
  ): Promise<StoredLifecycleRecoveryCandidate[]> {
    const result = await this.database.query<PgJobRow>(
      `SELECT jobs.*
         FROM platform_jobs jobs
        JOIN users actor ON actor.id = jobs.actor_user_id
        WHERE jobs.id::text > $1
          AND jobs.result_reference IS NULL
          AND (
            (
              jobs.job_type = $2
              AND actor.account_status = 'active'
              AND (
                (jobs.state = 'dead_letter' AND jobs.error_code = ANY($3::text[]))
                OR jobs.state = 'cancelled'
              )
            )
            OR
            (
              jobs.job_type = $4
              AND actor.account_status IN ('active', 'retiring')
              AND (
                (jobs.state = 'dead_letter' AND jobs.error_code = ANY($5::text[]))
                OR jobs.state = 'cancelled'
              )
            )
          )
        ORDER BY jobs.id::text ASC
        LIMIT $6`,
      [
        afterId,
        RESOURCE_DELETE_JOB_TYPE,
        [...RESOURCE_DELETE_RECOVERABLE_ERROR_CODES],
        OWNER_DELETE_CONTENT_JOB_TYPE,
        [...OWNER_DELETE_CONTENT_RECOVERABLE_ERROR_CODES],
        limit,
      ]
    );
    return result.rows.map(row => ({
      id: row.id,
      jobType: row.job_type,
      actorUserId: row.actor_user_id,
      payload: { format: row.payload_format, data: row.payload },
      priority: row.priority,
      updatedAt: integer(row.updated_at, 'updated_at'),
    }));
  }

  async getDeletionLifecycleRecoveryCandidate(
    id: string
  ): Promise<StoredLifecycleRecoveryCandidate | null> {
    const result = await this.database.query<PgJobRow>(
      `SELECT jobs.*
         FROM platform_jobs jobs
         JOIN users actor ON actor.id = jobs.actor_user_id
        WHERE jobs.id = $1
          AND jobs.result_reference IS NULL
          AND (
            (
              jobs.job_type = $2
              AND actor.account_status = 'active'
              AND (
                (jobs.state = 'dead_letter' AND jobs.error_code = ANY($3::text[]))
                OR jobs.state = 'cancelled'
              )
            )
            OR
            (
              jobs.job_type = $4
              AND actor.account_status IN ('active', 'retiring')
              AND (
                (jobs.state = 'dead_letter' AND jobs.error_code = ANY($5::text[]))
                OR jobs.state = 'cancelled'
              )
            )
          )`,
      [
        id,
        RESOURCE_DELETE_JOB_TYPE,
        [...RESOURCE_DELETE_RECOVERABLE_ERROR_CODES],
        OWNER_DELETE_CONTENT_JOB_TYPE,
        [...OWNER_DELETE_CONTENT_RECOVERABLE_ERROR_CODES],
      ]
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          jobType: row.job_type,
          actorUserId: row.actor_user_id,
          payload: { format: row.payload_format, data: row.payload },
          priority: row.priority,
          updatedAt: integer(row.updated_at, 'updated_at'),
        }
      : null;
  }

  async markDeletionLifecycleRecoveryHandled(
    id: string,
    resultReference: string
  ): Promise<void> {
    await this.database.transaction(async client => {
      const updated = await client.query(
        `UPDATE platform_jobs
            SET result_reference = $1
          WHERE id = $2
            AND job_type = ANY($3::text[])
            AND state = ANY($4::text[])
            AND result_reference IS NULL`,
        [
          resultReference,
          id,
          [RESOURCE_DELETE_JOB_TYPE, OWNER_DELETE_CONTENT_JOB_TYPE],
          ['cancelled', 'dead_letter'],
        ]
      );
      if (updated.rowCount === 1) return;
      const existing = await client.query<{ result_reference: string | null }>(
        `SELECT result_reference FROM platform_jobs
          WHERE id = $1
            AND job_type = ANY($2::text[])
            AND state = ANY($3::text[])`,
        [
          id,
          [RESOURCE_DELETE_JOB_TYPE, OWNER_DELETE_CONTENT_JOB_TYPE],
          ['cancelled', 'dead_letter'],
        ]
      );
      const existingReference = existing.rows[0]?.result_reference;
      if (
        existingReference === resultReference ||
        existingReference?.startsWith(
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

  async isPendingResourceDeletion(
    input: DurableResourceDeletionOccurrence
  ): Promise<boolean> {
    const table = (() => {
      switch (input.resourceType) {
        case 'document':
          return 'documents';
        case 'generated-media':
          return 'platform_generated_media';
        case 'persona':
          return 'personas';
      }
    })();
    const result = await this.database.query(
      `SELECT 1
         FROM platform_resource_deletion_tombstones tombstone
        WHERE tombstone.resource_type = $1
          AND tombstone.resource_id = $2
          AND tombstone.owner_user_id = $3
          AND tombstone.deletion_incarnation = $4
          AND tombstone.deletion_token = $5
          AND tombstone.completed_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${table} resource
             WHERE resource.id = tombstone.resource_id
               AND resource.user_id = tombstone.owner_user_id
          )`,
      [
        input.resourceType,
        input.resourceId,
        input.ownerUserId,
        input.deletionIncarnation,
        input.deletionToken,
      ]
    );
    return result.rowCount === 1;
  }

  async isOwnerCleanupRequired(targetUserId: string): Promise<boolean> {
    const result = await this.database.query(
      'SELECT 1 FROM users WHERE id = $1',
      [targetUserId]
    );
    return result.rowCount === 0;
  }

  async getByIdempotency(
    actorUserId: string,
    scope: string,
    keyHash: string
  ): Promise<DurableJobMetadata | null> {
    const result = await this.database.query<PgJobRow>(
      `SELECT * FROM platform_jobs
        WHERE actor_user_id = $1 AND idempotency_scope = $2
          AND idempotency_key_hash = $3`,
      [actorUserId, scope, keyHash]
    );
    return result.rows[0] ? metadata(result.rows[0]) : null;
  }

  async listJobs(
    options: DurableJobListOptions
  ): Promise<DurableJobMetadata[]> {
    const conditions: string[] = [];
    const parameters: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      parameters.push(value);
      conditions.push(sql.replace('?', `$${parameters.length}`));
    };
    if (options.actorUserId) add('actor_user_id = ?', options.actorUserId);
    if (options.state) add('state = ?', options.state);
    if (options.beforeCreatedAt !== undefined)
      add('created_at < ?', options.beforeCreatedAt);
    parameters.push(options.limit ?? 50);
    const result = await this.database.query<PgJobRow>(
      `SELECT * FROM platform_jobs
       ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id ASC LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map(metadata);
  }

  async getStoredPayload(job: DurableJobLease): Promise<StoredDurablePayload> {
    const row = await this.find(this.database, job.id);
    const timestamp = this.now();
    if (
      !row ||
      row.state !== 'running' ||
      row.lease_owner !== job.workerId ||
      integer(row.lease_token, 'lease_token') !== job.leaseToken ||
      row.lease_expires_at === null ||
      integer(row.lease_expires_at, 'lease_expires_at') <= timestamp
    ) {
      throw new DurableJobError('lease-lost', 'The durable job lease was lost');
    }
    return { format: row.payload_format, data: row.payload };
  }

  async listAttempts(id: string): Promise<DurableJobAttemptMetadata[]> {
    const result = await this.database.query<PgAttemptRow>(
      `SELECT * FROM platform_job_attempts
        WHERE job_id = $1 ORDER BY attempt_number ASC`,
      [id]
    );
    return result.rows.map(attempt);
  }

  async getStoredEvent(eventId: string): Promise<StoredDurableEventRow | null> {
    const result = await this.database.query<PgEventRow>(
      `SELECT global_cursor AS cursor, event_id, stream_id, stream_sequence,
              request_fingerprint, event_type, subject_id, actor_user_id,
              payload_format, payload, occurred_at
         FROM platform_events
        WHERE event_id = $1`,
      [eventId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...row,
      cursor: integer(row.cursor, 'event cursor'),
      stream_sequence: integer(row.stream_sequence, 'stream sequence'),
      occurred_at: integer(row.occurred_at, 'event occurred_at'),
    };
  }

  async latestStoredEventCursor(streamId: string): Promise<number> {
    const result = await this.database.query<{ cursor: string | number }>(
      `SELECT global_cursor AS cursor
         FROM platform_events
        WHERE stream_id = $1
        ORDER BY stream_sequence DESC
        LIMIT 1`,
      [streamId]
    );
    const row = result.rows[0];
    return row ? integer(row.cursor, 'event cursor') : 0;
  }

  async replayStoredEvents(
    afterCursor: number,
    limit: number,
    options: { streamId?: string; subjectId?: string } = {}
  ): Promise<StoredDurableEventRow[]> {
    const parameters: unknown[] = [afterCursor];
    const predicates = ['global_cursor > $1'];
    if (options.streamId) {
      parameters.push(options.streamId);
      predicates.push(`stream_id = $${parameters.length}`);
    }
    if (options.subjectId) {
      parameters.push(options.subjectId);
      predicates.push(`subject_id = $${parameters.length}`);
    }
    parameters.push(limit);
    const result = await this.database.query<PgEventRow>(
      `SELECT global_cursor AS cursor, event_id, stream_id, stream_sequence,
              request_fingerprint, event_type, subject_id, actor_user_id,
              payload_format, payload, occurred_at
         FROM platform_events
        WHERE ${predicates.join(' AND ')}
        ORDER BY global_cursor ASC LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map(row => ({
      ...row,
      cursor: integer(row.cursor, 'event cursor'),
      stream_sequence: integer(row.stream_sequence, 'stream sequence'),
      occurred_at: integer(row.occurred_at, 'event occurred_at'),
    }));
  }
}
