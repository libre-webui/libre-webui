/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import mediaGenerationJobService from '../../services/mediaGenerationJobService.js';
import { notificationService } from '../../services/notificationService.js';
import documentService, {
  DocumentChunkLimitError,
} from '../../services/documentService.js';
import durableChatGenerationService, {
  type DurableChatGenerationInput,
} from '../../services/durableChatGenerationService.js';
import pluginService from '../../services/pluginService.js';
import workAgentService from '../../services/workAgentService.js';
import {
  cleanupPlatformOwnerContent,
  cleanupPlatformResourceContent,
  getPlatformStorageRuntime,
  MAX_VECTOR_RESOURCE_INDEX_ENTRIES,
} from '../storage/index.js';
import { getCoordinator } from '../coordination/service.js';
import {
  combineAbortSignals,
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../coordination/sharedAdmission.js';
import type { CoordinationLease, Coordinator } from '../coordination/types.js';
import { createLogger } from '../../utils/logger.js';
import { DurableJobExecutionError } from './durableJobTypes.js';
import type { DurableJobHandler } from './embeddedDurableJobWorker.js';
import {
  AUTOMATION_RUN_JOB_TYPE,
  CHANNEL_MENTION_JOB_TYPE,
  CHAT_GENERATE_JOB_TYPE,
  WEBHOOK_DELIVER_JOB_TYPE,
  DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
  DOCUMENT_INGEST_JOB_TYPE,
  OWNER_DELETE_CONTENT_JOB_TYPE,
  RESOURCE_DELETE_JOB_TYPE,
  VIDEO_RESUME_IDEMPOTENCY_SCOPE,
  VIDEO_RESUME_JOB_TYPE,
  VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
  VIDEO_SUBMIT_JOB_TYPE,
  WORK_EXECUTE_JOB_TYPE,
} from './domainJobContracts.js';
import { getDurableJobRuntime } from './durableJobRuntime.js';
import type { DurableJobExecutionContext } from './embeddedDurableJobWorker.js';

const handlerLogger = createLogger('platform:job-handlers');

const resourceLeaseTtlMs = (): number => {
  const value = Number.parseInt(
    process.env.RESOURCE_LEASE_TTL_MS ?? '30000',
    10
  );
  if (!Number.isSafeInteger(value) || value < 5_000 || value > 300_000) {
    throw new Error(
      'RESOURCE_LEASE_TTL_MS must be between 5000 and 300000 milliseconds'
    );
  }
  return value;
};

const RESOURCE_LEASE_TTL_MS = resourceLeaseTtlMs();
const RESOURCE_LEASE_OPERATION_TIMEOUT_MS = Math.min(
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  Math.max(1_000, Math.floor(RESOURCE_LEASE_TTL_MS / 3))
);

export interface ResourceLeaseReservation {
  readonly signal: AbortSignal;
  extend(): Promise<boolean>;
  release(): Promise<boolean>;
}

const waitForResourceLeaseOperation = async <T>(
  operation: Promise<T>,
  signal: AbortSignal,
  operationTimeoutMs: number
): Promise<T> => {
  if (signal.aborted) throw signal.reason;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      withCoordinationTimeout(operation, operationTimeoutMs),
      new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(signal.reason);
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener) signal.removeEventListener('abort', abortListener);
  }
};

export const acquireResourceLease = async (
  context: DurableJobExecutionContext,
  resourceType: string,
  resourceId: string,
  coordinator: Coordinator = getCoordinator(),
  operationTimeoutMs = RESOURCE_LEASE_OPERATION_TIMEOUT_MS
): Promise<ResourceLeaseReservation> => {
  await context.assertSideEffectAllowed();
  try {
    let abandoned = false;
    const pendingLease = coordinator.acquireLease(
      `resource:${context.actorUserId}:${resourceType}:${resourceId}`,
      RESOURCE_LEASE_TTL_MS
    );
    void pendingLease
      .then(lease => {
        if (!abandoned || !lease) return;
        void withCoordinationTimeout(lease.release(), operationTimeoutMs).catch(
          () => undefined
        );
      })
      .catch(() => undefined);
    let lease: CoordinationLease | null;
    try {
      lease = await waitForResourceLeaseOperation(
        pendingLease,
        context.signal,
        operationTimeoutMs
      );
    } catch (error) {
      abandoned = true;
      throw error;
    }
    if (!lease) {
      throw new DurableJobExecutionError(
        true,
        'resource-busy',
        'The resource is being changed by another worker'
      );
    }
    let stopped = false;
    let lost = false;
    const lossController = new AbortController();
    let renewal: ReturnType<typeof setTimeout> | undefined;
    const markLost = (): void => {
      if (lost) return;
      lost = true;
      lossController.abort(
        new Error('The resource coordination lease was lost')
      );
    };
    const scheduleRenewal = (): void => {
      if (stopped || lost) return;
      renewal = setTimeout(
        async () => {
          try {
            if (
              !(await waitForResourceLeaseOperation(
                lease.extend(RESOURCE_LEASE_TTL_MS),
                context.signal,
                operationTimeoutMs
              ))
            ) {
              markLost();
            }
          } catch {
            markLost();
          }
          scheduleRenewal();
        },
        Math.max(1_000, Math.floor(RESOURCE_LEASE_TTL_MS / 3))
      );
      renewal.unref?.();
    };
    scheduleRenewal();
    return {
      signal: lossController.signal,
      async extend(): Promise<boolean> {
        if (stopped || lost) return false;
        try {
          const extended = await waitForResourceLeaseOperation(
            lease.extend(RESOURCE_LEASE_TTL_MS),
            context.signal,
            operationTimeoutMs
          );
          if (!extended) markLost();
          return extended;
        } catch {
          markLost();
          return false;
        }
      },
      async release(): Promise<boolean> {
        if (stopped) return false;
        stopped = true;
        if (renewal) clearTimeout(renewal);
        return withCoordinationTimeout(
          lease.release(),
          operationTimeoutMs
        ).catch(() => false);
      },
    };
  } catch (error) {
    if (error instanceof DurableJobExecutionError) throw error;
    throw new DurableJobExecutionError(
      true,
      'coordination-unavailable',
      'Resource coordination is unavailable'
    );
  }
};

const assertResourceLease = async (
  context: DurableJobExecutionContext,
  lease: Awaited<ReturnType<typeof acquireResourceLease>>
): Promise<void> => {
  await context.assertSideEffectAllowed();
  try {
    if (await lease.extend()) return;
  } catch {
    // Report the same safe failure as an expired fencing lease.
  }
  throw new DurableJobExecutionError(
    true,
    'resource-lease-lost',
    'The resource coordination lease was lost'
  );
};

const withResourceLeaseFence = (
  context: DurableJobExecutionContext,
  lease: Awaited<ReturnType<typeof acquireResourceLease>>
): DurableJobExecutionContext => ({
  ...context,
  signal: combineAbortSignals(context.signal, lease.signal),
  assertSideEffectAllowed: async () => {
    await context.assertSideEffectAllowed();
    await assertResourceLease(context, lease);
  },
});

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Cancelled'));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void => finish(signal.reason ?? new Error('Cancelled'));
    timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener('abort', abort, { once: true });
  });

const delayRecoveryDrillFault = async (
  marker: string,
  value: string,
  context: DurableJobExecutionContext
): Promise<void> => {
  if (
    process.env.LIBRE_ENABLE_TEST_FAULT_INJECTION !== 'true' ||
    context.attemptCount !== 1 ||
    !value.includes(marker)
  ) {
    return;
  }
  const delayMs = Number.parseInt(
    process.env.LIBRE_TEST_FAULT_DELAY_MS ?? '60000',
    10
  );
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 300_000) {
    throw new DurableJobExecutionError(
      false,
      'fault-injection-invalid',
      'The recovery-drill fault configuration is invalid'
    );
  }
  await delay(delayMs, context.signal);
};

const readVideoPayload = (value: unknown): { legacyJobId: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The media job payload is invalid'
    );
  }
  const legacyJobId = (value as Record<string, unknown>).legacyJobId;
  if (typeof legacyJobId !== 'string' || !legacyJobId.trim()) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The media job payload is invalid'
    );
  }
  return { legacyJobId };
};

const readResourceDeletePayload = (
  value: unknown
): {
  resourceType: 'document' | 'generated-media' | 'persona';
  resourceId: string;
  deletionIncarnation: number;
  deletionToken: string;
} => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The resource deletion payload is invalid'
    );
  }
  const record = value as Record<string, unknown>;
  const resourceType = record.resourceType;
  const resourceId = record.resourceId;
  const deletionIncarnation = record.deletionIncarnation;
  const deletionToken = record.deletionToken;
  if (
    !['document', 'generated-media', 'persona'].includes(
      String(resourceType)
    ) ||
    typeof resourceId !== 'string' ||
    !resourceId.trim() ||
    !Number.isSafeInteger(deletionIncarnation) ||
    Number(deletionIncarnation) <= 0 ||
    typeof deletionToken !== 'string' ||
    !/^[0-9a-f]{64}$/.test(deletionToken)
  ) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The resource deletion payload is invalid'
    );
  }
  return {
    resourceType: resourceType as 'document' | 'generated-media' | 'persona',
    resourceId,
    deletionIncarnation: Number(deletionIncarnation),
    deletionToken,
  };
};

const readWorkPayload = (value: unknown): { taskId: string; runId: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The Work execution payload is invalid'
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.taskId !== 'string' ||
    !record.taskId.trim() ||
    typeof record.runId !== 'string' ||
    !record.runId.trim()
  ) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The Work execution payload is invalid'
    );
  }
  return { taskId: record.taskId, runId: record.runId };
};

const readDocumentPayload = (value: unknown): { documentId: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The document ingestion payload is invalid'
    );
  }
  const documentId = (value as Record<string, unknown>).documentId;
  if (typeof documentId !== 'string' || !documentId.trim()) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The document ingestion payload is invalid'
    );
  }
  return { documentId };
};

const readOwnerDeletePayload = (
  value: unknown
): { targetUserId: string; actorUserId: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The owner cleanup payload is invalid'
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.targetUserId !== 'string' ||
    !record.targetUserId.trim() ||
    typeof record.actorUserId !== 'string' ||
    !record.actorUserId.trim()
  ) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The owner cleanup payload is invalid'
    );
  }
  return {
    targetUserId: record.targetUserId,
    actorUserId: record.actorUserId,
  };
};

const readChatPayload = (value: unknown): DurableChatGenerationInput => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The chat generation payload is invalid'
    );
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    'sessionId',
    'actorUserId',
    'userMessageId',
    'assistantMessageId',
  ] as const) {
    if (typeof record[field] !== 'string' || !record[field].trim()) {
      throw new DurableJobExecutionError(
        false,
        'payload-invalid',
        'The chat generation payload is invalid'
      );
    }
  }
  if (
    typeof record.message !== 'string' ||
    (!record.message.trim() && record.hasImages !== true) ||
    typeof record.hasImages !== 'boolean' ||
    !record.options ||
    typeof record.options !== 'object' ||
    Array.isArray(record.options) ||
    typeof record.webSearch !== 'boolean' ||
    (record.tools !== undefined && typeof record.tools !== 'boolean') ||
    (record.toolSelection !== undefined &&
      (typeof record.toolSelection !== 'object' ||
        record.toolSelection === null ||
        Array.isArray(record.toolSelection))) ||
    (record.regenerate !== undefined &&
      typeof record.regenerate !== 'boolean') ||
    (record.regenerate === true &&
      (typeof record.originalMessageId !== 'string' ||
        !record.originalMessageId.trim())) ||
    (record.compare !== undefined && typeof record.compare !== 'boolean') ||
    (record.modelOverride !== undefined &&
      (typeof record.modelOverride !== 'object' ||
        record.modelOverride === null ||
        Array.isArray(record.modelOverride) ||
        typeof (record.modelOverride as Record<string, unknown>).model !==
          'string' ||
        !(
          (record.modelOverride as Record<string, unknown>).model as string
        ).trim()))
  ) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The chat generation payload is invalid'
    );
  }
  return {
    ...(record as unknown as DurableChatGenerationInput),
    regenerate: record.regenerate === true,
    tools: record.tools === true,
  };
};

const submitVideo: DurableJobHandler = async context => {
  const { legacyJobId } = readVideoPayload(context.payload);
  const job = await mediaGenerationJobService.get(
    legacyJobId,
    context.actorUserId
  );
  if (!job) {
    throw new DurableJobExecutionError(
      false,
      'media-job-missing',
      'The media job no longer exists'
    );
  }
  let providerJobId = job.providerJobId;
  if (providerJobId === 'libre:prepared') {
    await context.assertSideEffectAllowed();
    try {
      const submitted = await pluginService.submitVideoGenRequest(
        job.model,
        job.prompt,
        {
          pluginId: job.pluginId,
          userId: context.actorUserId,
          ...job.options,
          idempotencyKey: job.id,
          requireIdempotency: process.env.LIBRE_PLATFORM_MODE === 'team',
          signal: context.signal,
        }
      );
      providerJobId = submitted.providerJobId;
      // Test-only exact fault window: provider accepted the stable idempotency
      // key, but the reconciled handle has not committed yet.
      await delayRecoveryDrillFault(
        'LIBRE_VIDEO_POST_SUBMIT_KILL',
        job.prompt,
        context
      );
    } catch {
      throw new DurableJobExecutionError(
        true,
        'provider-submit-failed',
        'The media provider did not accept the submission'
      );
    }
  }
  await context.assertSideEffectAllowed();
  await mediaGenerationJobService.acceptSubmittedProviderJob(
    job.id,
    context.actorUserId,
    providerJobId
  );
  return { resultReference: `media-job:${job.id}:submitted` };
};

const resumeVideo: DurableJobHandler = async context => {
  const { legacyJobId } = readVideoPayload(context.payload);
  let pollCount = 0;
  for (;;) {
    if (context.signal.aborted) throw context.signal.reason;
    const job = await mediaGenerationJobService.get(
      legacyJobId,
      context.actorUserId
    );
    if (!job) {
      throw new DurableJobExecutionError(
        false,
        'media-job-missing',
        'The media job no longer exists'
      );
    }
    if (job.status === 'completed') {
      return {
        resultReference: job.galleryId ? `gallery:${job.galleryId}` : null,
      };
    }
    if (job.status === 'failed') {
      throw new DurableJobExecutionError(
        false,
        'provider-job-failed',
        'The media provider reported failure'
      );
    }
    await context.assertSideEffectAllowed();
    let status: Awaited<ReturnType<typeof pluginService.pollVideoGenRequest>>;
    try {
      status = await pluginService.pollVideoGenRequest(
        job.model,
        job.providerJobId,
        job.pluginId,
        context.actorUserId,
        context.signal
      );
    } catch {
      throw new DurableJobExecutionError(
        true,
        'provider-poll-failed',
        'The media provider could not be reached'
      );
    }
    pollCount += 1;
    await context.reportProgress({
      current: Math.min(95, pollCount),
      total: 100,
      message: 'Waiting for the media provider',
    });
    if (status.status === 'failed') {
      await mediaGenerationJobService.update(
        job.id,
        context.actorUserId,
        'failed',
        {
          error: 'Video provider reported failure',
        }
      );
      // Best effort: a notification failure must not mask the job outcome.
      try {
        await notificationService.publish({
          userId: context.actorUserId,
          type: 'media-failed',
          title: `Video generation failed (${job.model})`,
          href: '/gallery',
          sourceKey: `media-job-failed:${job.id}`,
        });
      } catch {
        // Ignored by contract.
      }
      throw new DurableJobExecutionError(
        false,
        'provider-job-failed',
        'The media provider reported failure'
      );
    }
    if (status.status !== 'completed') {
      await mediaGenerationJobService.update(
        job.id,
        context.actorUserId,
        status.status
      );
      await delay(5_000, context.signal);
      continue;
    }
    await context.assertSideEffectAllowed();
    let downloaded: Awaited<
      ReturnType<typeof pluginService.downloadVideoGenResult>
    >;
    try {
      downloaded = await pluginService.downloadVideoGenResult(
        job.model,
        job.providerJobId,
        job.pluginId,
        context.actorUserId,
        context.signal
      );
    } catch {
      throw new DurableJobExecutionError(
        true,
        'provider-download-failed',
        'The completed media result could not be downloaded'
      );
    }
    await context.assertSideEffectAllowed();
    const media = await mediaGenerationJobService.completeWithMedia(
      job.id,
      context.actorUserId,
      {
        mimeType: downloaded.mimeType,
        mediaData: `data:${downloaded.mimeType};base64,${downloaded.video.toString('base64')}`,
        metadata: { ...job.options, usage: status.usage || null },
      },
      {
        attemptCount: context.attemptCount,
        signal: context.signal,
      }
    );
    await context.reportProgress({
      current: 100,
      total: 100,
      message: 'Media saved',
    });
    // Best effort: the saved media is authoritative even if notifying fails.
    try {
      await notificationService.publish({
        userId: context.actorUserId,
        type: 'media-ready',
        title: `Video ready (${job.model})`,
        href: '/gallery',
        sourceKey: `media-job-ready:${job.id}`,
      });
    } catch {
      // Ignored by contract.
    }
    return { resultReference: `gallery:${media.id}` };
  }
};

const withVideoResourceLease =
  (handler: DurableJobHandler): DurableJobHandler =>
  async context => {
    const { legacyJobId } = readVideoPayload(context.payload);
    const lease = await acquireResourceLease(
      context,
      'generated-media',
      legacyJobId
    );
    try {
      return await handler(withResourceLeaseFence(context, lease));
    } finally {
      await lease.release().catch(() => false);
    }
  };

const deleteResource: DurableJobHandler = async context => {
  const { resourceType, resourceId, deletionIncarnation, deletionToken } =
    readResourceDeletePayload(context.payload);
  const deletion = {
    resourceType,
    resourceId,
    ownerUserId: context.actorUserId,
    deletionIncarnation,
    deletionToken,
  };
  const lease = await acquireResourceLease(context, resourceType, resourceId);
  try {
    if (
      !(await getPlatformStorageRuntime().domains.resourceDeletions.isCleanupAuthorized(
        deletion
      ))
    ) {
      return { resultReference: `${resourceType}:${resourceId}:superseded` };
    }
    if (resourceType === 'document') {
      const service = getDurableJobRuntime().service;
      const ingestion = await service.getByIdempotency(
        context.actorUserId,
        DOCUMENT_INGEST_IDEMPOTENCY_SCOPE,
        resourceId
      );
      if (ingestion?.state === 'queued' || ingestion?.state === 'running') {
        const cancelled = await service.cancel(
          ingestion.id,
          context.actorUserId,
          'superseded'
        );
        if (cancelled.state === 'running') {
          throw new DurableJobExecutionError(
            true,
            'resource-work-draining',
            'Queued resource work is still stopping'
          );
        }
      }
    } else if (resourceType === 'generated-media') {
      const service = getDurableJobRuntime().service;
      for (const scope of [
        VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
        VIDEO_RESUME_IDEMPOTENCY_SCOPE,
      ]) {
        const mediaJob = await service.getByIdempotency(
          context.actorUserId,
          scope,
          resourceId
        );
        if (mediaJob?.state === 'queued' || mediaJob?.state === 'running') {
          const cancelled = await service.cancel(
            mediaJob.id,
            context.actorUserId,
            'superseded'
          );
          if (cancelled.state === 'running') {
            throw new DurableJobExecutionError(
              true,
              'resource-work-draining',
              'Queued resource work is still stopping'
            );
          }
        }
      }
    }
    await assertResourceLease(context, lease);
    if (
      !(await getPlatformStorageRuntime().domains.resourceDeletions.isCleanupAuthorized(
        deletion
      ))
    ) {
      return { resultReference: `${resourceType}:${resourceId}:superseded` };
    }
    await context.reportProgress({
      current: 1,
      total: 3,
      message: 'Removing indexed content',
    });
    try {
      const cleanup =
        await getPlatformStorageRuntime().domains.resourceDeletions.withAuthorizedCleanup(
          deletion,
          () =>
            cleanupPlatformResourceContent({
              resourceType,
              resourceId,
              ownerUserId: context.actorUserId,
            })
        );
      if (!cleanup.authorized) {
        return { resultReference: `${resourceType}:${resourceId}:superseded` };
      }
    } catch {
      throw new DurableJobExecutionError(
        true,
        'resource-cleanup-failed',
        'Resource content cleanup could not be completed'
      );
    }
    await assertResourceLease(context, lease);
    await context.reportProgress({
      current: 2,
      total: 3,
      message: 'Invalidating shared cache',
    });
    try {
      await getCoordinator().deleteCache(
        `resource:${context.actorUserId}:${resourceType}:${resourceId}`
      );
    } catch {
      throw new DurableJobExecutionError(
        true,
        'cache-invalidation-failed',
        'Resource cache invalidation could not be completed'
      );
    }
    if (
      !(await getPlatformStorageRuntime().domains.resourceDeletions.markCleanupCompleted(
        deletion
      ))
    ) {
      throw new DurableJobExecutionError(
        true,
        'resource-tombstone-lost',
        'Resource deletion state could not be finalized'
      );
    }
    await context.reportProgress({
      current: 3,
      total: 3,
      message: 'Resource cleanup completed',
    });
    return { resultReference: `${resourceType}:${resourceId}:deleted` };
  } finally {
    await lease.release().catch(() => false);
  }
};

const ingestDocument: DurableJobHandler = async context => {
  const { documentId } = readDocumentPayload(context.payload);
  const lease = await acquireResourceLease(context, 'document', documentId);
  const leasedContext = withResourceLeaseFence(context, lease);
  try {
    await context.reportProgress({
      current: 1,
      total: 3,
      message: 'Extracting document content',
    });
    let result: Awaited<ReturnType<typeof documentService.reprocessDocument>>;
    try {
      result = await documentService.reprocessDocument(
        documentId,
        context.actorUserId,
        leasedContext.signal,
        leasedContext.assertSideEffectAllowed,
        context.attemptCount
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (error instanceof DocumentChunkLimitError) {
        throw new DurableJobExecutionError(
          false,
          'document-chunk-limit',
          `The document exceeds the ${MAX_VECTOR_RESOURCE_INDEX_ENTRIES}-chunk indexing limit; increase the embedding chunk size or remove excessive paragraph breaks`
        );
      }
      throw new DurableJobExecutionError(
        true,
        'document-ingestion-failed',
        'Document extraction or embedding did not complete'
      );
    }
    await context.reportProgress({
      current: 3,
      total: 3,
      message: 'Document indexed',
    });
    return {
      resultReference: `document:${documentId}:chunks:${result.chunks}`,
    };
  } finally {
    await lease.release().catch(() => false);
  }
};

const generateChat: DurableJobHandler = async context => {
  const input = readChatPayload(context.payload);
  if (input.actorUserId !== context.actorUserId) {
    throw new DurableJobExecutionError(
      false,
      'actor-mismatch',
      'The chat generation actor does not match its durable job'
    );
  }
  await context.reportProgress({
    current: 1,
    total: 2,
    message: 'Generating chat response',
  });
  try {
    await durableChatGenerationService.execute(input, context);
  } catch (error) {
    if (error instanceof DurableJobExecutionError || context.signal.aborted) {
      throw error;
    }
    // The stored job record keeps only a sanitized summary; without this line
    // the real failure is unrecoverable from any log or table.
    handlerLogger.error(
      `Chat generation ${input.assistantMessageId} failed:`,
      error
    );
    throw new DurableJobExecutionError(
      true,
      'chat-generation-failed',
      'The chat response could not be completed'
    );
  }
  await context.reportProgress({
    current: 2,
    total: 2,
    message: 'Chat response saved',
  });
  return { resultReference: `chat-message:${input.assistantMessageId}` };
};

const deleteOwnerContent: DurableJobHandler = async context => {
  const { targetUserId, actorUserId } = readOwnerDeletePayload(context.payload);
  if (actorUserId !== context.actorUserId) {
    throw new DurableJobExecutionError(
      false,
      'actor-mismatch',
      'The owner cleanup actor does not match its durable job'
    );
  }
  const lease = await acquireResourceLease(context, 'owner', targetUserId);
  const leasedContext = withResourceLeaseFence(context, lease);
  try {
    await leasedContext.assertSideEffectAllowed();
    const service = getDurableJobRuntime().service;
    await service.cancelAllForActor(targetUserId, 'actor-revoked');
    const activeJobCount = await service.countActiveForActor(targetUserId);
    if (activeJobCount > 0) {
      throw new DurableJobExecutionError(
        true,
        'owner-jobs-draining',
        'Deleted owner jobs are still draining'
      );
    }
    await leasedContext.assertSideEffectAllowed();
    const result = await cleanupPlatformOwnerContent(targetUserId);
    await leasedContext.assertSideEffectAllowed();
    // Security principals: group memberships and grants naming this user
    // (rows owned by the user are removed by foreign-key cascade).
    {
      const { removeUserFromSecurityPrincipals } =
        await import('../../services/groupService.js');
      await removeUserFromSecurityPrincipals(targetUserId);
    }
    await leasedContext.assertSideEffectAllowed();
    await getCoordinator().deleteCache(`user:${targetUserId}`);
    await leasedContext.assertSideEffectAllowed();
    await getCoordinator().revoke(`user:${targetUserId}`);
    return {
      resultReference:
        `owner:${targetUserId}:vectors:${result.deletedVectors}:` +
        `blobs:${result.deletedBlobs}`,
    };
  } catch (error) {
    if (error instanceof DurableJobExecutionError) throw error;
    throw new DurableJobExecutionError(
      true,
      'owner-cleanup-failed',
      'Deleted owner content cleanup did not complete'
    );
  } finally {
    await lease.release().catch(() => false);
  }
};

const readAutomationPayload = (
  value: unknown
): { runId: string; automationId: string } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The automation run payload is invalid'
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.runId !== 'string' ||
    !record.runId.trim() ||
    typeof record.automationId !== 'string' ||
    !record.automationId.trim()
  ) {
    throw new DurableJobExecutionError(
      false,
      'payload-invalid',
      'The automation run payload is invalid'
    );
  }
  return { runId: record.runId, automationId: record.automationId };
};

const runAutomation: DurableJobHandler = async context => {
  const { runId, automationId } = readAutomationPayload(context.payload);
  const automationModule = await import('../../services/automationService.js');
  const automationService = automationModule.default;
  const { decodeProvider } = automationModule;
  const run = await automationService.getRunRecord(runId, context.actorUserId);
  // The run row is authoritative; a deleted automation cascades its runs
  // away and a finished run must never execute twice.
  if (!run || (run.status !== 'queued' && run.status !== 'running')) {
    return { resultReference: `automation-run:${runId}:skipped` };
  }
  const automation = await automationService.getAutomationRecord(automationId);
  if (!automation || automation.userId !== context.actorUserId) {
    await automationService.finalizeRun(runId, 'failed', 'automation-missing');
    return { resultReference: `automation-run:${runId}:missing` };
  }
  await context.assertSideEffectAllowed();
  await context.reportProgress({
    current: 1,
    total: 2,
    message: 'Preparing automation chat session',
  });

  const { default: chatService } =
    await import('../../services/chatService.js');
  // Message identities derive from the run so a retried attempt re-lands on
  // the identical durable chat job instead of enqueueing a duplicate.
  const userMessageId = `${runId}-user`;
  const assistantMessageId = `${runId}-assistant`;
  let sessionId = run.session_id;
  try {
    if (!sessionId) {
      let model = automation.model;
      let provider = decodeProvider(automation.provider ?? null);
      if (!model) {
        // Auto: fall back to the owner's default chat model.
        const { default: preferencesService } =
          await import('../../services/preferencesService.js');
        const preferences = await preferencesService.getPreferences(
          context.actorUserId
        );
        model = preferences.defaultModel;
        provider = {
          providerType: preferences.defaultProviderType ?? undefined,
          providerId: preferences.defaultProviderId ?? undefined,
        };
      }
      if (!model) {
        await automationService.finalizeRun(runId, 'failed', 'no-model', {
          userId: context.actorUserId,
          automationId,
        });
        return { resultReference: `automation-run:${runId}:no-model` };
      }
      const title = `${automation.name} — ${new Date(
        run.scheduled_for
      ).toLocaleDateString()}`;
      const session = await chatService.createSession(
        model,
        title,
        context.actorUserId,
        undefined,
        provider.providerType
          ? {
              providerType: provider.providerType as
                'ollama' | 'plugin' | 'agent',
              providerId: provider.providerId,
            }
          : undefined
      );
      sessionId = session.id;
      await automationService.markRunStarted(
        runId,
        sessionId,
        assistantMessageId
      );
    }
    await context.assertSideEffectAllowed();
    const queued = await chatService.queueDurableGeneration({
      sessionId,
      userId: context.actorUserId,
      userMessageId,
      assistantMessageId,
      message: automation.instructions,
      // Scheduled runs have no per-message toggle, so always request web
      // search; the generation pipeline only honors it when search is
      // available and the owner is authorized.
      webSearch: true,
    });
    if (!queued) {
      throw new Error('The automation chat session is no longer available');
    }
  } catch (error) {
    if (error instanceof DurableJobExecutionError || context.signal.aborted) {
      throw error;
    }
    handlerLogger.error(`Automation run ${runId} failed:`, error);
    throw new DurableJobExecutionError(
      true,
      'automation-run-failed',
      'The automation run could not start its chat generation'
    );
  }
  await context.reportProgress({
    current: 2,
    total: 2,
    message: 'Automation chat generation queued',
  });
  return { resultReference: `automation-run:${runId}:session:${sessionId}` };
};

const executeWork: DurableJobHandler = async context => {
  const { taskId, runId } = readWorkPayload(context.payload);
  await context.assertSideEffectAllowed();
  await context.reportProgress({
    current: 1,
    total: 2,
    message: 'Running isolated Work task',
  });
  try {
    await workAgentService.executeDurable(taskId, runId, context.actorUserId);
  } catch (error) {
    if (error instanceof DurableJobExecutionError) throw error;
    throw new DurableJobExecutionError(
      true,
      'work-execution-interrupted',
      'The isolated Work execution was interrupted'
    );
  }
  await context.reportProgress({
    current: 2,
    total: 2,
    message: 'Work execution settled',
  });
  return { resultReference: `work-run:${runId}` };
};

const readChannelMentionPayload = (
  payload: unknown
): {
  channelId: string;
  promptMessageId: string;
  replyMessageId: string;
  model: string;
  providerType?: string;
  providerId?: string;
} => {
  const record = payload as Record<string, unknown>;
  for (const field of [
    'channelId',
    'promptMessageId',
    'replyMessageId',
    'model',
  ]) {
    if (typeof record?.[field] !== 'string' || !record[field]) {
      throw new DurableJobExecutionError(
        false,
        'invalid-payload',
        'The channel mention payload is malformed'
      );
    }
  }
  return {
    channelId: record.channelId as string,
    promptMessageId: record.promptMessageId as string,
    replyMessageId: record.replyMessageId as string,
    model: record.model as string,
    ...(typeof record.providerType === 'string'
      ? { providerType: record.providerType }
      : {}),
    ...(typeof record.providerId === 'string'
      ? { providerId: record.providerId }
      : {}),
  };
};

/**
 * @model in a channel (CHANNEL-03): a one-shot completion executed with
 * the invoking user's credentials, model access, and provider routing —
 * never another member's. The pending reply row is authoritative; a
 * deleted reply skips generation, and failures surface on the reply
 * instead of dead-lettering silently.
 */
const runChannelMention: DurableJobHandler = async context => {
  const payload = readChannelMentionPayload(context.payload);
  const { channelService } = await import('../../services/channelService.js');
  const reply = await channelService.findMessage(payload.replyMessageId);
  if (!reply || reply.deleted_at !== null) {
    return {
      resultReference: `channel-mention:${payload.replyMessageId}:gone`,
    };
  }
  // Membership is the authority to speak in this channel; recheck it under
  // the job's identity so a removed member cannot leave a queued mention
  // running with stale access.
  try {
    await channelService.requireMember(payload.channelId, context.actorUserId);
  } catch {
    await channelService.failModelReply(
      payload.replyMessageId,
      'The requester is no longer a member of this channel'
    );
    return {
      resultReference: `channel-mention:${payload.replyMessageId}:denied`,
    };
  }
  try {
    const chatGenerationService = (
      await import('../../services/chatGenerationService.js')
    ).default;
    const conversation = await channelService.mentionContext(
      payload.channelId,
      payload.promptMessageId
    );
    const transcript = conversation
      .map(entry => `${entry.author}: ${entry.content}`)
      .join('\n');
    const system =
      'You are an assistant participating in a team channel. Reply to the ' +
      'latest message using the conversation for context. Be direct and ' +
      'concise; do not prefix your reply with your own name.';
    const now = Date.now();
    const pluginMessages = [
      {
        id: `${payload.replyMessageId}-system`,
        role: 'system' as const,
        content: system,
        timestamp: now,
      },
      {
        id: `${payload.replyMessageId}-prompt`,
        role: 'user' as const,
        content: transcript,
        timestamp: now,
      },
    ];
    const target = await chatGenerationService.prepareGenerationTarget(
      payload.model,
      context.actorUserId,
      {},
      payload.providerType
        ? ({
            providerType: payload.providerType,
            ...(payload.providerId ? { providerId: payload.providerId } : {}),
          } as never)
        : undefined,
      context.signal
    );
    await context.assertSideEffectAllowed();
    const result = await chatGenerationService.executeNonStreaming({
      target,
      ollamaMessages: pluginMessages.map(message => ({
        role: message.role,
        content: message.content,
      })),
      pluginMessages,
      userId: context.actorUserId,
      signal: context.signal,
    });
    await context.assertSideEffectAllowed();
    await channelService.completeModelReply(
      payload.replyMessageId,
      result.assistantContent.trim() || 'The model returned an empty reply.'
    );
    return { resultReference: `channel-mention:${payload.replyMessageId}` };
  } catch (error) {
    if (error instanceof DurableJobExecutionError) throw error;
    const summary =
      error instanceof Error && error.message
        ? error.message.slice(0, 300)
        : 'The model request failed';
    await channelService
      .failModelReply(payload.replyMessageId, summary)
      .catch(() => undefined);
    if (context.signal.aborted) throw error;
    throw new DurableJobExecutionError(true, 'channel-mention-failed', summary);
  }
};

const readWebhookPayload = (
  payload: unknown
): { targetId: string; event: Record<string, unknown> } => {
  const record = payload as Record<string, unknown>;
  if (
    typeof record?.targetId !== 'string' ||
    !record.targetId ||
    typeof record.event !== 'object' ||
    record.event === null
  ) {
    throw new DurableJobExecutionError(
      false,
      'invalid-payload',
      'The webhook delivery payload is malformed'
    );
  }
  return {
    targetId: record.targetId,
    event: record.event as Record<string, unknown>,
  };
};

/**
 * Signed webhook delivery (NOTIFY-01). The envelope is already redacted
 * when it is enqueued; this handler only signs and posts it through the
 * tool-server egress guard, retrying transient failures with the job
 * system's bounded backoff.
 */
const deliverWebhook: DurableJobHandler = async context => {
  const { targetId, event } = readWebhookPayload(context.payload);
  const { notificationService } =
    await import('../../services/notificationService.js');
  await context.assertSideEffectAllowed();
  try {
    const result = await notificationService.deliverWebhook(
      targetId,
      event,
      context.signal
    );
    if (!result.delivered && result.status !== undefined) {
      // 4xx responses are the receiver's verdict; only 5xx retries.
      if (result.status >= 500) {
        throw new DurableJobExecutionError(
          true,
          'webhook-upstream-error',
          `The webhook endpoint responded ${result.status}`
        );
      }
      return { resultReference: `webhook:${targetId}:${result.status}` };
    }
    return { resultReference: `webhook:${targetId}:delivered` };
  } catch (error) {
    if (error instanceof DurableJobExecutionError) throw error;
    if (context.signal.aborted) throw error;
    throw new DurableJobExecutionError(
      true,
      'webhook-delivery-failed',
      'The webhook could not be delivered'
    );
  }
};

export const createDomainDurableJobHandlers = (): ReadonlyMap<
  string,
  DurableJobHandler
> =>
  new Map([
    [VIDEO_SUBMIT_JOB_TYPE, withVideoResourceLease(submitVideo)],
    [VIDEO_RESUME_JOB_TYPE, withVideoResourceLease(resumeVideo)],
    [CHAT_GENERATE_JOB_TYPE, generateChat],
    [DOCUMENT_INGEST_JOB_TYPE, ingestDocument],
    [OWNER_DELETE_CONTENT_JOB_TYPE, deleteOwnerContent],
    [RESOURCE_DELETE_JOB_TYPE, deleteResource],
    [WORK_EXECUTE_JOB_TYPE, executeWork],
    [AUTOMATION_RUN_JOB_TYPE, runAutomation],
    [CHANNEL_MENTION_JOB_TYPE, runChannelMention],
    [WEBHOOK_DELIVER_JOB_TYPE, deliverWebhook],
  ]);
