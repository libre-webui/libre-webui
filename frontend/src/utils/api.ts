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

import axios from 'axios';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  OllamaModel,
  UserPreferences,
  ChatGenerationOptions,
  ModelCreatePayload,
  EmbeddingPayload,
  EmbeddingResponse,
  RunningModel,
  Plugin,
  PluginStatus,
  DocumentSummary,
  DocumentDetail,
  DocumentChunk,
  User,
  UserCreateRequest,
  UserUpdateRequest,
  LoginRequest,
  LoginResponse,
  SystemInfo,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  `${window.location.protocol}//${window.location.hostname}:3001/api`;

console.log('🚀 API_BASE_URL configured as:', API_BASE_URL);
console.log('🌐 Window location:', window.location);
console.log('🔧 Environment variables:', import.meta.env);
console.log('📱 User agent:', navigator.userAgent);
console.log('🎭 Demo mode detected:', isDemoMode());

// Mock response helper for demo mode
const createDemoResponse = <T>(
  data: T,
  success = true
): Promise<ApiResponse<T>> => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({
        success,
        data,
        error: success ? undefined : 'Demo mode: Backend not available',
      });
    }, 500); // Simulate network delay
  });
};

// Demo data for when backend is not available
const DEMO_MODELS: OllamaModel[] = [
  {
    name: 'llama3.2:3b',
    size: 2048000000,
    digest: 'demo-digest-1',
    modified_at: new Date().toISOString(),
    details: {
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '3B',
      quantization_level: 'Q4_0',
    },
  },
  {
    name: 'qwen2.5:7b',
    size: 4096000000,
    digest: 'demo-digest-2',
    modified_at: new Date().toISOString(),
    details: {
      format: 'gguf',
      family: 'qwen',
      families: ['qwen'],
      parameter_size: '7B',
      quantization_level: 'Q4_0',
    },
  },
];

const getDemoSessions = (): ChatSession[] => {
  // Always return at least one session in demo mode
  return [
    {
      id: 'demo-session-1',
      title: 'Demo Chat Session',
      model: DEMO_MODELS[0].name,
      messages: [
        {
          id: 'demo-msg-1',
          role: 'user',
          content: 'Hello! Can you tell me about this demo?',
          timestamp: Date.now(),
        },
        {
          id: 'demo-msg-2',
          role: 'assistant',
          content:
            'This is a demo of Libre WebUI! In a real deployment, I would be powered by Ollama running locally on your machine. This demo shows the beautiful interface and features without the backend connection.',
          timestamp: Date.now(),
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
};

const DEMO_SESSIONS: ChatSession[] = getDemoSessions();

// Get timeout from environment variable, default to 5 minutes for large models
const API_TIMEOUT = import.meta.env.VITE_API_TIMEOUT
  ? parseInt(import.meta.env.VITE_API_TIMEOUT)
  : 300000;

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
});

// Request interceptor
api.interceptors.request.use(
  config => {
    // Add auth token if available
    const token = localStorage.getItem('auth-token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  error => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  response => {
    return response;
  },
  error => {
    console.error('API Error:', error);
    return Promise.reject(error);
  }
);

export const chatApi = {
  // Sessions
  getSessions: (): Promise<ApiResponse<ChatSession[]>> => {
    // DEMO MODE PATCH: Only use demo sessions if VITE_DEMO_MODE is explicitly 'true'
    if (import.meta.env.VITE_DEMO_MODE === 'true') {
      return createDemoResponse(getDemoSessions());
    }
    return api.get('/chat/sessions').then(res => res.data);
  },

  createSession: (
    model: string,
    title?: string
  ): Promise<ApiResponse<ChatSession>> => {
    if (import.meta.env.VITE_DEMO_MODE === 'true') {
      const newSession: ChatSession = {
        id: `demo-session-${Date.now()}`,
        title: title || 'New Demo Session',
        model,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      DEMO_SESSIONS.unshift(newSession);
      return createDemoResponse(newSession);
    }
    return api.post('/chat/sessions', { model, title }).then(res => res.data);
  },

  getSession: (sessionId: string): Promise<ApiResponse<ChatSession>> => {
    if (isDemoMode()) {
      const session = getDemoSessions().find(s => s.id === sessionId);
      if (session) {
        return createDemoResponse(session);
      }
      return Promise.resolve({
        success: false,
        error: 'Session not found in demo mode',
      });
    }
    return api.get(`/chat/sessions/${sessionId}`).then(res => res.data);
  },

  updateSession: (
    sessionId: string,
    updates: Partial<ChatSession>
  ): Promise<ApiResponse<ChatSession>> => {
    if (isDemoMode()) {
      const session = DEMO_SESSIONS.find(s => s.id === sessionId);
      if (session) {
        const updatedSession = {
          ...session,
          ...updates,
          updatedAt: Date.now(),
        };
        return createDemoResponse(updatedSession);
      }
      return Promise.resolve({
        success: false,
        error: 'Session not found in demo mode',
      });
    }
    return api
      .put(`/chat/sessions/${sessionId}`, updates)
      .then(res => res.data);
  },

  deleteSession: (sessionId: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null);
    }
    return api.delete(`/chat/sessions/${sessionId}`).then(res => res.data);
  },

  clearAllSessions: (): Promise<ApiResponse> =>
    api.delete('/chat/sessions').then(res => res.data),

  // Messages
  sendMessage: (
    sessionId: string,
    content: string,
    options?: ChatGenerationOptions
  ): Promise<
    ApiResponse<{ userMessage: ChatMessage; assistantMessage: ChatMessage }>
  > =>
    api
      .post(`/chat/sessions/${sessionId}/messages`, { content, options })
      .then(res => res.data),

  saveMessage: (
    sessionId: string,
    message: Omit<ChatMessage, 'timestamp'> & { timestamp?: number }
  ): Promise<ApiResponse<ChatMessage>> =>
    api
      .post(`/chat/sessions/${sessionId}/messages`, message)
      .then(res => res.data),

  // Chat generation using new Ollama chat API
  generateChatResponse: (
    sessionId: string,
    message: string,
    options?: ChatGenerationOptions
  ): Promise<ApiResponse<ChatMessage>> =>
    api
      .post(`/chat/sessions/${sessionId}/generate`, { message, options })
      .then(res => res.data),

  // Streaming chat generation
  generateChatStreamResponse: (
    sessionId: string,
    message: string,
    options?: ChatGenerationOptions
  ) => {
    return {
      subscribe: async (
        onMessage: (
          data: ChatMessage | { content: string; done?: boolean }
        ) => void,
        onError?: (error: Error) => void,
        onComplete?: () => void
      ) => {
        try {
          const response = await fetch(
            `${API_BASE_URL}/chat/sessions/${sessionId}/generate/stream`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ message, options }),
            }
          );

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('No response body reader available');
          }

          const decoder = new TextDecoder();
          let buffer = '';

          const processChunk = () => {
            reader
              .read()
              .then(({ done, value }) => {
                if (done) {
                  onComplete?.();
                  return;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                  const trimmedLine = line.trim();
                  if (trimmedLine.startsWith('data: ')) {
                    const data = trimmedLine.slice(6);

                    if (data === '[DONE]') {
                      onComplete?.();
                      return;
                    }

                    try {
                      const parsedData = JSON.parse(data);
                      onMessage(parsedData);

                      if (
                        parsedData.type === 'done' ||
                        parsedData.type === 'error'
                      ) {
                        if (parsedData.type === 'error') {
                          onError?.(parsedData.error);
                        } else {
                          onComplete?.();
                        }
                        return;
                      }
                    } catch (parseError) {
                      console.error('Failed to parse SSE data:', parseError);
                    }
                  }
                }

                processChunk();
              })
              .catch(_error => {
                onError?.(
                  _error instanceof Error ? _error : new Error(String(_error))
                );
              });
          };

          processChunk();

          return () => reader.cancel();
        } catch (_error) {
          onError?.(
            _error instanceof Error ? _error : new Error(String(_error))
          );
          return () => {};
        }
      },
    };
  },
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

  pullModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.post(`/ollama/models/${modelName}/pull`).then(res => res.data);
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

    const eventSource = new EventSource(
      `${API_BASE_URL}/ollama/models/${modelName}/pull/stream`
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
    return api.delete(`/ollama/models/${modelName}`).then(res => res.data);
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
      .get(`/ollama/models/${modelName}`, { params: { verbose } })
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
    return api.post(`/ollama/models/${modelName}/push`).then(res => res.data);
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
};

export const pluginApi = {
  getAllPlugins: (): Promise<ApiResponse<Plugin[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin[]>([]);
    }
    return api.get('/plugins').then(res => res.data);
  },

  uploadPlugin: (file: File): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    const formData = new FormData();
    formData.append('plugin', file);
    return api
      .post('/plugins/upload', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      .then(res => res.data);
  },

  installPlugin: (
    pluginData: Omit<Plugin, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    return api.post('/plugins', pluginData).then(res => res.data);
  },

  updatePlugin: (
    id: string,
    updates: Partial<Plugin>
  ): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    return api.put(`/plugins/${id}`, updates).then(res => res.data);
  },

  deletePlugin: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse<void>(undefined);
    }
    return api.delete(`/plugins/${id}`).then(res => res.data);
  },

  activatePlugin: (id: string): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    return api.post(`/plugins/activate/${id}`).then(res => res.data);
  },

  deactivatePlugin: (id?: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse<void>(undefined);
    }
    const endpoint = id ? `/plugins/deactivate/${id}` : '/plugins/deactivate';
    return api.post(endpoint).then(res => res.data);
  },

  getActivePlugin: (): Promise<ApiResponse<Plugin | null>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin | null>(null);
    }
    return api.get('/plugins/active').then(res => res.data);
  },

  getPluginStatus: (): Promise<ApiResponse<PluginStatus[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<PluginStatus[]>([]);
    }
    return api.get('/plugins/status').then(res => res.data);
  },

  exportPlugin: (id: string): Promise<Blob> => {
    if (isDemoMode()) {
      return Promise.resolve(new Blob(['{}'], { type: 'application/json' }));
    }
    return api
      .get(`/plugins/${id}/export`, {
        responseType: 'blob',
      })
      .then(res => res.data);
  },
};

export const preferencesApi = {
  getPreferences: (): Promise<ApiResponse<UserPreferences>> =>
    api.get('/preferences').then(res => res.data),

  updatePreferences: (
    updates: Partial<UserPreferences>
  ): Promise<ApiResponse<UserPreferences>> =>
    api.put('/preferences', updates).then(res => res.data),

  setDefaultModel: (model: string): Promise<ApiResponse<UserPreferences>> =>
    api.put('/preferences/default-model', { model }).then(res => res.data),

  setSystemMessage: (message: string): Promise<ApiResponse<UserPreferences>> =>
    api.put('/preferences/system-message', { message }).then(res => res.data),

  setGenerationOptions: (
    options: Partial<UserPreferences['generationOptions']>
  ): Promise<ApiResponse<UserPreferences>> =>
    api.put('/preferences/generation-options', options).then(res => res.data),

  resetGenerationOptions: (): Promise<ApiResponse<UserPreferences>> =>
    api.post('/preferences/generation-options/reset').then(res => res.data),

  // Embedding settings
  setEmbeddingSettings: (
    settings: UserPreferences['embeddingSettings']
  ): Promise<ApiResponse<UserPreferences>> =>
    api.put('/preferences/embedding-settings', settings).then(res => res.data),

  resetEmbeddingSettings: (): Promise<ApiResponse<UserPreferences>> =>
    api.post('/preferences/embedding-settings/reset').then(res => res.data), // Data import/export
  importData: (
    data: Record<string, unknown>,
    mergeStrategy: 'replace' | 'merge' = 'replace'
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserPreferences>({
        theme: { mode: 'dark' },
        defaultModel: 'llama3.2',
        systemMessage: 'You are a helpful assistant.',
        generationOptions: {},
        embeddingSettings: {
          enabled: false,
          model: 'nomic-embed-text',
          chunkSize: 1000,
          chunkOverlap: 200,
          similarityThreshold: 0.7,
        },
        showUsername: false, // Default to showing "You"
      });
    }

    return api
      .post('/preferences/import', { data, mergeStrategy })
      .then(res => res.data);
  },
};

export const documentsApi = {
  uploadDocument: (
    file: File,
    sessionId?: string
  ): Promise<ApiResponse<DocumentSummary>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: 'demo-doc-' + Date.now(),
        filename: file.name,
        fileType: file.name.endsWith('.pdf')
          ? ('pdf' as const)
          : ('txt' as const),
        size: file.size,
        sessionId,
        uploadedAt: Date.now(),
      });
    }

    const formData = new FormData();
    formData.append('document', file);
    if (sessionId) {
      formData.append('sessionId', sessionId);
    }

    return api
      .post('/documents/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      })
      .then(res => res.data);
  },

  getDocuments: (
    sessionId?: string
  ): Promise<ApiResponse<DocumentSummary[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }

    const url = sessionId ? `/documents/session/${sessionId}` : '/documents';
    return api.get(url).then(res => res.data);
  },

  getDocument: (documentId: string): Promise<ApiResponse<DocumentDetail>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: documentId,
        filename: 'demo-document.pdf',
        fileType: 'pdf' as const,
        size: 1024,
        content: 'Demo document content...',
        uploadedAt: Date.now(),
      });
    }

    return api.get(`/documents/${documentId}`).then(res => res.data);
  },

  searchDocuments: (
    query: string,
    sessionId?: string,
    limit?: number
  ): Promise<ApiResponse<DocumentChunk[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }

    return api
      .post('/documents/search', { query, sessionId, limit })
      .then(res => res.data);
  },

  deleteDocument: (documentId: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/documents/${documentId}`).then(res => res.data);
  },

  // Embedding management
  getEmbeddingStatus: (): Promise<
    ApiResponse<{
      available: boolean;
      model: string;
      chunksWithEmbeddings: number;
      totalChunks: number;
    }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({
        available: false,
        model: 'nomic-embed-text',
        chunksWithEmbeddings: 0,
        totalChunks: 0,
      });
    }

    return api.get('/documents/embeddings/status').then(res => res.data);
  },

  regenerateEmbeddings: (): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.post('/documents/embeddings/regenerate').then(res => res.data);
  },
};

// Authentication API
export const authApi = {
  login: (credentials: LoginRequest): Promise<ApiResponse<LoginResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user',
          username: 'demo',
          email: 'demo@example.com',
          role: 'admin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token',
        systemInfo: {
          requiresAuth: true,
          singleUserMode: false,
          hasUsers: true,
          version: '0.1.0',
        },
      });
    }

    return api.post('/auth/login', credentials).then(res => res.data);
  },

  signup: (credentials: {
    username: string;
    password: string;
    email?: string;
  }): Promise<ApiResponse<LoginResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user-new',
          username: credentials.username,
          email: credentials.email || '',
          role: 'user',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token-new',
        systemInfo: {
          requiresAuth: true,
          singleUserMode: false,
          hasUsers: true,
          version: '0.1.0',
        },
      });
    }

    return api.post('/auth/signup', credentials).then(res => res.data);
  },

  logout: (): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.post('/auth/logout').then(res => res.data);
  },

  getSystemInfo: (): Promise<ApiResponse<SystemInfo>> => {
    console.log('getSystemInfo called, demo mode:', isDemoMode());

    if (isDemoMode()) {
      return createDemoResponse<SystemInfo>({
        requiresAuth: true,
        singleUserMode: false,
        hasUsers: true,
        version: '0.1.0',
      });
    }

    console.log('🔍 Making API call to:', API_BASE_URL + '/auth/system-info');
    console.log(
      '🌐 Full URL from:',
      window.location.origin,
      '-> API:',
      API_BASE_URL + '/auth/system-info'
    );
    return api
      .get('/auth/system-info')
      .then(res => {
        console.log('✅ getSystemInfo response:', res.data);
        return res.data;
      })
      .catch(error => {
        console.error('❌ getSystemInfo error:', error);
        if (error.response) {
          console.error('📄 Error response data:', error.response.data);
          console.error('🔢 Error status:', error.response.status);
          console.error('🔧 Error headers:', error.response.headers);
        }
        if (error.request) {
          console.error(
            '📡 Network error - no response received:',
            error.request
          );
        }
        console.error('🎯 Error config:', error.config);
        throw error;
      });
  },

  verifyToken: (): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id: 'demo-user',
        username: 'demo',
        email: 'demo@example.com',
        role: 'admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.get('/auth/verify').then(res => res.data);
  },
};

// Users API
export const usersApi = {
  getUsers: (): Promise<ApiResponse<User[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<User[]>([
        {
          id: 'demo-user',
          username: 'demo',
          email: 'demo@example.com',
          role: 'admin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
    }

    return api.get('/users').then(res => res.data);
  },

  createUser: (userData: UserCreateRequest): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id: 'new-user-' + Date.now(),
        username: userData.username,
        email: userData.email,
        role: userData.role,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.post('/users', userData).then(res => res.data);
  },

  updateUser: (
    id: string,
    userData: UserUpdateRequest
  ): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id,
        username: userData.username || 'demo',
        email: userData.email || 'demo@example.com',
        role: userData.role || 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch(`/users/${id}`, userData).then(res => res.data);
  },

  deleteUser: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/users/${id}`).then(res => res.data);
  },
};

export default api;
