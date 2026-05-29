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

import express, { NextFunction, Request, Response } from 'express';
import embeddingService from '../services/embeddingService.js';
import ollamaService from '../services/ollamaService.js';
import { ApiResponse, OllamaModel, getErrorMessage } from '../types/index.js';
import { AuthenticatedRequest, optionalAuth } from '../middleware/auth.js';
import { authService } from '../services/authService.js';
import { systemSettingsService } from '../services/systemSettingsService.js';

const router = express.Router();

const getRequestToken = (req: Request): string | null => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.trim()) {
    return queryToken;
  }

  return null;
};

const checkModelPullPermission = (
  req: AuthenticatedRequest
): { allowed: true } | { allowed: false; status: number; error: string } => {
  // When enabled, preserve current behavior.
  if (systemSettingsService.getAllowUserModelPull()) {
    return { allowed: true };
  }

  const token = getRequestToken(req);
  if (!token) {
    return {
      allowed: false,
      status: 401,
      error: 'Authentication required to install models',
    };
  }

  const payload = authService.verifyToken(token);
  if (!payload) {
    return {
      allowed: false,
      status: 401,
      error: 'Invalid or expired token',
    };
  }

  req.user = payload;

  if (payload.role !== 'admin') {
    return {
      allowed: false,
      status: 403,
      error: 'Only admins can install new models on this instance',
    };
  }

  return { allowed: true };
};

const enforceModelPullPermission = (
  req: AuthenticatedRequest,
  res: Response<ApiResponse>,
  next: NextFunction
): void => {
  const permission = checkModelPullPermission(req);
  if (!permission.allowed) {
    res.status(permission.status).json({
      success: false,
      error: permission.error,
    });
    return;
  }

  next();
};

// Health check
router.get(
  '/health',
  async (
    req: Request,
    res: Response<ApiResponse<{ status: string }>>
  ): Promise<void> => {
    try {
      const isHealthy = await ollamaService.isHealthy();

      if (isHealthy) {
        res.json({
          success: true,
          data: { status: 'healthy' },
          message: 'Ollama service is running',
        });
      } else {
        res.status(503).json({
          success: false,
          error: 'Ollama service is not available',
        });
      }
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Health check failed'),
      });
    }
  }
);

// Get available models
router.get(
  '/models',
  async (
    req: Request,
    res: Response<ApiResponse<OllamaModel[]>>
  ): Promise<void> => {
    try {
      const models = await ollamaService.getModels();
      res.json({
        success: true,
        data: models,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get models'),
      });
    }
  }
);

// Pull all models
router.post(
  '/models/pull-all',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const result = await ollamaService.pullAllModels();
      res.json({
        success: result.success,
        data: result.results,
        message: result.success
          ? 'All models updated.'
          : 'Some models failed to update.',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to pull models'),
      });
    }
  }
);

// Pull all models with streaming progress (GET for Server-Sent Events)
router.get(
  '/models/pull-all/stream',
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      await ollamaService.pullAllModelsStream(
        progress => {
          res.write(
            `data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`
          );
        },
        () => {
          res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
          res.end();
        },
        error => {
          res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
          res.end();
        }
      );
    } catch (error: unknown) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: getErrorMessage(error, 'Failed to pull models') })}\n\n`
      );
      res.end();
    }
  }
);

// Pull a new model (uses request body to support model names with slashes like hf.co/author/model:tag)
router.post(
  '/models/pull',
  enforceModelPullPermission,
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const modelName = req.body.name as string;
      if (!modelName) {
        res.status(400).json({
          success: false,
          error: 'Model name is required in request body',
        });
        return;
      }
      await ollamaService.pullModel(modelName);

      res.json({
        success: true,
        message: `Model ${modelName} pulled successfully`,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to pull model'),
      });
    }
  }
);

// Pull a model with streaming progress
// Uses query param ?model= to support model names with slashes (e.g., hf.co/author/model)
// Optional ?token= can be provided for role checks when EventSource cannot set auth headers
router.get(
  '/pull/stream',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const permission = checkModelPullPermission(req as AuthenticatedRequest);
      if (!permission.allowed) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.write(
          `data: ${JSON.stringify({ type: 'error', error: permission.error })}\n\n`
        );
        res.end();
        return;
      }

      const modelName = req.query.model as string;

      if (!modelName) {
        res
          .status(400)
          .json({ success: false, error: 'Model name is required' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      await ollamaService.pullModelStream(
        modelName,
        progress => {
          res.write(
            `data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`
          );
        },
        error => {
          res.write(
            `data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`
          );
          res.end();
        },
        () => {
          res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
          res.end();
        }
      );
    } catch (error: unknown) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: getErrorMessage(error, 'Failed to pull model') })}\n\n`
      );
      res.end();
    }
  }
);

// Delete a model (uses query param ?name= to support model names with slashes like hf.co/author/model:tag)
router.delete(
  '/models',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const modelName = req.query.name as string;
      if (!modelName) {
        res.status(400).json({
          success: false,
          error: 'Model name is required as query parameter',
        });
        return;
      }
      await ollamaService.deleteModel(modelName);

      res.json({
        success: true,
        message: `Model ${modelName} deleted successfully`,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete model'),
      });
    }
  }
);

// Show model information (uses query param ?name= to support model names with slashes like hf.co/author/model:tag)
router.get(
  '/models/show',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const modelName = req.query.name as string;
      if (!modelName) {
        res.status(400).json({
          success: false,
          error: 'Model name is required as query parameter',
        });
        return;
      }
      const verbose = req.query.verbose === 'true';
      const data = await ollamaService.showModel(modelName, verbose);
      res.json({ success: true, data });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to show model'),
      });
    }
  }
);

// Create a model
router.post(
  '/models',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      await ollamaService.createModel(req.body);
      res.json({ success: true, message: 'Model created successfully' });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to create model'),
      });
    }
  }
);

// Copy a model
router.post(
  '/models/copy',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { source, destination } = req.body;
      await ollamaService.copyModel(source, destination);
      res.json({ success: true, message: 'Model copied successfully' });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to copy model'),
      });
    }
  }
);

// Push a model (uses request body to support model names with slashes like hf.co/author/model:tag)
router.post(
  '/models/push',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const modelName = req.body.name as string;
      if (!modelName) {
        res.status(400).json({
          success: false,
          error: 'Model name is required in request body',
        });
        return;
      }
      await ollamaService.pushModel(modelName);
      res.json({
        success: true,
        message: `Model ${modelName} pushed successfully`,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to push model'),
      });
    }
  }
);

// Generate embeddings
router.post(
  '/embed',
  optionalAuth,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const data = await embeddingService.generateEmbeddings(
        req.body,
        req.user?.userId
      );
      res.json({ success: true, data });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate embeddings'),
      });
    }
  }
);

// List running models
router.get(
  '/running',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const data = await ollamaService.listRunningModels();
      res.json({ success: true, data });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to list running models'),
      });
    }
  }
);

// Unload a model from memory (free VRAM)
router.post(
  '/models/unload',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const modelName = req.body.name as string;
      if (!modelName) {
        res.status(400).json({
          success: false,
          error: 'Model name is required in request body',
        });
        return;
      }
      await ollamaService.unloadModel(modelName);
      res.json({
        success: true,
        message: `Model ${modelName} unloaded successfully`,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to unload model'),
      });
    }
  }
);

// Unload all running models from memory
router.post(
  '/models/unload-all',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      await ollamaService.unloadAllModels();
      res.json({
        success: true,
        message: 'All models unloaded successfully',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to unload all models'),
      });
    }
  }
);

// Get Ollama version
router.get(
  '/version',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const data = await ollamaService.getVersion();
      res.json({ success: true, data });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get version'),
      });
    }
  }
);

// Chat completion (non-streaming)
router.post(
  '/chat',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const data = await ollamaService.generateChatResponse(req.body);
      res.json({ success: true, data });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate chat response'),
      });
    }
  }
);

// Chat completion (streaming)
router.post(
  '/chat/stream',
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      await ollamaService.generateChatStreamResponse(
        req.body,
        chunk => {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        error => {
          res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        },
        () => {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      );
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to stream chat response'),
      });
    }
  }
);

// Check if blob exists
router.head(
  '/blobs/:digest',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const digest = req.params.digest as string;
      // Only allow lowercase hex strings of length 64 (SHA256)
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        res.status(400).json({ error: 'Invalid digest format' });
        return;
      }
      const exists = await ollamaService.checkBlobExists(digest);
      if (exists) {
        res.status(200).end();
      } else {
        res.status(404).end();
      }
    } catch (_error: unknown) {
      res.status(500).end();
    }
  }
);

// Push a blob
router.post(
  '/blobs/:digest',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const digest = req.params.digest as string;
      // Only allow lowercase hex strings of length 64 (SHA256)
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        res.status(400).json({ error: 'Invalid digest format' });
        return;
      }
      // Handle raw binary data
      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        chunks.push(chunk);
      });

      req.on('end', async () => {
        try {
          const data = Buffer.concat(chunks);
          await ollamaService.pushBlob(digest, data);
          res
            .status(201)
            .json({ success: true, message: 'Blob created successfully' });
        } catch (error: unknown) {
          res.status(400).json({
            success: false,
            error: getErrorMessage(error, 'Failed to create blob'),
          });
        }
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to push blob'),
      });
    }
  }
);

// Legacy embeddings endpoint (deprecated)
router.post(
  '/embeddings',
  optionalAuth,
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const data = await embeddingService.generateEmbeddings(
        {
          model: req.body.model,
          input: req.body.prompt,
          options: req.body.options,
          keep_alive: req.body.keep_alive,
        },
        req.user?.userId
      );
      res.json({
        success: true,
        data: { embedding: data.embeddings[0] || [] },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate legacy embeddings'),
      });
    }
  }
);

// Interface for remote model info
interface RemoteModelInfo {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
}

// Parse HTML from ollama.com search to extract model data
function parseOllamaSearchHtml(html: string): RemoteModelInfo[] {
  const models: RemoteModelInfo[] = [];

  // Match model cards - pattern: /library/MODEL_NAME followed by pull count
  const modelPattern =
    /<a href="\/library\/([^"]+)"[^>]*>[\s\S]*?x-test-pull-count>([^<]+)<\/span>/g;
  let match;

  while ((match = modelPattern.exec(html)) !== null) {
    const name = match[1];
    const pulls = match[2].trim();

    // Skip duplicates
    if (models.some(m => m.name === name)) continue;

    // Determine category from name patterns
    let category = 'general';
    const nameLower = name.toLowerCase();
    if (
      nameLower.includes('coder') ||
      nameLower.includes('code') ||
      nameLower.includes('starcoder') ||
      nameLower.includes('devstral')
    ) {
      category = 'coding';
    } else if (nameLower.includes('embed') || nameLower.includes('embedding')) {
      category = 'embedding';
    } else if (
      nameLower.includes('vision') ||
      nameLower.includes('vl') ||
      nameLower.includes('llava')
    ) {
      category = 'vision';
    } else if (
      nameLower.includes('thinking') ||
      nameLower.includes('r1') ||
      nameLower.includes('reasoning')
    ) {
      category = 'reasoning';
    }

    models.push({
      name,
      description: '', // Description would require fetching individual pages
      category,
      sizes: [],
      pulls,
      tags: [category],
    });
  }

  return models;
}

// Curated fallback list for when API fails
const CURATED_MODELS: RemoteModelInfo[] = [
  {
    name: 'deepseek-r1',
    description: 'Family of open reasoning models with exceptional performance',
    category: 'reasoning',
    sizes: ['1.5b', '7b', '8b', '14b', '32b', '70b', '671b'],
    pulls: '200M+',
    tags: ['reasoning', 'thinking'],
  },
  {
    name: 'llama3.2',
    description: "Meta's latest Llama model, great for general tasks",
    category: 'general',
    sizes: ['1b', '3b'],
    pulls: '50M+',
    tags: ['general', 'fast'],
  },
  {
    name: 'llama3.1',
    description: 'State-of-the-art model from Meta with tool support',
    category: 'general',
    sizes: ['8b', '70b', '405b'],
    pulls: '100M+',
    tags: ['tools', 'general'],
  },
  {
    name: 'gemma3',
    description: "Google's most capable model that runs on a single GPU",
    category: 'general',
    sizes: ['1b', '4b', '12b', '27b'],
    pulls: '30M+',
    tags: ['vision', 'general'],
  },
  {
    name: 'qwen2.5',
    description: 'Latest Qwen model with strong multilingual capabilities',
    category: 'general',
    sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b', '72b'],
    pulls: '20M+',
    tags: ['multilingual', 'coding'],
  },
  {
    name: 'qwen2.5-coder',
    description: 'Code-focused Qwen model for development tasks',
    category: 'coding',
    sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b'],
    pulls: '15M+',
    tags: ['coding'],
  },
  {
    name: 'mistral',
    description: 'Fast and efficient 7B model from Mistral AI',
    category: 'general',
    sizes: ['7b'],
    pulls: '40M+',
    tags: ['fast', 'general'],
  },
  {
    name: 'mixtral',
    description: 'Mixture of experts model with strong performance',
    category: 'general',
    sizes: ['8x7b', '8x22b'],
    pulls: '10M+',
    tags: ['moe', 'general'],
  },
  {
    name: 'codellama',
    description: "Meta's code-specialized Llama model for development",
    category: 'coding',
    sizes: ['7b', '13b', '34b', '70b'],
    pulls: '25M+',
    tags: ['coding'],
  },
  {
    name: 'phi3',
    description: "Microsoft's small but capable model",
    category: 'general',
    sizes: ['3.8b', '14b'],
    pulls: '15M+',
    tags: ['small', 'efficient'],
  },
  {
    name: 'llava',
    description: 'Vision-language model for image understanding',
    category: 'vision',
    sizes: ['7b', '13b', '34b'],
    pulls: '10M+',
    tags: ['vision', 'multimodal'],
  },
  {
    name: 'nomic-embed-text',
    description: 'High-quality text embedding model for RAG and search',
    category: 'embedding',
    sizes: ['137m'],
    pulls: '8M+',
    tags: ['embedding', 'rag'],
  },
  {
    name: 'mxbai-embed-large',
    description: 'Large embedding model with strong semantic understanding',
    category: 'embedding',
    sizes: ['335m'],
    pulls: '5M+',
    tags: ['embedding', 'rag'],
  },
  {
    name: 'starcoder2',
    description: 'Code generation model trained on diverse languages',
    category: 'coding',
    sizes: ['3b', '7b', '15b'],
    pulls: '3M+',
    tags: ['coding'],
  },
  {
    name: 'dolphin-mixtral',
    description: 'Uncensored Mixtral variant for unrestricted conversations',
    category: 'general',
    sizes: ['8x7b'],
    pulls: '2M+',
    tags: ['uncensored', 'moe'],
  },
];

// Fetch a single page from ollama.com
async function fetchOllamaPage(
  params: URLSearchParams,
  page: number,
  signal: AbortSignal
): Promise<RemoteModelInfo[]> {
  const pageParams = new URLSearchParams(params);
  if (page > 1) pageParams.set('page', String(page));

  const url = `https://ollama.com/search?${pageParams.toString()}`;
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: 'text/html',
      'HX-Request': 'true',
      'User-Agent':
        'Mozilla/5.0 (compatible; LibreWebUI/1.0; +https://librewebui.org)',
    },
  });

  if (response.ok) {
    const html = await response.text();
    return parseOllamaSearchHtml(html);
  }
  return [];
}

// Get popular models from Ollama library (from official ollama.com)
router.get(
  '/library',
  async (
    req: Request,
    res: Response<ApiResponse<RemoteModelInfo[]>>
  ): Promise<void> => {
    try {
      const search = (req.query.search as string) || '';
      const sort = (req.query.sort as string) || 'popular'; // popular, newest
      const category = (req.query.category as string) || ''; // vision, embedding, tools, cloud
      const pages = Math.min(
        Math.max(parseInt(req.query.pages as string) || 15, 1),
        20
      ); // fetch all ~11 pages by default

      let remoteModels: RemoteModelInfo[] = [];

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        // Build base params for ollama.com search
        const params = new URLSearchParams();
        if (search) params.set('q', search);
        if (sort === 'newest') params.set('o', 'newest');
        else params.set('o', 'popular');
        if (category) params.set('c', category);

        // Fetch multiple pages in parallel
        const pagePromises = Array.from({ length: pages }, (_, i) =>
          fetchOllamaPage(params, i + 1, controller.signal).catch(() => [])
        );

        const pageResults = await Promise.all(pagePromises);
        clearTimeout(timeoutId);

        // Combine and deduplicate results
        const seenNames = new Set<string>();
        for (const pageModels of pageResults) {
          for (const model of pageModels) {
            if (!seenNames.has(model.name)) {
              seenNames.add(model.name);
              remoteModels.push(model);
            }
          }
        }
      } catch (_fetchError) {
        // Silently fall back to curated list
      }

      // If remote fetch failed or returned empty, use curated list
      if (remoteModels.length === 0) {
        remoteModels = [...CURATED_MODELS];

        // Apply search filter to curated list
        if (search) {
          const searchLower = search.toLowerCase();
          remoteModels = remoteModels.filter(
            m =>
              m.name.toLowerCase().includes(searchLower) ||
              m.description.toLowerCase().includes(searchLower)
          );
        }

        // Apply category filter
        if (category) {
          remoteModels = remoteModels.filter(m =>
            m.tags?.includes(category.toLowerCase())
          );
        }
      }

      // ollama.com's cloud listing isn't categorized by the HTML scraper, so
      // tag these models explicitly when the cloud category was requested.
      // Cloud models must be pulled/run as "<name>:cloud" (the listing returns
      // bare names), so suffix them unless they already carry an explicit tag —
      // otherwise the Pull button would try to fetch a nonexistent base model.
      if (category === 'cloud') {
        remoteModels = remoteModels.map(m => ({
          ...m,
          name: m.name.includes(':') ? m.name : `${m.name}:cloud`,
          category: 'cloud',
          tags: Array.from(new Set([...(m.tags ?? []), 'cloud'])),
        }));
      }

      res.json({
        success: true,
        data: remoteModels,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to fetch library models'),
      });
    }
  }
);

export default router;
