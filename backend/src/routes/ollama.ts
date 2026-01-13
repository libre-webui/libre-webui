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
import ollamaService from '../services/ollamaService.js';
import { ApiResponse, OllamaModel, getErrorMessage } from '../types/index.js';

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
      const modelName = req.params.modelName as string;
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
router.get(
  '/models/:modelName/pull/stream',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const modelName = req.params.modelName as string;

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

// Delete a model
router.delete(
  '/models/:modelName',
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const modelName = req.params.modelName as string;
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
      const modelName = req.params.modelName as string;
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
      const modelName = req.params.modelName as string;
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

// Interface for remote model info
interface RemoteModelInfo {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
}

// Get popular models from Ollama library (curated list with live fetch fallback)
router.get(
  '/library',
  async (
    req: Request,
    res: Response<ApiResponse<RemoteModelInfo[]>>
  ): Promise<void> => {
    try {
      // Try to fetch from ollamadb.dev API first
      let remoteModels: RemoteModelInfo[] = [];

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(
          'https://ollamadb.dev/api/v1/models?sort_by=pulls&order=desc&limit=50&model_type=official',
          {
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
            },
          }
        );
        clearTimeout(timeoutId);

        if (response.ok) {
          const data = (await response.json()) as {
            models?: Array<{
              model_name?: string;
              description?: string;
              capability?: string;
              labels?: string[];
              pulls?: number;
            }>;
          };
          if (data.models && Array.isArray(data.models)) {
            remoteModels = data.models.map(
              (m: {
                model_name?: string;
                description?: string;
                capability?: string;
                labels?: string[];
                pulls?: number;
              }) => ({
                name: m.model_name || '',
                description: m.description || '',
                category: m.capability || 'general',
                sizes: [],
                pulls: m.pulls ? formatPulls(m.pulls) : undefined,
                tags: m.labels || [],
              })
            );
          }
        }
      } catch (_fetchError) {
        // Silently fall back to curated list
      }

      // If remote fetch failed or returned empty, use curated list
      if (remoteModels.length === 0) {
        remoteModels = [
          {
            name: 'deepseek-r1',
            description:
              'Family of open reasoning models with exceptional performance',
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
            description:
              "Google's most capable model that runs on a single GPU",
            category: 'general',
            sizes: ['1b', '4b', '12b', '27b'],
            pulls: '30M+',
            tags: ['vision', 'general'],
          },
          {
            name: 'qwen2.5',
            description:
              'Latest Qwen model with strong multilingual capabilities',
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
            description:
              'Large embedding model with strong semantic understanding',
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
            description:
              'Uncensored Mixtral variant for unrestricted conversations',
            category: 'general',
            sizes: ['8x7b'],
            pulls: '2M+',
            tags: ['uncensored', 'moe'],
          },
        ];
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

// Helper function to format pull counts
function formatPulls(pulls: number): string {
  if (pulls >= 1000000000) {
    return `${(pulls / 1000000000).toFixed(1)}B+`;
  } else if (pulls >= 1000000) {
    return `${(pulls / 1000000).toFixed(1)}M+`;
  } else if (pulls >= 1000) {
    return `${(pulls / 1000).toFixed(1)}K+`;
  }
  return pulls.toString();
}

export default router;
