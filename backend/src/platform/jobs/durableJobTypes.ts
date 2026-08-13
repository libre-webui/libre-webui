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

export type DurableJobState =
  'queued' | 'running' | 'succeeded' | 'cancelled' | 'dead_letter';

export type DurablePayloadInput =
  | { mode: 'encrypted'; value: unknown }
  | { mode: 'reference'; referenceId: string };

export interface DurableJobEnqueueInput {
  jobType: string;
  actorUserId: string;
  payload: DurablePayloadInput;
  idempotencyScope: string;
  idempotencyKey: string;
  maxAttempts?: number;
  priority?: number;
  availableAt?: number;
}

export interface DurableJobMetadata {
  id: string;
  jobType: string;
  actorUserId: string;
  state: DurableJobState;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  availableAt: number;
  cancellationRequestedAt: number | null;
  progressCurrent: number;
  progressTotal: number;
  progressMessage: string | null;
  resultReference: string | null;
  errorCode: string | null;
  errorSummary: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface DurableJobLease extends DurableJobMetadata {
  workerId: string;
  leaseToken: number;
  leaseExpiresAt: number;
}

export type DurableJobAttemptOutcome =
  | 'running'
  | 'succeeded'
  | 'retry_scheduled'
  | 'cancelled'
  | 'dead_letter'
  | 'abandoned';

export interface DurableJobAttemptMetadata {
  jobId: string;
  attemptNumber: number;
  leaseToken: number;
  workerId: string;
  startedAt: number;
  lastHeartbeatAt: number;
  finishedAt: number | null;
  outcome: DurableJobAttemptOutcome;
  errorCode: string | null;
  errorSummary: string | null;
}

export interface DurableJobEventAppendInput {
  streamId: string;
  eventType: string;
  subjectId: string;
  actorUserId?: string | null;
  payload: DurablePayloadInput;
}

export interface DurableJobEvent {
  cursor: number;
  eventId: string;
  streamId: string;
  streamSequence: number;
  eventType: string;
  subjectId: string;
  actorUserId: string | null;
  payload: unknown;
  occurredAt: number;
}

export interface DurableJobProgress {
  current: number;
  total: number;
  message?: string | null;
}

export type DurableCancellationCode =
  'user-requested' | 'superseded' | 'actor-revoked' | 'system-shutdown';

export class DurableJobError extends Error {
  constructor(
    readonly code:
      | 'invalid-input'
      | 'conflict'
      | 'not-found'
      | 'lease-lost'
      | 'cancelled'
      | 'storage-error',
    message: string
  ) {
    super(message);
    this.name = 'DurableJobError';
  }
}

/**
 * A handler may expose only a stable code and an operator-safe summary. The
 * worker never persists an arbitrary exception message because it can contain
 * prompts, credentials, or provider response bodies.
 */
export class DurableJobExecutionError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly safeCode: string,
    readonly safeSummary: string
  ) {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(safeCode)) {
      throw new DurableJobError(
        'invalid-input',
        'Invalid durable job execution error code'
      );
    }
    if (
      typeof safeSummary !== 'string' ||
      safeSummary.length === 0 ||
      Buffer.byteLength(safeSummary, 'utf8') > 512 ||
      [...safeSummary].some(character => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      throw new DurableJobError(
        'invalid-input',
        'Invalid durable job execution error summary'
      );
    }
    super(safeSummary);
    this.name = 'DurableJobExecutionError';
  }
}
