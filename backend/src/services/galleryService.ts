/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { Readable } from 'node:stream';
import { getPlatformStorageRuntime } from '../platform/storage/index.js';
import { transactionalResourceDeletionEnqueuer } from '../platform/jobs/resourceDeletionEnqueuer.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import {
  VIDEO_RESUME_IDEMPOTENCY_SCOPE,
  VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
} from '../platform/jobs/domainJobContracts.js';
import { getCoordinator } from '../platform/coordination/service.js';
import type {
  GeneratedImage,
  GeneratedMedia,
  GeneratedMediaKind,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('services:gallery-service');
const RESOURCE_TYPE = 'generated-media';
const BLOB_PURPOSE = 'gallery.media';
const LEGACY_MAX_BYTES = 200 * 1024 * 1024;

interface SaveImageParams {
  prompt: string;
  model: string;
  imageData: string;
  size?: string;
  quality?: string;
}

interface SaveMediaParams {
  /** Stable internal identity used by retryable durable producers. */
  id?: string;
  createdAt?: number;
  kind: GeneratedMediaKind;
  prompt: string;
  model: string;
  pluginId?: string;
  mediaData: string;
  mimeType: string;
  size?: string;
  quality?: string;
  metadata?: Record<string, unknown>;
}

interface GetMediaParams {
  limit?: number;
  offset?: number;
  kind?: GeneratedMediaKind;
}

interface MediaRecord extends Omit<GeneratedMedia, 'mediaData'> {
  legacyMediaData?: string;
}

const parseDataUrl = (
  mediaData: string,
  expectedMimeType?: string
): { mimeType: string; bytes: Buffer } => {
  const match =
    /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(
      mediaData
    );
  if (!match) {
    // Remote provider URLs were historically persisted and redirected to.
    // New writes reject them: provider content must be downloaded first so
    // retention, checksums, deletion, and access policy stay under Libre.
    throw new Error('Generated media must be a base64 data URL');
  }
  const mimeType = match[1].toLowerCase();
  if (expectedMimeType && mimeType !== expectedMimeType.toLowerCase()) {
    throw new Error('Generated media MIME type does not match its data URL');
  }
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > LEGACY_MAX_BYTES)
    throw new Error('Generated media is too large');
  if (bytes.toString('base64') !== match[2]) {
    throw new Error('Generated media base64 is not canonical');
  }
  return { mimeType, bytes };
};

class GalleryService {
  private async cancelVideoLifecycle(
    mediaId: string,
    userId: string
  ): Promise<void> {
    const service = getDurableJobRuntime().service;
    const runningIds: string[] = [];
    for (const scope of [
      VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
      VIDEO_RESUME_IDEMPOTENCY_SCOPE,
    ]) {
      const job = await service.getByIdempotency(userId, scope, mediaId);
      if (job?.state !== 'queued' && job?.state !== 'running') continue;
      const cancelled = await service.cancel(job.id, userId, 'superseded');
      if (cancelled.state === 'running') runningIds.push(cancelled.id);
    }
    const deadline = Date.now() + 15_000;
    while (runningIds.length > 0) {
      for (let index = runningIds.length - 1; index >= 0; index -= 1) {
        const job = await service.getMetadata(runningIds[index]);
        if (!job || job.state !== 'running') runningIds.splice(index, 1);
      }
      if (runningIds.length === 0) return;
      if (Date.now() >= deadline) {
        throw new Error(
          'Generated media work is still stopping; retry deletion'
        );
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private async withMediaWriteLease<T>(
    mediaId: string,
    userId: string,
    operation: (assertHeld: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const coordinator = getCoordinator();
    const deadline = Date.now() + 15_000;
    let lease = await coordinator.acquireLease(
      `resource:${userId}:${RESOURCE_TYPE}:${mediaId}`,
      30_000
    );
    while (!lease && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      lease = await coordinator.acquireLease(
        `resource:${userId}:${RESOURCE_TYPE}:${mediaId}`,
        30_000
      );
    }
    if (!lease) throw new Error('Generated media is still being updated');
    let closed = false;
    let lost = false;
    let renewalTimer: NodeJS.Timeout | undefined;
    const assertHeld = async (): Promise<void> => {
      if (closed || lost) {
        throw new Error('The shared generated media write lease was lost');
      }
      try {
        if (await lease.extend(30_000)) return;
      } catch {
        // Report expiry and coordination outages through one safe fence.
      }
      lost = true;
      throw new Error('The shared generated media write lease was lost');
    };
    const renew = async (): Promise<void> => {
      if (closed || lost) return;
      try {
        if (!(await lease.extend(30_000))) lost = true;
      } catch {
        lost = true;
      }
      if (!closed && !lost) renewalTimer = setTimeout(renew, 10_000);
    };
    renewalTimer = setTimeout(renew, 10_000);
    renewalTimer.unref?.();
    try {
      await assertHeld();
      const result = await operation(assertHeld);
      return result;
    } finally {
      closed = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      await lease.release().catch(() => false);
    }
  }

  private async getRecord(
    mediaId: string,
    userId: string
  ): Promise<MediaRecord | undefined> {
    return getPlatformStorageRuntime().domains.gallery.findByOwner(
      mediaId,
      userId
    );
  }

  private async migrateLegacyBlob(
    record: MediaRecord
  ): Promise<string | undefined> {
    if (!record.legacyMediaData) return undefined;
    const platform = getPlatformStorageRuntime();
    const existing = await platform.blobReferences.find(
      RESOURCE_TYPE,
      record.id,
      BLOB_PURPOSE
    );
    if (existing) return existing.blobId;
    const parsed = parseDataUrl(record.legacyMediaData, record.mimeType);
    const blob = await platform.blobStore.put({
      ownerUserId: record.userId,
      purpose: BLOB_PURPOSE,
      contentType: record.mimeType,
      expectedSize: parsed.bytes.length,
      metadata: { resourceType: RESOURCE_TYPE, resourceId: record.id },
      source: Readable.from(parsed.bytes),
    });
    try {
      await platform.domains.gallery.adoptLegacyBlob({
        blobId: blob.id,
        ownerUserId: record.userId,
        resourceType: RESOURCE_TYPE,
        resourceId: record.id,
        purpose: BLOB_PURPOSE,
        createdAt: Date.now(),
      });
      const authoritative = await platform.blobReferences.find(
        RESOURCE_TYPE,
        record.id,
        BLOB_PURPOSE
      );
      if (!authoritative) {
        throw new Error(
          'Legacy gallery migration did not publish a blob reference'
        );
      }
      if (authoritative.blobId !== blob.id) {
        await platform.blobStore
          .delete({ id: blob.id, ownerUserId: record.userId })
          .catch(error => {
            logger.warn(
              'Concurrent gallery migration left an orphan for reconciliation',
              error
            );
            return false;
          });
      }
      return authoritative.blobId;
    } catch (error) {
      await platform.blobStore
        .delete({ id: blob.id, ownerUserId: record.userId })
        .catch(() => undefined);
      throw error;
    }
  }

  async saveImage(
    userId: string,
    params: SaveImageParams
  ): Promise<GeneratedImage | null> {
    const saved = await this.saveMedia(userId, {
      kind: 'image',
      prompt: params.prompt,
      model: params.model,
      mediaData: params.imageData,
      mimeType: inferImageMimeType(params.imageData),
      ...(params.size ? { size: params.size } : {}),
      ...(params.quality ? { quality: params.quality } : {}),
    });
    return saved
      ? {
          id: saved.id,
          userId: saved.userId,
          prompt: saved.prompt,
          model: saved.model,
          imageData: params.imageData,
          ...(saved.size ? { size: saved.size } : {}),
          ...(saved.quality ? { quality: saved.quality } : {}),
          createdAt: saved.createdAt,
        }
      : null;
  }

  async saveMedia(
    userId: string,
    params: SaveMediaParams
  ): Promise<GeneratedMedia | null> {
    let blobId: string | undefined;
    try {
      const {
        id: requestedId,
        createdAt: requestedCreatedAt,
        ...mediaParams
      } = params;
      const id = requestedId ?? randomUUID();
      const createdAt = requestedCreatedAt ?? Date.now();
      if (requestedId) {
        const existing = await this.getRecord(requestedId, userId);
        if (existing) {
          return { ...existing, mediaData: mediaParams.mediaData };
        }
      }
      const parsed = parseDataUrl(mediaParams.mediaData, mediaParams.mimeType);
      const platform = getPlatformStorageRuntime();
      const blob = await platform.blobStore.put({
        ownerUserId: userId,
        purpose: BLOB_PURPOSE,
        contentType: mediaParams.mimeType,
        expectedSize: parsed.bytes.length,
        metadata: { resourceType: RESOURCE_TYPE, resourceId: id },
        source: Readable.from(parsed.bytes),
      });
      blobId = blob.id;
      try {
        await platform.domains.gallery.insert(
          {
            id,
            userId,
            kind: mediaParams.kind,
            prompt: mediaParams.prompt,
            model: mediaParams.model,
            ...(mediaParams.pluginId ? { pluginId: mediaParams.pluginId } : {}),
            mimeType: mediaParams.mimeType,
            ...(mediaParams.size ? { size: mediaParams.size } : {}),
            ...(mediaParams.quality ? { quality: mediaParams.quality } : {}),
            ...(mediaParams.metadata ? { metadata: mediaParams.metadata } : {}),
            createdAt,
          },
          {
            blobId: blob.id,
            ownerUserId: userId,
            resourceType: RESOURCE_TYPE,
            resourceId: id,
            purpose: BLOB_PURPOSE,
            createdAt,
          }
        );
      } catch (error) {
        let existing: MediaRecord | undefined;
        let reference:
          Awaited<ReturnType<typeof platform.blobReferences.find>> | undefined;
        try {
          existing = await this.getRecord(id, userId);
          reference = await platform.blobReferences.find(
            RESOURCE_TYPE,
            id,
            BLOB_PURPOSE
          );
          const committedRecordMatches =
            existing !== undefined &&
            existing.id === id &&
            existing.userId === userId &&
            existing.kind === mediaParams.kind &&
            existing.prompt === mediaParams.prompt &&
            existing.model === mediaParams.model &&
            (existing.pluginId ?? undefined) === mediaParams.pluginId &&
            existing.mimeType === mediaParams.mimeType &&
            (existing.size ?? undefined) === mediaParams.size &&
            (existing.quality ?? undefined) === mediaParams.quality &&
            JSON.stringify(existing.metadata ?? undefined) ===
              JSON.stringify(mediaParams.metadata ?? undefined) &&
            existing.createdAt === createdAt;
          if (
            existing &&
            committedRecordMatches &&
            reference?.blobId === blob.id &&
            reference.ownerUserId === userId &&
            reference.resourceType === RESOURCE_TYPE &&
            reference.resourceId === id &&
            reference.purpose === BLOB_PURPOSE
          ) {
            await platform.blobStore.stat(blob.id, userId);
            return { ...existing, mediaData: mediaParams.mediaData };
          }
        } catch {
          throw new Error(
            'Generated media insert outcome is ambiguous; reconciliation is required'
          );
        }
        if (!existing && !reference) {
          await platform.blobStore.delete({
            id: blob.id,
            ownerUserId: userId,
          });
          blobId = undefined;
        } else {
          throw new Error(
            'Generated media insert outcome conflicts with authoritative metadata; reconciliation is required'
          );
        }
        throw error;
      }
      return { id, userId, createdAt, ...mediaParams };
    } catch (error) {
      logger.error('Error saving generated media:', error);
      if (blobId)
        logger.warn(`Gallery blob ${blobId} may require reconciliation`);
      return null;
    }
  }

  async getMedia(
    userId: string,
    params: GetMediaParams = {}
  ): Promise<{ media: GeneratedMedia[]; total: number }> {
    const limit = Math.max(1, Math.min(100, params.limit || 20));
    const offset = Math.max(0, params.offset || 0);
    const result =
      await getPlatformStorageRuntime().domains.gallery.listByOwner(userId, {
        limit,
        offset,
        ...(params.kind ? { kind: params.kind } : {}),
      });
    return {
      media: result.records.map(record => ({ ...record, mediaData: '' })),
      total: result.total,
    };
  }

  async getMediaItem(
    mediaId: string,
    userId: string
  ): Promise<GeneratedMedia | null> {
    const record = await this.getRecord(mediaId, userId);
    if (!record) return null;
    return { ...record, mediaData: record.legacyMediaData || '' };
  }

  async openMediaContent(
    mediaId: string,
    userId: string,
    range?: { start: number; end?: number },
    signal?: AbortSignal
  ) {
    const record = await this.getRecord(mediaId, userId);
    if (!record) return undefined;
    const platform = getPlatformStorageRuntime();
    let reference = await platform.blobReferences.find(
      RESOURCE_TYPE,
      mediaId,
      BLOB_PURPOSE
    );
    if (!reference) {
      await this.migrateLegacyBlob(record);
      reference = await platform.blobReferences.find(
        RESOURCE_TYPE,
        mediaId,
        BLOB_PURPOSE
      );
    }
    if (!reference || reference.ownerUserId !== userId) return undefined;
    const content = await platform.blobStore.open({
      id: reference.blobId,
      ownerUserId: userId,
      ...(range ? { range } : {}),
      ...(signal ? { signal } : {}),
    });
    return { record, content };
  }

  async getImages(
    userId: string,
    params: { limit?: number; offset?: number } = {}
  ): Promise<{ images: GeneratedImage[]; total: number }> {
    const result = await this.getMedia(userId, { ...params, kind: 'image' });
    return {
      images: result.media.map(item => ({
        id: item.id,
        userId: item.userId,
        prompt: item.prompt,
        model: item.model,
        imageData: `/api/media/gallery/${encodeURIComponent(item.id)}/content`,
        ...(item.size ? { size: item.size } : {}),
        ...(item.quality ? { quality: item.quality } : {}),
        createdAt: item.createdAt,
      })),
      total: result.total,
    };
  }

  async getImage(
    imageId: string,
    userId: string
  ): Promise<GeneratedImage | null> {
    const item = await this.getMediaItem(imageId, userId);
    if (!item || item.kind !== 'image') return null;
    return {
      id: item.id,
      userId: item.userId,
      prompt: item.prompt,
      model: item.model,
      imageData: `/api/media/gallery/${encodeURIComponent(item.id)}/content`,
      ...(item.size ? { size: item.size } : {}),
      ...(item.quality ? { quality: item.quality } : {}),
      createdAt: item.createdAt,
    };
  }

  /**
   * Retention sweep (MEDIA-01): when GALLERY_RETENTION_DAYS is configured,
   * delete gallery items older than the cutoff through the same durable
   * deletion lifecycle as a manual delete. Unset means keep forever.
   */
  async sweepRetention(now: number): Promise<number> {
    const days = Number.parseInt(process.env.GALLERY_RETENTION_DAYS || '', 10);
    if (!Number.isInteger(days) || days < 1) return 0;
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const expired =
      await getPlatformStorageRuntime().domains.gallery.listCreatedBefore(
        cutoff,
        25
      );
    let removed = 0;
    for (const item of expired) {
      try {
        if (await this.deleteMedia(item.id, item.userId)) removed += 1;
      } catch (error) {
        logger.warn('Gallery retention delete failed', {
          mediaId: item.id,
          error,
        });
      }
    }
    return removed;
  }

  async deleteMedia(mediaId: string, userId: string): Promise<boolean> {
    await this.cancelVideoLifecycle(mediaId, userId);
    return this.withMediaWriteLease(mediaId, userId, async assertHeld => {
      await this.cancelVideoLifecycle(mediaId, userId);
      const platform = getPlatformStorageRuntime();
      const existing = await this.getRecord(mediaId, userId);
      if (!existing) return false;
      await assertHeld();
      return platform.domains.gallery.deleteAndEnqueue(
        mediaId,
        userId,
        transactionalResourceDeletionEnqueuer
      );
    });
  }

  async deleteImage(imageId: string, userId: string): Promise<boolean> {
    const record = await this.getRecord(imageId, userId);
    return record?.kind === 'image' ? this.deleteMedia(imageId, userId) : false;
  }

  async deleteAllImages(userId: string): Promise<boolean> {
    const items = await this.getMedia(userId, { kind: 'image', limit: 100 });
    let offset = 0;
    let page = items;
    while (page.media.length > 0) {
      for (const item of page.media) await this.deleteMedia(item.id, userId);
      offset += page.media.length;
      if (offset >= page.total) break;
      page = await this.getMedia(userId, { kind: 'image', limit: 100 });
    }
    return true;
  }
}

function inferImageMimeType(imageData: string): string {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(imageData);
  return match?.[1]?.toLowerCase() || 'image/png';
}

export default new GalleryService();
