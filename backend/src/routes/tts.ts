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

// Rate limiter for TTS routes: 30 requests per minute
const ttsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per windowMs
  message: {
    success: false,
    message: 'Too many TTS requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/tts/models
 * Get all available TTS models from plugins
 */
router.get('/models', async (_req, res) => {
  try {
    const models = pluginService.getAvailableTTSModels();
    res.json({
      success: true,
      data: models,
    });
  } catch (error) {
    console.error('Failed to get TTS models:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get TTS models',
    });
  }
});

/**
 * GET /api/tts/voices/:pluginId
 * Get available voices for a specific TTS plugin
 */
router.get('/voices/:pluginId', async (req, res) => {
  try {
    const { pluginId } = req.params;
    const config = pluginService.getTTSConfig(pluginId);

    if (!config) {
      res.status(404).json({
        success: false,
        message: 'TTS plugin not found or has no TTS configuration',
      });
      return;
    }

    res.json({
      success: true,
      data: {
        voices: config.voices || [],
        default_voice: config.default_voice,
        formats: config.formats || ['mp3'],
        default_format: config.default_format || 'mp3',
        max_characters: config.max_characters,
        supports_streaming: config.supports_streaming || false,
      },
    });
  } catch (error) {
    console.error('Failed to get TTS voices:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get TTS voices',
    });
  }
});

/**
 * POST /api/tts/generate
 * Generate speech from text using a TTS plugin
 */
router.post('/generate', ttsRateLimiter, async (req, res) => {
  try {
    const { model, input, voice, response_format, speed } = req.body;

    // Validate required fields
    if (!model || typeof model !== 'string') {
      res.status(400).json({
        success: false,
        message: 'Model is required and must be a string',
      });
      return;
    }

    if (!input || typeof input !== 'string') {
      res.status(400).json({
        success: false,
        message: 'Input text is required and must be a string',
      });
      return;
    }

    if (input.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Input text cannot be empty',
      });
      return;
    }

    // Validate optional parameters
    if (speed !== undefined) {
      const speedNum = Number(speed);
      if (isNaN(speedNum) || speedNum < 0.25 || speedNum > 4.0) {
        res.status(400).json({
          success: false,
          message: 'Speed must be a number between 0.25 and 4.0',
        });
        return;
      }
    }

    const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
    if (response_format && !validFormats.includes(response_format)) {
      res.status(400).json({
        success: false,
        message: `Invalid response_format. Must be one of: ${validFormats.join(', ')}`,
      });
      return;
    }

    // Execute TTS request
    const audioBuffer = await pluginService.executeTTSRequest(model, input, {
      voice,
      response_format,
      speed,
    });

    // Determine content type based on format
    const contentTypeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      opus: 'audio/opus',
      aac: 'audio/aac',
      flac: 'audio/flac',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
    };

    const format = response_format || 'mp3';
    const contentType = contentTypeMap[format] || 'audio/mpeg';

    // Set response headers
    res.set({
      'Content-Type': contentType,
      'Content-Length': audioBuffer.length.toString(),
      'Content-Disposition': `inline; filename="speech.${format}"`,
    });

    // Send audio data
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS generation failed:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    // Determine appropriate status code
    let statusCode = 500;
    if (errorMessage.includes('No TTS plugin found')) {
      statusCode = 404;
    } else if (errorMessage.includes('API key not found')) {
      statusCode = 503; // Service unavailable
    } else if (errorMessage.includes('exceeds maximum length')) {
      statusCode = 400;
    }

    res.status(statusCode).json({
      success: false,
      message: errorMessage,
    });
  }
});

/**
 * POST /api/tts/generate-base64
 * Generate speech from text and return as base64 encoded string
 * Useful for frontend playback without streaming
 */
router.post('/generate-base64', ttsRateLimiter, async (req, res) => {
  try {
    const { model, input, voice, response_format, speed } = req.body;

    // Validate required fields
    if (!model || typeof model !== 'string') {
      res.status(400).json({
        success: false,
        message: 'Model is required and must be a string',
      });
      return;
    }

    if (!input || typeof input !== 'string') {
      res.status(400).json({
        success: false,
        message: 'Input text is required and must be a string',
      });
      return;
    }

    if (input.length === 0) {
      res.status(400).json({
        success: false,
        message: 'Input text cannot be empty',
      });
      return;
    }

    // Validate optional parameters
    if (speed !== undefined) {
      const speedNum = Number(speed);
      if (isNaN(speedNum) || speedNum < 0.25 || speedNum > 4.0) {
        res.status(400).json({
          success: false,
          message: 'Speed must be a number between 0.25 and 4.0',
        });
        return;
      }
    }

    const validFormats = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'];
    if (response_format && !validFormats.includes(response_format)) {
      res.status(400).json({
        success: false,
        message: `Invalid response_format. Must be one of: ${validFormats.join(', ')}`,
      });
      return;
    }

    // Execute TTS request
    const audioBuffer = await pluginService.executeTTSRequest(model, input, {
      voice,
      response_format,
      speed,
    });

    const format = response_format || 'mp3';

    // Determine MIME type for data URL
    const mimeTypeMap: Record<string, string> = {
      mp3: 'audio/mpeg',
      opus: 'audio/opus',
      aac: 'audio/aac',
      flac: 'audio/flac',
      wav: 'audio/wav',
      pcm: 'audio/pcm',
    };

    const mimeType = mimeTypeMap[format] || 'audio/mpeg';

    // Return base64 encoded audio
    res.json({
      success: true,
      data: {
        audio: audioBuffer.toString('base64'),
        format,
        mimeType,
        size: audioBuffer.length,
      },
    });
  } catch (error) {
    console.error('TTS generation failed:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';

    let statusCode = 500;
    if (errorMessage.includes('No TTS plugin found')) {
      statusCode = 404;
    } else if (errorMessage.includes('API key not found')) {
      statusCode = 503;
    } else if (errorMessage.includes('exceeds maximum length')) {
      statusCode = 400;
    }

    res.status(statusCode).json({
      success: false,
      message: errorMessage,
    });
  }
});

/**
 * GET /api/tts/plugins
 * Get all plugins that support TTS capability
 */
router.get('/plugins', async (_req, res) => {
  try {
    const plugins = pluginService.getPluginsByCapability('tts');
    res.json({
      success: true,
      data: plugins.map(p => ({
        id: p.id,
        name: p.name,
        models:
          p.capabilities?.tts?.model_map ||
          (p.type === 'tts' ? p.model_map : []),
        config: p.capabilities?.tts?.config,
      })),
    });
  } catch (error) {
    console.error('Failed to get TTS plugins:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get TTS plugins',
    });
  }
});

export default router;
