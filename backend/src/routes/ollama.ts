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
import {
  getModelDownloadMode,
  isModelDownloadMode,
  setModelDownloadMode,
  userCanDownloadModels,
} from '../services/modelAccessService.js';
import { userModel } from '../models/userModel.js';
import {
  abortChatGenerationOnResponseClose,
  isChatGenerationCancelled,
} from '../utils/chatCancellation.js';

const router = express.Router();
router.use(authenticate);

/**
 * Like requireAdmin, but for model pulls: administrators always pass, other
 * active users pass when an administrator has opened model downloads to all
 * users. Authorization follows current database state on every request.
 */
const requireModelDownloadAccess = (
  req: AuthenticatedRequest,
  res: Response,
  next: express.NextFunction
): void => {
  if (!req.user) {
    res.status(403).json({
      success: false,
      message: 'Model downloads require an account.',
    });
    return;
  }
  const currentUser = userModel.getUserById(req.user.userId);
  if (!currentUser || !userCanDownloadModels(currentUser)) {
    res.status(403).json({
      success: false,
      message: 'Model downloads are restricted to administrators.',
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

// Who may pull models. Read is open to any authenticated user so the
// interface can decide whether to offer download affordances; changing the
// mode is admin-only.
router.get('/models/access', (req: AuthenticatedRequest, res: Response) => {
  const currentUser = req.user ? userModel.getUserById(req.user.userId) : null;
  res.json({
    success: true,
    data: {
      mode: getModelDownloadMode(),
      allowed: currentUser ? userCanDownloadModels(currentUser) : false,
    },
  });
});

router.put(
  '/models/access',
  requireAdmin,
  (req: Request, res: Response): void => {
    const mode = req.body?.mode;
    if (!isModelDownloadMode(mode)) {
      res.status(400).json({
        success: false,
        error: 'mode must be "admins" or "all-users".',
      });
      return;
    }
    setModelDownloadMode(mode);
    res.json({ success: true, data: { mode: getModelDownloadMode() } });
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
  requireModelDownloadAccess,
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
  requireModelDownloadAccess,
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

/**
 * What a model recommends for its own generation. The settings UI uses this to
 * show, and to return to, the model's own values rather than a fixed default.
 */
router.get(
  '/models/:modelName/defaults',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const modelName = decodeURIComponent(req.params.modelName as string);
      const defaults = await ollamaService.getModelDefaults(modelName);

      res.json({
        success: true,
        data: {
          model: modelName,
          options: defaults.options,
          trainedContextLength: defaults.trainedContextLength,
          contextCapped: defaults.contextCapped,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to read model defaults'),
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
    const { controller, cleanup } = abortChatGenerationOnResponseClose(res);
    try {
      const data = await ollamaService.generateChatResponse(
        req.body,
        controller.signal,
        { userId: (req as AuthenticatedRequest).user?.userId }
      );
      res.json({ success: true, data });
    } catch (error: unknown) {
      if (isChatGenerationCancelled(error, controller.signal)) {
        if (!res.writableEnded) res.status(499).end();
        return;
      }
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate chat response'),
      });
    } finally {
      cleanup();
    }
  }
);

// Chat completion (streaming)
router.post(
  '/chat/stream',
  async (req: Request, res: Response): Promise<void> => {
    const { controller, cleanup } = abortChatGenerationOnResponseClose(res);
    const signal = controller.signal;
    try {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      await ollamaService.generateChatStreamResponse(
        req.body,
        chunk => {
          if (signal.aborted || res.writableEnded) return;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        },
        error => {
          if (signal.aborted || res.writableEnded) return;
          res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        },
        () => {
          if (signal.aborted || res.writableEnded) return;
          res.write('data: [DONE]\n\n');
          res.end();
        },
        signal,
        { userId: (req as AuthenticatedRequest).user?.userId }
      );
    } catch (error: unknown) {
      if (isChatGenerationCancelled(error, signal)) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to stream chat response'),
      });
    } finally {
      cleanup();
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
