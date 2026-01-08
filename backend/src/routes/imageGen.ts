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

const router = express.Router();

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

/**
 * GET /api/image-gen/models
 * Get all available image generation models from plugins
 */
router.get('/models', async (_req, res) => {
  try {
    const models = pluginService.getAvailableImageGenModels();
    res.json({
      success: true,
      data: models,
    });
  } catch (error) {
    console.error('Failed to get image generation models:', error);
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
router.get('/config/:pluginId', async (req, res) => {
  try {
    const { pluginId } = req.params;
    const config = pluginService.getImageGenConfig(pluginId);

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
    console.error('Failed to get image generation config:', error);
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
router.get('/plugins', async (_req, res) => {
  try {
    const plugins = pluginService.getPluginsByCapability('image');
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
    console.error('Failed to get image generation plugins:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get image generation plugins',
    });
  }
});

/**
 * POST /api/image-gen/generate
 * Generate an image using an image generation plugin
 */
router.post('/generate', imageGenRateLimiter, async (req, res) => {
  try {
    const { model, prompt, size, quality, style, n, response_format } =
      req.body;

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

    if (prompt.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Prompt cannot be empty',
      });
      return;
    }

    // Validate optional parameters
    if (n !== undefined) {
      const nNum = Number(n);
      if (isNaN(nNum) || nNum < 1 || nNum > 10) {
        res.status(400).json({
          success: false,
          message: 'n must be a number between 1 and 10',
        });
        return;
      }
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
    const result = await pluginService.executeImageGenRequest(model, prompt, {
      size,
      quality,
      style,
      n,
      response_format,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Image generation failed:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    // Determine appropriate status code
    let statusCode = 500;
    if (errorMessage.includes('No image generation plugin found')) {
      statusCode = 404;
    } else if (errorMessage.includes('API key not found')) {
      statusCode = 503; // Service unavailable
    } else if (errorMessage.includes('exceeds maximum')) {
      statusCode = 400;
    }

    res.status(statusCode).json({
      success: false,
      message: errorMessage,
    });
  }
});

export default router;
