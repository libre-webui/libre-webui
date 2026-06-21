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

import type {
  ApiResponse,
  EmbeddingPayload,
  EmbeddingResponse,
  ModelCreatePayload,
  OllamaModel,
  RunningModel,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { API_BASE_URL } from '@/utils/config';
import { api, createDemoResponse } from './client';
import { DEMO_MODELS } from './demoData';

export const ollamaApi = {
  // Health check
  checkHealth: (): Promise<ApiResponse<{ status: string }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ status: 'offline' }, false);
    }
    return api.get('/ollama/health').then(res => res.data);
  },

  // Models
  getModels: (): Promise<ApiResponse<OllamaModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse(DEMO_MODELS);
    }
    return api.get('/ollama/models').then(res => res.data);
  },

  pullModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .post('/ollama/models/pull', { name: modelName })
      .then(res => res.data);
  },

  pullModelStream: (
    modelName: string,
    onProgress: (progress: {
      status: string;
      digest?: string;
      total?: number;
      completed?: number;
      percent?: number;
    }) => void,
    onComplete: () => void,
    onError: (error: string) => void
  ): (() => void) => {
    if (isDemoMode()) {
      // Simulate pull progress for demo mode
      let progress = 0;
      const interval = setInterval(() => {
        progress += Math.random() * 20;
        if (progress >= 100) {
          progress = 100;
          onProgress({
            status: 'success',
            total: 100,
            completed: 100,
            percent: 100,
          });
          clearInterval(interval);
          setTimeout(onComplete, 500);
        } else {
          onProgress({
            status: 'pulling',
            total: 100,
            completed: progress,
            percent: Math.round(progress),
          });
        }
      }, 1000);
      return () => clearInterval(interval);
    }

    const params = new URLSearchParams({
      model: modelName,
    });
    const token = localStorage.getItem('auth-token');
    if (token) {
      params.set('token', token);
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/ollama/pull/stream?${params.toString()}`
    );

    eventSource.onmessage = event => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'progress':
          onProgress({
            status: data.status,
            digest: data.digest,
            total: data.total,
            completed: data.completed,
            percent: data.percent,
          });
          break;
        case 'complete':
          eventSource.close();
          onComplete();
          break;
        case 'error':
          eventSource.close();
          onError(data.error);
          break;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      onError('Connection to server lost');
    };

    // Return cancel function
    return () => {
      eventSource.close();
    };
  },

  deleteModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .delete('/ollama/models', { params: { name: modelName } })
      .then(res => res.data);
  },

  showModel: (
    modelName: string,
    verbose = false
  ): Promise<ApiResponse<OllamaModel | null>> => {
    if (isDemoMode()) {
      const model = DEMO_MODELS.find(m => m.name === modelName);
      return createDemoResponse(model || null, !!model);
    }
    return api
      .get('/ollama/models/show', { params: { name: modelName, verbose } })
      .then(res => res.data);
  },

  createModel: (payload: ModelCreatePayload): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.post('/ollama/models', payload).then(res => res.data);
  },

  copyModel: (source: string, destination: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .post('/ollama/models/copy', { source, destination })
      .then(res => res.data);
  },

  pushModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .post('/ollama/models/push', { name: modelName })
      .then(res => res.data);
  },

  pullAllModels: (): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.post('/ollama/models/pull-all').then(res => res.data);
  },

  pullAllModelsStream: (
    onProgress: (progress: {
      current: number;
      total: number;
      modelName: string;
      status: 'starting' | 'success' | 'error';
      error?: string;
    }) => void,
    onComplete: () => void,
    onError: (error: string) => void
  ): void => {
    if (isDemoMode()) {
      // Simulate progress for demo mode
      const demoModels = DEMO_MODELS;
      let current = 0;
      const interval = setInterval(() => {
        current++;
        if (current <= demoModels.length) {
          onProgress({
            current,
            total: demoModels.length,
            modelName: demoModels[current - 1]?.name || 'demo-model',
            status: Math.random() > 0.1 ? 'success' : 'error',
            error: Math.random() > 0.1 ? undefined : 'Demo error',
          });
        }
        if (current >= demoModels.length) {
          clearInterval(interval);
          setTimeout(onComplete, 500);
        }
      }, 1000);
      return;
    }

    const eventSource = new EventSource(
      `${API_BASE_URL}/ollama/models/pull-all/stream`
    );

    eventSource.onmessage = event => {
      const data = JSON.parse(event.data);

      switch (data.type) {
        case 'progress':
          onProgress({
            current: data.current,
            total: data.total,
            modelName: data.modelName,
            status: data.status,
            error: data.error,
          });
          break;
        case 'complete':
          eventSource.close();
          onComplete();
          break;
        case 'error':
          eventSource.close();
          onError(data.error);
          break;
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      onError('Connection to server lost');
    };
  },

  generateEmbeddings: (
    payload: EmbeddingPayload
  ): Promise<ApiResponse<EmbeddingResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse({ embeddings: [[]] }, false);
    }
    return api.post('/ollama/embed', payload).then(res => res.data);
  },

  listRunningModels: (): Promise<ApiResponse<RunningModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }
    return api.get('/ollama/running').then(res => res.data);
  },

  // Unload a model from VRAM (useful on Windows to free memory before switching)
  unloadModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null);
    }
    return api
      .post('/ollama/models/unload', { name: modelName })
      .then(res => res.data);
  },

  // Unload all running models from VRAM
  unloadAllModels: (): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null);
    }
    return api.post('/ollama/models/unload-all').then(res => res.data);
  },

  getVersion: (): Promise<ApiResponse<{ version: string }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ version: 'demo-mode' }, false);
    }
    return api.get('/ollama/version').then(res => res.data);
  },

  // Chat completion
  chatCompletion: (payload: {
    model: string;
    messages: Array<{ role: string; content: string; images?: string[] }>;
    stream?: boolean;
    format?: string | Record<string, unknown>;
    options?: Record<string, unknown>;
  }): Promise<ApiResponse<{ message: { content: string; role: string } }>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        { message: { content: 'Demo response', role: 'assistant' } },
        false
      );
    }
    return api.post('/ollama/chat', payload).then(res => res.data);
  },

  // Blob management
  checkBlobExists: (digest: string): Promise<boolean> => {
    if (isDemoMode()) {
      return Promise.resolve(false);
    }
    return api
      .head(`/ollama/blobs/${digest}`)
      .then(() => true)
      .catch(() => false);
  },

  pushBlob: (digest: string, data: Blob | Buffer): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .post(`/ollama/blobs/${digest}`, data, {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
      .then(res => res.data);
  },

  // Legacy embeddings (deprecated)
  generateLegacyEmbeddings: (payload: {
    model: string;
    prompt: string;
    options?: Record<string, unknown>;
  }): Promise<ApiResponse<{ embedding: number[] }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ embedding: [] }, false);
    }
    return api.post('/ollama/embeddings', payload).then(res => res.data);
  },

  getLibraryModels: (params?: {
    search?: string;
    sort?: 'popular' | 'newest';
    category?: string;
  }): Promise<
    ApiResponse<
      Array<{
        name: string;
        description: string;
        category: string;
        sizes: string[];
        pulls?: string;
        tags?: string[];
      }>
    >
  > => {
    if (isDemoMode()) {
      const demoLibraryModels = [
        {
          name: 'llama3.2',
          description: "Meta's latest Llama model",
          category: 'general',
          sizes: ['1b', '3b'],
          pulls: '50M+',
          tags: ['general'],
        },
        {
          name: 'deepseek-r1',
          description: 'Open reasoning model',
          category: 'reasoning',
          sizes: ['7b', '14b', '32b'],
          pulls: '200M+',
          tags: ['reasoning'],
        },
      ];

      if (params?.category === 'cloud') {
        return createDemoResponse([
          {
            name: 'gpt-oss:cloud',
            description: 'Demo cloud model using Ollama cloud naming',
            category: 'cloud',
            sizes: ['cloud'],
            pulls: 'Cloud',
            tags: ['cloud'],
          },
        ]);
      }

      return createDemoResponse(demoLibraryModels);
    }
    const queryParams = new URLSearchParams();
    if (params?.search) queryParams.set('search', params.search);
    if (params?.sort) queryParams.set('sort', params.sort);
    if (params?.category) queryParams.set('category', params.category);
    const queryString = queryParams.toString();
    return api
      .get(`/ollama/library${queryString ? `?${queryString}` : ''}`)
      .then(res => res.data);
  },
};
