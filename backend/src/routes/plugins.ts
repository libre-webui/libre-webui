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
import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';
import pluginService from '../services/pluginService.js';
import pluginCredentialsService from '../services/pluginCredentialsService.js';
import {
  ApiResponse,
  Plugin,
  PluginStatus,
  getErrorMessage,
} from '../types/index.js';

// Extend Request interface to include file property
interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

const router = express.Router();

// Rate limiting for plugin operations
const pluginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many plugin requests from this IP, please try again later.',
  },
});

// More restrictive rate limiting for upload operations
const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 uploads per windowMs
  message: {
    success: false,
    error: 'Too many upload requests from this IP, please try again later.',
  },
});

// Helper function to safely clean up uploaded files
const safeCleanupFile = (filePath: string, tempDir: string): void => {
  try {
    const resolvedPath = path.resolve(filePath);
    const resolvedTempDir = path.resolve(tempDir);

    // Ensure the file is within the temp directory
    if (
      resolvedPath.startsWith(resolvedTempDir) &&
      fs.existsSync(resolvedPath)
    ) {
      fs.unlinkSync(resolvedPath);
    }
  } catch (error) {
    console.error('Failed to cleanup file:', error);
  }
};

// Configure multer for file uploads
const upload = multer({
  dest: 'temp/',
  fileFilter: (
    req: Request,
    file: Express.Multer.File,
    cb: FileFilterCallback
  ) => {
    const allowedTypes = ['.json', '.zip'];
    const fileExt = path.extname(file.originalname).toLowerCase();

    if (allowedTypes.includes(fileExt)) {
      cb(null, true);
    } else {
      cb(new Error('Only .json and .zip files are allowed'));
    }
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Get all plugins
router.get(
  '/',
  async (req: Request, res: Response<ApiResponse<Plugin[]>>): Promise<void> => {
    try {
      const plugins = pluginService.getAllPlugins();
      res.json({
        success: true,
        data: plugins,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load plugins'),
      });
    }
  }
);

// Get active plugins
router.get(
  '/active',
  async (req: Request, res: Response<ApiResponse<Plugin[]>>): Promise<void> => {
    try {
      const activePlugins = pluginService.getActivePlugins();

      res.json({
        success: true,
        data: activePlugins,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get active plugins'),
      });
    }
  }
);

// Get active plugin (alternative route)
router.get(
  '/active/current',
  async (
    req: Request,
    res: Response<ApiResponse<Plugin | null>>
  ): Promise<void> => {
    try {
      const activePlugin = pluginService.getActivePlugin();

      res.json({
        success: true,
        data: activePlugin,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get active plugin'),
      });
    }
  }
);

// Get plugin status
router.get(
  '/status/all',
  async (
    req: Request,
    res: Response<ApiResponse<PluginStatus[]>>
  ): Promise<void> => {
    try {
      const status = pluginService.getPluginStatus();

      res.json({
        success: true,
        data: status,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin status'),
      });
    }
  }
);

// Get a specific plugin
router.get(
  '/:id',
  async (req: Request, res: Response<ApiResponse<Plugin>>): Promise<void> => {
    try {
      const { id } = req.params;
      const plugin = pluginService.getPlugin(id);

      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin'),
      });
    }
  }
);

// Upload and install a plugin
router.post(
  '/upload',
  uploadRateLimit,
  upload.single('plugin'),
  async (
    req: MulterRequest,
    res: Response<ApiResponse<Plugin>>
  ): Promise<void> => {
    const tempDir = path.resolve('temp/');

    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded',
        });
        return;
      }

      // Validate file path is within temp directory
      const resolvedFilePath = path.resolve(req.file.path);
      if (!resolvedFilePath.startsWith(tempDir)) {
        safeCleanupFile(req.file.path, tempDir);
        res.status(400).json({
          success: false,
          error: 'Invalid file path',
        });
        return;
      }

      const fileExt = path.extname(req.file.originalname).toLowerCase();
      let pluginData: unknown;

      if (fileExt === '.json') {
        // Handle JSON file with safe path handling
        const fileContent = fs.readFileSync(resolvedFilePath, 'utf8');
        pluginData = JSON.parse(fileContent);
      } else if (fileExt === '.zip') {
        // Handle ZIP file (for future extension)
        safeCleanupFile(req.file.path, tempDir);
        res.status(400).json({
          success: false,
          error: 'ZIP file support is not implemented yet',
        });
        return;
      } else {
        // Clean up invalid file type
        safeCleanupFile(req.file.path, tempDir);
        res.status(400).json({
          success: false,
          error: 'Unsupported file type',
        });
        return;
      }

      // Clean up uploaded file after reading
      safeCleanupFile(req.file.path, tempDir);

      // Install the plugin
      const plugin = pluginService.importPlugin(pluginData);

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      // Clean up uploaded file if it exists
      if (req.file) {
        safeCleanupFile(req.file.path, tempDir);
      }

      const errorMessage = getErrorMessage(error, 'Failed to upload plugin');

      if (errorMessage.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: errorMessage,
        });
      } else if (errorMessage.includes('Invalid')) {
        res.status(400).json({
          success: false,
          error: errorMessage,
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }
  }
);

// Install plugin from JSON data (alternative to file upload)
router.post(
  '/install',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<Plugin>>): Promise<void> => {
    try {
      const pluginData = req.body;
      const plugin = pluginService.installPlugin(pluginData);

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to install plugin');

      if (errorMessage.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: errorMessage,
        });
      } else if (errorMessage.includes('Invalid')) {
        res.status(400).json({
          success: false,
          error: errorMessage,
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }
  }
);

// Update a plugin
router.put(
  '/:id',
  async (req: Request, res: Response<ApiResponse<Plugin>>): Promise<void> => {
    try {
      const { id } = req.params;
      const updates = req.body;

      // Ensure the ID matches
      if (updates.id && updates.id !== id) {
        res.status(400).json({
          success: false,
          error: 'Plugin ID in body does not match URL parameter',
        });
        return;
      }

      updates.id = id;
      const plugin = pluginService.installPlugin(updates);

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update plugin'),
      });
    }
  }
);

// Delete a plugin
router.delete(
  '/:id',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const { id } = req.params;
      const success = pluginService.deletePlugin(id);

      if (!success) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      res.json({
        success: true,
        data: true,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete plugin'),
      });
    }
  }
);

// Activate a plugin
router.post(
  '/activate/:id',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const { id } = req.params;
      const success = pluginService.activatePlugin(id);

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to activate plugin');

      if (errorMessage.includes('not found')) {
        res.status(404).json({
          success: false,
          error: errorMessage,
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }
  }
);

// Deactivate a specific plugin
router.post(
  '/deactivate/:id',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const { id } = req.params;
      const success = pluginService.deactivatePlugin(id);

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to deactivate plugin'),
      });
    }
  }
);

// Deactivate all plugins (legacy)
router.post(
  '/deactivate',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const success = pluginService.deactivatePlugin();

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to deactivate plugin'),
      });
    }
  }
);

// Export plugin
router.get(
  '/:id/export',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { id } = req.params;
      const plugin = pluginService.exportPlugin(id);

      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      // Remove runtime properties for export
      const exportData = {
        ...plugin,
        active: undefined,
        created_at: undefined,
        updated_at: undefined,
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
      res.send(JSON.stringify(exportData, null, 2));
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to export plugin'),
      });
    }
  }
);

// ============================================
// Plugin Credentials Endpoints
// ============================================

// Get all credentials for current user (API keys are masked)
router.get(
  '/credentials/all',
  async (
    req: Request,
    res: Response<
      ApiResponse<
        Array<{ plugin_id: string; has_api_key: boolean; updated_at: number }>
      >
    >
  ): Promise<void> => {
    try {
      // Get userId from auth context (defaults to 'default' for single-user mode)
      const userId = (req as Request & { userId?: string }).userId || 'default';
      const credentials = pluginCredentialsService.getCredentials(userId);

      res.json({
        success: true,
        data: credentials,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin credentials'),
      });
    }
  }
);

// Set API key for a plugin
router.post(
  '/:id/credentials',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const { id } = req.params;
      const { api_key } = req.body;

      if (!api_key || typeof api_key !== 'string') {
        res.status(400).json({
          success: false,
          error: 'API key is required',
        });
        return;
      }

      // Verify plugin exists
      const plugin = pluginService.getPlugin(id);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      // Get userId from auth context
      const userId = (req as Request & { userId?: string }).userId || 'default';
      const success = pluginCredentialsService.setApiKey(id, api_key, userId);

      if (success) {
        res.json({
          success: true,
          data: true,
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to save API key',
        });
      }
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set API key'),
      });
    }
  }
);

// Delete API key for a plugin
router.delete(
  '/:id/credentials',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const { id } = req.params;

      // Verify plugin exists
      const plugin = pluginService.getPlugin(id);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      // Get userId from auth context
      const userId = (req as Request & { userId?: string }).userId || 'default';
      const success = pluginCredentialsService.deleteApiKey(id, userId);

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete API key'),
      });
    }
  }
);

// Check if API key exists for a plugin (without revealing the key)
router.get(
  '/:id/credentials/check',
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const { id } = req.params;

      // Verify plugin exists
      const plugin = pluginService.getPlugin(id);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      // Get userId from auth context
      const userId = (req as Request & { userId?: string }).userId || 'default';
      const hasKey = pluginCredentialsService.hasApiKey(
        id,
        plugin.auth.key_env,
        userId
      );

      res.json({
        success: true,
        data: hasKey,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to check API key'),
      });
    }
  }
);

export default router;
