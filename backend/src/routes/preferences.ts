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
import preferencesService from '../services/preferencesService.js';
import {
  ApiResponse,
  UserPreferences,
  getErrorMessage,
} from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';

const router = express.Router();

// Rate limiter for preferences routes: 30 requests per minute (reasonable for settings)
const preferencesRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute
  message: {
    success: false,
    message: 'Too many preferences requests, please slow down',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiter to all preferences routes
router.use(preferencesRateLimiter);

// Apply authentication middleware to all preferences routes
router.use(authenticate);

// Get user preferences
router.get(
  '/',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const preferences = await preferencesService.getPreferences(userId);
      res.json({
        success: true,
        data: preferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get preferences'),
      });
    }
  }
);

// Update user preferences
router.put(
  '/',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const updates = req.body;
      const updatedPreferences = await preferencesService.updatePreferences(
        updates,
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update preferences'),
      });
    }
  }
);

// Set default model (convenience endpoint)
router.put(
  '/default-model',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const { model } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required',
        });
        return;
      }

      const updatedPreferences = await preferencesService.setDefaultModel(
        model,
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set default model'),
      });
    }
  }
);

// Set system message (convenience endpoint)
router.put(
  '/system-message',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const { message } = req.body;

      if (message === undefined) {
        res.status(400).json({
          success: false,
          error: 'Message is required',
        });
        return;
      }

      const updatedPreferences = await preferencesService.setSystemMessage(
        message,
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set system message'),
      });
    }
  }
);

// Set generation options (convenience endpoint)
router.put(
  '/generation-options',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const options = req.body;

      if (!options || typeof options !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Generation options are required',
        });
        return;
      }

      const updatedPreferences = await preferencesService.setGenerationOptions(
        options,
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set generation options'),
      });
    }
  }
);

// Reset generation options to defaults
router.post(
  '/generation-options/reset',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const updatedPreferences =
        await preferencesService.resetGenerationOptions(userId);

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to reset generation options'),
      });
    }
  }
);

// Set embedding settings
router.put(
  '/embedding-settings',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const settings = req.body;

      if (!settings || typeof settings !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Embedding settings are required',
        });
        return;
      }

      const updatedPreferences = await preferencesService.setEmbeddingSettings(
        settings,
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set embedding settings'),
      });
    }
  }
);

// Reset embedding settings to defaults
router.post(
  '/embedding-settings/reset',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const updatedPreferences =
        await preferencesService.resetEmbeddingSettings(userId);

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to reset embedding settings'),
      });
    }
  }
);

// Import preferences data
router.post(
  '/import',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          error: 'User ID not found in token',
        });
        return;
      }

      const { data, mergeStrategy } = req.body;

      if (!data) {
        res.status(400).json({
          success: false,
          error: 'Import data is required',
        });
        return;
      }

      if (mergeStrategy && !['merge', 'replace'].includes(mergeStrategy)) {
        res.status(400).json({
          success: false,
          error: 'Invalid merge strategy. Must be "merge" or "replace"',
        });
        return;
      }

      const updatedPreferences = await preferencesService.importData(
        data,
        mergeStrategy || 'merge',
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to import preferences data'),
      });
    }
  }
);

export default router;
