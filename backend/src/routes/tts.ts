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

import express, { type Response } from 'express';
import multer from 'multer';
import rateLimit from '../middleware/sharedRateLimit.js';
import pluginService from '../services/pluginService.js';
import {
  authenticate,
  requireFeature,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { createLogger } from '../utils/logger.js';
import {
  parseTTSVoiceCloneUpload,
  reserveTTSVoiceCloneUpload,
  TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES,
  TTSVoiceCloneConcurrencyError,
  TTSVoiceCloneUploadError,
  validateTTSVoiceCloneAudio,
} from '../utils/ttsVoiceCloneUpload.js';
import {
  TTSConcurrencyError,
  TTSProviderResponseError,
} from '../services/pluginTTSService.js';
import voiceProfileService from '../services/voiceProfileService.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import type { Plugin } from '../types/index.js';
import {
  acquireSharedCapacity,
  combineAbortSignals,
  SharedCapacityExceededError,
  SharedCapacityUnavailableError,
  type SharedCapacityReservation,
} from '../platform/coordination/sharedAdmission.js';

const logger = createLogger('routes:tts');

const router = express.Router();
router.use(authenticate);
router.use(requireFeature('tts'));

const TTS_RESPONSE_FORMATS = [
  'mp3',
  'opus',
  'aac',
  'flac',
  'wav',
  'pcm',
] as const;

type TTSResponseFormat = (typeof TTS_RESPONSE_FORMATS)[number];

const isTTSResponseFormat = (value: unknown): value is TTSResponseFormat =>
  typeof value === 'string' &&
  (TTS_RESPONSE_FORMATS as readonly string[]).includes(value);

const ttsContentType = (format: TTSResponseFormat): string =>
  ({
    mp3: 'audio/mpeg',
    opus: 'audio/opus',
    aac: 'audio/aac',
    flac: 'audio/flac',
    wav: 'audio/wav',
    pcm: 'audio/pcm',
  })[format];

const providerResponseStatus = (status: number): number =>
  status === 401 || status === 403
    ? 502
    : status >= 400 && status < 500
      ? status
      : 502;

// Sentence-aware playback can issue many small provider-safe batches. Keep a
// bounded per-minute ceiling while allowing a long response to finish.
const ttsRateLimiter = rateLimit({
  keyPrefix: 'text-to-speech',
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: {
    success: false,
    message: 'Too many TTS requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Voice cloning carries a memory-backed upload and is substantially more
// expensive than one sentence batch. Limit it independently per account.
const voiceCloneRateLimiter = rateLimit({
  keyPrefix: 'voice-cloning',
  windowMs: 60 * 1000,
  max: 6,
  keyGenerator: req =>
    (req as AuthenticatedRequest).user?.userId || 'unauthenticated',
  message: {
    success: false,
    message: 'Too many voice-cloning requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const MAX_REUSABLE_VOICE_REQUESTS_PER_USER = 4;
const MAX_REUSABLE_VOICE_REQUESTS_GLOBAL = 8;

class ReusableVoiceConcurrencyError extends Error {
  constructor() {
    super('Too many concurrent saved-voice requests');
    this.name = 'ReusableVoiceConcurrencyError';
  }
}

async function withReusableVoiceSlot<T>(
  userId: string,
  clientSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  let slot: SharedCapacityReservation;
  try {
    slot = await acquireSharedCapacity({
      limits: [
        {
          scope: 'saved-voice.global',
          capacity: MAX_REUSABLE_VOICE_REQUESTS_GLOBAL,
        },
        {
          scope: 'saved-voice.user',
          subject: userId,
          capacity: MAX_REUSABLE_VOICE_REQUESTS_PER_USER,
        },
      ],
    });
  } catch (error) {
    if (error instanceof SharedCapacityExceededError) {
      throw new ReusableVoiceConcurrencyError();
    }
    throw error;
  }
  try {
    return await operation(combineAbortSignals(clientSignal, slot.signal));
  } finally {
    await slot.release();
  }
}

function authenticatedUserId(req: AuthenticatedRequest): string {
  if (!req.user) throw new Error('Authenticated user context is required');
  return req.user.userId;
}

function requestString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function requestAbortSignal(
  req: AuthenticatedRequest,
  res: Response
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('TTS client disconnected'));
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

async function selectedCloningPlugin(
  model: string,
  pluginId: string | undefined,
  userId: string
) {
  const plugin = await pluginService.getPluginForTTS(model, pluginId, userId);
  const config = plugin?.capabilities?.tts?.config;
  if (!plugin) throw new Error(`No TTS plugin found for model: ${model}`);
  if (!config?.supports_voice_cloning) {
    throw new Error(`TTS plugin ${plugin.id} does not support voice cloning`);
  }
  return { plugin, config };
}

async function assertProfileRoutingIsCurrent(
  profile: { routingFingerprint: string },
  plugin: Plugin,
  userId: string
): Promise<void> {
  if (
    profile.routingFingerprint !==
    (await pluginService.getCredentialRoutingAuthFingerprint(plugin, userId))
  ) {
    throw new Error(
      'Saved voice provider routing changed; create a new profile to consent to the current endpoint'
    );
  }
}

function profileRequestStatus(message: string): number {
  if (/consent for this saved voice/i.test(message)) return 403;
  if (/not found/i.test(message)) return 404;
  if (/Database is not available/i.test(message)) return 503;
  if (
    /required|invalid|maximum|must be at most|unsupported|does not support|requires/i.test(
      message
    )
  ) {
    return 400;
  }
  return 500;
}

/** Metadata only: reference recordings and transcripts are never returned. */
router.get(
  '/voice-profiles',
  requireFeature('voice-cloning'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const pluginId = requestString(req.query.pluginId);
      const model = requestString(req.query.model);
      res.json({
        success: true,
        data: await voiceProfileService.list(authenticatedUserId(req), {
          ...(pluginId ? { pluginId } : {}),
          ...(model ? { model } : {}),
        }),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to list voice profiles';
      logger.error('Failed to list voice profiles:', error);
      res
        .status(profileRequestStatus(message))
        .json({ success: false, message });
    }
  }
);

/** Withdraw consent for a saved voice; the profile row stays as a receipt. */
router.post(
  '/voice-profiles/:profileId/revoke',
  requireFeature('voice-cloning'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const profileId = Array.isArray(req.params.profileId)
        ? req.params.profileId[0]
        : req.params.profileId;
      const userId = authenticatedUserId(req);
      if (!(await voiceProfileService.revoke(profileId, userId))) {
        res.status(404).json({
          success: false,
          message: 'Voice profile not found or already revoked',
        });
        return;
      }
      recordAuditEvent({
        actorUserId: userId,
        action: 'voice-profile.consent.revoke',
        targetType: 'voice-profile',
        targetId: profileId,
        result: 'success',
      });
      res.json({
        success: true,
        data: await voiceProfileService.getMetadata(profileId, userId),
      });
    } catch (error) {
      logger.error('Failed to revoke voice profile consent:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to revoke voice profile consent',
      });
    }
  }
);

router.delete(
  '/voice-profiles/:profileId',
  requireFeature('voice-cloning'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const profileId = Array.isArray(req.params.profileId)
        ? req.params.profileId[0]
        : req.params.profileId;
      if (
        !(await voiceProfileService.delete(profileId, authenticatedUserId(req)))
      ) {
        res
          .status(404)
          .json({ success: false, message: 'Voice profile not found' });
        return;
      }
      res.status(204).send();
    } catch (error) {
      logger.error('Failed to delete voice profile:', error);
      res
        .status(500)
        .json({ success: false, message: 'Failed to delete voice profile' });
    }
  }
);

/**
 * GET /api/tts/models
 * Get all available TTS models from plugins
 */
router.get('/models', async (req: AuthenticatedRequest, res) => {
  try {
    await pluginService.refreshStaleCapabilityModels('tts', req.user?.userId);
    const models = await pluginService.getAvailableTTSModels(req.user?.userId);
    res.json({
      success: true,
      data: models,
    });
  } catch (error) {
    logger.error('Failed to get TTS models:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get TTS models',
    });
  }
});

/**
 * GET /api/tts/voices/:pluginId
 * Get available voices for a specific TTS plugin
 */
router.get('/voices/:pluginId', async (req: AuthenticatedRequest, res) => {
  try {
    const pluginId = req.params.pluginId as string;
    const config = await pluginService.getTTSConfig(pluginId, req.user?.userId);

    if (!config) {
      res.status(404).json({
        success: false,
        message: 'TTS plugin not found or has no TTS configuration',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        voices: config.voices || [],
        default_voice: config.default_voice,
        formats: config.formats || ['mp3'],
        default_format: config.default_format || 'mp3',
        max_characters: config.max_characters,
        supports_streaming: config.supports_streaming || false,
        supports_voice_cloning: config.supports_voice_cloning || false,
        clone_requires_transcript: config.clone_requires_transcript || false,
        clone_audio_mime_types: config.clone_audio_mime_types,
        clone_max_audio_bytes: config.clone_max_audio_bytes,
      },
    });
  } catch (error) {
    logger.error('Failed to get TTS voices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get TTS voices',
    });
  }
});

/**
 * POST /api/tts/generate
 * Generate speech from text using a TTS plugin
 */
router.post(
  '/generate',
  ttsRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    try {
      const {
        model,
        pluginId,
        input,
        voice,
        voiceProfileId,
        response_format,
        speed,
      } = req.body;

      // Validate required fields
      if (!model || typeof model !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Model is required and must be a string',
        });
        return;
      }

      if (!input || typeof input !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Input text is required and must be a string',
        });
        return;
      }

      if (
        pluginId !== undefined &&
        (typeof pluginId !== 'string' || pluginId.length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: 'pluginId must be a non-empty string when provided',
        });
        return;
      }
      if (
        voiceProfileId !== undefined &&
        (typeof voiceProfileId !== 'string' || voiceProfileId.length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: 'voiceProfileId must be a non-empty string when provided',
        });
        return;
      }
      if (voiceProfileId && voice !== undefined) {
        res.status(400).json({
          success: false,
          message: 'voice and voiceProfileId cannot be used together',
        });
        return;
      }

      if (input.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Input text cannot be empty',
        });
        return;
      }

      // Validate optional parameters
      if (speed !== undefined) {
        const speedNum = Number(speed);
        if (isNaN(speedNum) || speedNum < 0.25 || speedNum > 4.0) {
          res.status(400).json({
            success: false,
            message: 'Speed must be a number between 0.25 and 4.0',
          });
          return;
        }
      }

      const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
      if (response_format && !validFormats.includes(response_format)) {
        res.status(400).json({
          success: false,
          message: `Invalid response_format. Must be one of: ${validFormats.join(', ')}`,
        });
        return;
      }

      const userId = authenticatedUserId(req);
      const profileRoute = voiceProfileId
        ? await voiceProfileService.getMetadata(voiceProfileId, userId)
        : null;
      if (voiceProfileId && !profileRoute) {
        throw new Error('Voice profile not found');
      }
      if (
        profileRoute &&
        (profileRoute.model !== model ||
          (pluginId !== undefined && profileRoute.pluginId !== pluginId))
      ) {
        throw new Error(
          'Voice profile does not match the requested TTS plugin and model'
        );
      }
      const routedPluginId = profileRoute?.pluginId || pluginId;
      const selectedPlugin = await pluginService.getPluginForTTS(
        model,
        routedPluginId,
        userId
      );
      const configuredFormat =
        selectedPlugin?.capabilities?.tts?.config?.default_format;
      const format = isTTSResponseFormat(response_format)
        ? response_format
        : isTTSResponseFormat(configuredFormat)
          ? configuredFormat
          : 'mp3';

      let audioBuffer: Buffer;
      if (voiceProfileId && profileRoute) {
        const { plugin, config } = await selectedCloningPlugin(
          model,
          profileRoute.pluginId,
          userId
        );
        audioBuffer = await withReusableVoiceSlot(
          userId,
          requestAbort.signal,
          async sharedSignal => {
            const profile = await voiceProfileService.get(
              voiceProfileId,
              userId,
              config
            );
            if (!profile) throw new Error('Voice profile not found');
            await assertProfileRoutingIsCurrent(profile, plugin, userId);
            // Transfer receipt: the encrypted reference audio is about to be
            // resent to the provider for this generation.
            await voiceProfileService.recordTransfer(voiceProfileId, userId);
            return pluginService.executeVoiceCloneRequest(
              model,
              input,
              profile.referenceAudio,
              {
                referenceText: profile.referenceText,
                response_format: format,
                pluginId: profile.pluginId,
                userId,
                signal: sharedSignal,
              }
            );
          }
        );
      } else {
        audioBuffer = await pluginService.executeTTSRequest(model, input, {
          voice,
          response_format: format,
          speed,
          pluginId,
          userId,
          signal: requestAbort.signal,
        });
      }

      if (requestAbort.signal.aborted) return;

      // Determine content type based on format
      const contentTypeMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        opus: 'audio/opus',
        aac: 'audio/aac',
        flac: 'audio/flac',
        wav: 'audio/wav',
        pcm: 'audio/pcm',
      };

      const contentType = contentTypeMap[format] || 'audio/mpeg';

      // Set response headers
      res.set({
        'Content-Type': contentType,
        'Content-Length': audioBuffer.length.toString(),
        'Content-Disposition': `inline; filename="speech.${format}"`,
      });

      // Send audio data
      res.send(audioBuffer);
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      if (error instanceof TTSConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof ReusableVoiceConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof SharedCapacityUnavailableError) {
        res.status(503).json({
          success: false,
          message: 'TTS admission is temporarily unavailable',
        });
        return;
      }
      if (error instanceof TTSVoiceCloneUploadError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof TTSProviderResponseError) {
        logger.warn(
          `TTS provider returned status ${error.providerStatus} during generation`
        );
        res.status(providerResponseStatus(error.providerStatus)).json({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error('TTS generation failed:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Determine appropriate status code
      let statusCode = 500;
      if (errorMessage.includes('No TTS plugin found')) {
        statusCode = 404;
      } else if (errorMessage.includes('Voice profile not found')) {
        statusCode = 404;
      } else if (errorMessage.includes('Consent for this saved voice')) {
        statusCode = 403;
      } else if (errorMessage.includes('API key not found')) {
        statusCode = 503; // Service unavailable
      } else if (
        errorMessage.includes('exceeds maximum length') ||
        errorMessage.includes('does not match') ||
        errorMessage.includes('provider routing changed') ||
        errorMessage.includes('cannot be used together') ||
        errorMessage.includes('does not support voice cloning') ||
        errorMessage.includes('requires a reference audio transcript')
      ) {
        statusCode = 400;
      }

      res.status(statusCode).json({
        success: false,
        message: errorMessage,
      });
    } finally {
      requestAbort.cleanup();
    }
  }
);

/**
 * POST /api/tts/voice-clone
 * Generate speech using an ephemeral reference-audio sample. The sample is
 * held in memory only and is never written to storage.
 */
router.post(
  '/voice-clone',
  requireFeature('voice-cloning'),
  voiceCloneRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    let uploadSlot: SharedCapacityReservation | undefined;
    try {
      const userId = authenticatedUserId(req);
      uploadSlot = await reserveTTSVoiceCloneUpload(userId);
      const operationSignal = combineAbortSignals(
        requestAbort.signal,
        uploadSlot.signal
      );
      await parseTTSVoiceCloneUpload(req, res, operationSignal);

      const {
        model,
        pluginId,
        input,
        referenceText,
        reference_text: legacyReferenceText,
        response_format,
        responseFormat,
      } = req.body || {};

      if (!model || typeof model !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Model is required and must be a string',
        });
        return;
      }
      if (!input || typeof input !== 'string' || input.trim().length === 0) {
        res.status(400).json({
          success: false,
          message: 'Input text is required and must be a non-empty string',
        });
        return;
      }
      if (
        pluginId !== undefined &&
        (typeof pluginId !== 'string' || pluginId.length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: 'pluginId must be a non-empty string when provided',
        });
        return;
      }

      const normalizedReferenceText = referenceText ?? legacyReferenceText;
      if (
        normalizedReferenceText !== undefined &&
        typeof normalizedReferenceText !== 'string'
      ) {
        res.status(400).json({
          success: false,
          message: 'referenceText must be a string when provided',
        });
        return;
      }

      const requestedFormat = response_format ?? responseFormat;
      if (
        requestedFormat !== undefined &&
        !isTTSResponseFormat(requestedFormat)
      ) {
        res.status(400).json({
          success: false,
          message: `Invalid response format. Must be one of: ${TTS_RESPONSE_FORMATS.join(', ')}`,
        });
        return;
      }

      const selectedPlugin = await pluginService.getPluginForTTS(
        model,
        pluginId,
        userId
      );
      if (!selectedPlugin) {
        res.status(404).json({
          success: false,
          message: `No TTS plugin found for model: ${model}`,
        });
        return;
      }
      const config = selectedPlugin.capabilities?.tts?.config;
      if (!config?.supports_voice_cloning) {
        res.status(400).json({
          success: false,
          message: `TTS plugin ${selectedPlugin.id} does not support voice cloning`,
        });
        return;
      }
      if (
        config.clone_requires_transcript &&
        (!normalizedReferenceText ||
          normalizedReferenceText.trim().length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: `TTS plugin ${selectedPlugin.id} requires a reference audio transcript for voice cloning`,
        });
        return;
      }

      const referenceAudio = validateTTSVoiceCloneAudio(req.file, config);
      const format = requestedFormat || config.default_format || 'wav';
      if (!isTTSResponseFormat(format)) {
        res.status(400).json({
          success: false,
          message: `Invalid configured response format: ${format}`,
        });
        return;
      }

      const audioBuffer = await pluginService.executeVoiceCloneRequest(
        model,
        input,
        referenceAudio,
        {
          referenceText: normalizedReferenceText,
          response_format: format,
          pluginId: selectedPlugin.id,
          userId,
          signal: operationSignal,
        }
      );

      if (operationSignal.aborted) return;

      res.set({
        'Content-Type': ttsContentType(format),
        'Content-Length': audioBuffer.length.toString(),
        'Content-Disposition': `inline; filename="speech.${format}"`,
      });
      res.send(audioBuffer);
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      if (error instanceof TTSConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof TTSVoiceCloneConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof SharedCapacityUnavailableError) {
        res.status(503).json({
          success: false,
          message: 'TTS admission is temporarily unavailable',
        });
        return;
      }
      if (error instanceof multer.MulterError) {
        logger.warn(`TTS voice-clone upload failed: ${error.code}`);
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
        logger.warn(`TTS voice-clone upload failed: ${error.code}`);
        res.status(400).json({
          success: false,
          message: error.message,
        });
        return;
      }
      if (error instanceof TTSProviderResponseError) {
        logger.warn(
          `TTS provider returned status ${error.providerStatus} during voice cloning`
        );
        res.status(providerResponseStatus(error.providerStatus)).json({
          success: false,
          message: error.message,
        });
        return;
      }

      logger.error('TTS voice cloning failed:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      let statusCode = 500;
      if (errorMessage.includes('No TTS plugin found')) {
        statusCode = 404;
      } else if (errorMessage.includes('API key not found')) {
        statusCode = 503;
      } else if (
        errorMessage.includes('does not support voice cloning') ||
        errorMessage.includes('requires a reference audio transcript') ||
        errorMessage.includes('exceeds maximum length')
      ) {
        statusCode = 400;
      }
      res.status(statusCode).json({
        success: false,
        message: errorMessage,
      });
    } finally {
      await uploadSlot?.release();
      requestAbort.cleanup();
    }
  }
);

/**
 * POST /api/tts/generate-base64
 * Generate speech from text and return as base64 encoded string
 * Useful for frontend playback without streaming
 */
router.post(
  '/generate-base64',
  ttsRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    try {
      const {
        model,
        pluginId,
        input,
        voice,
        voiceProfileId,
        response_format,
        speed,
      } = req.body;

      // Validate required fields
      if (!model || typeof model !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Model is required and must be a string',
        });
        return;
      }

      if (!input || typeof input !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Input text is required and must be a string',
        });
        return;
      }

      if (
        pluginId !== undefined &&
        (typeof pluginId !== 'string' || pluginId.length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: 'pluginId must be a non-empty string when provided',
        });
        return;
      }
      if (
        voiceProfileId !== undefined &&
        (typeof voiceProfileId !== 'string' || voiceProfileId.length === 0)
      ) {
        res.status(400).json({
          success: false,
          message: 'voiceProfileId must be a non-empty string when provided',
        });
        return;
      }
      if (voiceProfileId && voice !== undefined) {
        res.status(400).json({
          success: false,
          message: 'voice and voiceProfileId cannot be used together',
        });
        return;
      }

      if (input.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Input text cannot be empty',
        });
        return;
      }

      // Validate optional parameters
      if (speed !== undefined) {
        const speedNum = Number(speed);
        if (isNaN(speedNum) || speedNum < 0.25 || speedNum > 4.0) {
          res.status(400).json({
            success: false,
            message: 'Speed must be a number between 0.25 and 4.0',
          });
          return;
        }
      }

      const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
      if (response_format && !validFormats.includes(response_format)) {
        res.status(400).json({
          success: false,
          message: `Invalid response_format. Must be one of: ${validFormats.join(', ')}`,
        });
        return;
      }

      const userId = authenticatedUserId(req);
      const profileRoute = voiceProfileId
        ? await voiceProfileService.getMetadata(voiceProfileId, userId)
        : null;
      if (voiceProfileId && !profileRoute) {
        throw new Error('Voice profile not found');
      }
      if (
        profileRoute &&
        (profileRoute.model !== model ||
          (pluginId !== undefined && profileRoute.pluginId !== pluginId))
      ) {
        throw new Error(
          'Voice profile does not match the requested TTS plugin and model'
        );
      }
      const routedPluginId = profileRoute?.pluginId || pluginId;
      const selectedPlugin = await pluginService.getPluginForTTS(
        model,
        routedPluginId,
        userId
      );
      const configuredFormat =
        selectedPlugin?.capabilities?.tts?.config?.default_format;
      const requestedFormat = isTTSResponseFormat(response_format)
        ? response_format
        : isTTSResponseFormat(configuredFormat)
          ? configuredFormat
          : 'mp3';

      let audioBuffer: Buffer;
      if (voiceProfileId && profileRoute) {
        const { plugin, config } = await selectedCloningPlugin(
          model,
          profileRoute.pluginId,
          userId
        );
        audioBuffer = await withReusableVoiceSlot(
          userId,
          requestAbort.signal,
          async sharedSignal => {
            const profile = await voiceProfileService.get(
              voiceProfileId,
              userId,
              config
            );
            if (!profile) throw new Error('Voice profile not found');
            await assertProfileRoutingIsCurrent(profile, plugin, userId);
            // Transfer receipt: the encrypted reference audio is about to be
            // resent to the provider for this generation.
            await voiceProfileService.recordTransfer(voiceProfileId, userId);
            return pluginService.executeVoiceCloneRequest(
              model,
              input,
              profile.referenceAudio,
              {
                referenceText: profile.referenceText,
                response_format: requestedFormat,
                pluginId: profile.pluginId,
                userId,
                signal: sharedSignal,
              }
            );
          }
        );
      } else {
        audioBuffer = await pluginService.executeTTSRequest(model, input, {
          voice,
          response_format: requestedFormat,
          speed,
          pluginId,
          userId,
          signal: requestAbort.signal,
        });
      }

      if (requestAbort.signal.aborted) return;

      // Auto-detect actual audio format from buffer header
      let detectedFormat = requestedFormat;
      if (audioBuffer.length >= 4) {
        const header = audioBuffer.slice(0, 4).toString('ascii');
        if (header === 'RIFF') {
          detectedFormat = 'wav';
        } else if (header === 'fLaC') {
          detectedFormat = 'flac';
        } else if (header === 'OggS') {
          detectedFormat = 'opus';
        } else if (
          audioBuffer[0] === 0xff &&
          (audioBuffer[1] & 0xe0) === 0xe0
        ) {
          detectedFormat = 'mp3';
        }
      }

      const format = detectedFormat;

      // Determine MIME type for data URL
      const mimeTypeMap: Record<string, string> = {
        mp3: 'audio/mpeg',
        opus: 'audio/opus',
        aac: 'audio/aac',
        flac: 'audio/flac',
        wav: 'audio/wav',
        pcm: 'audio/pcm',
      };

      const mimeType = mimeTypeMap[format] || 'audio/mpeg';

      // Return base64 encoded audio
      res.json({
        success: true,
        data: {
          audio: audioBuffer.toString('base64'),
          format,
          mimeType,
          size: audioBuffer.length,
        },
      });
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      if (error instanceof TTSConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof ReusableVoiceConcurrencyError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof SharedCapacityUnavailableError) {
        res.status(503).json({
          success: false,
          message: 'TTS admission is temporarily unavailable',
        });
        return;
      }
      if (error instanceof TTSVoiceCloneUploadError) {
        res.status(400).json({ success: false, message: error.message });
        return;
      }
      if (error instanceof TTSProviderResponseError) {
        logger.warn(
          `TTS provider returned status ${error.providerStatus} during base64 generation`
        );
        res.status(providerResponseStatus(error.providerStatus)).json({
          success: false,
          message: error.message,
        });
        return;
      }
      logger.error('TTS generation failed:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      let statusCode = 500;
      if (errorMessage.includes('No TTS plugin found')) {
        statusCode = 404;
      } else if (errorMessage.includes('Voice profile not found')) {
        statusCode = 404;
      } else if (errorMessage.includes('Consent for this saved voice')) {
        statusCode = 403;
      } else if (errorMessage.includes('API key not found')) {
        statusCode = 503;
      } else if (
        errorMessage.includes('exceeds maximum length') ||
        errorMessage.includes('does not match') ||
        errorMessage.includes('provider routing changed') ||
        errorMessage.includes('cannot be used together') ||
        errorMessage.includes('does not support voice cloning') ||
        errorMessage.includes('requires a reference audio transcript')
      ) {
        statusCode = 400;
      }

      res.status(statusCode).json({
        success: false,
        message: errorMessage,
      });
    } finally {
      requestAbort.cleanup();
    }
  }
);

/**
 * GET /api/tts/plugins
 * Get all plugins that support TTS capability
 */
router.get('/plugins', async (req: AuthenticatedRequest, res) => {
  try {
    await pluginService.refreshStaleCapabilityModels('tts', req.user?.userId);
    const plugins = await pluginService.getPluginsByCapability(
      'tts',
      req.user?.userId
    );
    res.json({
      success: true,
      data: plugins.map(p => ({
        id: p.id,
        name: p.name,
        models:
          p.capabilities?.tts?.model_map ||
          (p.type === 'tts' ? p.model_map : []),
        config: p.capabilities?.tts?.config,
      })),
    });
  } catch (error) {
    logger.error('Failed to get TTS plugins:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get TTS plugins',
    });
  }
});

export default router;
