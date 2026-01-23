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
import rateLimit from 'express-rate-limit';
import axios from 'axios';
import { ApiResponse, getErrorMessage } from '../types/index.js';

const router = express.Router();

// Cache for model lists (24h TTL)
interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const modelCache: Map<string, CacheEntry<HuggingFaceModel[]>> = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// HuggingFace API types
interface HuggingFaceModel {
  id: string;
  modelId: string;
  author: string;
  sha: string;
  lastModified: string;
  private: boolean;
  disabled: boolean;
  gated: boolean | string;
  downloads: number;
  likes: number;
  tags: string[];
  pipeline_tag?: string;
  library_name?: string;
  createdAt: string;
}

interface HuggingFaceModelResponse {
  id: string;
  modelId: string;
  author: string;
  downloads: number;
  likes: number;
  tags: string[];
  pipeline_tag?: string;
  library_name?: string;
  gated: boolean | string;
}

// Rate limiting for Hub API requests
const hubRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per window
  message: {
    success: false,
    error: 'Too many HuggingFace Hub requests, please try again later.',
  },
});

router.use(hubRateLimit);

/**
 * Get models from HuggingFace Hub API
 * Supports filtering by task, author, search query, and sorting
 */
router.get(
  '/models',
  async (
    req: Request,
    res: Response<ApiResponse<HuggingFaceModelResponse[]>>
  ): Promise<void> => {
    try {
      const {
        task = 'text-generation',
        search = '',
        author = '',
        sort = 'downloads',
        direction = 'desc',
        limit = '50',
        inference = 'true', // Only show models available for inference
      } = req.query;

      // Build cache key
      const cacheKey = JSON.stringify({
        task,
        search,
        author,
        sort,
        direction,
        limit,
        inference,
      });

      // Check cache
      const cached = modelCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        res.json({
          success: true,
          data: cached.data.map(formatModelResponse),
        });
        return;
      }

      // Build HuggingFace API URL
      const params = new URLSearchParams();

      if (task) params.append('pipeline_tag', task as string);
      if (search) params.append('search', search as string);
      if (author) params.append('author', author as string);
      if (sort) params.append('sort', sort as string);
      if (direction === 'asc') params.append('direction', '-1');
      if (limit) params.append('limit', limit as string);
      if (inference === 'true') params.append('inference', 'warm');

      const url = `https://huggingface.co/api/models?${params.toString()}`;

      const response = await axios.get<HuggingFaceModel[]>(url, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
        },
      });

      // Cache the response
      modelCache.set(cacheKey, {
        data: response.data,
        timestamp: Date.now(),
      });

      res.json({
        success: true,
        data: response.data.map(formatModelResponse),
      });
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        res.status(status).json({
          success: false,
          error: `HuggingFace API error: ${error.message}`,
        });
      } else {
        res.status(500).json({
          success: false,
          error: getErrorMessage(error, 'Failed to fetch models'),
        });
      }
    }
  }
);

/**
 * Get a specific model's details
 */
router.get(
  '/models/:author/:modelName',
  async (
    req: Request,
    res: Response<ApiResponse<HuggingFaceModel>>
  ): Promise<void> => {
    try {
      const { author, modelName } = req.params;
      const modelId = `${author}/${modelName}`;

      const url = `https://huggingface.co/api/models/${modelId}`;

      const response = await axios.get<HuggingFaceModel>(url, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
        },
      });

      res.json({
        success: true,
        data: response.data,
      });
    } catch (error: unknown) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status || 500;
        res.status(status).json({
          success: false,
          error:
            status === 404
              ? 'Model not found'
              : `HuggingFace API error: ${error.message}`,
        });
      } else {
        res.status(500).json({
          success: false,
          error: getErrorMessage(error, 'Failed to fetch model'),
        });
      }
    }
  }
);

/**
 * Get available tasks (pipeline tags) from HuggingFace
 */
router.get(
  '/tasks',
  async (req: Request, res: Response<ApiResponse<string[]>>): Promise<void> => {
    // Common tasks for chat/inference
    const tasks = [
      'text-generation',
      'text2text-generation',
      'text-to-speech',
      'automatic-speech-recognition',
      'text-to-image',
      'image-to-text',
      'feature-extraction',
      'fill-mask',
      'question-answering',
      'summarization',
      'translation',
      'zero-shot-classification',
    ];

    res.json({
      success: true,
      data: tasks,
    });
  }
);

/**
 * Clear the model cache (admin endpoint)
 */
router.post(
  '/cache/clear',
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    modelCache.clear();
    res.json({
      success: true,
      data: true,
    });
  }
);

/**
 * Get trending models for quick access
 */
router.get(
  '/trending',
  async (
    req: Request,
    res: Response<ApiResponse<HuggingFaceModelResponse[]>>
  ): Promise<void> => {
    try {
      const { task = 'text-generation', limit = '20' } = req.query;

      const cacheKey = `trending_${task}_${limit}`;

      // Check cache
      const cached = modelCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        res.json({
          success: true,
          data: cached.data.map(formatModelResponse),
        });
        return;
      }

      const params = new URLSearchParams();
      params.append('pipeline_tag', task as string);
      params.append('sort', 'trending');
      params.append('limit', limit as string);
      params.append('inference', 'warm');

      const url = `https://huggingface.co/api/models?${params.toString()}`;

      const response = await axios.get<HuggingFaceModel[]>(url, {
        timeout: 10000,
        headers: {
          Accept: 'application/json',
        },
      });

      // Cache the response
      modelCache.set(cacheKey, {
        data: response.data,
        timestamp: Date.now(),
      });

      res.json({
        success: true,
        data: response.data.map(formatModelResponse),
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to fetch trending models'),
      });
    }
  }
);

/**
 * Format model response to include only necessary fields
 */
function formatModelResponse(
  model: HuggingFaceModel
): HuggingFaceModelResponse {
  return {
    id: model.id || model.modelId,
    modelId: model.modelId || model.id,
    author: model.author || model.id?.split('/')[0] || 'unknown',
    downloads: model.downloads || 0,
    likes: model.likes || 0,
    tags: model.tags || [],
    pipeline_tag: model.pipeline_tag,
    library_name: model.library_name,
    gated: model.gated || false,
  };
}

export default router;
