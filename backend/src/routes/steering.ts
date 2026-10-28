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
 * Model steering: the vectors a chat model's server offers, for the chat
 * controls, and the administrator's choice of who may use them. The mix
 * itself travels with a chat's generation options and is checked again on
 * every request by the plugin service.
 */

import express from 'express';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import pluginService from '../services/pluginService.js';
import {
  getSteeringAccessMode,
  isSteeringAccessMode,
  setSteeringAccessMode,
  steeringAccessModeLockedByEnv,
  userCanSteer,
} from '../services/steeringService.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import { createLogger } from '../utils/logger.js';
import type { ApiResponse } from '../types/index.js';

const logger = createLogger('routes:steering');
const router = express.Router();

router.use(authenticate);

const queryText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : undefined;

router.get('/vectors', async (req: AuthenticatedRequest, res) => {
  const model = queryText(req.query.model, 512);
  if (!model) {
    res.status(400).json({ success: false, error: 'A model is required' });
    return;
  }
  const providerId = queryText(req.query.providerId, 128);
  try {
    const userId = req.user?.userId;
    if (!(await userCanSteer(userId))) {
      res.json({
        success: true,
        data: { allowed: false, supported: false, vectors: [] },
      } as ApiResponse);
      return;
    }
    const controller = new AbortController();
    // Someone who closes the panel stops the ask, which on a llama-swap
    // proxy can otherwise go on to load the model.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const vectors = await pluginService.getSteeringVectors(
      model,
      userId,
      providerId,
      controller.signal
    );
    res.json({
      success: true,
      data: {
        allowed: true,
        supported: Boolean(vectors && vectors.length > 0),
        vectors: vectors ?? [],
      },
    } as ApiResponse);
  } catch (error) {
    logger.error('Failed to list steering vectors:', error);
    res
      .status(502)
      .json({ success: false, error: 'Failed to list steering vectors' });
  }
});

router.get('/access', requireAdmin, async (_req, res) => {
  try {
    res.json({
      success: true,
      data: {
        mode: await getSteeringAccessMode(),
        lockedByEnv: steeringAccessModeLockedByEnv(),
      },
    } as ApiResponse);
  } catch (error) {
    logger.error('Failed to read the steering access mode:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to read the steering access mode',
    });
  }
});

router.put('/access', requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    if (steeringAccessModeLockedByEnv()) {
      res.status(409).json({
        success: false,
        error: 'STEERING_ACCESS_MODE pins this setting',
      } as ApiResponse);
      return;
    }
    const mode = (req.body as { mode?: unknown })?.mode;
    if (!isSteeringAccessMode(mode)) {
      res
        .status(400)
        .json({ success: false, error: 'Invalid steering access mode' });
      return;
    }
    await setSteeringAccessMode(mode);
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'steering-access.mode.update',
      targetType: 'feature',
      targetId: 'steering',
      result: 'success',
      details: { mode },
    });
    res.json({ success: true, data: { mode } } as ApiResponse);
  } catch (error) {
    logger.error('Failed to update the steering access mode:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update the steering access mode',
    });
  }
});

export default router;
