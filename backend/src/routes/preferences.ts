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

import express, { Request, Response } from 'express';
import preferencesService from '../services/preferencesService';
import { ApiResponse, UserPreferences, getErrorMessage } from '../types';

const router = express.Router();

// Get user preferences
router.get(
  '/',
  async (
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const preferences = preferencesService.getPreferences();
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
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const updates = req.body;
      const updatedPreferences = preferencesService.updatePreferences(updates);

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
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const { model } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required',
        });
        return;
      }

      const updatedPreferences = preferencesService.setDefaultModel(model);

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
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const { message } = req.body;

      if (message === undefined) {
        res.status(400).json({
          success: false,
          error: 'Message is required',
        });
        return;
      }

      const updatedPreferences = preferencesService.setSystemMessage(message);

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

export default router;
