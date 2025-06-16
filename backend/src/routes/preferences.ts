import express, { Request, Response } from 'express';
import preferencesService from '../services/preferencesService';
import { ApiResponse, UserPreferences } from '../types';

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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
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
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
      });
    }
  }
);

export default router;
