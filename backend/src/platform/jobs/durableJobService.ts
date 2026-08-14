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
  type DurableChatCancellationDecision,
  type DurableChatCompletionPublishInput,
  type DurableJobActorFilter,
  type DurableJobCancellationSummary,
  type DurableJobEnqueueInput,
  type DurableJobEvent,
  type DurableJobEventAppendInput,
  type DurableJobLease,
  type DurableJobListOptions,
  type DurableJobAttemptMetadata,
  type DurableLifecycleRecoverySummary,
  type DurableJobMetadata,
  type DurableJobProgress,
  type DurableResourceDeletionOccurrence,
  type DurableJobState,
  type DurablePayloadInput,
} from './durableJobTypes.js';
import {
  SQLiteDurableJobRepository,
  type PreparedDurableEventAppend,
  type StoredLifecycleRecoveryCandidate,
  type StoredDurableEventRow,
  type StoredDurablePayload,
} from './sqliteDurableJobRepository.js';
import {
  DELETION_LIFECYCLE_RECOVERY_NOT_REQUIRED_REFERENCE,
  DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX,
  DELETION_LIFECYCLE_RECOVERY_DELAY_MS,
  OWNER_DELETE_CONTENT_JOB_TYPE,
  OWNER_DELETE_CONTENT_RECOVERY_IDEMPOTENCY_SCOPE,
  CHAT_GENERATE_JOB_TYPE,
  chatGenerationIdempotencyScope,
  RESOURCE_DELETE_JOB_TYPE,
  RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
} from './domainJobContracts.js';
import { durableEventId } from './durableEventIdentity.js';

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

const RECOVERY_SCAN_PAGE_SIZE = 100;

const objectPayload = (value: unknown): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new DurableJobError(
      'storage-error',
      'Durable lifecycle payload is invalid'
    );
  }
  return value as Record<string, unknown>;
};

const resourceDeletionOccurrence = (
  value: unknown,
  actorUserId: string
): DurableResourceDeletionOccurrence => {
  const record = objectPayload(value);
  const resourceType = record.resourceType;
  const resourceId = record.resourceId;
  const deletionIncarnation = record.deletionIncarnation;
  const deletionToken = record.deletionToken;
  if (
    !['document', 'generated-media', 'persona'].includes(
      String(resourceType)
    ) ||
    typeof resourceId !== 'string' ||
    resourceId.length === 0 ||
    !Number.isSafeInteger(deletionIncarnation) ||
    Number(deletionIncarnation) < 1 ||
    typeof deletionToken !== 'string' ||
    !/^[0-9a-f]{64}$/.test(deletionToken)
  ) {
    throw new DurableJobError(
      'storage-error',
      'Durable resource deletion payload is invalid'
    );
  }
  validateText(resourceId, 'resource ID');
  return {
    resourceType:
      resourceType as DurableResourceDeletionOccurrence['resourceType'],
    resourceId,
    ownerUserId: actorUserId,
    deletionIncarnation: Number(deletionIncarnation),
    deletionToken,
  };
};

const ownerDeletionPayload = (
  value: unknown,
  actorUserId: string
): { targetUserId: string; actorUserId: string } => {
  const record = objectPayload(value);
  if (
    typeof record.targetUserId !== 'string' ||
    typeof record.actorUserId !== 'string' ||
    record.actorUserId !== actorUserId
  ) {
    throw new DurableJobError(
      'storage-error',
      'Durable owner deletion payload is invalid'
    );
  }
  validateText(record.targetUserId, 'target user ID');
  return { targetUserId: record.targetUserId, actorUserId };
};

/**
 * Validated service boundary for durable jobs and the transactional event log.
 * Payloads are either opaque references or authenticated AES-256-GCM JSON.
 */
export class DurableJobService {
  private readonly pendingLifecycleRecoveryIds = new Set<string>();

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

  private decodeStoredJobPayload(
    job: Pick<
      StoredLifecycleRecoveryCandidate,
      'id' | 'jobType' | 'actorUserId'
    >,
    stored: StoredDurablePayload
  ): unknown {
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
      jobPayloadAad(job.id, job.jobType, job.actorUserId)
    );
    try {
      if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
        throw new DurableJobError(
          'storage-error',
          'Durable job payload exceeds the supported limit'
        );
      }
      return JSON.parse(plaintext.toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof DurableJobError) throw error;
      throw new DurableJobError(
        'storage-error',
        'Durable job payload is not valid JSON'
      );
    } finally {
      plaintext.fill(0);
    }
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
    this.flushPendingLifecycleRecovery();
    const claimed = this.repository.claimWithLifecycleRecovery(
      workerId,
      leaseMs
    );
    for (const id of claimed.terminalLifecycleJobIds) {
      this.pendingLifecycleRecoveryIds.add(id);
    }
    try {
      this.flushPendingLifecycleRecovery();
    } catch (error) {
      // Never discard a lease already committed by the repository. The exact
      // terminal IDs remain queued in memory and are retried before the next
      // claim; a process loss is covered by the bounded startup scan.
      if (!claimed.lease) throw error;
    }
    return claimed.lease;
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
    return this.decodeStoredJobPayload(lease, stored);
  }

  private reconcileDeletionLifecycleCandidate(
    candidate: StoredLifecycleRecoveryCandidate
  ): 'recovery' | 'skipped' {
    const decoded = this.decodeStoredJobPayload(candidate, candidate.payload);
    let recovery: DurableJobMetadata | null = null;
    if (candidate.jobType === RESOURCE_DELETE_JOB_TYPE) {
      const occurrence = resourceDeletionOccurrence(
        decoded,
        candidate.actorUserId
      );
      if (!this.repository.isPendingResourceDeletion(occurrence)) {
        this.repository.markDeletionLifecycleRecoveryHandled(
          candidate.id,
          DELETION_LIFECYCLE_RECOVERY_NOT_REQUIRED_REFERENCE
        );
        return 'skipped';
      }
      recovery = this.enqueue({
        jobType: RESOURCE_DELETE_JOB_TYPE,
        actorUserId: candidate.actorUserId,
        idempotencyScope: RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE,
        idempotencyKey: candidate.id,
        payload: { mode: 'encrypted', value: decoded },
        maxAttempts: 5,
        priority: candidate.priority,
        availableAt: candidate.updatedAt + DELETION_LIFECYCLE_RECOVERY_DELAY_MS,
      });
    } else if (candidate.jobType === OWNER_DELETE_CONTENT_JOB_TYPE) {
      const owner = ownerDeletionPayload(decoded, candidate.actorUserId);
      if (!this.repository.isOwnerCleanupRequired(owner.targetUserId)) {
        this.repository.markDeletionLifecycleRecoveryHandled(
          candidate.id,
          DELETION_LIFECYCLE_RECOVERY_NOT_REQUIRED_REFERENCE
        );
        return 'skipped';
      }
      recovery = this.enqueue({
        jobType: OWNER_DELETE_CONTENT_JOB_TYPE,
        actorUserId: candidate.actorUserId,
        idempotencyScope: OWNER_DELETE_CONTENT_RECOVERY_IDEMPOTENCY_SCOPE,
        idempotencyKey: candidate.id,
        payload: { mode: 'encrypted', value: decoded },
        maxAttempts: 10,
        priority: candidate.priority,
        availableAt: candidate.updatedAt + DELETION_LIFECYCLE_RECOVERY_DELAY_MS,
      });
    } else {
      throw new DurableJobError(
        'storage-error',
        'Unexpected deletion lifecycle job type'
      );
    }
    this.repository.markDeletionLifecycleRecoveryHandled(
      candidate.id,
      `${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}${recovery.id}`
    );
    return 'recovery';
  }

  private reconcilePendingLifecycleRecovery(): void {
    for (const id of [...this.pendingLifecycleRecoveryIds]) {
      const candidate =
        this.repository.getDeletionLifecycleRecoveryCandidate(id);
      if (candidate) this.reconcileDeletionLifecycleCandidate(candidate);
      this.pendingLifecycleRecoveryIds.delete(id);
    }
  }

  private flushPendingLifecycleRecovery(): void {
    this.reconcilePendingLifecycleRecovery();
  }

  reconcileDeletionLifecycleJob(id: string): DurableLifecycleRecoverySummary {
    validateText(id, 'ID');
    this.pendingLifecycleRecoveryIds.add(id);
    const candidate = this.repository.getDeletionLifecycleRecoveryCandidate(id);
    if (!candidate) {
      this.pendingLifecycleRecoveryIds.delete(id);
      return { examined: 0, recoveryJobs: 0, skipped: 0 };
    }
    const outcome = this.reconcileDeletionLifecycleCandidate(candidate);
    this.pendingLifecycleRecoveryIds.delete(id);
    return {
      examined: 1,
      recoveryJobs: outcome === 'recovery' ? 1 : 0,
      skipped: outcome === 'skipped' ? 1 : 0,
    };
  }

  reconcileDeletionLifecycleJobs(): DurableLifecycleRecoverySummary {
    const summary: DurableLifecycleRecoverySummary = {
      examined: 0,
      recoveryJobs: 0,
      skipped: 0,
    };
    let afterId = '';
    for (;;) {
      const candidates =
        this.repository.listDeletionLifecycleRecoveryCandidates(
          afterId,
          RECOVERY_SCAN_PAGE_SIZE
        );
      for (const candidate of candidates) {
        afterId = candidate.id;
        summary.examined += 1;
        const outcome = this.reconcileDeletionLifecycleCandidate(candidate);
        if (outcome === 'recovery') summary.recoveryJobs += 1;
        else summary.skipped += 1;
      }
      if (candidates.length < RECOVERY_SCAN_PAGE_SIZE) break;
    }
    return summary;
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
    const state = this.repository.abandon(lease);
    if (
      (state === 'cancelled' || state === 'dead_letter') &&
      (lease.jobType === RESOURCE_DELETE_JOB_TYPE ||
        lease.jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
    ) {
      this.reconcileDeletionLifecycleJob(lease.id);
    }
    return state;
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
    const cancelled = this.repository.requestCancellation(
      id,
      actorUserId,
      reason
    );
    if (
      cancelled.state === 'cancelled' &&
      (cancelled.jobType === RESOURCE_DELETE_JOB_TYPE ||
        cancelled.jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
    ) {
      this.reconcileDeletionLifecycleJob(cancelled.id);
    }
    return cancelled;
  }

  cancelAllForActor(
    actorUserId: string,
    reason: DurableCancellationCode,
    filter: DurableJobActorFilter = {}
  ): DurableJobCancellationSummary {
    validateText(actorUserId, 'actor user ID');
    this.validateActorFilter(filter);
    return this.repository.requestActorCancellation(
      actorUserId,
      reason,
      filter
    );
  }

  countActiveForActor(
    actorUserId: string,
    filter: DurableJobActorFilter = {}
  ): number {
    validateText(actorUserId, 'actor user ID');
    this.validateActorFilter(filter);
    return this.repository.countActiveForActor(actorUserId, filter);
  }

  countNonSucceededForActor(
    actorUserId: string,
    filter: DurableJobActorFilter = {}
  ): number {
    validateText(actorUserId, 'actor user ID');
    this.validateActorFilter(filter);
    return this.repository.countNonSucceededForActor(actorUserId, filter);
  }

  private validateActorFilter(filter: DurableJobActorFilter): void {
    if (
      filter.excludeHandledLifecycleJobs !== undefined &&
      typeof filter.excludeHandledLifecycleJobs !== 'boolean'
    ) {
      throw invalid('Invalid durable lifecycle job filter');
    }
    for (const jobType of filter.jobTypes ?? []) validateText(jobType, 'type');
    for (const jobType of filter.excludeJobTypes ?? []) {
      validateText(jobType, 'excluded type');
    }
    for (const scope of filter.idempotencyScopes ?? []) {
      validateText(scope, 'idempotency scope');
    }
    for (const id of filter.excludeJobIds ?? []) validateText(id, 'ID');
    if ((filter.jobTypes?.length ?? 0) > 64) {
      throw invalid('Too many durable job type filters');
    }
    if ((filter.excludeJobTypes?.length ?? 0) > 64) {
      throw invalid('Too many durable job type exclusions');
    }
    if ((filter.excludeJobIds?.length ?? 0) > 64) {
      throw invalid('Too many durable job exclusions');
    }
    if ((filter.idempotencyScopes?.length ?? 0) > 64) {
      throw invalid('Too many durable job idempotency scope filters');
    }
  }

  getMetadata(id: string): DurableJobMetadata | null {
    validateText(id, 'ID');
    return this.repository.getMetadata(id);
  }

  getByIdempotency(
    actorUserId: string,
    idempotencyScope: string,
    idempotencyKey: string
  ): DurableJobMetadata | null {
    validateText(actorUserId, 'actor user ID');
    validateText(idempotencyScope, 'idempotency scope');
    validateText(idempotencyKey, 'idempotency key', MAX_REFERENCE_BYTES);
    return this.repository.getByIdempotency(
      actorUserId,
      idempotencyScope,
      hash(`${actorUserId}\0${idempotencyScope}\0${idempotencyKey}`)
    );
  }

  listJobs(options: DurableJobListOptions = {}): DurableJobMetadata[] {
    if (options.actorUserId !== undefined) {
      validateText(options.actorUserId, 'actor user ID');
    }
    const states: DurableJobState[] = [
      'queued',
      'running',
      'succeeded',
      'cancelled',
      'dead_letter',
    ];
    if (options.state !== undefined && !states.includes(options.state)) {
      throw invalid('Invalid durable job state filter');
    }
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw invalid('Durable job list limit must be between 1 and 200');
    }
    if (
      options.beforeCreatedAt !== undefined &&
      (!Number.isSafeInteger(options.beforeCreatedAt) ||
        options.beforeCreatedAt < 0)
    ) {
      throw invalid('Invalid durable job list cursor');
    }
    return this.repository.listJobs({ ...options, limit });
  }

  listAttempts(id: string): DurableJobAttemptMetadata[] {
    validateText(id, 'ID');
    return this.repository.listAttempts(id);
  }

  private prepareEvent(
    input: DurableJobEventAppendInput
  ): PreparedDurableEventAppend {
    validateText(input.eventId, 'event ID');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.eventId
      )
    ) {
      throw invalid('Invalid durable job event ID');
    }
    validateText(input.streamId, 'event stream ID');
    validateText(input.eventType, 'event type');
    validateText(input.subjectId, 'event subject ID');
    if (input.actorUserId !== null && input.actorUserId !== undefined) {
      validateText(input.actorUserId, 'event actor user ID');
    }
    const eventId = input.eventId;
    const validated = validatePayloadInput(input.payload);
    const requestFingerprint = hash(
      JSON.stringify([
        input.streamId,
        input.eventType,
        input.subjectId,
        input.actorUserId ?? null,
        validated.mode,
        validated.canonical,
      ])
    );
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
    return {
      eventId,
      requestFingerprint,
      streamId: input.streamId,
      eventType: input.eventType,
      subjectId: input.subjectId,
      actorUserId: input.actorUserId ?? null,
      payload,
      occurredAt: this.now(),
    };
  }

  appendEvent(input: DurableJobEventAppendInput): number {
    return this.repository.appendEvent(this.prepareEvent(input));
  }

  requestChatCancellation(input: {
    actorUserId: string;
    sessionId: string;
    assistantMessageId: string;
  }): DurableChatCancellationDecision {
    validateText(input.actorUserId, 'chat cancellation actor user ID');
    validateText(input.sessionId, 'chat cancellation session ID');
    validateText(input.assistantMessageId, 'chat cancellation message ID');
    const scope = chatGenerationIdempotencyScope(input.sessionId);
    return this.repository.requestChatCancellation({
      actorUserId: input.actorUserId,
      idempotencyScope: scope,
      idempotencyKeyHash: hash(
        `${input.actorUserId}\0${scope}\0${input.assistantMessageId}`
      ),
      doneEventId: durableEventId(
        'chat',
        input.sessionId,
        input.assistantMessageId,
        'done'
      ),
      event: this.prepareEvent({
        eventId: durableEventId(
          'chat',
          input.sessionId,
          input.assistantMessageId,
          'cancel-requested',
          input.actorUserId
        ),
        streamId: `chat:${input.sessionId}`,
        eventType: 'chat.cancel-requested.v1',
        subjectId: input.assistantMessageId,
        actorUserId: input.actorUserId,
        payload: {
          mode: 'encrypted',
          value: {
            type: 'cancel-requested',
            messageId: input.assistantMessageId,
          },
        },
      }),
    });
  }

  publishChatCompletion(input: DurableChatCompletionPublishInput): number {
    validateText(input.lease.jobId, 'chat completion job ID');
    validateText(input.lease.workerId, 'chat completion worker ID');
    if (!Number.isSafeInteger(input.lease.leaseToken)) {
      throw invalid('Invalid durable chat completion lease token');
    }
    validateText(input.actorUserId, 'chat completion actor user ID');
    validateText(input.sessionId, 'chat completion session ID');
    validateText(input.expectedJobType, 'chat completion job type');
    validateText(input.message.id, 'chat completion message ID');
    if (
      input.expectedJobType !== CHAT_GENERATE_JOB_TYPE ||
      input.message.sessionId !== input.sessionId
    ) {
      throw invalid('Invalid durable chat completion identity');
    }
    const expectedScope = chatGenerationIdempotencyScope(input.sessionId);
    if (
      input.event.eventId !==
        durableEventId('chat', input.sessionId, input.message.id, 'done') ||
      input.event.streamId !== `chat:${input.sessionId}` ||
      input.event.eventType !== 'chat.done.v1' ||
      input.event.subjectId !== input.message.id ||
      input.event.actorUserId !== input.actorUserId
    ) {
      throw invalid('Invalid durable chat completion event');
    }
    return this.repository.publishChatCompletion({
      ...input,
      expectedIdempotencyScope: expectedScope,
      expectedIdempotencyKeyHash: hash(
        `${input.actorUserId}\0${expectedScope}\0${input.message.id}`
      ),
      cancellationEventId: durableEventId(
        'chat',
        input.sessionId,
        input.message.id,
        'cancel-requested',
        input.actorUserId
      ),
      event: this.prepareEvent(input.event),
    });
  }

  getEvent(eventId: string): DurableJobEvent | null {
    validateText(eventId, 'event ID');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        eventId
      )
    ) {
      throw invalid('Invalid durable job event ID');
    }
    const row = this.repository.getStoredEvent(eventId);
    return row ? this.decodeEvent(row) : null;
  }

  latestEventCursor(streamId: string): number {
    validateText(streamId, 'event stream ID');
    return this.repository.latestStoredEventCursor(streamId);
  }

  replayEvents(
    afterCursor: number,
    options: { limit?: number; streamId?: string; subjectId?: string } = {}
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
    if (options.subjectId !== undefined) {
      validateText(options.subjectId, 'event subject ID');
    }
    return this.repository
      .replayStoredEvents(afterCursor, limit, {
        streamId: options.streamId,
        subjectId: options.subjectId,
      })
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
