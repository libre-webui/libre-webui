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

import express, { Response } from 'express';
import rateLimit from 'express-rate-limit';

import {
  authenticate,
  requireAdmin,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { type ApiResponse, getErrorMessage } from '../types/index.js';
import systemDiagnosticsService, {
  type SystemDiagnostics,
} from '../services/systemDiagnosticsService.js';

const router = express.Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    keyGenerator: req =>
      `user:${(req as AuthenticatedRequest).user?.userId ?? 'unknown'}`,
    message: {
      success: false,
      error: 'Too many system diagnostics requests, please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
  })
);

router.get(
  '/',
  async (
    _req: AuthenticatedRequest,
    res: Response<ApiResponse<SystemDiagnostics>>
  ): Promise<void> => {
    try {
      const diagnostics = await systemDiagnosticsService.getDiagnostics();
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: diagnostics });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to collect system diagnostics'),
      });
    }
  }
);

export default router;
