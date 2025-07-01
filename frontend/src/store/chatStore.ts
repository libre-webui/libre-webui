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

import { create } from 'zustand';
import {
  ChatSession,
  ChatMessage,
  OllamaModel,
  GenerationStatistics,
} from '@/types';
import { chatApi, ollamaApi, preferencesApi } from '@/utils/api';
import { pluginApi } from '@/utils/api';
import { generateId } from '@/utils';
import toast from 'react-hot-toast';

// Helper function to extract error message from unknown error
const getErrorMessage = (error: unknown, fallback: string): string => {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = error as { response?: { data?: { error?: string } } };
    if (response.response?.data?.error) {
      return response.response.data.error;
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
};

interface ChatState {
  // Sessions
  sessions: ChatSession[];
  currentSession: ChatSession | null;
  setCurrentSession: (session: ChatSession | null) => void;
  createSession: (model: string, title?: string) => Promise<void>;
  loadSessions: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;

  // Messages
  addMessage: (
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }
  ) => void;
  updateMessage: (
    sessionId: string,
    messageId: string,
    content: string
  ) => void;
  updateMessageWithStatistics: (
    sessionId: string,
    messageId: string,
    content: string,
    statistics?: GenerationStatistics
  ) => void;

  // Models
  models: OllamaModel[];
  loadModels: () => Promise<void>;
  loadPreferences: () => Promise<void>;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  updateCurrentSessionModel: (model: string) => Promise<void>;

  // System Message
  systemMessage: string;
  setSystemMessage: (message: string) => void;

  // UI state
  loading: boolean;
  error: string | null;
  setError: (error: string | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  // Sessions
  sessions: [],
  currentSession: null,
  setCurrentSession: session => {
    console.log('Store: setCurrentSession called', {
      newSessionId: session?.id,
      messagesCount: session?.messages.length,
    });
    set({ currentSession: session });
  },

  createSession: async (model: string, title?: string) => {
    try {
      set({ loading: true, error: null });
      const response = await chatApi.createSession(model, title);

      if (response.success && response.data) {
        const newSession = response.data;

        set(state => ({
          sessions: [newSession, ...state.sessions],
          currentSession: newSession,
          loading: false,
        }));

        // Note: System message is now automatically added by the backend when creating sessions

        toast.success('New chat created');
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to create session');
      set({ error: errorMessage, loading: false });
      toast.error(errorMessage);
    }
  },

  loadSessions: async () => {
    try {
      set({ loading: true, error: null });
      const response = await chatApi.getSessions();
      console.log('[DEBUG] loadSessions response:', response);
      if (response.success && response.data) {
        set(prevState => {
          const sessions = response.data || [];
          const backendSessionIds = sessions.map(s => s.id);
          // Debug: Compare frontend and backend session IDs
          const frontendSessionIds = prevState.sessions.map(s => s.id);
          console.log('[DEBUG] Backend session IDs:', backendSessionIds);
          console.log(
            '[DEBUG] Frontend session IDs (before update):',
            frontendSessionIds
          );
          let currentSession: ChatSession | null = null;
          // Only keep currentSession if it exists in backend sessions
          if (
            prevState.currentSession &&
            backendSessionIds.includes(prevState.currentSession.id)
          ) {
            currentSession =
              sessions.find(s => s.id === prevState.currentSession!.id) || null;
            console.log('[DEBUG] Keeping currentSession:', currentSession?.id);
          } else if (sessions.length > 0) {
            currentSession = sessions[0];
            if (prevState.currentSession) {
              console.warn(
                '[DEBUG] Previous currentSession not found in backend sessions:',
                prevState.currentSession.id
              );
              toast.error(
                'Current session not found in backend. Please select or create a new chat.'
              );
            }
            console.log(
              '[DEBUG] Forced: currentSession set to first available:',
              currentSession.id
            );
          } else {
            console.log(
              '[DEBUG] Forced: No valid sessions available, currentSession set to null'
            );
          }
          console.log('[DEBUG] Setting sessions:', sessions);
          return {
            sessions,
            currentSession,
            loading: false,
          };
        });
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to load sessions');
      set({ error: errorMessage, loading: false });
      toast.error(errorMessage);
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      console.log('Store: deleteSession called with:', sessionId);
      const response = await chatApi.deleteSession(sessionId);
      console.log('Store: deleteSession API response:', response);

      if (response.success) {
        set(state => {
          const updatedSessions = state.sessions.filter(
            s => s.id !== sessionId
          );
          const newCurrentSession =
            state.currentSession?.id === sessionId
              ? updatedSessions[0] || null
              : state.currentSession;

          console.log(
            'Store: Updating state, sessions count:',
            updatedSessions.length
          );

          return {
            sessions: updatedSessions,
            currentSession: newCurrentSession,
          };
        });
        toast.success('Chat deleted');
      } else {
        console.error('Store: deleteSession failed:', response);
        toast.error('Failed to delete chat');
      }
    } catch (error: unknown) {
      console.error('Store: deleteSession error:', error);
      const errorMessage = getErrorMessage(error, 'Failed to delete session');
      toast.error(errorMessage);
    }
  },

  clearAllSessions: async () => {
    try {
      set({ loading: true, error: null });
      const response = await chatApi.clearAllSessions();

      if (response.success) {
        set({
          sessions: [],
          currentSession: null,
          loading: false,
        });
        toast.success('All chat history cleared');
      } else {
        console.error('Store: clearAllSessions failed:', response);
        toast.error('Failed to clear chat history');
        set({ loading: false });
      }
    } catch (error: unknown) {
      console.error('Store: clearAllSessions error:', error);
      const errorMessage = getErrorMessage(
        error,
        'Failed to clear chat history'
      );
      toast.error(errorMessage);
      set({ loading: false });
    }
  },

  updateSessionTitle: async (sessionId: string, title: string) => {
    try {
      const response = await chatApi.updateSession(sessionId, { title });

      if (response.success && response.data) {
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === sessionId ? response.data! : s
          ),
          currentSession:
            state.currentSession?.id === sessionId
              ? response.data!
              : state.currentSession,
        }));
        toast.success('Chat title updated');
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to update session');
      toast.error(errorMessage);
    }
  },

  // Messages
  addMessage: (
    sessionId: string,
    message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }
  ) => {
    const state = get();
    // Block if currentSession is not valid
    if (
      !state.currentSession ||
      !state.sessions.find(s => s.id === state.currentSession?.id)
    ) {
      toast.error('No valid chat session. Please create or select a chat.');
      console.error(
        'addMessage blocked: currentSession is not valid',
        state.currentSession?.id
      );
      return;
    }
    // Block if sessionId is not in the current sessions list
    if (!state.sessions.find(s => s.id === sessionId)) {
      toast.error(
        'Session not found or invalid. Please select or create a valid chat session.'
      );
      console.error(
        'addMessage blocked: sessionId not found in sessions',
        sessionId
      );
      return;
    }
    const newMessage: ChatMessage = {
      ...message,
      id: message.id || generateId(),
      timestamp: Date.now(),
    };

    console.log('Store: addMessage called', {
      sessionId,
      role: message.role,
      messageId: newMessage.id,
      contentLength: message.content.length,
    });

    set(state => {
      // Prevent adding duplicate messages
      const session = state.sessions.find(s => s.id === sessionId);
      if (session) {
        const existingMessage = session.messages.find(
          m => m.id === newMessage.id
        );
        if (existingMessage) {
          console.log('Store: Message already exists, skipping add');
          return state;
        }
      }

      const updatedSessions = state.sessions.map(session => {
        if (session.id === sessionId) {
          return {
            ...session,
            messages: [...session.messages, newMessage],
            updatedAt: Date.now(),
          };
        }
        return session;
      });

      return {
        sessions: updatedSessions,
        currentSession:
          state.currentSession?.id === sessionId
            ? updatedSessions.find(s => s.id === sessionId) ||
              state.currentSession
            : state.currentSession,
      };
    });
  },

  updateMessage: (sessionId: string, messageId: string, content: string) => {
    set(state => {
      console.log('Store: updateMessage called', {
        sessionId,
        messageId,
        contentLength: content.length,
        currentSessionId: state.currentSession?.id,
        isCurrentSession: state.currentSession?.id === sessionId,
      });

      // Only update if this is for the current session
      if (state.currentSession?.id !== sessionId) {
        console.log('Store: Ignoring updateMessage for non-current session');
        return state;
      }

      const updatedSessions = state.sessions.map(session => {
        if (session.id === sessionId) {
          const updatedMessages = session.messages.map(msg => {
            if (msg.id === messageId) {
              console.log(
                'Store: Updating message',
                msg.id,
                'with content length:',
                content.length
              );
              return { ...msg, content };
            }
            return msg;
          });

          return {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now(),
          };
        }
        return session;
      });

      const newCurrentSession =
        state.currentSession?.id === sessionId
          ? updatedSessions.find(s => s.id === sessionId) ||
            state.currentSession
          : state.currentSession;

      console.log(
        'Store: Updated session messages count:',
        newCurrentSession?.messages.length
      );

      return {
        sessions: updatedSessions,
        currentSession: newCurrentSession,
      };
    });
  },

  updateMessageWithStatistics: (
    sessionId: string,
    messageId: string,
    content: string,
    statistics?: GenerationStatistics
  ) => {
    set(state => {
      console.log('Store: updateMessageWithStatistics called', {
        sessionId,
        messageId,
        contentLength: content.length,
        hasStatistics: !!statistics,
        currentSessionId: state.currentSession?.id,
        isCurrentSession: state.currentSession?.id === sessionId,
      });

      // Only update if this is for the current session
      if (state.currentSession?.id !== sessionId) {
        console.log(
          'Store: Ignoring updateMessageWithStatistics for non-current session'
        );
        return state;
      }

      const updatedSessions = state.sessions.map(session => {
        if (session.id === sessionId) {
          const updatedMessages = session.messages.map(msg => {
            if (msg.id === messageId) {
              console.log(
                'Store: Updating message',
                msg.id,
                'with content length:',
                content.length,
                'and statistics:',
                !!statistics
              );
              return { ...msg, content, statistics };
            }
            return msg;
          });

          return {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now(),
          };
        }
        return session;
      });

      const newCurrentSession =
        state.currentSession && state.currentSession.id === sessionId
          ? updatedSessions.find(s => s.id === sessionId) ||
            state.currentSession
          : state.currentSession;

      return {
        sessions: updatedSessions,
        currentSession: newCurrentSession,
      };
    });
  },

  // Models
  models: [],
  loadModels: async () => {
    try {
      set({ loading: true, error: null });
      console.log('Loading models from API...');

      // Load Ollama models
      const ollamaResponse = await ollamaApi.getModels();
      console.log('[DEBUG] loadModels ollama response:', ollamaResponse);

      let allModels: OllamaModel[] = [];

      if (ollamaResponse.success && ollamaResponse.data) {
        allModels = [...ollamaResponse.data];
        console.log('Ollama models loaded:', ollamaResponse.data.length);
      }

      // Load plugin models
      try {
        console.log('🔌 Loading plugin models...');
        const pluginsResponse = await pluginApi.getAllPlugins();
        console.log('🔌 Plugins API response:', pluginsResponse);
        if (pluginsResponse.success && pluginsResponse.data) {
          // Find ALL active plugins and add their models
          const activePlugins = pluginsResponse.data.filter(
            plugin => plugin.active
          );
          console.log(
            '🔌 Active plugins found:',
            activePlugins.map(p => p.name)
          );

          for (const activePlugin of activePlugins) {
            if (activePlugin.model_map) {
              const pluginModels: OllamaModel[] = activePlugin.model_map.map(
                modelName => ({
                  name: modelName,
                  model: modelName,
                  size: 0, // Plugin models don't have size info
                  digest: '',
                  details: {
                    parent_model: '',
                    format: '',
                    family: '',
                    families: [],
                    parameter_size: '',
                    quantization_level: '',
                  },
                  modified_at: new Date().toISOString(),
                  expires_at: new Date().toISOString(),
                  size_vram: 0,
                  isPlugin: true,
                  pluginName: activePlugin.name,
                })
              );

              allModels.push(...pluginModels);
              console.log(
                'Plugin models added:',
                pluginModels.length,
                'from',
                activePlugin.name
              );
            }
          }
        }
      } catch (pluginError) {
        console.error('❌ Failed to load plugin models:', pluginError);
        if (pluginError instanceof Error) {
          console.error('❌ Plugin error details:', {
            message: pluginError.message,
            response: (
              pluginError as { response?: { data: unknown; status: number } }
            ).response?.data,
            status: (
              pluginError as { response?: { data: unknown; status: number } }
            ).response?.status,
            url: (pluginError as { config?: { url: string } }).config?.url,
          });
        }
        // Continue without plugin models
      }

      console.log('Total models loaded:', allModels.length);
      set({ models: allModels, loading: false });
    } catch (error: unknown) {
      console.error('Error loading models:', error);
      const errorMessage = getErrorMessage(error, 'Failed to load models');
      set({ error: errorMessage, loading: false });
      toast.error(errorMessage);
    }
  },

  // Load preferences from backend and set default model
  loadPreferences: async () => {
    try {
      console.log('🔄 Loading preferences from backend...');
      const response = await preferencesApi.getPreferences();
      console.log('📦 Backend preferences response:', response);

      if (response.success && response.data) {
        const { defaultModel, systemMessage } = response.data;
        console.log('📋 Extracted defaultModel:', defaultModel);
        console.log('📋 Extracted systemMessage:', systemMessage);

        if (defaultModel) {
          console.log('✅ Setting selectedModel to:', defaultModel);
          set({ selectedModel: defaultModel });
          console.log('✅ Loaded default model from backend:', defaultModel);
        } else {
          console.log('⚠️ No defaultModel found in response');
        }

        if (systemMessage !== undefined) {
          set({ systemMessage: systemMessage });
          console.log('✅ Loaded system message from backend:', systemMessage);
        }
      } else {
        console.log('❌ Backend response unsuccessful or no data');
      }
    } catch (_error) {
      console.warn('❌ Failed to load preferences from backend:', _error);
    }
  },

  selectedModel: '',
  setSelectedModel: model => {
    set({ selectedModel: model });
    // Save to backend preferences when model is selected
    preferencesApi.setDefaultModel(model).catch(_error => {
      console.warn('Failed to save default model to backend:', _error);
    });
  },

  updateCurrentSessionModel: async (model: string) => {
    const state = get();
    if (!state.currentSession) {
      throw new Error('No current session to update');
    }

    try {
      const response = await chatApi.updateSession(state.currentSession.id, {
        model,
      });

      if (response.success && response.data) {
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === state.currentSession?.id ? response.data! : s
          ),
          currentSession: response.data,
          selectedModel: model,
        }));
        toast.success('Model updated for current chat');
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(
        error,
        'Failed to update session model'
      );
      toast.error(errorMessage);
      throw error;
    }
  },

  // System Message
  systemMessage: '',
  setSystemMessage: message => {
    set({ systemMessage: message });
    // Save to backend preferences when system message is updated
    preferencesApi.setSystemMessage(message).catch(_error => {
      console.warn('Failed to save system message to backend:', _error);
    });
  },

  // UI state
  loading: false,
  error: null,
  setError: error => set({ error }),

  // Add a global test function for debugging
  ...(typeof window !== 'undefined' && {
    testPluginApi: async () => {
      try {
        console.log('🧪 Testing plugin API...');
        const { pluginApi } = await import('@/utils/api');
        const result = await pluginApi.getAllPlugins();
        console.log('✅ Plugin API test result:', result);
        return result;
      } catch (error) {
        console.error('❌ Plugin API test failed:', error);
        return { error };
      }
    },
  }),
}));
