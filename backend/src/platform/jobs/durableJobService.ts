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
import {
  Aes256GcmKeyring,
  parseAesGcmEnvelope,
} from '../storage/aesGcmKeyring.js';
import {
  DurableJobError,
  type DurableCancellationCode,
  type DurableJobEnqueueInput,
  type DurableJobEvent,
  type DurableJobEventAppendInput,
  type DurableJobLease,
  type DurableJobMetadata,
  type DurableJobProgress,
  type DurableJobState,
  type DurablePayloadInput,
} from './durableJobTypes.js';
import {
  SQLiteDurableJobRepository,
  type PreparedDurableEventAppend,
  type StoredDurableEventRow,
  type StoredDurablePayload,
} from './sqliteDurableJobRepository.js';

const MAX_IDENTIFIER_BYTES = 256;
const MAX_REFERENCE_BYTES = 2048;
const MAX_SAFE_TEXT_BYTES = 512;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const MAX_ATTEMPTS = 10;
const MAX_PRIORITY = 100;
const MAX_PROGRESS = 1_000_000_000;
const MAX_EVENT_REPLAY = 500;
const MAX_SCHEDULE_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
const MIN_LEASE_MS = 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const SAFE_CODE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;

const invalid = (message: string): DurableJobError =>
  new DurableJobError('invalid-input', message);

const validateText = (
  value: string,
  field: string,
  maxBytes = MAX_IDENTIFIER_BYTES
): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    [...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    throw invalid(`Invalid durable job ${field}`);
  }
};

const validateOptionalSafeText = (
  value: string | null | undefined,
  field: string,
  maxBytes = MAX_SAFE_TEXT_BYTES
): string | null => {
  if (value === undefined || value === null || value === '') return null;
  validateText(value, field, maxBytes);
  return value;
};

const canonicalJson = (value: unknown): string => {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw invalid('Durable job payload is too complex');
    }
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') return JSON.stringify(candidate);
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw invalid('Durable job payload contains a non-finite number');
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object') {
      throw invalid('Durable job payload must contain only JSON values');
    }
    if (ancestors.has(candidate)) {
      throw invalid('Durable job payload contains a cycle');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return `[${Array.from(candidate, item => visit(item, depth + 1)).join(
          ','
        )}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid('Durable job payload must contain plain JSON objects');
      }
      const record = candidate as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys
        .map(key => `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };

  const serialized = visit(value, 0);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw invalid('Durable job payload exceeds 64 KiB');
  }
  return serialized;
};

const hash = (value: string): string =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const jobPayloadAad = (
  id: string,
  jobType: string,
  actorUserId: string
): Buffer => Buffer.from(`durable-job:v1\0${id}\0${jobType}\0${actorUserId}`);

const eventPayloadAad = (
  eventId: string,
  streamId: string,
  eventType: string,
  subjectId: string,
  actorUserId: string | null
): Buffer =>
  Buffer.from(
    `durable-event:v1\0${eventId}\0${streamId}\0${eventType}\0${subjectId}\0${actorUserId ?? ''}`
  );

const validatePayloadInput = (
  input: DurablePayloadInput
): { canonical: string; mode: DurablePayloadInput['mode'] } => {
  if (input.mode === 'reference') {
    validateText(input.referenceId, 'payload reference', MAX_REFERENCE_BYTES);
    return { canonical: input.referenceId, mode: input.mode };
  }
  if (input.mode !== 'encrypted') {
    throw invalid('Invalid durable job payload mode');
  }
  return { canonical: canonicalJson(input.value), mode: input.mode };
};

/**
 * Validated service boundary for durable jobs and the transactional event log.
 * Payloads are either opaque references or authenticated AES-256-GCM JSON.
 */
export class DurableJobService {
  constructor(
    private readonly repository: SQLiteDurableJobRepository,
    private readonly keyring: Aes256GcmKeyring,
    private readonly now: () => number = Date.now
  ) {}

  private encodeJobPayload(
    jobId: string,
    jobType: string,
    actorUserId: string,
    input: DurablePayloadInput
  ): { stored: StoredDurablePayload; canonical: string } {
    const validated = validatePayloadInput(input);
    if (validated.mode === 'reference') {
      return {
        stored: { format: 'reference', data: validated.canonical },
        canonical: `reference\0${validated.canonical}`,
      };
    }
    const envelope = this.keyring.encrypt(
      Buffer.from(validated.canonical, 'utf8'),
      jobPayloadAad(jobId, jobType, actorUserId)
    );
    return {
      stored: { format: 'encrypted', data: JSON.stringify(envelope) },
      canonical: `encrypted\0${validated.canonical}`,
    };
  }

  enqueue(input: DurableJobEnqueueInput): DurableJobMetadata {
    validateText(input.jobType, 'type');
    validateText(input.actorUserId, 'actor user ID');
    validateText(input.idempotencyScope, 'idempotency scope');
    validateText(input.idempotencyKey, 'idempotency key', MAX_REFERENCE_BYTES);
    const maxAttempts = input.maxAttempts ?? 3;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > MAX_ATTEMPTS
    ) {
      throw invalid(
        `Durable job max attempts must be between 1 and ${MAX_ATTEMPTS}`
      );
    }
    const priority = input.priority ?? 0;
    if (
      !Number.isSafeInteger(priority) ||
      priority < -MAX_PRIORITY ||
      priority > MAX_PRIORITY
    ) {
      throw invalid('Invalid durable job priority');
    }
    const timestamp = this.now();
    const availableAt = input.availableAt ?? timestamp;
    if (
      !Number.isSafeInteger(availableAt) ||
      availableAt < 0 ||
      availableAt > timestamp + MAX_SCHEDULE_DELAY_MS
    ) {
      throw invalid('Invalid durable job availability time');
    }

    const id = crypto.randomUUID();
    const encoded = this.encodeJobPayload(
      id,
      input.jobType,
      input.actorUserId,
      input.payload
    );
    const idempotencyKeyHash = hash(
      `${input.actorUserId}\0${input.idempotencyScope}\0${input.idempotencyKey}`
    );
    const requestFingerprint = hash(
      `${input.jobType}\0${input.actorUserId}\0${input.idempotencyScope}\0` +
        `${maxAttempts}\0${priority}\0${input.availableAt === undefined ? 'now' : availableAt}\0` +
        encoded.canonical
    );
    return this.repository.enqueue({
      id,
      jobType: input.jobType,
      actorUserId: input.actorUserId,
      payload: encoded.stored,
      idempotencyScope: input.idempotencyScope,
      idempotencyKeyHash,
      requestFingerprint,
      maxAttempts,
      priority,
      availableAt,
    });
  }

  claim(workerId: string, leaseMs: number): DurableJobLease | null {
    validateText(workerId, 'worker ID');
    this.validateLeaseDuration(leaseMs);
    return this.repository.claim(workerId, leaseMs);
  }

  heartbeat(
    lease: DurableJobLease,
    leaseMs: number
  ): {
    owned: boolean;
    cancellationRequested: boolean;
  } {
    this.validateLeaseDuration(leaseMs);
    return this.repository.heartbeat(lease, leaseMs);
  }

  private validateLeaseDuration(leaseMs: number): void {
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < MIN_LEASE_MS ||
      leaseMs > MAX_LEASE_MS
    ) {
      throw invalid(
        `Durable job lease must be between ${MIN_LEASE_MS} and ${MAX_LEASE_MS} ms`
      );
    }
  }

  readPayload(lease: DurableJobLease): unknown {
    const stored = this.repository.getStoredPayload(lease);
    if (stored.format === 'reference') {
      return { referenceId: stored.data };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored.data);
    } catch {
      throw new DurableJobError(
        'storage-error',
        'Durable job payload envelope is invalid'
      );
    }
    const plaintext = this.keyring.decrypt(
      parseAesGcmEnvelope(parsed),
      jobPayloadAad(lease.id, lease.jobType, lease.actorUserId)
    );
    if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
      throw new DurableJobError(
        'storage-error',
        'Durable job payload exceeds the supported limit'
      );
    }
    try {
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch {
      throw new DurableJobError(
        'storage-error',
        'Durable job payload is not valid JSON'
      );
    }
  }

  reportProgress(lease: DurableJobLease, progress: DurableJobProgress): void {
    if (
      !Number.isSafeInteger(progress.current) ||
      !Number.isSafeInteger(progress.total) ||
      progress.current < 0 ||
      progress.total <= 0 ||
      progress.total > MAX_PROGRESS ||
      progress.current > progress.total
    ) {
      throw invalid('Invalid durable job progress');
    }
    const message = validateOptionalSafeText(
      progress.message,
      'progress message'
    );
    this.repository.updateProgress(
      lease,
      progress.current,
      progress.total,
      message
    );
  }

  complete(lease: DurableJobLease, resultReference?: string | null): void {
    const reference = validateOptionalSafeText(
      resultReference,
      'result reference',
      MAX_REFERENCE_BYTES
    );
    this.repository.complete(lease, reference);
  }

  fail(
    lease: DurableJobLease,
    options: {
      retryable: boolean;
      errorCode: string;
      errorSummary: string;
      backoffMs: number;
    }
  ): DurableJobState {
    if (!SAFE_CODE_PATTERN.test(options.errorCode)) {
      throw invalid('Invalid durable job error code');
    }
    validateText(options.errorSummary, 'error summary', MAX_SAFE_TEXT_BYTES);
    if (
      !Number.isSafeInteger(options.backoffMs) ||
      options.backoffMs < 0 ||
      options.backoffMs > MAX_LEASE_MS
    ) {
      throw invalid('Invalid durable job retry backoff');
    }
    return this.repository.fail(
      lease,
      options.retryable,
      options.errorCode,
      options.errorSummary,
      this.now() + options.backoffMs
    );
  }

  abandon(lease: DurableJobLease): DurableJobState {
    return this.repository.abandon(lease);
  }

  cancel(
    id: string,
    actorUserId: string,
    reason: DurableCancellationCode = 'user-requested'
  ): DurableJobMetadata {
    validateText(id, 'ID');
    validateText(actorUserId, 'actor user ID');
    const allowedReasons: readonly DurableCancellationCode[] = [
      'user-requested',
      'superseded',
      'actor-revoked',
      'system-shutdown',
    ];
    if (!allowedReasons.includes(reason)) {
      throw invalid('Invalid durable job cancellation code');
    }
    return this.repository.requestCancellation(id, actorUserId, reason);
  }

  getMetadata(id: string): DurableJobMetadata | null {
    validateText(id, 'ID');
    return this.repository.getMetadata(id);
  }

  appendEvent(input: DurableJobEventAppendInput): number {
    validateText(input.streamId, 'event stream ID');
    validateText(input.eventType, 'event type');
    validateText(input.subjectId, 'event subject ID');
    if (input.actorUserId !== null && input.actorUserId !== undefined) {
      validateText(input.actorUserId, 'event actor user ID');
    }
    const eventId = crypto.randomUUID();
    const validated = validatePayloadInput(input.payload);
    let payload: StoredDurablePayload;
    if (validated.mode === 'reference') {
      payload = { format: 'reference', data: validated.canonical };
    } else {
      const envelope = this.keyring.encrypt(
        Buffer.from(validated.canonical, 'utf8'),
        eventPayloadAad(
          eventId,
          input.streamId,
          input.eventType,
          input.subjectId,
          input.actorUserId ?? null
        )
      );
      payload = { format: 'encrypted', data: JSON.stringify(envelope) };
    }
    const prepared: PreparedDurableEventAppend = {
      eventId,
      streamId: input.streamId,
      eventType: input.eventType,
      subjectId: input.subjectId,
      actorUserId: input.actorUserId ?? null,
      payload,
      occurredAt: this.now(),
    };
    return this.repository.appendEvent(prepared);
  }

  replayEvents(
    afterCursor: number,
    options: { limit?: number; streamId?: string } = {}
  ): DurableJobEvent[] {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0) {
      throw invalid('Invalid durable event cursor');
    }
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_REPLAY) {
      throw invalid(
        `Durable event replay limit must be between 1 and ${MAX_EVENT_REPLAY}`
      );
    }
    if (options.streamId !== undefined) {
      validateText(options.streamId, 'event stream ID');
    }
    return this.repository
      .replayStoredEvents(afterCursor, limit, options.streamId)
      .map(row => this.decodeEvent(row));
  }

  private decodeEvent(row: StoredDurableEventRow): DurableJobEvent {
    let payload: unknown;
    if (row.payload_format === 'reference') {
      payload = { referenceId: row.payload };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        throw new DurableJobError(
          'storage-error',
          'Durable event payload envelope is invalid'
        );
      }
      const plaintext = this.keyring.decrypt(
        parseAesGcmEnvelope(parsed),
        eventPayloadAad(
          row.event_id,
          row.stream_id,
          row.event_type,
          row.subject_id,
          row.actor_user_id
        )
      );
      if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
        throw new DurableJobError(
          'storage-error',
          'Durable event payload exceeds the supported limit'
        );
      }
      try {
        payload = JSON.parse(plaintext.toString('utf8')) as unknown;
      } catch {
        throw new DurableJobError(
          'storage-error',
          'Durable event payload is not valid JSON'
        );
      }
    }
    return {
      cursor: row.cursor,
      eventId: row.event_id,
      streamId: row.stream_id,
      streamSequence: row.stream_sequence,
      eventType: row.event_type,
      subjectId: row.subject_id,
      actorUserId: row.actor_user_id,
      payload,
      occurredAt: row.occurred_at,
    };
  }
}
