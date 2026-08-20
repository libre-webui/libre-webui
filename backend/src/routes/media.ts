/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import express from 'express';
import multer from 'multer';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireFeature,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { budgetGuard } from '../middleware/index.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import galleryService from '../services/galleryService.js';
import mediaGenerationJobService from '../services/mediaGenerationJobService.js';
import pluginService from '../services/pluginService.js';
import { AudioGenerationConcurrencyError } from '../services/pluginAudioGenerationService.js';
import { VideoCancellationUnsupportedError } from '../services/pluginVideoGenerationService.js';
import voiceProfileService from '../services/voiceProfileService.js';
import {
  TTSConcurrencyError,
  TTSProviderResponseError,
} from '../services/pluginTTSService.js';
import type { GeneratedMediaKind } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  IMAGE_EDIT_GLOBAL_MAX_IMAGE_BYTES,
  IMAGE_EDIT_GLOBAL_MAX_REFERENCE_IMAGES,
  ImageEditUploadError,
  validateImageEditUpload,
} from '../utils/imageEditUpload.js';
import {
  parseTTSVoiceCloneUpload,
  reserveTTSVoiceCloneUpload,
  TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES,
  TTSVoiceCloneConcurrencyError,
  TTSVoiceCloneUploadError,
  validateTTSVoiceCloneAudio,
} from '../utils/ttsVoiceCloneUpload.js';
import {
  getDurableJobRuntime,
  VIDEO_RESUME_IDEMPOTENCY_SCOPE,
  VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
} from '../platform/jobs/index.js';
import {
  combineAbortSignals,
  SharedCapacityUnavailableError,
  type SharedCapacityReservation,
} from '../platform/coordination/sharedAdmission.js';

const logger = createLogger('routes:media');
const router = express.Router();
const videoJobLocks = new Map<string, Promise<void>>();
const generationRateLimiter = rateLimit({
  keyPrefix: 'media-generate',
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});
const pollingRateLimiter = rateLimit({
  keyPrefix: 'media-poll',
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
const galleryRateLimiter = rateLimit({
  keyPrefix: 'media-gallery',
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
// Umbrella limit ahead of authentication; per-route limiters below stay tighter.
const routerRateLimiter = rateLimit({
  keyPrefix: 'media-router',
  windowMs: 60_000,
  max: 240,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(routerRateLimiter);
router.use(authenticate);

function userId(req: AuthenticatedRequest): string {
  if (!req.user) throw new Error('Authenticated user context is required');
  return req.user.userId;
}

function requestAbortSignal(
  req: AuthenticatedRequest,
  res: express.Response
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Media client disconnected'));
    }
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once?.('aborted', abort);
  res.once?.('close', abortOnResponseClose);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off?.('aborted', abort);
      res.off?.('close', abortOnResponseClose);
    },
  };
}

const providerResponseStatus = (status: number): number =>
  status === 401 || status === 403
    ? 502
    : status >= 400 && status < 500
      ? status
      : 502;

router.get('/models', async (req: AuthenticatedRequest, res) => {
  try {
    const id = userId(req);
    await Promise.all([
      pluginService.refreshStaleCapabilityModels('video', id),
      pluginService.refreshStaleCapabilityModels('tts', id),
      pluginService.refreshStaleCapabilityModels('audio', id),
    ]);
    const [videoModels, audioModels, ttsModels] = await Promise.all([
      pluginService.getAvailableVideoGenModels(id),
      pluginService.getAvailableAudioGenModels(id),
      pluginService.getAvailableTTSModels(id),
    ]);
    res.json({
      success: true,
      data: {
        video: videoModels,
        audio: [
          ...audioModels.map(model => ({ ...model, mode: 'sound' as const })),
          ...ttsModels.map(model => ({ ...model, mode: 'speech' as const })),
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
  budgetGuard,
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
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
      const selectedPlugin = await pluginService.getPluginForTTS(
        model,
        pluginId,
        id
      );
      const configuredFormat =
        selectedPlugin?.capabilities?.tts?.config?.default_format;
      const format = isAudioFormat(response_format)
        ? response_format
        : isAudioFormat(configuredFormat)
          ? configuredFormat
          : 'mp3';
      const audio = await pluginService.executeTTSRequest(model, input.trim(), {
        pluginId,
        userId: id,
        ...(typeof voice === 'string' && voice ? { voice } : {}),
        ...(typeof speed === 'number' ? { speed } : {}),
        response_format: format,
        signal: requestAbort.signal,
      });
      if (requestAbort.signal.aborted) return;
      const mimeType = audioMimeType(format);
      const mediaData = `data:${mimeType};base64,${audio.toString('base64')}`;
      const saved = await galleryService.saveMedia(id, {
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
      if (requestAbort.signal.aborted) return;
      if (error instanceof SharedCapacityUnavailableError) {
        res.status(503).json({
          success: false,
          message: 'Media admission is temporarily unavailable',
        });
        return;
      }
      if (error instanceof TTSConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof TTSProviderResponseError) {
        logger.warn(
          `TTS provider returned status ${error.providerStatus} during gallery generation`
        );
        res.status(providerResponseStatus(error.providerStatus)).json({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error('Audio generation failed:', error);
      const message =
        error instanceof Error ? error.message : 'Audio generation failed';
      res.status(/exceeds maximum length/i.test(message) ? 400 : 500).json({
        success: false,
        message,
      });
    } finally {
      requestAbort.cleanup();
    }
  }
);

router.post(
  '/audio/voice-clone',
  requireFeature('voice-cloning'),
  budgetGuard,
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    let uploadSlot: SharedCapacityReservation | undefined;
    try {
      const id = userId(req);
      uploadSlot = await reserveTTSVoiceCloneUpload(id);
      const operationSignal = combineAbortSignals(
        requestAbort.signal,
        uploadSlot.signal
      );
      await parseTTSVoiceCloneUpload(req, res, operationSignal);
      const {
        model,
        pluginId,
        input,
        reference_text,
        response_format,
        saveVoiceName,
        consentToStore,
        consentTtlDays,
      } = req.body || {};
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
      if (reference_text !== undefined && typeof reference_text !== 'string') {
        res.status(400).json({
          success: false,
          message: 'reference_text must be a string when provided',
        });
        return;
      }
      if (
        saveVoiceName !== undefined &&
        (typeof saveVoiceName !== 'string' || saveVoiceName.trim().length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: 'saveVoiceName must be a non-empty string when provided',
        });
        return;
      }
      if (saveVoiceName !== undefined && consentToStore !== 'true') {
        res.status(400).json({
          success: false,
          message: 'Explicit consent is required to save a reusable voice',
        });
        return;
      }
      if (consentToStore === 'true' && saveVoiceName === undefined) {
        res.status(400).json({
          success: false,
          message: 'A voice name is required when consentToStore is true',
        });
        return;
      }
      let consentExpiresAt: number | null = null;
      if (consentTtlDays !== undefined) {
        const days = Number(consentTtlDays);
        if (
          !Number.isInteger(days) ||
          days < 1 ||
          days > 3650 ||
          saveVoiceName === undefined
        ) {
          res.status(400).json({
            success: false,
            message:
              'consentTtlDays must be 1-3650 and requires a saved voice name',
          });
          return;
        }
        consentExpiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      }

      const selectedPlugin = await pluginService.getPluginForTTS(
        model,
        pluginId,
        id
      );
      const config = selectedPlugin?.capabilities?.tts?.config;
      if (!selectedPlugin || !config?.supports_voice_cloning) {
        res.status(400).json({
          success: false,
          message: 'The selected TTS model does not support voice cloning',
        });
        return;
      }
      if (config.clone_requires_transcript && !reference_text?.trim()) {
        res.status(400).json({
          success: false,
          message: 'An exact reference transcript is required',
        });
        return;
      }

      const format = isAudioFormat(response_format)
        ? response_format
        : isAudioFormat(config.default_format)
          ? config.default_format
          : 'wav';
      const referenceAudio = validateTTSVoiceCloneAudio(req.file, config);
      const profileInput =
        saveVoiceName !== undefined
          ? {
              name: saveVoiceName,
              pluginId: selectedPlugin.id,
              model,
              routingFingerprint:
                await pluginService.getCredentialRoutingAuthFingerprint(
                  selectedPlugin,
                  id
                ),
              referenceAudio,
              ...(reference_text?.trim()
                ? { referenceText: reference_text.trim() }
                : {}),
              ...(consentExpiresAt !== null ? { consentExpiresAt } : {}),
            }
          : null;
      if (profileInput)
        await voiceProfileService.validateCreate(id, profileInput);
      const audio = await pluginService.executeVoiceCloneRequest(
        model,
        input.trim(),
        referenceAudio,
        {
          pluginId,
          userId: id,
          referenceText: reference_text?.trim() || undefined,
          response_format: format,
          signal: operationSignal,
        }
      );
      if (operationSignal.aborted) return;
      const mimeType = audioMimeType(format);
      const saved = await galleryService.saveMedia(id, {
        kind: 'audio',
        prompt: input.trim(),
        model,
        pluginId,
        mediaData: `data:${mimeType};base64,${audio.toString('base64')}`,
        mimeType,
        metadata: { mode: 'speech', voiceClone: true, format },
      });
      if (!saved) throw new Error('Failed to save generated audio');
      // Persist only after successful provider and gallery generation. If the
      // final atomic profile check loses a race, roll back the gallery item so
      // the caller never receives a partial success.
      if (profileInput) {
        try {
          const created = await voiceProfileService.create(id, profileInput);
          recordAuditEvent({
            actorUserId: id,
            action: 'voice-profile.consent.grant',
            targetType: 'voice-profile',
            targetId: created.id,
            result: 'success',
            details: {
              pluginId: created.pluginId,
              model: created.model,
              consentExpiresAt: created.consentExpiresAt,
            },
          });
        } catch (error) {
          await galleryService.deleteMedia(saved.id, id);
          throw error;
        }
      }
      res.json({ success: true, data: publicMedia(saved) });
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      if (error instanceof SharedCapacityUnavailableError) {
        res.status(503).json({
          success: false,
          message: 'Media admission is temporarily unavailable',
        });
        return;
      }
      if (error instanceof TTSConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof TTSVoiceCloneConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof multer.MulterError) {
        logger.warn(`Gallery voice-clone upload failed: ${error.code}`);
        res.status(400).json({
          success: false,
          message:
            error.code === 'LIMIT_FILE_SIZE'
              ? `Reference audio exceeds the global maximum size of ${TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES / (1024 * 1024)} MiB`
              : `Invalid voice clone upload: ${error.message}`,
        });
        return;
      }
      if (error instanceof TTSVoiceCloneUploadError) {
        logger.warn(`Gallery voice-clone upload failed: ${error.code}`);
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof TTSProviderResponseError) {
        logger.warn(
          `TTS provider returned status ${error.providerStatus} during gallery voice cloning`
        );
        res.status(providerResponseStatus(error.providerStatus)).json({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error('Voice-cloned audio generation failed:', error);
      const message =
        error instanceof Error ? error.message : 'Voice cloning failed';
      res
        .status(
          /required|maximum|at most|limited to|already exists|unsupported|does not support|no voice clone endpoint/i.test(
            message
          )
            ? 400
            : 500
        )
        .json({ success: false, message });
    } finally {
      await uploadSlot?.release();
      requestAbort.cleanup();
    }
  }
);

const imageEditUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: IMAGE_EDIT_GLOBAL_MAX_IMAGE_BYTES,
    files: IMAGE_EDIT_GLOBAL_MAX_REFERENCE_IMAGES + 1,
    fields: 16,
  },
}).fields([
  { name: 'images', maxCount: IMAGE_EDIT_GLOBAL_MAX_REFERENCE_IMAGES },
  { name: 'mask', maxCount: 1 },
]);

const parseImageEditUpload = (
  req: AuthenticatedRequest,
  res: express.Response
): Promise<void> =>
  new Promise((resolve, reject) => {
    imageEditUpload(req, res, (error: unknown) =>
      error ? reject(error) : resolve()
    );
  });

const readGalleryImageSource = async (
  mediaId: string,
  ownerUserId: string
): Promise<{ buffer: Buffer; mimeType: string } | null> => {
  const opened = await galleryService.openMediaContent(mediaId, ownerUserId);
  if (!opened || opened.record.kind !== 'image') return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of opened.content.body) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > IMAGE_EDIT_GLOBAL_MAX_IMAGE_BYTES) {
      throw new ImageEditUploadError(
        'file_too_large',
        'The selected gallery image is too large to edit'
      );
    }
    chunks.push(piece);
  }
  return { buffer: Buffer.concat(chunks), mimeType: opened.record.mimeType };
};

/**
 * Provider-neutral image edit/inpaint/composite (IMAGE-01). Sources come
 * from uploaded files, an owned gallery image, or both; an optional PNG
 * transparency mask marks the regions to repaint. The result lands in the
 * gallery with full provenance metadata.
 */
router.post(
  '/image/edit',
  budgetGuard,
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    try {
      const id = userId(req);
      await parseImageEditUpload(req, res);
      const { prompt, model, pluginId, size, sourceMediaId } = req.body || {};
      if (
        typeof prompt !== 'string' ||
        prompt.trim().length === 0 ||
        typeof model !== 'string' ||
        typeof pluginId !== 'string'
      ) {
        res.status(400).json({
          success: false,
          message: 'prompt, model, and pluginId are required',
        });
        return;
      }
      if (size !== undefined && typeof size !== 'string') {
        res
          .status(400)
          .json({ success: false, message: 'size must be a string' });
        return;
      }
      const config = await pluginService.getImageGenConfig(pluginId, id);
      if (!config?.edit_endpoint) {
        res.status(400).json({
          success: false,
          message: 'The selected model does not support image editing',
        });
        return;
      }
      const files = req.files as
        Record<string, Express.Multer.File[] | undefined> | undefined;
      const uploadedImages = files?.images ?? [];
      const maskFile = files?.mask?.[0];

      const images: Array<{
        buffer: Buffer;
        mimeType: string;
        filename: string;
      }> = [];
      const provenanceSources: string[] = [];
      if (typeof sourceMediaId === 'string' && sourceMediaId) {
        const source = await readGalleryImageSource(sourceMediaId, id);
        if (!source) {
          res.status(404).json({
            success: false,
            message: 'Gallery source image not found',
          });
          return;
        }
        images.push(
          validateImageEditUpload(
            {
              buffer: source.buffer,
              mimetype: source.mimeType,
              size: source.buffer.length,
            },
            {
              allowedMimeTypes: config.edit_mime_types,
              maxBytes: config.max_edit_image_bytes,
              filename: 'source.png',
            }
          )
        );
        provenanceSources.push(sourceMediaId);
      }
      for (const [index, file] of uploadedImages.entries()) {
        images.push(
          validateImageEditUpload(file, {
            allowedMimeTypes: config.edit_mime_types,
            maxBytes: config.max_edit_image_bytes,
            filename: `image-${index}.png`,
          })
        );
      }
      if (images.length === 0) {
        res.status(400).json({
          success: false,
          message: 'A source image (upload or gallery) is required',
        });
        return;
      }
      let mask = null;
      if (maskFile) {
        if (config.supports_mask === false) {
          res.status(400).json({
            success: false,
            message: 'The selected model does not support edit masks',
          });
          return;
        }
        // Masks must carry alpha, so only PNG is accepted regardless of
        // the model's reference-image formats.
        mask = validateImageEditUpload(maskFile, {
          allowedMimeTypes: ['image/png'],
          maxBytes: config.max_edit_image_bytes,
          filename: 'mask.png',
        });
      }

      const result = await pluginService.executeImageEditRequest(
        model,
        prompt.trim(),
        images,
        mask,
        {
          ...(size ? { size } : {}),
          pluginId,
          userId: id,
          signal: requestAbort.signal,
        }
      );
      if (requestAbort.signal.aborted) return;
      const first = result.images[0];
      if (!first?.b64_json) {
        res.status(502).json({
          success: false,
          message: 'The provider did not return image data for this edit',
        });
        return;
      }
      const mimeType = first.mime_type || 'image/png';
      const saved = await galleryService.saveMedia(id, {
        kind: 'image',
        prompt: prompt.trim(),
        model,
        pluginId,
        mediaData: `data:${mimeType};base64,${first.b64_json}`,
        mimeType,
        metadata: {
          edit: {
            sourceMediaIds: provenanceSources,
            uploadedImages: uploadedImages.length,
            maskUsed: Boolean(mask),
          },
        },
      });
      if (!saved) throw new Error('Failed to save the edited image');
      res.json({ success: true, data: publicMedia(saved) });
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      if (error instanceof ImageEditUploadError) {
        res.status(error.code === 'file_too_large' ? 413 : 400).json({
          success: false,
          message: error.message,
        });
        return;
      }
      if (error instanceof multer.MulterError) {
        res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
          success: false,
          message: 'Invalid image edit upload',
        });
        return;
      }
      logger.error('Image edit failed:', error);
      const message =
        error instanceof Error ? error.message : 'Image edit failed';
      const status = /does not support|required|at most|exceeds maximum/.test(
        message
      )
        ? 400
        : /API key not found/.test(message)
          ? 503
          : /No image generation plugin found/.test(message)
            ? 404
            : 502;
      res.status(status).json({ success: false, message });
    } finally {
      requestAbort.cleanup();
    }
  }
);

router.post(
  '/sound/generate',
  budgetGuard,
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
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
          signal: requestAbort.signal,
        }
      );
      if (requestAbort.signal.aborted) return;
      const mediaData = `data:${generated.mimeType};base64,${generated.audio.toString(
        'base64'
      )}`;
      const saved = await galleryService.saveMedia(id, {
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
      if (requestAbort.signal.aborted) return;
      if (error instanceof SharedCapacityUnavailableError) {
        res.status(503).json({
          success: false,
          message: 'Media admission is temporarily unavailable',
        });
        return;
      }
      if (error instanceof AudioGenerationConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      logger.error('Audio generation failed:', error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Audio generation failed',
      });
    } finally {
      requestAbort.cleanup();
    }
  }
);

router.post(
  '/video/generate',
  budgetGuard,
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
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
      // The prepared row and submission job are one transaction. Provider
      // acceptance runs in the external worker with a stable idempotency key.
      const job = await mediaGenerationJobService.queueVideoSubmission(id, {
        pluginId,
        model,
        prompt: prompt.trim(),
        options,
      });
      if (requestAbort.signal.aborted) return;
      res.status(202).json({ success: true, data: await publicJob(job, id) });
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      logger.error('Video generation submission failed:', error);
      res.status(500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Video generation failed',
      });
    } finally {
      requestAbort.cleanup();
    }
  }
);

router.get(
  '/video/jobs',
  pollingRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const id = userId(req);
    const requestedLimit = Number(req.query.limit);
    const jobs = await mediaGenerationJobService.list(id, {
      limit: Number.isInteger(requestedLimit) ? requestedLimit : 20,
      activeOnly: req.query.active === 'true',
    });
    res.json({
      success: true,
      data: { jobs: await Promise.all(jobs.map(job => publicJob(job, id))) },
    });
  }
);

async function resumeVideoJob(
  req: AuthenticatedRequest,
  res: express.Response
) {
  const requestAbort = requestAbortSignal(req, res);
  let releaseJobLock: (() => void) | undefined;
  try {
    const id = userId(req);
    const jobId = Array.isArray(req.params.jobId)
      ? req.params.jobId[0]
      : req.params.jobId;
    releaseJobLock = await acquireVideoJobLock(`${id}:${jobId}`);
    if (requestAbort.signal.aborted) return;
    // Reload only after acquiring the lock: another tab may have completed and
    // persisted this job while this request waited.
    const job = await mediaGenerationJobService.get(jobId, id);
    if (!job) {
      res.status(404).json({ success: false, message: 'Video job not found' });
      return;
    }
    if (job.status === 'completed') {
      res.json({
        success: true,
        data: {
          ...(await publicJob(job, id)),
          media: publicMedia(
            await galleryService.getMediaItem(job.galleryId!, id)
          ),
        },
      });
      return;
    }
    if (job.status === 'failed') {
      res.json({ success: true, data: await publicJob(job, id) });
      return;
    }

    const durable =
      (await getDurableJobRuntime().service.getByIdempotency(
        id,
        VIDEO_RESUME_IDEMPOTENCY_SCOPE,
        job.id
      )) ||
      (await getDurableJobRuntime().service.getByIdempotency(
        id,
        VIDEO_SUBMIT_IDEMPOTENCY_SCOPE,
        job.id
      ));
    if (durable?.state === 'queued' || durable?.state === 'running') {
      res.json({
        success: true,
        data: {
          ...(await publicJob(job, id)),
          durable: {
            id: durable.id,
            state: durable.state,
            progressCurrent: durable.progressCurrent,
            progressTotal: durable.progressTotal,
            progressMessage: durable.progressMessage,
          },
        },
      });
      return;
    }
    if (durable?.state === 'dead_letter') {
      await mediaGenerationJobService.update(job.id, id, 'failed', {
        error: durable.errorSummary || 'Video processing failed',
      });
      res.json({
        success: true,
        data: {
          ...(await publicJob(job, id)),
          status: 'failed',
          error: durable.errorSummary || 'Video processing failed',
        },
      });
      return;
    }

    if (process.env.LIBRE_PLATFORM_MODE === 'team') {
      // Team media work belongs exclusively to the external durable worker.
      // A polling app replica must never become an unleased provider worker.
      res.status(202).json({
        success: true,
        data: {
          ...(await publicJob(job, id)),
          durable: durable
            ? { id: durable.id, state: durable.state }
            : undefined,
        },
      });
      return;
    }

    const status = await pluginService.pollVideoGenRequest(
      job.model,
      job.providerJobId,
      job.pluginId,
      id,
      requestAbort.signal
    );
    if (requestAbort.signal.aborted) return;
    if (status.status === 'failed') {
      await mediaGenerationJobService.update(job.id, id, 'failed', {
        error: status.error || 'Video provider reported failure',
      });
      res.json({
        success: true,
        data: {
          ...(await publicJob(job, id)),
          status: 'failed',
          error: status.error,
        },
      });
      return;
    }
    if (status.status !== 'completed') {
      await mediaGenerationJobService.update(job.id, id, status.status);
      res.json({
        success: true,
        data: { ...(await publicJob(job, id)), status: status.status },
      });
      return;
    }

    const downloaded = await pluginService.downloadVideoGenResult(
      job.model,
      job.providerJobId,
      job.pluginId,
      id,
      requestAbort.signal
    );
    if (requestAbort.signal.aborted) return;
    const media = await mediaGenerationJobService.completeWithMedia(
      job.id,
      id,
      {
        mediaData: `data:${downloaded.mimeType};base64,${downloaded.video.toString(
          'base64'
        )}`,
        mimeType: downloaded.mimeType,
        metadata: { ...job.options, usage: status.usage || null },
      }
    );
    res.json({
      success: true,
      data: {
        ...(await publicJob(job, id)),
        status: 'completed',
        media: publicMedia(media),
      },
    });
  } catch (error) {
    if (requestAbort.signal.aborted) return;
    logger.error('Video generation polling failed:', error);
    res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : 'Video polling failed',
    });
  } finally {
    releaseJobLock?.();
    requestAbort.cleanup();
  }
}

router.get('/video/jobs/:jobId', pollingRateLimiter, resumeVideoJob);

router.post('/video/jobs/:jobId/resume', pollingRateLimiter, resumeVideoJob);

router.delete(
  '/video/jobs/:jobId',
  generationRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    let releaseJobLock: (() => void) | undefined;
    try {
      const id = userId(req);
      const jobId = Array.isArray(req.params.jobId)
        ? req.params.jobId[0]
        : req.params.jobId;
      releaseJobLock = await acquireVideoJobLock(`${id}:${jobId}`);
      if (requestAbort.signal.aborted) return;
      const job = await mediaGenerationJobService.get(jobId, id);
      if (!job) {
        res
          .status(404)
          .json({ success: false, message: 'Video job not found' });
        return;
      }
      if (job.status === 'completed' || job.status === 'failed') {
        res.status(409).json({
          success: false,
          message: 'Only an active video job can be cancelled',
        });
        return;
      }
      if (job.providerJobId === 'libre:prepared') {
        res.status(409).json({
          success: false,
          message: 'The provider submission is still being reconciled',
        });
        return;
      }
      if (
        !(await pluginService.canCancelVideoGenRequest(
          job.model,
          job.pluginId,
          id
        ))
      ) {
        res.status(409).json({
          success: false,
          message:
            'The selected video provider does not declare job cancellation',
        });
        return;
      }
      await pluginService.cancelVideoGenRequest(
        job.model,
        job.providerJobId,
        job.pluginId,
        id,
        requestAbort.signal
      );
      const durable = await getDurableJobRuntime().service.getByIdempotency(
        id,
        VIDEO_RESUME_IDEMPOTENCY_SCOPE,
        job.id
      );
      if (
        durable &&
        (durable.state === 'queued' || durable.state === 'running')
      ) {
        await getDurableJobRuntime().service.cancel(
          durable.id,
          id,
          'user-requested'
        );
      }
      await mediaGenerationJobService.remove(job.id, id);
      if (requestAbort.signal.aborted) return;
      res.json({ success: true });
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      const unsupported = error instanceof VideoCancellationUnsupportedError;
      logger.error('Video generation cancellation failed:', error);
      res.status(unsupported ? 409 : 500).json({
        success: false,
        message:
          error instanceof Error ? error.message : 'Video cancellation failed',
      });
    } finally {
      releaseJobLock?.();
      requestAbort.cleanup();
    }
  }
);

async function acquireVideoJobLock(key: string): Promise<() => void> {
  const previous = videoJobLocks.get(key) || Promise.resolve();
  let release = () => {};
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => held);
  videoJobLocks.set(key, tail);
  await previous.catch(() => undefined);
  return () => {
    release();
    if (videoJobLocks.get(key) === tail) videoJobLocks.delete(key);
  };
}

router.get(
  '/gallery',
  galleryRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const kind = req.query.kind;
    if (kind && !['image', 'video', 'audio'].includes(String(kind))) {
      res.status(400).json({ success: false, message: 'Invalid media kind' });
      return;
    }
    const result = await galleryService.getMedia(userId(req), {
      limit: Number(req.query.limit) || 20,
      offset: Number(req.query.offset) || 0,
      ...(kind ? { kind: kind as GeneratedMediaKind } : {}),
    });
    res.json({
      success: true,
      data: { ...result, media: result.media.map(publicMedia) },
    });
  }
);

router.get(
  '/gallery/:mediaId/content',
  galleryRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    const mediaId = Array.isArray(req.params.mediaId)
      ? req.params.mediaId[0]
      : req.params.mediaId;
    try {
      const rawRange = req.headers.range;
      let range: { start: number; end?: number } | undefined;
      if (rawRange) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rawRange.trim());
        if (!match) {
          res.status(416).set('Accept-Ranges', 'bytes').end();
          return;
        }
        range = {
          start: Number(match[1]),
          ...(match[2] ? { end: Number(match[2]) } : {}),
        };
      }
      const opened = await galleryService.openMediaContent(
        mediaId,
        userId(req),
        range,
        requestAbort.signal
      );
      if (!opened) {
        res.status(404).json({ success: false, message: 'Media not found' });
        return;
      }
      if (!isSafeMediaMimeType(opened.record.kind, opened.record.mimeType)) {
        res
          .status(422)
          .json({ success: false, message: 'Stored media type is invalid' });
        return;
      }
      res.status(opened.content.range ? 206 : 200);
      res.set({
        'Content-Type': opened.record.mimeType,
        'Content-Length': String(
          opened.content.range?.length ?? opened.content.descriptor.size
        ),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=300',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'X-Content-Type-Options': 'nosniff',
      });
      if (opened.content.range) {
        res.set(
          'Content-Range',
          `bytes ${opened.content.range.start}-${opened.content.range.end}/${opened.content.range.total}`
        );
      }
      opened.content.body.on('error', error => res.destroy(error));
      opened.content.body.pipe(res);
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'invalid-range'
      ) {
        res.status(416).set('Accept-Ranges', 'bytes').end();
        return;
      }
      logger.error('Gallery media stream failed:', error);
      res.status(500).json({ success: false, message: 'Failed to read media' });
    } finally {
      requestAbort.cleanup();
    }
  }
);

router.delete(
  '/gallery/:mediaId',
  galleryRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const mediaId = Array.isArray(req.params.mediaId)
      ? req.params.mediaId[0]
      : req.params.mediaId;
    const deleted = await galleryService.deleteMedia(mediaId, userId(req));
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

async function publicJob(
  job: {
    id: string;
    status: string;
    model: string;
    pluginId: string;
    galleryId?: string;
    error?: string;
    createdAt: number;
    updatedAt: number;
    prompt?: string;
    providerJobId?: string;
  },
  id: string
): Promise<Record<string, unknown>> {
  return {
    id: job.id,
    status: job.status,
    model: job.model,
    pluginId: job.pluginId,
    galleryId: job.galleryId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    prompt: job.prompt,
    cancellable:
      (job.status === 'pending' || job.status === 'in_progress') &&
      job.providerJobId !== 'libre:prepared' &&
      (await pluginService.canCancelVideoGenRequest(
        job.model,
        job.pluginId,
        id
      )),
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
