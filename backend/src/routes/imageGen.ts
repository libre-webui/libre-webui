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

import express from 'express';
import rateLimit from 'express-rate-limit';
import pluginService from '../services/pluginService.js';
import galleryService from '../services/galleryService.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import {
  normalizeImageGenerationCount,
  normalizeImageMediaType,
} from '../utils/imageGenerationValidation.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:image-gen');

const router = express.Router();
const getRequestUserId = (req: AuthenticatedRequest): string => {
  if (!req.user) {
    throw new Error('Authenticated user context is required');
  }
  return req.user.userId;
};

function requestAbortSignal(
  req: AuthenticatedRequest,
  res: express.Response
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Image generation client disconnected'));
    }
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once?.('aborted', abort);
  res.once?.('close', abortOnResponseClose);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off?.('aborted', abort);
      res.off?.('close', abortOnResponseClose);
    },
  };
}

// Rate limiter for image generation routes: 10 requests per minute
const imageGenRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // limit each IP to 10 requests per windowMs
  message: {
    success: false,
    message: 'Too many image generation requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for gallery routes: 60 requests per minute
const galleryRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per windowMs
  message: {
    success: false,
    message: 'Too many gallery requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Image generation can consume paid provider credentials and gallery data is
// user-scoped, so every route requires an authenticated account.
router.use(authenticate);

/**
 * GET /api/image-gen/models
 * Get all available image generation models from plugins
 */
router.get('/models', async (req: AuthenticatedRequest, res) => {
  try {
    await pluginService.refreshStaleCapabilityModels(
      'image',
      getRequestUserId(req)
    );
    const models = await pluginService.getAvailableImageGenModels(
      getRequestUserId(req)
    );
    res.json({
      success: true,
      data: models,
    });
  } catch (error) {
    logger.error('Failed to get image generation models:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get image generation models',
    });
  }
});

/**
 * GET /api/image-gen/config/:pluginId
 * Get configuration for a specific image generation plugin
 */
router.get('/config/:pluginId', async (req: AuthenticatedRequest, res) => {
  try {
    const pluginId = req.params.pluginId as string;
    const config = await pluginService.getImageGenConfig(
      pluginId,
      getRequestUserId(req)
    );

    if (!config) {
      res.status(404).json({
        success: false,
        message: 'Image generation plugin not found or has no configuration',
      });
      return;
    }

    res.json({
      success: true,
      data: config,
    });
  } catch (error) {
    logger.error('Failed to get image generation config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get image generation config',
    });
  }
});

/**
 * GET /api/image-gen/plugins
 * Get all plugins that support image generation capability
 */
router.get('/plugins', async (req: AuthenticatedRequest, res) => {
  try {
    await pluginService.refreshStaleCapabilityModels(
      'image',
      getRequestUserId(req)
    );
    const plugins = (
      await pluginService.getPluginsByCapability('image', getRequestUserId(req))
    ).filter(plugin => plugin.active);
    res.json({
      success: true,
      data: plugins.map(p => ({
        id: p.id,
        name: p.name,
        models:
          p.capabilities?.image?.model_map ||
          (p.type === 'image' ? p.model_map : []),
        config: p.capabilities?.image?.config,
      })),
    });
  } catch (error) {
    logger.error('Failed to get image generation plugins:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get image generation plugins',
    });
  }
});

/**
 * POST /api/image-gen/generate
 * Generate an image using an image generation plugin
 * Auto-saves generated images to the user's gallery
 */
router.post(
  '/generate',
  imageGenRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    const requestAbort = requestAbortSignal(req, res);
    try {
      const {
        model,
        pluginId,
        prompt,
        size,
        quality,
        style,
        n,
        response_format,
      } = req.body;

      // Validate required fields
      if (!model || typeof model !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Model is required and must be a string',
        });
        return;
      }

      if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({
          success: false,
          message: 'Prompt is required and must be a string',
        });
        return;
      }

      if (typeof pluginId !== 'string' || pluginId.trim().length === 0) {
        res.status(400).json({
          success: false,
          message: 'pluginId is required and must be a non-empty string',
        });
        return;
      }

      if (prompt.length === 0) {
        res.status(400).json({
          success: false,
          message: 'Prompt cannot be empty',
        });
        return;
      }

      let normalizedImageCount: number | undefined;
      try {
        normalizedImageCount = normalizeImageGenerationCount(n);
      } catch {
        res.status(400).json({
          success: false,
          message: 'n must be an integer between 1 and 10',
        });
        return;
      }

      const validFormats = ['url', 'b64_json'];
      if (response_format && !validFormats.includes(response_format)) {
        res.status(400).json({
          success: false,
          message: `Invalid response_format. Must be one of: ${validFormats.join(', ')}`,
        });
        return;
      }

      // Execute image generation request
      const userId = getRequestUserId(req);
      const result = await pluginService.executeImageGenRequest(model, prompt, {
        size,
        quality,
        style,
        n: normalizedImageCount,
        response_format,
        pluginId,
        userId,
        signal: requestAbort.signal,
      });

      if (requestAbort.signal.aborted) return;

      // Auto-save generated images to gallery
      const savedImages: string[] = [];

      if (result.images && result.images.length > 0) {
        for (const image of result.images) {
          // Get the image data as base64 data URL
          let imageData: string | null = null;
          if (image.b64_json) {
            const mediaType =
              normalizeImageMediaType(image.mime_type) || 'image/png';
            imageData = `data:${mediaType};base64,${image.b64_json}`;
          } else if (image.url) {
            imageData = image.url;
          }

          if (imageData) {
            const saved = await galleryService.saveImage(userId, {
              prompt,
              model,
              imageData,
              size,
              quality,
            });
            if (saved) {
              savedImages.push(saved.id);
            }
          }
        }
      }

      res.json({
        success: true,
        data: {
          ...result,
          savedToGallery: savedImages,
        },
      });
    } catch (error) {
      if (requestAbort.signal.aborted) return;
      logger.error('Image generation failed:', error);

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Determine appropriate status code
      let statusCode = 500;
      if (errorMessage.includes('No image generation plugin found')) {
        statusCode = 404;
      } else if (errorMessage.includes('API key not found')) {
        statusCode = 503; // Service unavailable
      } else if (
        errorMessage.includes('exceeds maximum') ||
        errorMessage.includes('supports only one image')
      ) {
        statusCode = 400;
      }

      res.status(statusCode).json({
        success: false,
        message: errorMessage,
      });
    } finally {
      requestAbort.cleanup();
    }
  }
);

/**
 * GET /api/image-gen/gallery
 * Get user's generated images with pagination
 */
router.get(
  '/gallery',
  galleryRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getRequestUserId(req);
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await galleryService.getImages(userId, { limit, offset });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('Failed to get gallery images:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get gallery images',
      });
    }
  }
);

/**
 * GET /api/image-gen/gallery/:imageId
 * Get a single image by ID
 */
router.get(
  '/gallery/:imageId',
  galleryRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getRequestUserId(req);
      const imageId = req.params.imageId as string;

      const image = await galleryService.getImage(imageId, userId);

      if (!image) {
        res.status(404).json({
          success: false,
          message: 'Image not found',
        });
        return;
      }

      res.json({
        success: true,
        data: image,
      });
    } catch (error) {
      logger.error('Failed to get gallery image:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get gallery image',
      });
    }
  }
);

/**
 * DELETE /api/image-gen/gallery/:imageId
 * Delete an image from the gallery
 */
router.delete(
  '/gallery/:imageId',
  galleryRateLimiter,
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = getRequestUserId(req);
      const imageId = req.params.imageId as string;

      const deleted = await galleryService.deleteImage(imageId, userId);

      if (!deleted) {
        res.status(404).json({
          success: false,
          message: 'Image not found or already deleted',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Image deleted successfully',
      });
    } catch (error) {
      logger.error('Failed to delete gallery image:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete gallery image',
      });
    }
  }
);

export default router;
