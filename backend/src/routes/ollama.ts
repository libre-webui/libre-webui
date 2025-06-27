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
import ollamaService from '../services/ollamaService';
import { ApiResponse, OllamaModel, getErrorMessage } from '../types';

const router = express.Router();

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

// Pull a new model
router.post(
  '/models/:modelName/pull',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { modelName } = req.params;
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

// Delete a model
router.delete(
  '/models/:modelName',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { modelName } = req.params;
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

// Show model information
router.get(
  '/models/:modelName',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { modelName } = req.params;
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

// Push a model
router.post(
  '/models/:modelName/push',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { modelName } = req.params;
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
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const data = await ollamaService.generateEmbeddings(req.body);
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
      const { digest } = req.params;
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
      const { digest } = req.params;
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
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const data = await ollamaService.generateLegacyEmbeddings(req.body);
      res.json({ success: true, data });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate legacy embeddings'),
      });
    }
  }
);

export default router;
