import express, { Request, Response } from 'express';
import ollamaService from '../services/ollamaService';
import { ApiResponse, OllamaModel } from '../types';

const router = express.Router();

// Health check
router.get('/health', async (req: Request, res: Response<ApiResponse<{ status: string }>>): Promise<void> => {
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
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get available models
router.get('/models', async (req: Request, res: Response<ApiResponse<OllamaModel[]>>): Promise<void> => {
  try {
    const models = await ollamaService.getModels();
    res.json({
      success: true,
      data: models,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Pull all models
router.post('/models/pull-all', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const result = await ollamaService.pullAllModels();
    res.json({
      success: result.success,
      data: result.results,
      message: result.success ? 'All models updated.' : 'Some models failed to update.'
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Pull all models with streaming progress (GET for Server-Sent Events)
router.get('/models/pull-all/stream', async (req: Request, res: Response): Promise<void> => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    await ollamaService.pullAllModelsStream(
      (progress) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', ...progress })}\n\n`);
      },
      () => {
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        res.end();
      },
      (error) => {
        res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
        res.end();
      }
    );
  } catch (error: any) {
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
    res.end();
  }
});

// Pull a new model
router.post('/models/:modelName/pull', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const { modelName } = req.params;
    await ollamaService.pullModel(modelName);
    
    res.json({
      success: true,
      message: `Model ${modelName} pulled successfully`,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Delete a model
router.delete('/models/:modelName', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const { modelName } = req.params;
    await ollamaService.deleteModel(modelName);
    
    res.json({
      success: true,
      message: `Model ${modelName} deleted successfully`,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Show model information
router.get('/models/:modelName', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const { modelName } = req.params;
    const verbose = req.query.verbose === 'true';
    const data = await ollamaService.showModel(modelName, verbose);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a model
router.post('/models', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    await ollamaService.createModel(req.body);
    res.json({ success: true, message: 'Model created successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Copy a model
router.post('/models/copy', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const { source, destination } = req.body;
    await ollamaService.copyModel(source, destination);
    res.json({ success: true, message: 'Model copied successfully' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Push a model
router.post('/models/:modelName/push', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const { modelName } = req.params;
    await ollamaService.pushModel(modelName);
    res.json({ success: true, message: `Model ${modelName} pushed successfully` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate embeddings
router.post('/embed', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const data = await ollamaService.generateEmbeddings(req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List running models
router.get('/running', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const data = await ollamaService.listRunningModels();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get Ollama version
router.get('/version', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const data = await ollamaService.getVersion();
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Chat completion (non-streaming)
router.post('/chat', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const data = await ollamaService.generateChatResponse(req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Chat completion (streaming)
router.post('/chat/stream', async (req: Request, res: Response): Promise<void> => {
  try {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    await ollamaService.generateChatStreamResponse(
      req.body,
      (chunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
      (error) => {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      },
      () => {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    );
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check if blob exists
router.head('/blobs/:digest', async (req: Request, res: Response): Promise<void> => {
  try {
    const { digest } = req.params;
    const exists = await ollamaService.checkBlobExists(digest);
    
    if (exists) {
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  } catch (error: any) {
    res.status(500).end();
  }
});

// Push a blob
router.post('/blobs/:digest', async (req: Request, res: Response): Promise<void> => {
  try {
    const { digest } = req.params;
    
    // Handle raw binary data
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    
    req.on('end', async () => {
      try {
        const data = Buffer.concat(chunks);
        await ollamaService.pushBlob(digest, data);
        res.status(201).json({ success: true, message: 'Blob created successfully' });
      } catch (error: any) {
        res.status(400).json({ success: false, error: error.message });
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Legacy embeddings endpoint (deprecated)
router.post('/embeddings', async (req: Request, res: Response<ApiResponse>): Promise<void> => {
  try {
    const data = await ollamaService.generateLegacyEmbeddings(req.body);
    res.json({ success: true, data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
