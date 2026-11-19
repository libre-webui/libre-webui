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
 * The Decisions API: list the decision models a user can reach and ask one
 * of them typed questions. The access mode is read on every request and the
 * admin toggle lives under /access.
 */

import express, { Response } from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  decisionAccessModeLockedByEnv,
  getDecisionAccessMode,
  isDecisionAccessMode,
  setDecisionAccessMode,
  userIdCanUseDecisionModels,
} from '../services/decisionAccessService.js';
import {
  DecisionAccessError,
  DecisionModelNotFoundError,
  getDecisionService,
} from '../services/decisionService.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import {
  DecisionProviderError,
  DecisionValidationError,
  parseDecisionInput,
} from '../utils/decisionProtocol.js';
import { getErrorMessage } from '../types/index.js';
import { isProviderRequestCancelled } from '../utils/providerFetch.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:decisions');
const router = express.Router();

router.use(
  rateLimit({
    keyPrefix: 'decisions',
    windowMs: 60_000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
  authenticate
);

router.get('/access', async (req: AuthenticatedRequest, res: Response) => {
  res.json({
    success: true,
    data: {
      mode: await getDecisionAccessMode(),
      lockedByEnv: decisionAccessModeLockedByEnv(),
      allowed: await userIdCanUseDecisionModels(req.user?.userId),
    },
  });
});

router.put(
  '/access',
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    if (decisionAccessModeLockedByEnv()) {
      res.status(409).json({
        success: false,
        error: 'An environment variable pins this setting',
      });
      return;
    }
    const mode = (req.body as { mode?: unknown })?.mode;
    if (!isDecisionAccessMode(mode)) {
      res.status(400).json({
        success: false,
        error: 'mode must be "admins" or "all-users".',
      });
      return;
    }
    await setDecisionAccessMode(mode);
    recordAuditEvent({
      actorUserId: req.user?.userId,
      action: 'decision-access.mode.update',
      targetType: 'feature',
      targetId: 'decision-models',
      result: 'success',
      details: { mode },
    });
    res.json({ success: true, data: { mode } });
  }
);

router.get(
  '/models',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const userId = req.user?.userId;
      const allowed = await userIdCanUseDecisionModels(userId);
      const models = await (await getDecisionService()).listModels(userId);
      // The list is returned either way so the pickers can tell a decision
      // model apart from a chat model; `allowed` says whether it can run.
      res.json({ success: true, data: { allowed, models } });
    } catch (error) {
      logger.error('Failed to list decision models:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to list decision models'),
      });
    }
  }
);

router.post(
  '/',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.model !== 'string' || !body.model.trim()) {
        throw new DecisionValidationError('model is required.');
      }
      const providerType =
        body.providerType === 'ollama' || body.providerType === 'plugin'
          ? body.providerType
          : undefined;
      const providerId =
        typeof body.providerId === 'string' && body.providerId.trim()
          ? body.providerId.trim()
          : undefined;
      const input = parseDecisionInput(body);
      const outcome = await (
        await getDecisionService()
      ).decide(
        req.user?.userId || 'default',
        { model: body.model.trim(), providerType, providerId, input },
        controller.signal
      );
      res.json({ success: true, data: outcome });
    } catch (error) {
      if (controller.signal.aborted || isProviderRequestCancelled(error)) {
        return;
      }
      if (error instanceof DecisionAccessError) {
        res.status(403).json({ success: false, error: error.message });
        return;
      }
      if (error instanceof DecisionModelNotFoundError) {
        res.status(404).json({ success: false, error: error.message });
        return;
      }
      if (error instanceof DecisionValidationError) {
        res.status(400).json({ success: false, error: error.message });
        return;
      }
      if (error instanceof DecisionProviderError) {
        res.status(502).json({
          success: false,
          error: error.message,
          ...(error.status ? { providerStatus: error.status } : {}),
        });
        return;
      }
      logger.error('Decision request failed:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'The decision request failed'),
      });
    }
  }
);

export default router;
