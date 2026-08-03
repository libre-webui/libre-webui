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
  ChatGenerationOptions,
  ChatMessage,
  ChatProviderType,
  ChatSession,
  SessionFolder,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { API_BASE_URL } from '@/utils/config';
import { api, createDemoResponse, logger } from './client';
import { DEMO_SESSIONS, getDemoSessions } from './demoData';

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
    title?: string,
    personaId?: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ): Promise<ApiResponse<ChatSession>> => {
    if (import.meta.env.VITE_DEMO_MODE === 'true') {
      const newSession: ChatSession = {
        id: `demo-session-${Date.now()}`,
        title: title || 'New Chat',
        model,
        providerType,
        providerId:
          providerType === 'plugin' || providerType === 'agent'
            ? providerId
            : null,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        personaId,
      };
      DEMO_SESSIONS.unshift(newSession);
      return createDemoResponse(newSession);
    }
    return api
      .post('/chat/sessions', {
        model,
        title,
        personaId,
        providerType,
        providerId,
      })
      .then(res => res.data);
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
      const sessionIndex = DEMO_SESSIONS.findIndex(s => s.id === sessionId);
      const session = DEMO_SESSIONS[sessionIndex];
      if (session) {
        const updatedSession = {
          ...session,
          ...updates,
          updatedAt: Date.now(),
        };
        DEMO_SESSIONS[sessionIndex] = updatedSession;
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

  generateTitle: (
    sessionId: string,
    model: string,
    message: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ): Promise<
    ApiResponse<{
      title: string;
      source: 'plugin' | 'ollama' | 'fallback';
      updatedAt: number;
    }>
  > => {
    if (isDemoMode()) {
      const title =
        message.substring(0, 30) + (message.length > 30 ? '...' : '');
      return createDemoResponse({
        title,
        source: 'fallback' as const,
        updatedAt: Date.now(),
      });
    }
    return api
      .post(`/chat/sessions/${sessionId}/generate-title`, {
        model,
        message,
        providerType,
        providerId,
      })
      .then(res => res.data);
  },

  // Session folders
  getFolders: (): Promise<ApiResponse<SessionFolder[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }
    return api.get('/chat/folders').then(res => res.data);
  },

  createFolder: (name: string): Promise<ApiResponse<SessionFolder>> =>
    api.post('/chat/folders', { name }).then(res => res.data),

  renameFolder: (
    folderId: string,
    name: string
  ): Promise<ApiResponse<SessionFolder>> =>
    api.put(`/chat/folders/${folderId}`, { name }).then(res => res.data),

  deleteFolder: (folderId: string): Promise<ApiResponse> =>
    api.delete(`/chat/folders/${folderId}`).then(res => res.data),

  generateFollowUps: (
    sessionId: string
  ): Promise<ApiResponse<{ suggestions: string[] }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ suggestions: [] });
    }
    return api
      .post(`/chat/sessions/${sessionId}/followups`)
      .then(res => res.data);
  },

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

  updateMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<ChatMessage>
  ): Promise<ApiResponse<ChatMessage>> => {
    if (isDemoMode()) {
      return createDemoResponse<ChatMessage>({} as ChatMessage);
    }
    return api
      .put(`/chat/sessions/${sessionId}/messages/${messageId}`, updates)
      .then(res => res.data);
  },

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
                      logger.error('Failed to parse SSE data:', parseError);
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

  // Branching API
  getMessageBranches: (
    sessionId: string,
    messageId: string
  ): Promise<ApiResponse<ChatMessage[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }
    return api
      .get(`/chat/sessions/${sessionId}/messages/${messageId}/branches`)
      .then(res => res.data);
  },

  switchMessageBranch: (
    sessionId: string,
    messageId: string,
    branchIndex: number
  ): Promise<ApiResponse<ChatMessage>> => {
    if (isDemoMode()) {
      return createDemoResponse<ChatMessage>({} as ChatMessage);
    }
    return api
      .post(`/chat/sessions/${sessionId}/messages/${messageId}/branch`, {
        branchIndex,
      })
      .then(res => res.data);
  },

  createMessageBranch: (
    sessionId: string,
    originalMessageId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }
  ): Promise<ApiResponse<ChatMessage>> => {
    if (isDemoMode()) {
      return createDemoResponse<ChatMessage>({} as ChatMessage);
    }
    return api
      .post(
        `/chat/sessions/${sessionId}/messages/${originalMessageId}/branches`,
        {
          ...message,
        }
      )
      .then(res => res.data);
  },
};
