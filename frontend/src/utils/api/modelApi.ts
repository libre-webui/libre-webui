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
  GenerationOptions,
  EmbeddingResponse,
  ModelCreatePayload,
  OllamaModel,
  RunningModel,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { API_BASE_URL } from '@/utils/config';
import { api, createDemoResponse } from './client';
import { DEMO_MODELS } from './demoData';

const streamWithAuthentication = (
  url: string,
  onData: (data: Record<string, unknown>) => void,
  onError: (error: string) => void
): (() => void) => {
  const controller = new AbortController();
  const token = localStorage.getItem('auth-token');

  void (async () => {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/event-stream',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) {
        let message = `Request failed with status ${response.status}`;
        try {
          const payload = (await response.json()) as {
            error?: unknown;
            message?: unknown;
          };
          if (typeof payload.error === 'string') message = payload.error;
          else if (typeof payload.message === 'string')
            message = payload.message;
        } catch {
          // Keep the status-based fallback for non-JSON responses.
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error('Response stream is unavailable');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() || '';
          for (const event of events) {
            const dataLine = event
              .split(/\r?\n/)
              .find(line => line.startsWith('data:'));
            if (!dataLine) continue;
            onData(
              JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
            );
          }
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        onError(error instanceof Error ? error.message : 'Connection lost');
      }
    }
  })();

  return () => controller.abort();
};

/**
 * Announces that the set of installed models changed, so every list in the
 * app can catch up. Without it a freshly pulled model stays invisible to the
 * chat model picker until the whole application is reloaded.
 */
export const MODELS_CHANGED_EVENT = 'libre:models-changed';

const notifyModelsChanged = (): void => {
  window.dispatchEvent(new Event(MODELS_CHANGED_EVENT));
};

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

  // Who may pull models: 'admins' or 'all-users', plus whether the current
  // account may pull right now.
  getModelAccess: (): Promise<
    ApiResponse<{ mode: 'admins' | 'all-users'; allowed: boolean }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({ mode: 'admins' as const, allowed: false });
    }
    return api.get('/ollama/models/access').then(res => res.data);
  },

  setModelAccess: (
    mode: 'admins' | 'all-users'
  ): Promise<ApiResponse<{ mode: 'admins' | 'all-users' }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ mode });
    }
    return api.put('/ollama/models/access', { mode }).then(res => res.data);
  },

  pullModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.post('/ollama/models/pull', { name: modelName }).then(res => {
      notifyModelsChanged();
      return res.data;
    });
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
          setTimeout(() => {
            notifyModelsChanged();
            onComplete();
          }, 500);
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
    return streamWithAuthentication(
      `${API_BASE_URL}/ollama/pull/stream?${params.toString()}`,
      data => {
        switch (data.type) {
          case 'progress':
            onProgress({
              status: typeof data.status === 'string' ? data.status : 'pulling',
              digest: typeof data.digest === 'string' ? data.digest : undefined,
              total: typeof data.total === 'number' ? data.total : undefined,
              completed:
                typeof data.completed === 'number' ? data.completed : undefined,
              percent:
                typeof data.percent === 'number' ? data.percent : undefined,
            });
            break;
          case 'complete':
            notifyModelsChanged();
            onComplete();
            break;
          case 'error':
            onError(String(data.error || 'Model pull failed'));
            break;
        }
      },
      onError
    );
  },

  deleteModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .delete('/ollama/models', { params: { name: modelName } })
      .then(res => {
        notifyModelsChanged();
        return res.data;
      });
  },

  /** What a model recommends for its own generation, from its modelfile. */
  getModelDefaults: (
    model: string
  ): Promise<
    ApiResponse<{
      model: string;
      options: Partial<GenerationOptions>;
      trainedContextLength?: number;
      contextCapped: boolean;
    }>
  > =>
    api
      .get(`/ollama/models/${encodeURIComponent(model)}/defaults`)
      .then(response => response.data),

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
    return api.post('/ollama/models', payload).then(res => {
      notifyModelsChanged();
      return res.data;
    });
  },

  copyModel: (source: string, destination: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api
      .post('/ollama/models/copy', { source, destination })
      .then(res => {
        notifyModelsChanged();
        return res.data;
      });
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
          setTimeout(() => {
            notifyModelsChanged();
            onComplete();
          }, 500);
        }
      }, 1000);
      return;
    }

    streamWithAuthentication(
      `${API_BASE_URL}/ollama/models/pull-all/stream`,
      data => {
        switch (data.type) {
          case 'progress': {
            const status =
              data.status === 'success' || data.status === 'error'
                ? data.status
                : 'starting';
            onProgress({
              current: typeof data.current === 'number' ? data.current : 0,
              total: typeof data.total === 'number' ? data.total : 0,
              modelName:
                typeof data.modelName === 'string' ? data.modelName : 'unknown',
              status,
              error: typeof data.error === 'string' ? data.error : undefined,
            });
            break;
          }
          case 'complete':
            notifyModelsChanged();
            onComplete();
            break;
          case 'error':
            onError(String(data.error || 'Model update failed'));
            break;
        }
      },
      onError
    );
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
