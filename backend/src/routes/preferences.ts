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
import rateLimit from '../middleware/sharedRateLimit.js';
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
  DATA_ARCHIVE_MAX_BYTES,
  DataArchiveValidationError,
  type DataArchiveImportResult,
  type DataArchiveMergeStrategy,
  type DataArchivePreflight,
  type UserDataArchive,
} from '../services/dataArchiveService.js';
import { createLogger } from '../utils/logger.js';
import {
  acquireSharedCapacity,
  combineAbortSignals,
  SharedCapacityExceededError,
  SharedCapacityUnavailableError,
  type SharedCapacityReservation,
} from '../platform/coordination/sharedAdmission.js';

const router = express.Router();
const logger = createLogger('routes:preferences');

const archiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DATA_ARCHIVE_MAX_BYTES,
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

const MAX_ACTIVE_ARCHIVE_IMPORTS_PER_USER = 1;
const MAX_ACTIVE_ARCHIVE_IMPORTS_GLOBAL = 2;

interface ArchiveImportAdmission {
  slot: SharedCapacityReservation;
  signal: AbortSignal;
  cleanupClientSignal: () => void;
  released: boolean;
}

function archiveImportAdmission(
  res: Response
): ArchiveImportAdmission | undefined {
  return res.locals.archiveImportAdmission as
    ArchiveImportAdmission | undefined;
}

async function releaseArchiveImport(res: Response): Promise<void> {
  const admission = archiveImportAdmission(res);
  if (!admission || admission.released) return;
  admission.released = true;
  admission.cleanupClientSignal();
  await admission.slot.release();
}

async function reserveArchiveImport(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  let slot: SharedCapacityReservation;
  try {
    slot = await acquireSharedCapacity({
      limits: [
        {
          scope: 'archive-import.global',
          capacity: MAX_ACTIVE_ARCHIVE_IMPORTS_GLOBAL,
        },
        {
          scope: 'archive-import.user',
          subject: userId,
          capacity: MAX_ACTIVE_ARCHIVE_IMPORTS_PER_USER,
        },
      ],
    });
  } catch (error) {
    if (error instanceof SharedCapacityExceededError) {
      res.status(429).json({
        success: false,
        error: 'Another user data archive is already being processed',
      });
      return;
    }
    res.status(503).json({
      success: false,
      error: 'Archive import admission is temporarily unavailable',
    });
    return;
  }
  const clientAbort = new AbortController();
  const abortClient = () => {
    if (!clientAbort.signal.aborted) {
      clientAbort.abort(new Error('Archive import client disconnected'));
    }
  };
  const responseClosed = () => {
    if (!res.writableEnded) abortClient();
  };
  req.once('aborted', abortClient);
  res.once('close', responseClosed);
  const signal = combineAbortSignals(slot.signal, clientAbort.signal);
  res.locals.archiveImportAdmission = {
    slot,
    signal,
    released: false,
    cleanupClientSignal: () => {
      req.off('aborted', abortClient);
      res.off('close', responseClosed);
    },
  } satisfies ArchiveImportAdmission;
  res.locals.sharedCapacitySignal = signal;
  next();
}

function receiveArchiveFile(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const signal = archiveImportAdmission(res)?.signal;
  let uploadSettled = false;
  const failAdmission = (reason: unknown): void => {
    if (uploadSettled) return;
    uploadSettled = true;
    void releaseArchiveImport(res);
    if (!res.destroyed && !res.headersSent) {
      res.status(503).json({
        success: false,
        error: 'Archive import admission is temporarily unavailable',
      });
    }
    // Reject the route before waiting for a slow sender to finish. Multer
    // receives the request error in the same turn and destroys its partial
    // Busboy upload; its later callback is ignored by uploadSettled.
    if (!req.destroyed) {
      req.emit(
        'error',
        reason instanceof Error
          ? reason
          : new Error('Archive upload admission was lost')
      );
    }
  };
  const abortUpload = () => {
    const reason =
      signal?.reason instanceof Error
        ? signal.reason
        : new Error('Archive upload admission was lost');
    failAdmission(reason);
  };
  if (signal?.aborted) {
    failAdmission(signal.reason);
    return;
  }
  archiveUpload.single('archive')(req, res, error => {
    if (uploadSettled) return;
    signal?.removeEventListener('abort', abortUpload);
    if (signal?.aborted) {
      failAdmission(signal.reason);
      return;
    }
    uploadSettled = true;
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
    void releaseArchiveImport(res);
  });
  if (!uploadSettled) {
    signal?.addEventListener('abort', abortUpload, { once: true });
    if (signal?.aborted) abortUpload();
  }
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
  keyPrefix: 'preferences-routes',
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

      const updatedPreferences = await preferencesService.setDefaultModel(
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

      const updatedPreferences =
        await preferencesService.setModelGenerationOptions(
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
        data: await dataArchiveService.exportUserData(userId),
      });
    } catch (error: unknown) {
      res.status(archiveErrorStatus(error)).json({
        success: false,
        error: archiveErrorMessage(error, 'Failed to export user data'),
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
  if (error instanceof SharedCapacityUnavailableError) return 503;
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
      const signal = res.locals.sharedCapacitySignal as AbortSignal | undefined;
      res.json({
        success: true,
        data: await dataArchiveService.preflight(
          data,
          strategy,
          userId,
          signal
        ),
      });
    } catch (error: unknown) {
      if (!res.destroyed && !res.headersSent) {
        res.status(archiveErrorStatus(error)).json({
          success: false,
          error: archiveErrorMessage(
            error,
            'Failed to validate user data archive'
          ),
        });
      }
    } finally {
      await releaseArchiveImport(res);
    }
  }
);

// Import a validated archive. "overwrite" applies only to matching IDs;
// records absent from the archive are never deleted.
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
      const signal = res.locals.sharedCapacitySignal as AbortSignal | undefined;
      const result = await dataArchiveService.importUserData(
        data,
        strategy,
        userId,
        signal
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      if (!res.destroyed && !res.headersSent) {
        res.status(archiveErrorStatus(error)).json({
          success: false,
          error: archiveErrorMessage(
            error,
            'Failed to import user data archive'
          ),
        });
      }
    } finally {
      await releaseArchiveImport(res);
    }
  }
);

export default router;
