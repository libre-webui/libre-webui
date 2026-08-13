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

import express, { type NextFunction, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import preferencesService from '../services/preferencesService.js';
import {
  ApiResponse,
  UserPreferences,
  getErrorMessage,
} from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { ChatProviderSelectionError } from '../utils/chatProviderSelection.js';
import dataArchiveService, {
  DataArchiveValidationError,
  type DataArchiveImportResult,
  type DataArchiveMergeStrategy,
  type DataArchivePreflight,
  type UserDataArchive,
} from '../services/dataArchiveService.js';
import { createLogger } from '../utils/logger.js';

const router = express.Router();
const logger = createLogger('routes:preferences');

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 1,
    fields: 1,
    // Busboy raises LIMIT_PART_COUNT when the configured count is reached,
    // so allow the two expected parts and reject any third part.
    parts: 3,
    fieldNameSize: 100,
    fieldSize: 32,
  },
  fileFilter: (_req, file, callback) => {
    if (
      file.mimetype === 'application/json' ||
      file.mimetype === 'text/json' ||
      file.mimetype === 'text/plain' ||
      !file.mimetype
    ) {
      callback(null, true);
      return;
    }
    callback(new Error('Portable archive must be a JSON file'));
  },
});

const activeArchiveImportsByUser = new Map<string, number>();
let activeArchiveImportsGlobal = 0;
const MAX_ACTIVE_ARCHIVE_IMPORTS_PER_USER = 1;
const MAX_ACTIVE_ARCHIVE_IMPORTS_GLOBAL = 2;

function reserveArchiveImport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const activeForUser = activeArchiveImportsByUser.get(userId) || 0;
  if (
    activeForUser >= MAX_ACTIVE_ARCHIVE_IMPORTS_PER_USER ||
    activeArchiveImportsGlobal >= MAX_ACTIVE_ARCHIVE_IMPORTS_GLOBAL
  ) {
    res.status(429).json({
      success: false,
      error: 'Another user data archive is already being processed',
    });
    return;
  }

  activeArchiveImportsByUser.set(userId, activeForUser + 1);
  activeArchiveImportsGlobal += 1;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeArchiveImportsGlobal = Math.max(0, activeArchiveImportsGlobal - 1);
    const remaining = (activeArchiveImportsByUser.get(userId) || 1) - 1;
    if (remaining > 0) activeArchiveImportsByUser.set(userId, remaining);
    else activeArchiveImportsByUser.delete(userId);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

function receiveArchiveFile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  archiveUpload.single('archive')(req, res, error => {
    if (!error) {
      next();
      return;
    }
    const tooLarge =
      error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: tooLarge
        ? 'Portable archive exceeds the 50 MB import limit'
        : getErrorMessage(error, 'Failed to read portable archive'),
    });
  });
}

function markArchiveNoStore(
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

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

      const preferences = preferencesService.getPreferences(userId);
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
      const updatedPreferences = preferencesService.updatePreferences(
        updates,
        userId
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
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

      const { model, providerType, providerId } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required',
        });
        return;
      }

      const updatedPreferences = preferencesService.setDefaultModel(
        model,
        userId,
        { providerType, providerId }
      );

      res.json({
        success: true,
        data: updatedPreferences,
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
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

      const updatedPreferences = preferencesService.setSystemMessage(
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

      const updatedPreferences = preferencesService.setGenerationOptions(
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

/**
 * Pins generation options for one model. Sending an empty object clears them,
 * returning that model to what its own modelfile recommends. Kept separate
 * from the generic preferences update, which shallow-merges and would drop
 * every other model's pinned options.
 */
router.put(
  '/model-generation-options',
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

      const { model, options } = req.body ?? {};

      if (typeof model !== 'string' || !model.trim()) {
        res.status(400).json({
          success: false,
          error: 'A model name is required',
        });
        return;
      }

      if (!options || typeof options !== 'object') {
        res.status(400).json({
          success: false,
          error: 'Generation options are required',
        });
        return;
      }

      const updatedPreferences = preferencesService.setModelGenerationOptions(
        model.trim(),
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
        error: getErrorMessage(error, 'Failed to set model generation options'),
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
        preferencesService.resetGenerationOptions(userId);

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

      const updatedPreferences = preferencesService.setEmbeddingSettings(
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
        preferencesService.resetEmbeddingSettings(userId);

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

// Export the authenticated user's portable data. Building this on the server
// avoids exporting a stale or incomplete copy of the frontend stores.
router.get(
  '/export',
  markArchiveNoStore,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<UserDataArchive>>
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

      res.json({
        success: true,
        data: dataArchiveService.exportUserData(userId),
      });
    } catch (error: unknown) {
      logger.error('Failed to export user data archive:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to export user data',
      });
    }
  }
);

function readArchiveImportRequest(req: AuthenticatedRequest): {
  data: unknown;
  strategy: DataArchiveMergeStrategy;
} {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new DataArchiveValidationError('Import request must be an object');
  }
  const request = body as Record<string, unknown>;
  let data = request.data;
  if (req.file) {
    try {
      data = JSON.parse(req.file.buffer.toString('utf8')) as unknown;
    } catch {
      throw new DataArchiveValidationError(
        'Portable archive is not valid JSON'
      );
    }
  }
  if (!data) {
    throw new DataArchiveValidationError('Import data is required');
  }

  // Accept the old client values during the archive v1 -> v2 migration.
  const requestedStrategy = request.strategy ?? request.mergeStrategy ?? 'skip';
  const strategy =
    requestedStrategy === 'merge'
      ? 'skip'
      : requestedStrategy === 'replace'
        ? 'overwrite'
        : requestedStrategy;
  if (strategy !== 'skip' && strategy !== 'overwrite') {
    throw new DataArchiveValidationError(
      'Invalid import strategy. Must be "skip" or "overwrite"'
    );
  }
  return { data, strategy };
}

function archiveErrorStatus(error: unknown): number {
  if (error instanceof DataArchiveValidationError) return error.statusCode;
  if (
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    (error.statusCode === 400 || error.statusCode === 409)
  ) {
    return error.statusCode;
  }
  return 500;
}

function archiveErrorMessage(error: unknown, fallback: string): string {
  if (archiveErrorStatus(error) < 500) {
    return getErrorMessage(error, fallback);
  }
  logger.error(`${fallback}:`, error);
  return fallback;
}

// Validate, migrate, and calculate conflicts without writing anything.
router.post(
  '/import/preflight',
  markArchiveNoStore,
  reserveArchiveImport,
  receiveArchiveFile,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<DataArchivePreflight>>
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
      const { data, strategy } = readArchiveImportRequest(req);
      res.json({
        success: true,
        data: dataArchiveService.preflight(data, strategy, userId),
      });
    } catch (error: unknown) {
      res.status(archiveErrorStatus(error)).json({
        success: false,
        error: archiveErrorMessage(
          error,
          'Failed to validate user data archive'
        ),
      });
    }
  }
);

// Import a validated archive in one SQLite transaction. "overwrite" applies
// only to matching IDs; records absent from the archive are never deleted.
router.post(
  '/import',
  markArchiveNoStore,
  reserveArchiveImport,
  receiveArchiveFile,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<DataArchiveImportResult>>
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

      const { data, strategy } = readArchiveImportRequest(req);
      const result = dataArchiveService.importUserData(data, strategy, userId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      res.status(archiveErrorStatus(error)).json({
        success: false,
        error: archiveErrorMessage(error, 'Failed to import user data archive'),
      });
    }
  }
);

export default router;
