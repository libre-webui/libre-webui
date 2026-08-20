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

/**
 * Administrator control over the voice governance modes (AUDIO-03): who may
 * use speech-to-text, text-to-speech, hands-free voice mode, and voice
 * cloning. The backend enforces each mode on every request through the
 * central authorization service; this router only reads and writes the
 * persisted settings.
 */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  getVoiceAccessMode,
  isVoiceAccessMode,
  isVoiceFeatureKey,
  setVoiceAccessMode,
  VOICE_FEATURE_KEYS,
  voiceAccessModeLockedByEnv,
} from '../services/voiceAccessService.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:voice-access');
const router = express.Router();

const voiceAccessRateLimiter = rateLimit({
  keyPrefix: 'voice-access',
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(voiceAccessRateLimiter, authenticate, requireAdmin);

router.get('/', async (_req, res) => {
  try {
    const data: Record<string, { mode: string; lockedByEnv: boolean }> = {};
    for (const feature of VOICE_FEATURE_KEYS) {
      data[feature] = {
        mode: await getVoiceAccessMode(feature),
        lockedByEnv: voiceAccessModeLockedByEnv(feature),
      };
    }
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to read voice access modes:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to read voice access modes',
    });
  }
});

router.put('/:feature', async (req: AuthenticatedRequest, res) => {
  try {
    const feature = req.params.feature;
    if (!isVoiceFeatureKey(feature)) {
      res
        .status(400)
        .json({ success: false, message: 'Unknown voice feature' });
      return;
    }
    if (voiceAccessModeLockedByEnv(feature)) {
      res.status(409).json({
        success: false,
        message: 'An environment variable pins this setting',
      });
      return;
    }
    const mode = (req.body as { mode?: unknown })?.mode;
    if (!isVoiceAccessMode(mode)) {
      res
        .status(400)
        .json({ success: false, message: 'Invalid voice access mode' });
      return;
    }
    await setVoiceAccessMode(feature, mode);
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'voice-access.mode.update',
      targetType: 'feature',
      targetId: feature,
      result: 'success',
      details: { mode },
    });
    res.json({ success: true, data: { feature, mode } });
  } catch (error) {
    logger.error('Failed to update the voice access mode:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update the voice access mode',
    });
  }
});

export default router;
