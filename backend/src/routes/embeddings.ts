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
import {
  ApiResponse,
  EmbeddingModel,
  getErrorMessage,
} from '../types/index.js';
import embeddingService from '../services/embeddingService.js';
import { AuthenticatedRequest, optionalAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(optionalAuth);

router.get(
  '/models',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<EmbeddingModel[]>>
  ): Promise<void> => {
    try {
      const models = await embeddingService.getAvailableModels(
        req.user?.userId
      );
      res.json({
        success: true,
        data: models,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get embedding models'),
      });
    }
  }
);

export default router;
