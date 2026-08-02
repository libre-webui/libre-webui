/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import galleryService from '../services/galleryService.js';
import mediaGenerationJobService from '../services/mediaGenerationJobService.js';
import pluginService from '../services/pluginService.js';
import type { GeneratedMediaKind } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:media');
const router = express.Router();
const generationRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const pollingRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const galleryRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(authenticate);

function userId(req: AuthenticatedRequest): string {
  if (!req.user) throw new Error('Authenticated user context is required');
  return req.user.userId;
}

router.get('/models', async (req: AuthenticatedRequest, res) => {
  try {
    const id = userId(req);
    await Promise.all([
      pluginService.refreshStaleCapabilityModels('video', id),
      pluginService.refreshStaleCapabilityModels('tts', id),
      pluginService.refreshStaleCapabilityModels('audio', id),
    ]);
    res.json({
      success: true,
      data: {
        video: pluginService.getAvailableVideoGenModels(id),
        audio: [
          ...pluginService
            .getAvailableAudioGenModels(id)
            .map(model => ({ ...model, mode: 'sound' as const })),
          ...pluginService
            .getAvailableTTSModels(id)
            .map(model => ({ ...model, mode: 'speech' as const })),
        ],
      },
    });
  } catch (error) {
    logger.error('Failed to load media generation models:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load media generation models',
    });
  }
});

router.post(
  '/audio/generate',
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { model, pluginId, input, voice, response_format, speed } =
        req.body;
      if (
        typeof model !== 'string' ||
        typeof pluginId !== 'string' ||
        typeof input !== 'string' ||
        input.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          message: 'model, pluginId, and input are required',
        });
        return;
      }
      const id = userId(req);
      const format = isAudioFormat(response_format) ? response_format : 'mp3';
      const audio = await pluginService.executeTTSRequest(model, input.trim(), {
        pluginId,
        userId: id,
        ...(typeof voice === 'string' && voice ? { voice } : {}),
        ...(typeof speed === 'number' ? { speed } : {}),
        response_format: format,
      });
      const mimeType = audioMimeType(format);
      const mediaData = `data:${mimeType};base64,${audio.toString('base64')}`;
      const saved = galleryService.saveMedia(id, {
        kind: 'audio',
        prompt: input.trim(),
        model,
        pluginId,
        mediaData,
        mimeType,
        metadata: { voice: voice || null, format },
      });
      if (!saved) throw new Error('Failed to save generated audio');
      res.json({ success: true, data: publicMedia(saved) });
    } catch (error) {
      logger.error('Audio generation failed:', error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Audio generation failed',
      });
    }
  }
);

router.post(
  '/sound/generate',
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { model, pluginId, prompt, voice, format } = req.body;
      if (
        typeof model !== 'string' ||
        typeof pluginId !== 'string' ||
        typeof prompt !== 'string' ||
        prompt.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          message: 'model, pluginId, and prompt are required',
        });
        return;
      }
      const id = userId(req);
      const generated = await pluginService.executeAudioGenRequest(
        model,
        prompt.trim(),
        {
          pluginId,
          userId: id,
          ...(typeof voice === 'string' && voice ? { voice } : {}),
          ...(isGeneratedAudioFormat(format) ? { format } : {}),
        }
      );
      const mediaData = `data:${generated.mimeType};base64,${generated.audio.toString(
        'base64'
      )}`;
      const saved = galleryService.saveMedia(id, {
        kind: 'audio',
        prompt: prompt.trim(),
        model,
        pluginId,
        mediaData,
        mimeType: generated.mimeType,
        metadata: {
          mode: 'sound',
          voice: voice || null,
          format: format || null,
          transcript: generated.transcript || null,
        },
      });
      if (!saved) throw new Error('Failed to save generated audio');
      res.json({ success: true, data: publicMedia(saved) });
    } catch (error) {
      logger.error('Audio generation failed:', error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Audio generation failed',
      });
    }
  }
);

router.post(
  '/video/generate',
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const {
        model,
        pluginId,
        prompt,
        duration,
        resolution,
        aspect_ratio,
        generate_audio,
      } = req.body;
      if (
        typeof model !== 'string' ||
        typeof pluginId !== 'string' ||
        typeof prompt !== 'string' ||
        prompt.trim().length === 0
      ) {
        res.status(400).json({
          success: false,
          message: 'model, pluginId, and prompt are required',
        });
        return;
      }
      const id = userId(req);
      const options = {
        ...(Number.isInteger(duration) && duration > 0 ? { duration } : {}),
        ...(typeof resolution === 'string' && resolution ? { resolution } : {}),
        ...(typeof aspect_ratio === 'string' && aspect_ratio
          ? { aspectRatio: aspect_ratio }
          : {}),
        ...(typeof generate_audio === 'boolean'
          ? { generateAudio: generate_audio }
          : {}),
      };
      const submitted = await pluginService.submitVideoGenRequest(
        model,
        prompt.trim(),
        { pluginId, userId: id, ...options }
      );
      const job = mediaGenerationJobService.create(id, {
        providerJobId: submitted.providerJobId,
        pluginId,
        model,
        prompt: prompt.trim(),
        options,
      });
      res.status(202).json({ success: true, data: publicJob(job) });
    } catch (error) {
      logger.error('Video generation submission failed:', error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Video generation failed',
      });
    }
  }
);

router.get(
  '/video/jobs/:jobId',
  pollingRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = userId(req);
      const jobId = Array.isArray(req.params.jobId)
        ? req.params.jobId[0]
        : req.params.jobId;
      const job = mediaGenerationJobService.get(jobId, id);
      if (!job) {
        res
          .status(404)
          .json({ success: false, message: 'Video job not found' });
        return;
      }
      if (job.status === 'completed') {
        res.json({
          success: true,
          data: {
            ...publicJob(job),
            media: publicMedia(galleryService.getMediaItem(job.galleryId!, id)),
          },
        });
        return;
      }
      if (job.status === 'failed') {
        res.json({ success: true, data: publicJob(job) });
        return;
      }

      const status = await pluginService.pollVideoGenRequest(
        job.model,
        job.providerJobId,
        job.pluginId,
        id
      );
      if (status.status === 'failed') {
        mediaGenerationJobService.update(job.id, id, 'failed', {
          error: status.error || 'Video provider reported failure',
        });
        res.json({
          success: true,
          data: { ...publicJob(job), status: 'failed', error: status.error },
        });
        return;
      }
      if (status.status !== 'completed') {
        mediaGenerationJobService.update(job.id, id, status.status);
        res.json({
          success: true,
          data: { ...publicJob(job), status: status.status },
        });
        return;
      }

      const downloaded = await pluginService.downloadVideoGenResult(
        job.model,
        job.providerJobId,
        job.pluginId,
        id
      );
      const media = galleryService.saveMedia(id, {
        kind: 'video',
        prompt: job.prompt,
        model: job.model,
        pluginId: job.pluginId,
        mediaData: `data:${downloaded.mimeType};base64,${downloaded.video.toString(
          'base64'
        )}`,
        mimeType: downloaded.mimeType,
        metadata: { ...job.options, usage: status.usage || null },
      });
      if (!media) throw new Error('Failed to save generated video');
      mediaGenerationJobService.update(job.id, id, 'completed', {
        galleryId: media.id,
      });
      res.json({
        success: true,
        data: {
          ...publicJob(job),
          status: 'completed',
          media: publicMedia(media),
        },
      });
    } catch (error) {
      logger.error('Video generation polling failed:', error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Video polling failed',
      });
    }
  }
);

router.get('/gallery', galleryRateLimiter, (req: AuthenticatedRequest, res) => {
  const kind = req.query.kind;
  if (kind && !['image', 'video', 'audio'].includes(String(kind))) {
    res.status(400).json({ success: false, message: 'Invalid media kind' });
    return;
  }
  const result = galleryService.getMedia(userId(req), {
    limit: Number(req.query.limit) || 20,
    offset: Number(req.query.offset) || 0,
    ...(kind ? { kind: kind as GeneratedMediaKind } : {}),
  });
  res.json({
    success: true,
    data: { ...result, media: result.media.map(publicMedia) },
  });
});

router.get(
  '/gallery/:mediaId/content',
  galleryRateLimiter,
  (req: AuthenticatedRequest, res) => {
    const mediaId = Array.isArray(req.params.mediaId)
      ? req.params.mediaId[0]
      : req.params.mediaId;
    const item = galleryService.getMediaItem(mediaId, userId(req));
    if (!item) {
      res.status(404).json({ success: false, message: 'Media not found' });
      return;
    }

    const match =
      /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/i.exec(
        item.mediaData
      );
    if (match) {
      const encodedMimeType = match[1].toLowerCase();
      if (
        encodedMimeType !== item.mimeType.toLowerCase() ||
        !isSafeMediaMimeType(item.kind, encodedMimeType)
      ) {
        res
          .status(422)
          .json({ success: false, message: 'Stored media type is invalid' });
        return;
      }
      const data = Buffer.from(match[2], 'base64');
      if (data.length > 200 * 1024 * 1024) {
        res.status(413).json({ success: false, message: 'Media is too large' });
        return;
      }
      res.set({
        'Content-Type': encodedMimeType,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, max-age=300',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      });
      res.send(data);
      return;
    }

    try {
      const url = new URL(item.mediaData);
      if (
        item.kind !== 'image' ||
        (url.protocol !== 'http:' && url.protocol !== 'https:')
      ) {
        throw new Error();
      }
      res.redirect(302, url.toString());
    } catch {
      res
        .status(422)
        .json({ success: false, message: 'Stored media is invalid' });
    }
  }
);

router.delete(
  '/gallery/:mediaId',
  galleryRateLimiter,
  (req: AuthenticatedRequest, res) => {
    const mediaId = Array.isArray(req.params.mediaId)
      ? req.params.mediaId[0]
      : req.params.mediaId;
    const deleted = galleryService.deleteMedia(mediaId, userId(req));
    if (!deleted) {
      res.status(404).json({ success: false, message: 'Media not found' });
      return;
    }
    res.json({ success: true });
  }
);

function isSafeMediaMimeType(
  kind: GeneratedMediaKind,
  mimeType: string
): boolean {
  const allowed: Record<GeneratedMediaKind, ReadonlySet<string>> = {
    image: new Set([
      'image/avif',
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]),
    video: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
    audio: new Set([
      'audio/aac',
      'audio/flac',
      'audio/l16',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
      'audio/opus',
      'audio/wav',
      'audio/webm',
    ]),
  };
  return allowed[kind].has(mimeType.toLowerCase());
}

function audioMimeType(format: string): string {
  return (
    (
      {
        mp3: 'audio/mpeg',
        pcm: 'audio/L16',
        wav: 'audio/wav',
        opus: 'audio/opus',
        aac: 'audio/aac',
        flac: 'audio/flac',
      } as Record<string, string>
    )[format] || 'audio/mpeg'
  );
}

function isAudioFormat(
  value: unknown
): value is 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' {
  return (
    typeof value === 'string' &&
    ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(value)
  );
}

function isGeneratedAudioFormat(
  value: unknown
): value is 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16' {
  return (
    typeof value === 'string' &&
    ['wav', 'mp3', 'flac', 'opus', 'pcm16'].includes(value)
  );
}

function publicJob(job: {
  id: string;
  status: string;
  model: string;
  pluginId: string;
  galleryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}) {
  return {
    id: job.id,
    status: job.status,
    model: job.model,
    pluginId: job.pluginId,
    galleryId: job.galleryId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function publicMedia<T extends { id: string; mediaData: string }>(
  media: T | null
): (Omit<T, 'mediaData'> & { mediaData: string }) | null {
  return media
    ? {
        ...media,
        mediaData: `/api/media/gallery/${encodeURIComponent(media.id)}/content`,
      }
    : null;
}

export default router;
