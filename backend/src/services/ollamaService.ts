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

import axios, { AxiosInstance } from 'axios';
import {
  OllamaModel,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
} from '../types';

class OllamaService {
  private client: AxiosInstance;
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.client = axios.create({
      baseURL: this.baseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.client.get('/');
      return response.status === 200;
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED') {
        console.warn(
          'Ollama service is not running. Please start it with: ollama serve'
        );
      } else {
        console.error('Ollama health check failed:', error.message);
      }
      return false;
    }
  }

  async getModels(): Promise<OllamaModel[]> {
    try {
      console.log('Fetching models from Ollama...');
      const response = await this.client.get('/api/tags');
      console.log('Ollama response:', JSON.stringify(response.data, null, 2));
      const models = response.data.models || [];
      console.log(`Found ${models.length} models`);
      return models;
    } catch (error: any) {
      if (error.code === 'ECONNREFUSED') {
        console.error(
          'Cannot connect to Ollama. Please ensure Ollama is running with: ollama serve'
        );
        throw new Error(
          'Ollama service is not running. Please start it with: ollama serve'
        );
      } else {
        console.error('Failed to fetch models:', error.message);
        throw new Error('Failed to fetch available models from Ollama');
      }
    }
  }

  async generateResponse(
    request: OllamaGenerateRequest
  ): Promise<OllamaGenerateResponse> {
    try {
      const response = await this.client.post('/api/generate', {
        ...request,
        stream: false, // For non-streaming responses
      });
      return response.data;
    } catch (error: any) {
      console.error('Failed to generate response:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to generate response'
      );
    }
  }

  async generateStreamResponse(
    request: OllamaGenerateRequest,
    onChunk: (chunk: OllamaGenerateResponse) => void,
    onError: (error: Error) => void,
    onComplete: () => void
  ): Promise<void> {
    try {
      const response = await this.client.post(
        '/api/generate',
        {
          ...request,
          stream: true,
        },
        {
          responseType: 'stream',
        }
      );

      let buffer = '';

      response.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              onChunk(data);
              if (data.done) {
                onComplete();
                return;
              }
            } catch (parseError) {
              console.error('Failed to parse chunk:', parseError);
            }
          }
        }
      });

      response.data.on('error', (error: Error) => {
        onError(error);
      });

      response.data.on('end', () => {
        onComplete();
      });
    } catch (error: any) {
      console.error('Failed to generate stream response:', error);
      onError(
        new Error(
          error.response?.data?.error || 'Failed to generate stream response'
        )
      );
    }
  }

  async pullModel(modelName: string): Promise<void> {
    try {
      console.log(`Pulling model: ${modelName}`);
      const response = await this.client.post('/api/pull', {
        name: modelName,
      });
      console.log(`Successfully pulled model: ${modelName}`);
    } catch (error: any) {
      console.error(
        `Failed to pull model ${modelName}:`,
        error.response?.data || error.message
      );
      throw new Error(error.response?.data?.error || 'Failed to pull model');
    }
  }

  async deleteModel(modelName: string): Promise<void> {
    try {
      await this.client.delete('/api/delete', {
        data: { name: modelName },
      });
    } catch (error: any) {
      console.error('Failed to delete model:', error);
      throw new Error(error.response?.data?.error || 'Failed to delete model');
    }
  }

  async showModel(modelName: string, verbose = false): Promise<any> {
    try {
      const response = await this.client.post('/api/show', {
        model: modelName,
        verbose,
      });
      return response.data;
    } catch (error: any) {
      console.error('Failed to show model:', error);
      throw new Error(error.response?.data?.error || 'Failed to show model');
    }
  }

  async createModel(payload: any): Promise<void> {
    try {
      await this.client.post('/api/create', payload);
    } catch (error: any) {
      console.error('Failed to create model:', error);
      throw new Error(error.response?.data?.error || 'Failed to create model');
    }
  }

  async copyModel(source: string, destination: string): Promise<void> {
    try {
      await this.client.post('/api/copy', { source, destination });
    } catch (error: any) {
      console.error('Failed to copy model:', error);
      throw new Error(error.response?.data?.error || 'Failed to copy model');
    }
  }

  async pushModel(modelName: string): Promise<void> {
    try {
      await this.client.post('/api/push', { model: modelName });
    } catch (error: any) {
      console.error('Failed to push model:', error);
      throw new Error(error.response?.data?.error || 'Failed to push model');
    }
  }

  async generateEmbeddings(payload: any): Promise<any> {
    try {
      const response = await this.client.post('/api/embed', payload);
      return response.data;
    } catch (error: any) {
      console.error('Failed to generate embeddings:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to generate embeddings'
      );
    }
  }

  async listRunningModels(): Promise<any> {
    try {
      const response = await this.client.get('/api/ps');
      return response.data;
    } catch (error: any) {
      console.error('Failed to list running models:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to list running models'
      );
    }
  }

  async getVersion(): Promise<any> {
    try {
      const response = await this.client.get('/api/version');
      return response.data;
    } catch (error: any) {
      console.error('Failed to get version:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to get Ollama version'
      );
    }
  }

  // Chat completion methods
  async generateChatResponse(request: any): Promise<any> {
    try {
      const response = await this.client.post('/api/chat', {
        ...request,
        stream: false,
      });
      return response.data;
    } catch (error: any) {
      console.error('Failed to generate chat response:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to generate chat response'
      );
    }
  }

  async generateChatStreamResponse(
    request: any,
    onChunk: (chunk: any) => void,
    onError: (error: Error) => void,
    onComplete: () => void
  ): Promise<void> {
    try {
      const response = await this.client.post(
        '/api/chat',
        {
          ...request,
          stream: true,
        },
        {
          responseType: 'stream',
        }
      );

      let buffer = '';

      response.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const data = JSON.parse(line);
              onChunk(data);
              if (data.done) {
                onComplete();
                return;
              }
            } catch (parseError) {
              console.error('Failed to parse chunk:', parseError);
            }
          }
        }
      });

      response.data.on('error', (error: Error) => {
        onError(error);
      });

      response.data.on('end', () => {
        onComplete();
      });
    } catch (error: any) {
      console.error('Failed to generate chat stream response:', error);
      onError(
        new Error(
          error.response?.data?.error ||
            'Failed to generate chat stream response'
        )
      );
    }
  }

  // Blob management methods
  async checkBlobExists(digest: string): Promise<boolean> {
    try {
      const response = await this.client.head(`/api/blobs/${digest}`);
      return response.status === 200;
    } catch (error: any) {
      if (error.response?.status === 404) {
        return false;
      }
      console.error('Failed to check blob:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to check blob existence'
      );
    }
  }

  async pushBlob(digest: string, data: Buffer | string): Promise<void> {
    try {
      await this.client.post(`/api/blobs/${digest}`, data, {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      });
    } catch (error: any) {
      console.error('Failed to push blob:', error);
      throw new Error(error.response?.data?.error || 'Failed to push blob');
    }
  }

  // Legacy embeddings endpoint (deprecated but still supported)
  async generateLegacyEmbeddings(payload: any): Promise<any> {
    try {
      const response = await this.client.post('/api/embeddings', payload);
      return response.data;
    } catch (error: any) {
      console.error('Failed to generate legacy embeddings:', error);
      throw new Error(
        error.response?.data?.error || 'Failed to generate legacy embeddings'
      );
    }
  }

  // Pull all models
  async pullAllModels(): Promise<{
    success: boolean;
    results: { name: string; success: boolean }[];
  }> {
    const results: { name: string; success: boolean }[] = [];
    try {
      const models = await this.getModels();
      for (const model of models) {
        try {
          await this.pullModel(model.name);
          results.push({ name: model.name, success: true });
        } catch (err: any) {
          results.push({ name: model.name, success: false });
        }
      }
      return { success: true, results };
    } catch (error: any) {
      return { success: false, results };
    }
  }

  // Pull all models with progress streaming
  async pullAllModelsStream(
    onProgress: (progress: {
      current: number;
      total: number;
      modelName: string;
      status: 'starting' | 'success' | 'error';
      error?: string;
    }) => void,
    onComplete: () => void,
    onError: (error: string) => void
  ): Promise<void> {
    try {
      const models = await this.getModels();
      const total = models.length;

      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        try {
          onProgress({
            current: i + 1,
            total,
            modelName: model.name,
            status: 'starting',
          });
          await this.pullModel(model.name);
          onProgress({
            current: i + 1,
            total,
            modelName: model.name,
            status: 'success',
          });
        } catch (err: any) {
          onProgress({
            current: i + 1,
            total,
            modelName: model.name,
            status: 'error',
            error: err.message,
          });
        }
      }
      onComplete();
    } catch (error: any) {
      onError(error.message);
    }
  }
}

export default new OllamaService();
