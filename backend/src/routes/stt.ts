/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import express, { type Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authenticate, type AuthenticatedRequest } from '../middleware/auth.js';
import pluginService from '../services/pluginService.js';
import { STTProviderResponseError } from '../services/pluginSTTService.js';
import { createLogger } from '../utils/logger.js';
import {
  parseSTTAudioUpload,
  STTAudioUploadError,
  validateSTTAudio,
} from '../utils/sttAudioUpload.js';

const logger = createLogger('routes:stt');
const router = express.Router();

router.use(authenticate);
router.use(
  rateLimit({
    windowMs: 60_000,
    max: 30,
    keyGenerator: req =>
      (req as AuthenticatedRequest).user?.userId || 'unauthenticated',
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      message: 'Too many speech-to-text requests, please try again later',
    },
  })
);

const activeByUser = new Map<string, number>();
let activeGlobal = 0;
const MAX_ACTIVE_PER_USER = 2;
const MAX_ACTIVE_GLOBAL = 6;

function userId(req: AuthenticatedRequest): string {
  if (!req.user) throw new Error('Authenticated user context is required');
  return req.user.userId;
}

function reserveTranscriptionSlot(id: string): () => void {
  const active = activeByUser.get(id) || 0;
  if (active >= MAX_ACTIVE_PER_USER || activeGlobal >= MAX_ACTIVE_GLOBAL) {
    throw new Error('Too many concurrent speech-to-text requests');
  }
  activeByUser.set(id, active + 1);
  activeGlobal += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeGlobal = Math.max(0, activeGlobal - 1);
    const remaining = (activeByUser.get(id) || 1) - 1;
    if (remaining > 0) activeByUser.set(id, remaining);
    else activeByUser.delete(id);
  };
}

export function requestAbortSignal(
  req: AuthenticatedRequest,
  res: Response
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('STT client disconnected'));
    }
  };
  const responseClosed = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', responseClosed);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', abort);
      res.off('close', responseClosed);
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
    await pluginService.refreshStaleCapabilityModels('stt', id);
    res.json({
      success: true,
      data: await pluginService.getAvailableSTTModels(id),
    });
  } catch (error) {
    logger.error('Failed to load speech-to-text models:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load speech-to-text models',
    });
  }
});

router.post('/transcribe', async (req: AuthenticatedRequest, res) => {
  const abort = requestAbortSignal(req, res);
  let releaseSlot: (() => void) | undefined;
  try {
    if (abort.signal.aborted) return;
    const id = userId(req);
    // Reserve before multer buffers the recording. The same per-user/global
    // ceiling therefore bounds both upload memory and provider work.
    releaseSlot = reserveTranscriptionSlot(id);
    await parseSTTAudioUpload(req, res);
    if (abort.signal.aborted) return;
    const { model, pluginId, language, prompt } = req.body || {};
    if (typeof model !== 'string' || typeof pluginId !== 'string') {
      res.status(400).json({
        success: false,
        message: 'model and pluginId are required',
      });
      return;
    }
    if (
      language !== undefined &&
      (typeof language !== 'string' ||
        !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language))
    ) {
      res.status(400).json({
        success: false,
        message: 'language must be a valid BCP 47 language tag',
      });
      return;
    }
    if (
      prompt !== undefined &&
      (typeof prompt !== 'string' || prompt.length > 1000)
    ) {
      res.status(400).json({
        success: false,
        message: 'prompt must be a string of at most 1000 characters',
      });
      return;
    }

    const selected = (await pluginService.getAvailableSTTModels(id)).find(
      entry => entry.model === model && entry.plugin === pluginId
    );
    if (!selected) {
      res.status(404).json({
        success: false,
        message: 'The selected speech-to-text model is not available',
      });
      return;
    }
    const audio = validateSTTAudio(req.file, selected.config);
    if (abort.signal.aborted) return;
    const result = await pluginService.executeSTTRequest(model, audio, {
      pluginId,
      userId: id,
      ...(language ? { language } : {}),
      ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
      signal: abort.signal,
    });
    if (!abort.signal.aborted) {
      res.json({ success: true, data: result });
    }
  } catch (error) {
    if (abort.signal.aborted) return;
    if (error instanceof STTProviderResponseError) {
      logger.warn(
        `Speech provider returned status ${error.providerStatus} during transcription`
      );
      res.status(providerResponseStatus(error.providerStatus)).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof STTAudioUploadError) {
      res.status(error.code === 'file_too_large' ? 413 : 400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        success: false,
        message:
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Audio recording is too large'
            : 'Invalid speech-to-text upload',
      });
      return;
    }
    const message =
      error instanceof Error ? error.message : 'Speech transcription failed';
    if (/concurrent speech-to-text/i.test(message)) {
      res.status(429).json({ success: false, message });
      return;
    }
    if (/cancelled|disconnected/i.test(message)) return;
    logger.error('Speech transcription failed:', error);
    res.status(500).json({
      success: false,
      message: 'Speech transcription failed',
    });
  } finally {
    abort.cleanup();
    releaseSlot?.();
  }
});

export default router;
