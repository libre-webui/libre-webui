import axios from 'axios';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  OllamaModel,
  UserPreferences,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

console.log('API_BASE_URL configured as:', API_BASE_URL);
console.log('Environment variables:', import.meta.env);
console.log('Demo mode detected:', isDemoMode());

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

const DEMO_SESSIONS: ChatSession[] = [
  {
    id: 'demo-session-1',
    title: 'Demo Chat Session',
    model: 'llama3.2:3b',
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

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
});

// Request interceptor
api.interceptors.request.use(
  config => {
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
    if (isDemoMode()) {
      return createDemoResponse(DEMO_SESSIONS);
    }
    return api.get('/chat/sessions').then(res => res.data);
  },

  createSession: (
    model: string,
    title?: string
  ): Promise<ApiResponse<ChatSession>> => {
    if (isDemoMode()) {
      const newSession: ChatSession = {
        id: `demo-session-${Date.now()}`,
        title: title || 'New Demo Session',
        model,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return createDemoResponse(newSession);
    }
    return api.post('/chat/sessions', { model, title }).then(res => res.data);
  },

  getSession: (sessionId: string): Promise<ApiResponse<ChatSession>> => {
    if (isDemoMode()) {
      const session = DEMO_SESSIONS.find(s => s.id === sessionId);
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
    options?: any
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
    options?: any
  ): Promise<ApiResponse<ChatMessage>> =>
    api
      .post(`/chat/sessions/${sessionId}/generate`, { message, options })
      .then(res => res.data),

  // Streaming chat generation
  generateChatStreamResponse: (
    sessionId: string,
    message: string,
    options?: any
  ) => {
    return {
      subscribe: async (
        onMessage: (data: any) => void,
        onError?: (error: any) => void,
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
              .catch(error => {
                onError?.(error);
              });
          };

          processChunk();

          return () => reader.cancel();
        } catch (error) {
          onError?.(error);
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

  deleteModel: (modelName: string): Promise<ApiResponse> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.delete(`/ollama/models/${modelName}`).then(res => res.data);
  },

  showModel: (
    modelName: string,
    verbose = false
  ): Promise<ApiResponse<any>> => {
    if (isDemoMode()) {
      const model = DEMO_MODELS.find(m => m.name === modelName);
      return createDemoResponse(model || null, !!model);
    }
    return api
      .get(`/ollama/models/${modelName}`, { params: { verbose } })
      .then(res => res.data);
  },

  createModel: (payload: any): Promise<ApiResponse> => {
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

  generateEmbeddings: (payload: any): Promise<ApiResponse<any>> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.post('/ollama/embed', payload).then(res => res.data);
  },

  listRunningModels: (): Promise<ApiResponse<any>> => {
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
  chatCompletion: (payload: any): Promise<ApiResponse<any>> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
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
  generateLegacyEmbeddings: (payload: any): Promise<ApiResponse<any>> => {
    if (isDemoMode()) {
      return createDemoResponse(null, false);
    }
    return api.post('/ollama/embeddings', payload).then(res => res.data);
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
};

export default api;
