/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import type { PostgresQueryExecutor } from '../../persistence/postgresDatabase.js';
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
  type DurableJobAttemptMetadata,
  type DurableJobEnqueueInput,
  type DurableJobEvent,
  type DurableJobEventAppendInput,
  type DurableJobLease,
  type DurableJobListOptions,
  type DurableLifecycleRecoverySummary,
  type DurableJobMetadata,
  type DurableJobProgress,
  type DurableResourceDeletionOccurrence,
  type DurableJobState,
  type DurablePayloadInput,
} from './durableJobTypes.js';
import { PostgresDurableJobRepository } from './postgresDurableJobRepository.js';
import type {
  PreparedDurableEventAppend,
  PreparedDurableJobEnqueue,
  StoredLifecycleRecoveryCandidate,
  StoredDurableEventRow,
  StoredDurablePayload,
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

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_REFERENCE_BYTES = 2048;
const MAX_SAFE_TEXT_BYTES = 512;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 10_000;
const SAFE_CODE = /^[a-z][a-z0-9.-]{0,63}$/;

const invalid = (message: string): DurableJobError =>
  new DurableJobError('invalid-input', message);

const text = (
  value: string,
  field: string,
  maximum = MAX_IDENTIFIER_BYTES
): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    [...value].some(character => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    })
  ) {
    throw invalid(`Invalid durable job ${field}`);
  }
};

const canonical = (value: unknown): string => {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      throw invalid('Durable job payload is too complex');
    }
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate))
        throw invalid('Durable job payload contains a non-finite number');
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object' || ancestors.has(candidate)) {
      throw invalid('Durable job payload must contain acyclic JSON values');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return `[${candidate.map(item => visit(item, depth + 1)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid('Durable job payload must contain plain JSON objects');
      }
      const object = candidate as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map(key => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`)
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

const digest = (value: string): string =>
  crypto.createHash('sha256').update(value, 'utf8').digest('hex');

const jobAad = (id: string, type: string, actor: string): Buffer =>
  Buffer.from(`durable-job:v1\0${id}\0${type}\0${actor}`);

const eventAad = (
  id: string,
  stream: string,
  type: string,
  subject: string,
  actor: string | null
): Buffer =>
  Buffer.from(
    `durable-event:v1\0${id}\0${stream}\0${type}\0${subject}\0${actor ?? ''}`
  );

const payload = (
  input: DurablePayloadInput
): { mode: 'encrypted' | 'reference'; canonical: string } => {
  if (input.mode === 'reference') {
    text(input.referenceId, 'payload reference', MAX_REFERENCE_BYTES);
    return { mode: 'reference', canonical: input.referenceId };
  }
  if (input.mode !== 'encrypted')
    throw invalid('Invalid durable job payload mode');
  return { mode: 'encrypted', canonical: canonical(input.value) };
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
  text(resourceId, 'resource ID');
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
  text(record.targetUserId, 'target user ID');
  return { targetUserId: record.targetUserId, actorUserId };
};

/** Async service boundary used by PostgreSQL application and worker processes. */
export class PostgresDurableJobService {
  private readonly pendingLifecycleRecoveryIds = new Set<string>();

  constructor(
    private readonly repository: PostgresDurableJobRepository,
    private readonly keyring: Aes256GcmKeyring,
    private readonly now: () => number = Date.now
  ) {}

  private decodeStoredJobPayload(
    job: Pick<
      StoredLifecycleRecoveryCandidate,
      'id' | 'jobType' | 'actorUserId'
    >,
    stored: StoredDurablePayload
  ): unknown {
    if (stored.format === 'reference') return { referenceId: stored.data };
    let envelope: unknown;
    try {
      envelope = JSON.parse(stored.data);
    } catch {
      throw new DurableJobError(
        'storage-error',
        'Durable job payload envelope is invalid'
      );
    }
    const plaintext = this.keyring.decrypt(
      parseAesGcmEnvelope(envelope),
      jobAad(job.id, job.jobType, job.actorUserId)
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

  private prepareEnqueue(
    input: DurableJobEnqueueInput
  ): PreparedDurableJobEnqueue {
    text(input.jobType, 'type');
    text(input.actorUserId, 'actor user ID');
    text(input.idempotencyScope, 'idempotency scope');
    text(input.idempotencyKey, 'idempotency key', MAX_REFERENCE_BYTES);
    const maxAttempts = input.maxAttempts ?? 3;
    const priority = input.priority ?? 0;
    const timestamp = this.now();
    const availableAt = input.availableAt ?? timestamp;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 10
    ) {
      throw invalid('Durable job max attempts must be between 1 and 10');
    }
    if (!Number.isSafeInteger(priority) || priority < -100 || priority > 100) {
      throw invalid('Invalid durable job priority');
    }
    if (
      !Number.isSafeInteger(availableAt) ||
      availableAt < 0 ||
      availableAt > timestamp + 365 * 24 * 60 * 60 * 1000
    ) {
      throw invalid('Invalid durable job availability time');
    }
    const id = crypto.randomUUID();
    const validated = payload(input.payload);
    const stored: StoredDurablePayload =
      validated.mode === 'reference'
        ? { format: 'reference', data: validated.canonical }
        : {
            format: 'encrypted',
            data: JSON.stringify(
              this.keyring.encrypt(
                Buffer.from(validated.canonical, 'utf8'),
                jobAad(id, input.jobType, input.actorUserId)
              )
            ),
          };
    const canonicalPayload = `${validated.mode}\0${validated.canonical}`;
    return {
      id,
      jobType: input.jobType,
      actorUserId: input.actorUserId,
      payload: stored,
      idempotencyScope: input.idempotencyScope,
      idempotencyKeyHash: digest(
        `${input.actorUserId}\0${input.idempotencyScope}\0${input.idempotencyKey}`
      ),
      requestFingerprint: digest(
        `${input.jobType}\0${input.actorUserId}\0${input.idempotencyScope}\0${maxAttempts}\0${priority}\0${input.availableAt === undefined ? 'now' : availableAt}\0${canonicalPayload}`
      ),
      maxAttempts,
      priority,
      availableAt,
    };
  }

  enqueue(input: DurableJobEnqueueInput): Promise<DurableJobMetadata> {
    return this.repository.enqueue(this.prepareEnqueue(input));
  }

  enqueueWithExecutor(
    executor: PostgresQueryExecutor,
    input: DurableJobEnqueueInput
  ): Promise<DurableJobMetadata> {
    return this.repository.enqueueWithExecutor(
      executor,
      this.prepareEnqueue(input)
    );
  }

  async enqueueChatGenerationWithExecutor(
    executor: PostgresQueryExecutor,
    input: DurableJobEnqueueInput,
    cancellation: {
      eventId: string;
      streamId: string;
      subjectId: string;
      actorUserId: string;
    }
  ): Promise<{ job: DurableJobMetadata; created: boolean }> {
    const sessionId = cancellation.streamId.startsWith('chat:')
      ? cancellation.streamId.slice('chat:'.length)
      : '';
    const expectedScope = chatGenerationIdempotencyScope(sessionId);
    if (
      !sessionId ||
      input.jobType !== CHAT_GENERATE_JOB_TYPE ||
      input.actorUserId !== cancellation.actorUserId ||
      input.idempotencyScope !== expectedScope ||
      input.idempotencyKey !== cancellation.subjectId ||
      cancellation.eventId !==
        durableEventId(
          'chat',
          sessionId,
          cancellation.subjectId,
          'cancel-requested',
          cancellation.actorUserId
        )
    ) {
      throw invalid('Invalid chat generation cancellation identity');
    }
    const cancellationCommitted =
      await this.repository.lockChatCancellationDecision(
        executor,
        cancellation
      );
    const prepared = this.prepareEnqueue(input);
    const existing = await executor.query(
      `SELECT id FROM platform_jobs
        WHERE actor_user_id = $1 AND idempotency_scope = $2
          AND idempotency_key_hash = $3`,
      [
        prepared.actorUserId,
        prepared.idempotencyScope,
        prepared.idempotencyKeyHash,
      ]
    );
    let job = await this.repository.enqueueWithExecutor(executor, prepared);
    if (cancellationCommitted) {
      job = await this.repository.requestCancellationWithExecutor(
        executor,
        job.id,
        input.actorUserId,
        'user-requested'
      );
    }
    return { job, created: existing.rows[0] === undefined };
  }

  async claim(
    workerId: string,
    leaseMs: number
  ): Promise<DurableJobLease | null> {
    text(workerId, 'worker ID');
    this.leaseDuration(leaseMs);
    await this.flushPendingLifecycleRecovery();
    const claimed = await this.repository.claimWithLifecycleRecovery(
      workerId,
      leaseMs
    );
    for (const id of claimed.terminalLifecycleJobIds) {
      this.pendingLifecycleRecoveryIds.add(id);
    }
    try {
      await this.flushPendingLifecycleRecovery();
    } catch (error) {
      // Do not discard a PostgreSQL lease that already committed. Exact
      // terminal IDs remain queued on this service and are retried before the
      // next claim; process loss is covered by the bounded startup scan.
      if (!claimed.lease) throw error;
    }
    return claimed.lease;
  }

  heartbeat(job: DurableJobLease, leaseMs: number) {
    this.leaseDuration(leaseMs);
    return this.repository.heartbeat(job, leaseMs);
  }

  /** Read-only ownership and cancellation check; never extends the lease. */
  inspectLease(job: DurableJobLease) {
    return this.repository.inspectLease(job);
  }

  private leaseDuration(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 15 * 60_000) {
      throw invalid('Durable job lease must be between 1000 and 900000 ms');
    }
  }

  async readPayload(job: DurableJobLease): Promise<unknown> {
    const stored = await this.repository.getStoredPayload(job);
    return this.decodeStoredJobPayload(job, stored);
  }

  private async reconcileDeletionLifecycleCandidate(
    candidate: StoredLifecycleRecoveryCandidate
  ): Promise<'recovery' | 'skipped'> {
    const decoded = this.decodeStoredJobPayload(candidate, candidate.payload);
    let recovery: DurableJobMetadata | null = null;
    if (candidate.jobType === RESOURCE_DELETE_JOB_TYPE) {
      const occurrence = resourceDeletionOccurrence(
        decoded,
        candidate.actorUserId
      );
      if (!(await this.repository.isPendingResourceDeletion(occurrence))) {
        await this.repository.markDeletionLifecycleRecoveryHandled(
          candidate.id,
          DELETION_LIFECYCLE_RECOVERY_NOT_REQUIRED_REFERENCE
        );
        return 'skipped';
      }
      recovery = await this.enqueue({
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
      if (!(await this.repository.isOwnerCleanupRequired(owner.targetUserId))) {
        await this.repository.markDeletionLifecycleRecoveryHandled(
          candidate.id,
          DELETION_LIFECYCLE_RECOVERY_NOT_REQUIRED_REFERENCE
        );
        return 'skipped';
      }
      recovery = await this.enqueue({
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
    await this.repository.markDeletionLifecycleRecoveryHandled(
      candidate.id,
      `${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}${recovery.id}`
    );
    return 'recovery';
  }

  private async flushPendingLifecycleRecovery(): Promise<void> {
    for (const id of [...this.pendingLifecycleRecoveryIds]) {
      const candidate =
        await this.repository.getDeletionLifecycleRecoveryCandidate(id);
      if (candidate) await this.reconcileDeletionLifecycleCandidate(candidate);
      this.pendingLifecycleRecoveryIds.delete(id);
    }
  }

  async reconcileDeletionLifecycleJob(
    id: string
  ): Promise<DurableLifecycleRecoverySummary> {
    text(id, 'ID');
    this.pendingLifecycleRecoveryIds.add(id);
    const candidate =
      await this.repository.getDeletionLifecycleRecoveryCandidate(id);
    if (!candidate) {
      this.pendingLifecycleRecoveryIds.delete(id);
      return { examined: 0, recoveryJobs: 0, skipped: 0 };
    }
    const outcome = await this.reconcileDeletionLifecycleCandidate(candidate);
    this.pendingLifecycleRecoveryIds.delete(id);
    return {
      examined: 1,
      recoveryJobs: outcome === 'recovery' ? 1 : 0,
      skipped: outcome === 'skipped' ? 1 : 0,
    };
  }

  async reconcileDeletionLifecycleJobs(): Promise<DurableLifecycleRecoverySummary> {
    const summary: DurableLifecycleRecoverySummary = {
      examined: 0,
      recoveryJobs: 0,
      skipped: 0,
    };
    let afterId = '';
    for (;;) {
      const candidates =
        await this.repository.listDeletionLifecycleRecoveryCandidates(
          afterId,
          RECOVERY_SCAN_PAGE_SIZE
        );
      for (const candidate of candidates) {
        afterId = candidate.id;
        summary.examined += 1;
        const outcome =
          await this.reconcileDeletionLifecycleCandidate(candidate);
        if (outcome === 'recovery') summary.recoveryJobs += 1;
        else summary.skipped += 1;
      }
      if (candidates.length < RECOVERY_SCAN_PAGE_SIZE) break;
    }
    return summary;
  }

  reportProgress(
    job: DurableJobLease,
    progress: DurableJobProgress
  ): Promise<void> {
    if (
      !Number.isSafeInteger(progress.current) ||
      !Number.isSafeInteger(progress.total) ||
      progress.current < 0 ||
      progress.total < 1 ||
      progress.total > 1_000_000_000 ||
      progress.current > progress.total
    ) {
      throw invalid('Invalid durable job progress');
    }
    const message = progress.message || null;
    if (message !== null)
      text(message, 'progress message', MAX_SAFE_TEXT_BYTES);
    return this.repository.updateProgress(
      job,
      progress.current,
      progress.total,
      message
    );
  }

  complete(
    job: DurableJobLease,
    resultReference?: string | null
  ): Promise<void> {
    const reference = resultReference || null;
    if (reference) text(reference, 'result reference', MAX_REFERENCE_BYTES);
    return this.repository.complete(job, reference);
  }

  fail(
    job: DurableJobLease,
    options: {
      retryable: boolean;
      errorCode: string;
      errorSummary: string;
      backoffMs: number;
    }
  ): Promise<DurableJobState> {
    if (!SAFE_CODE.test(options.errorCode))
      throw invalid('Invalid durable job error code');
    text(options.errorSummary, 'error summary', MAX_SAFE_TEXT_BYTES);
    if (
      !Number.isSafeInteger(options.backoffMs) ||
      options.backoffMs < 0 ||
      options.backoffMs > 15 * 60_000
    ) {
      throw invalid('Invalid durable job retry backoff');
    }
    return this.repository.fail(
      job,
      options.retryable,
      options.errorCode,
      options.errorSummary,
      this.now() + options.backoffMs
    );
  }

  async abandon(job: DurableJobLease): Promise<DurableJobState> {
    const state = await this.repository.abandon(job);
    if (
      (state === 'cancelled' || state === 'dead_letter') &&
      (job.jobType === RESOURCE_DELETE_JOB_TYPE ||
        job.jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
    ) {
      await this.reconcileDeletionLifecycleJob(job.id);
    }
    return state;
  }

  async cancel(
    id: string,
    actor: string,
    reason: DurableCancellationCode = 'user-requested'
  ): Promise<DurableJobMetadata> {
    text(id, 'ID');
    text(actor, 'actor user ID');
    let cancelled: DurableJobMetadata;
    try {
      cancelled = await this.repository.requestCancellation(id, actor, reason);
    } catch (error) {
      // A queued cancellation can commit while only its acknowledgement is
      // lost. Resolve that exact actor/job before deciding whether lifecycle
      // continuation is required; never turn an unknown outcome into a second
      // mutation against another actor's job.
      let committed: DurableJobMetadata | null = null;
      try {
        committed = await this.repository.getMetadata(id);
      } catch {
        throw error;
      }
      if (
        !committed ||
        committed.actorUserId !== actor ||
        committed.state !== 'cancelled'
      ) {
        throw error;
      }
      cancelled = committed;
    }
    if (
      cancelled.state === 'cancelled' &&
      (cancelled.jobType === RESOURCE_DELETE_JOB_TYPE ||
        cancelled.jobType === OWNER_DELETE_CONTENT_JOB_TYPE)
    ) {
      await this.reconcileDeletionLifecycleJob(cancelled.id);
    }
    return cancelled;
  }

  cancelAllForActor(
    actor: string,
    reason: DurableCancellationCode,
    filter: DurableJobActorFilter = {}
  ): Promise<DurableJobCancellationSummary> {
    text(actor, 'actor user ID');
    this.validateActorFilter(filter);
    return this.repository.requestActorCancellation(actor, reason, filter);
  }

  countActiveForActor(
    actor: string,
    filter: DurableJobActorFilter = {}
  ): Promise<number> {
    text(actor, 'actor user ID');
    this.validateActorFilter(filter);
    return this.repository.countActiveForActor(actor, filter);
  }

  countNonSucceededForActor(
    actor: string,
    filter: DurableJobActorFilter = {}
  ): Promise<number> {
    text(actor, 'actor user ID');
    this.validateActorFilter(filter);
    return this.repository.countNonSucceededForActor(actor, filter);
  }

  private validateActorFilter(filter: DurableJobActorFilter): void {
    if (
      filter.excludeHandledLifecycleJobs !== undefined &&
      typeof filter.excludeHandledLifecycleJobs !== 'boolean'
    ) {
      throw invalid('Invalid durable lifecycle job filter');
    }
    for (const jobType of filter.jobTypes ?? []) text(jobType, 'type');
    for (const jobType of filter.excludeJobTypes ?? []) {
      text(jobType, 'excluded type');
    }
    for (const scope of filter.idempotencyScopes ?? []) {
      text(scope, 'idempotency scope');
    }
    for (const id of filter.excludeJobIds ?? []) text(id, 'ID');
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

  getMetadata(id: string): Promise<DurableJobMetadata | null> {
    text(id, 'ID');
    return this.repository.getMetadata(id);
  }

  getByIdempotency(actor: string, scope: string, key: string) {
    text(actor, 'actor user ID');
    text(scope, 'idempotency scope');
    text(key, 'idempotency key', MAX_REFERENCE_BYTES);
    return this.repository.getByIdempotency(
      actor,
      scope,
      digest(`${actor}\0${scope}\0${key}`)
    );
  }

  listJobs(options: DurableJobListOptions = {}): Promise<DurableJobMetadata[]> {
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw invalid('Durable job list limit must be between 1 and 200');
    }
    return this.repository.listJobs({ ...options, limit });
  }

  listAttempts(id: string): Promise<DurableJobAttemptMetadata[]> {
    text(id, 'ID');
    return this.repository.listAttempts(id);
  }

  private prepareEvent(
    input: DurableJobEventAppendInput
  ): PreparedDurableEventAppend {
    text(input.eventId, 'event ID');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.eventId
      )
    ) {
      throw invalid('Invalid durable job event ID');
    }
    text(input.streamId, 'event stream ID');
    text(input.eventType, 'event type');
    text(input.subjectId, 'event subject ID');
    if (input.actorUserId) text(input.actorUserId, 'event actor user ID');
    const eventId = input.eventId;
    const validated = payload(input.payload);
    const requestFingerprint = digest(
      JSON.stringify([
        input.streamId,
        input.eventType,
        input.subjectId,
        input.actorUserId ?? null,
        validated.mode,
        validated.canonical,
      ])
    );
    const stored: StoredDurablePayload =
      validated.mode === 'reference'
        ? { format: 'reference', data: validated.canonical }
        : {
            format: 'encrypted',
            data: JSON.stringify(
              this.keyring.encrypt(
                Buffer.from(validated.canonical, 'utf8'),
                eventAad(
                  eventId,
                  input.streamId,
                  input.eventType,
                  input.subjectId,
                  input.actorUserId ?? null
                )
              )
            ),
          };
    return {
      eventId,
      requestFingerprint,
      streamId: input.streamId,
      eventType: input.eventType,
      subjectId: input.subjectId,
      actorUserId: input.actorUserId ?? null,
      payload: stored,
      occurredAt: this.now(),
    };
  }

  async appendEvent(input: DurableJobEventAppendInput): Promise<number> {
    return this.repository.appendEventTransaction(this.prepareEvent(input));
  }

  async requestChatCancellation(input: {
    actorUserId: string;
    sessionId: string;
    assistantMessageId: string;
  }): Promise<DurableChatCancellationDecision> {
    text(input.actorUserId, 'chat cancellation actor user ID');
    text(input.sessionId, 'chat cancellation session ID');
    text(input.assistantMessageId, 'chat cancellation message ID');
    const scope = chatGenerationIdempotencyScope(input.sessionId);
    return this.repository.requestChatCancellation({
      actorUserId: input.actorUserId,
      idempotencyScope: scope,
      idempotencyKeyHash: digest(
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

  async publishChatCompletion(
    input: DurableChatCompletionPublishInput
  ): Promise<number> {
    text(input.lease.jobId, 'chat completion job ID');
    text(input.lease.workerId, 'chat completion worker ID');
    if (!Number.isSafeInteger(input.lease.leaseToken)) {
      throw invalid('Invalid durable chat completion lease token');
    }
    text(input.actorUserId, 'chat completion actor user ID');
    text(input.sessionId, 'chat completion session ID');
    text(input.expectedJobType, 'chat completion job type');
    text(input.message.id, 'chat completion message ID');
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
      expectedIdempotencyKeyHash: digest(
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

  async getEvent(eventId: string): Promise<DurableJobEvent | null> {
    text(eventId, 'event ID');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        eventId
      )
    ) {
      throw invalid('Invalid durable job event ID');
    }
    const row = await this.repository.getStoredEvent(eventId);
    return row ? this.decodeEvent(row) : null;
  }

  async latestEventCursor(streamId: string): Promise<number> {
    text(streamId, 'event stream ID');
    return this.repository.latestStoredEventCursor(streamId);
  }

  async replayEvents(
    afterCursor: number,
    options: { limit?: number; streamId?: string; subjectId?: string } = {}
  ): Promise<DurableJobEvent[]> {
    if (!Number.isSafeInteger(afterCursor) || afterCursor < 0)
      throw invalid('Invalid durable event cursor');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      throw invalid('Invalid durable event replay limit');
    if (options.streamId !== undefined)
      text(options.streamId, 'event stream ID');
    if (options.subjectId !== undefined)
      text(options.subjectId, 'event subject ID');
    const rows = await this.repository.replayStoredEvents(afterCursor, limit, {
      streamId: options.streamId,
      subjectId: options.subjectId,
    });
    return rows.map(row => this.decodeEvent(row));
  }

  private decodeEvent(row: StoredDurableEventRow): DurableJobEvent {
    let decoded: unknown;
    if (row.payload_format === 'reference') {
      decoded = { referenceId: row.payload };
    } else {
      let envelope: unknown;
      try {
        envelope = JSON.parse(row.payload);
      } catch {
        throw new DurableJobError(
          'storage-error',
          'Durable event payload envelope is invalid'
        );
      }
      const plaintext = this.keyring.decrypt(
        parseAesGcmEnvelope(envelope),
        eventAad(
          row.event_id,
          row.stream_id,
          row.event_type,
          row.subject_id,
          row.actor_user_id
        )
      );
      try {
        decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
      } finally {
        plaintext.fill(0);
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
      payload: decoded,
      occurredAt: row.occurred_at,
    };
  }
}
