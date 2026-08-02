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
import embeddingService from '../services/embeddingService.js';
import ollamaService from '../services/ollamaService.js';
import { ApiResponse, OllamaModel, getErrorMessage } from '../types/index.js';
import {
  authenticate,
  AuthenticatedRequest,
  requireAdmin,
} from '../middleware/auth.js';
import {
  getOllamaLibraryModels,
  type RemoteModelInfo,
} from '../utils/ollamaLibrary.js';

const router = express.Router();
router.use(authenticate);

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
  requireAdmin,
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
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

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
  requireAdmin,
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
router.get(
  '/pull/stream',
  requireAdmin,
  async (req: Request, res: Response): Promise<void> => {
    try {
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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
  requireAdmin,
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

      const remoteModels = await getOllamaLibraryModels({
        search,
        sort,
        category,
        pages,
      });

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
