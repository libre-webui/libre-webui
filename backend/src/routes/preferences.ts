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
import preferencesService from '../services/preferencesService.js';
import {
  ApiResponse,
  UserPreferences,
  getErrorMessage,
} from '../types/index.js';

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

// Set generation options (convenience endpoint)
router.put(
  '/generation-options',
  async (
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const options = req.body;

      if (!options || typeof options !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Generation options are required',
        });
        return;
      }

      const updatedPreferences =
        preferencesService.setGenerationOptions(options);

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
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const updatedPreferences = preferencesService.resetGenerationOptions();

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
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const settings = req.body;

      if (!settings || typeof settings !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Embedding settings are required',
        });
        return;
      }

      const updatedPreferences =
        preferencesService.setEmbeddingSettings(settings);

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
    req: Request,
    res: Response<ApiResponse<UserPreferences>>
  ): Promise<void> => {
    try {
      const updatedPreferences = preferencesService.resetEmbeddingSettings();

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

// Export all user data
router.get('/export', async (req: Request, res: Response): Promise<void> => {
  try {
    // Import services here to avoid circular dependencies
    const chatService = (await import('../services/chatService.js')).default;
    const documentService = (await import('../services/documentService.js'))
      .default;

    // Get all user data
    const preferences = preferencesService.getPreferences();
    const sessions = chatService.getAllSessions();
    const documents = documentService.getDocuments();

    const exportData = {
      preferences,
      sessions,
      documents,
      exportedAt: new Date().toISOString(),
      version: '1.0',
      format: 'libre-webui-export',
    };

    // Set headers for file download
    const timestamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="libre-webui-export-${timestamp}.json"`
    );

    res.json(exportData);
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to export user data'),
    });
  }
});

// Import user data with duplicate detection
router.post('/import', async (req: Request, res: Response): Promise<void> => {
  try {
    const { data, mergeStrategy = 'skip' } = req.body;

    if (!data || typeof data !== 'object') {
      res.status(400).json({
        success: false,
        error: 'Invalid import data format',
      });
      return;
    }

    // Validate export format
    if (data.format !== 'libre-webui-export') {
      res.status(400).json({
        success: false,
        error:
          'Invalid export format. Please use a valid Libre WebUI export file.',
      });
      return;
    }

    // Import services here to avoid circular dependencies
    const chatService = (await import('../services/chatService.js')).default;
    const documentService = (await import('../services/documentService.js'))
      .default;

    const importResult = {
      preferences: { imported: false, error: null as string | null },
      sessions: { imported: 0, skipped: 0, errors: [] as string[] },
      documents: { imported: 0, skipped: 0, errors: [] as string[] },
    };

    // Import preferences (always overwrites)
    try {
      if (data.preferences) {
        preferencesService.updatePreferences(data.preferences);
        importResult.preferences.imported = true;
      }
    } catch (error) {
      importResult.preferences.error = getErrorMessage(
        error,
        'Failed to import preferences'
      );
    }

    // Import sessions with duplicate detection
    if (data.sessions && Array.isArray(data.sessions)) {
      const existingSessions = chatService.getAllSessions();
      const existingSessionIds = new Set(existingSessions.map(s => s.id));

      for (const session of data.sessions) {
        try {
          if (existingSessionIds.has(session.id)) {
            if (mergeStrategy === 'skip') {
              importResult.sessions.skipped++;
              continue;
            } else if (mergeStrategy === 'overwrite') {
              // Delete existing session first
              chatService.deleteSession(session.id);
            }
            // For 'merge' strategy, we'll let the service handle it
          }

          // Create the session
          const newSession = chatService.createSession(
            session.model,
            session.title
          );

          // Update with imported data
          chatService.updateSession(newSession.id, {
            id: session.id, // Use original ID
            messages: session.messages || [],
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          });

          importResult.sessions.imported++;
        } catch (error) {
          importResult.sessions.errors.push(
            `Session "${session.title || session.id}": ${getErrorMessage(error, 'Import failed')}`
          );
        }
      }
    }

    // Import documents with duplicate detection
    if (data.documents && Array.isArray(data.documents)) {
      const existingDocuments = documentService.getDocuments();
      const existingDocumentIds = new Set(existingDocuments.map(d => d.id));

      for (const document of data.documents) {
        try {
          if (existingDocumentIds.has(document.id)) {
            if (mergeStrategy === 'skip') {
              importResult.documents.skipped++;
              continue;
            } else if (mergeStrategy === 'overwrite') {
              // Delete existing document first
              documentService.deleteDocument(document.id);
            }
          }

          // Import the document by recreating it
          documentService.restoreDocument(document);
          importResult.documents.imported++;
        } catch (error) {
          importResult.documents.errors.push(
            `Document "${document.filename || document.id}": ${getErrorMessage(error, 'Import failed')}`
          );
        }
      }
    }

    res.json({
      success: true,
      data: importResult,
      message: 'Import completed successfully',
    });
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(error, 'Failed to import user data'),
    });
  }
});

export default router;
