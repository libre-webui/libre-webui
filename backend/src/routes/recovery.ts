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

/** Administrator surface for verified recovery drills (RECOVERY-01). */

import express from 'express';
import rateLimit from '../middleware/sharedRateLimit.js';
import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import {
  RecoveryDrillError,
  drillIntervalHours,
  drillsSupported,
  listDrills,
  runDrill,
} from '../services/recoveryDrillService.js';
import { recordAuditEvent } from '../services/securityAuditService.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('recovery-routes');

const recoveryRateLimiter = rateLimit({
  keyPrefix: 'recovery',
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(recoveryRateLimiter, authenticate, requireAdmin);

/** Drill history plus the effective schedule configuration. */
router.get('/drills', async (_req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: {
        supported: drillsSupported(),
        intervalHours: drillIntervalHours(),
        drills: await listDrills(),
      },
    });
  } catch (error) {
    logger.error('Drill list error:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to list recovery drills' });
  }
});

/** Run a drill now. Refused while one is already running. */
router.post('/drills/run', async (req: AuthenticatedRequest, res) => {
  try {
    const drill = await runDrill({
      origin: 'manual',
      createdBy: req.user!.userId,
    });
    void recordAuditEvent({
      action: 'recovery.drill.run',
      result: drill?.status === 'passed' ? 'success' : 'failure',
      actorUserId: req.user!.userId,
      targetType: 'recovery-drill',
      ...(drill?.id ? { targetId: drill.id } : {}),
    });
    res.json({ success: true, data: drill });
  } catch (error) {
    if (error instanceof RecoveryDrillError) {
      res
        .status(error.statusCode)
        .json({ success: false, message: error.message });
      return;
    }
    logger.error('Drill run error:', error);
    res
      .status(500)
      .json({ success: false, message: 'The recovery drill failed to start' });
  }
});

export default router;
