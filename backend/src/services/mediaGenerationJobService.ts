/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'node:crypto';
import { getPlatformStorageRuntime } from '../platform/storage/index.js';
import type { MediaGenerationStatus } from '../platform/storage/platformDomainRepositories.js';
import type { GeneratedMedia } from '../types/index.js';
import galleryService from './galleryService.js';
import {
  transactionalVideoResumeEnqueuer,
  transactionalVideoSubmissionEnqueuer,
} from '../platform/jobs/videoGenerationEnqueuer.js';
import {
  VIDEO_RESUME_IDEMPOTENCY_SCOPE,
  VIDEO_RESUME_JOB_TYPE,
  VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
  VIDEO_SUBMIT_JOB_TYPE,
} from '../platform/jobs/domainJobContracts.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';

const MEDIA_POST_SAVE_FAULT_MARKER = 'LIBRE_MEDIA_POST_SAVE_KILL';
export const PREPARED_VIDEO_PROVIDER_JOB_ID = 'libre:prepared';

const delayAfterMediaSaveForRecoveryDrill = async (
  prompt: string,
  attemptCount: number | undefined,
  signal?: AbortSignal
): Promise<void> => {
  if (
    process.env.LIBRE_ENABLE_TEST_FAULT_INJECTION !== 'true' ||
    attemptCount !== 1 ||
    !prompt.includes(MEDIA_POST_SAVE_FAULT_MARKER)
  ) {
    return;
  }
  const delayMs = Number.parseInt(
    process.env.LIBRE_TEST_FAULT_DELAY_MS ?? '60000',
    10
  );
  if (!Number.isSafeInteger(delayMs) || delayMs < 1 || delayMs > 300_000) {
    throw new Error('Invalid recovery-drill fault delay');
  }
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Media generation was cancelled'));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const abort = (): void =>
      finish(signal?.reason ?? new Error('Media generation was cancelled'));
    timer = setTimeout(finish, delayMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
  });
};

export interface MediaGenerationJob {
  id: string;
  userId: string;
  providerJobId: string;
  pluginId: string;
  model: string;
  prompt: string;
  status: MediaGenerationStatus;
  options: Record<string, unknown>;
  galleryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

class MediaGenerationJobService {
  async queueVideoSubmission(
    userId: string,
    input: Omit<
      MediaGenerationJob,
      'id' | 'userId' | 'providerJobId' | 'status' | 'createdAt' | 'updatedAt'
    >
  ): Promise<MediaGenerationJob> {
    const id = randomUUID();
    const now = Date.now();
    const repository = getPlatformStorageRuntime().domains.mediaJobs;
    await repository.deleteTerminalBefore(now - 30 * 24 * 60 * 60 * 1000);
    const record: MediaGenerationJob = {
      id,
      userId,
      providerJobId: PREPARED_VIDEO_PROVIDER_JOB_ID,
      pluginId: input.pluginId,
      model: input.model,
      prompt: input.prompt,
      status: 'pending',
      options: input.options || {},
      createdAt: now,
      updatedAt: now,
    };
    try {
      await repository.createPreparedAndEnqueue(
        record,
        transactionalVideoSubmissionEnqueuer
      );
    } catch (error) {
      let committed: MediaGenerationJob | undefined;
      let durable: { jobType: string; actorUserId: string } | undefined;
      try {
        committed = await repository.findByOwner(id, userId);
        durable =
          (await getDurableJobRuntime().service.getByIdempotency(
            userId,
            VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
            id
          )) ?? undefined;
      } catch {
        throw new Error(
          'Video submission publication outcome is ambiguous; reconciliation is required'
        );
      }
      const exact =
        committed?.id === record.id &&
        committed.userId === record.userId &&
        committed.providerJobId === PREPARED_VIDEO_PROVIDER_JOB_ID &&
        committed.pluginId === record.pluginId &&
        committed.model === record.model &&
        committed.prompt === record.prompt &&
        JSON.stringify(committed.options) === JSON.stringify(record.options) &&
        committed.createdAt === record.createdAt &&
        durable?.jobType === VIDEO_SUBMIT_JOB_TYPE &&
        durable.actorUserId === userId;
      if (!exact) {
        if (!committed && !durable) throw error;
        throw new Error(
          'Video submission publication conflicts with authoritative state; reconciliation is required'
        );
      }
    }
    return record;
  }

  async acceptSubmittedProviderJob(
    jobId: string,
    userId: string,
    providerJobId: string
  ): Promise<void> {
    if (!providerJobId.trim()) throw new Error('Provider job ID is required');
    const repository = getPlatformStorageRuntime().domains.mediaJobs;
    let accepted: boolean;
    try {
      accepted = await repository.acceptProviderAndEnqueueResume(
        jobId,
        userId,
        providerJobId,
        Date.now(),
        PREPARED_VIDEO_PROVIDER_JOB_ID,
        transactionalVideoResumeEnqueuer
      );
    } catch (error) {
      let committed: MediaGenerationJob | undefined;
      let durable: { jobType: string; actorUserId: string } | undefined;
      try {
        committed = await repository.findByOwner(jobId, userId);
        durable =
          (await getDurableJobRuntime().service.getByIdempotency(
            userId,
            VIDEO_RESUME_IDEMPOTENCY_SCOPE,
            jobId
          )) ?? undefined;
      } catch {
        throw new Error(
          'Video provider acceptance outcome is ambiguous; reconciliation is required'
        );
      }
      if (
        committed?.providerJobId === providerJobId &&
        durable?.jobType === VIDEO_RESUME_JOB_TYPE &&
        durable.actorUserId === userId
      ) {
        return;
      }
      if (
        committed?.providerJobId === PREPARED_VIDEO_PROVIDER_JOB_ID &&
        !durable
      ) {
        throw error;
      }
      throw new Error(
        'Video provider acceptance conflicts with authoritative state; reconciliation is required'
      );
    }
    if (!accepted) throw new Error('Media generation job is unavailable');
  }

  async create(
    userId: string,
    input: Omit<
      MediaGenerationJob,
      'id' | 'userId' | 'status' | 'createdAt' | 'updatedAt'
    >
  ): Promise<MediaGenerationJob> {
    const id = randomUUID();
    const now = Date.now();
    const repository = getPlatformStorageRuntime().domains.mediaJobs;
    await repository.deleteTerminalBefore(now - 30 * 24 * 60 * 60 * 1000);
    const record: MediaGenerationJob = {
      id,
      userId,
      providerJobId: input.providerJobId,
      pluginId: input.pluginId,
      model: input.model,
      prompt: input.prompt,
      status: 'pending',
      options: input.options || {},
      createdAt: now,
      updatedAt: now,
    };
    await repository.create(record);
    return record;
  }

  async get(id: string, userId: string): Promise<MediaGenerationJob | null> {
    return (
      (await getPlatformStorageRuntime().domains.mediaJobs.findByOwner(
        id,
        userId
      )) || null
    );
  }

  async list(
    userId: string,
    options: { limit?: number; activeOnly?: boolean } = {}
  ): Promise<MediaGenerationJob[]> {
    return getPlatformStorageRuntime().domains.mediaJobs.listByOwner(userId, {
      limit: Math.min(Math.max(options.limit ?? 20, 1), 100),
      activeOnly: options.activeOnly === true,
    });
  }

  async remove(id: string, userId: string): Promise<boolean> {
    return getPlatformStorageRuntime().domains.mediaJobs.deleteByOwner(
      id,
      userId
    );
  }

  async update(
    id: string,
    userId: string,
    status: MediaGenerationStatus,
    fields: { galleryId?: string; error?: string } = {}
  ): Promise<void> {
    const updated =
      await getPlatformStorageRuntime().domains.mediaJobs.updateStatus(
        id,
        userId,
        status,
        fields,
        Date.now()
      );
    if (!updated) throw new Error('Media generation job is unavailable');
  }

  /**
   * Persist a downloaded provider result and conditionally claim completion.
   * A losing retry removes its duplicate blob and returns the durable winner.
   */
  async completeWithMedia(
    jobId: string,
    userId: string,
    input: {
      mimeType: string;
      mediaData: string;
      metadata?: Record<string, unknown>;
    },
    execution: { attemptCount?: number; signal?: AbortSignal } = {}
  ): Promise<GeneratedMedia> {
    const repository = getPlatformStorageRuntime().domains.mediaJobs;
    const job = await repository.findByOwner(jobId, userId);
    if (!job) throw new Error('Media generation job is unavailable');
    if (job.galleryId) {
      const existing = await galleryService.getMediaItem(job.galleryId, userId);
      if (existing) return existing;
    }
    const media = await galleryService.saveMedia(userId, {
      id: job.id,
      createdAt: job.createdAt,
      kind: 'video',
      prompt: job.prompt,
      model: job.model,
      pluginId: job.pluginId,
      mediaData: input.mediaData,
      mimeType: input.mimeType,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    if (!media) throw new Error('Unable to persist generated video');
    await delayAfterMediaSaveForRecoveryDrill(
      job.prompt,
      execution.attemptCount,
      execution.signal
    );
    const won = await repository.completeIfUnclaimed(
      jobId,
      userId,
      media.id,
      Date.now()
    );
    if (!won) {
      await galleryService.deleteMedia(media.id, userId);
      const winner = await repository.findByOwner(jobId, userId);
      if (!winner?.galleryId) {
        throw new Error('Media completion raced without a winner');
      }
      const existing = await galleryService.getMediaItem(
        winner.galleryId,
        userId
      );
      if (!existing) throw new Error('Completed gallery media is unavailable');
      return existing;
    }
    return media;
  }
}

export default new MediaGenerationJobService();
