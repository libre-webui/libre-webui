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
  Persona,
} from '@/types';
import { chatApi, ollamaApi, preferencesApi, personaApi } from '@/utils/api';
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
  createSession: (
    model: string,
    title?: string,
    personaId?: string
  ) => Promise<ChatSession | undefined>;
  loadSessions: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  clearAllState: () => void; // Clear all store state (for logout)
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

  // Personas
  personas: { [key: string]: Persona };
  loadPersonas: () => Promise<void>;
  getCurrentPersona: () => Persona | null;

  // System Message
  systemMessage: string;
  setSystemMessage: (message: string) => void;

  // UI state
  loading: boolean;
  error: string | null;
  setError: (error: string | null) => void;

  // Title generation state
  generatingTitleForSession: string | null;
  setGeneratingTitleForSession: (sessionId: string | null) => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  // Sessions
  sessions: [],
  currentSession: null,
  setCurrentSession: session => {
    set({ currentSession: session });
  },

  createSession: async (model: string, title?: string, personaId?: string) => {
    try {
      set({ loading: true, error: null });
      const response = await chatApi.createSession(model, title, personaId);

      if (response.success && response.data) {
        const newSession = response.data;

        set(state => ({
          sessions: [newSession, ...state.sessions],
          currentSession: newSession,
          loading: false,
        }));

        // Note: System message is now automatically added by the backend when creating sessions

        toast.success('New chat created');
        return newSession;
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to create session');
      set({ error: errorMessage, loading: false });
      toast.error(errorMessage);
    }
    return undefined;
  },

  loadSessions: async () => {
    try {
      set({ loading: true, error: null });
      const response = await chatApi.getSessions();
      if (response.success && response.data) {
        set(prevState => {
          const sessions = response.data || [];
          const backendSessionIds = sessions.map(s => s.id);
          let currentSession: ChatSession | null = null;
          // Only keep currentSession if it exists in backend sessions
          if (
            prevState.currentSession &&
            backendSessionIds.includes(prevState.currentSession.id)
          ) {
            currentSession =
              sessions.find(s => s.id === prevState.currentSession!.id) || null;
          } else if (sessions.length > 0) {
            currentSession = sessions[0];
            if (prevState.currentSession) {
              console.warn(
                'Previous currentSession not found in backend sessions:',
                prevState.currentSession.id
              );
              // Don't show error toast here - let the ChatPage handle URL redirect
            }
          }

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
      const response = await chatApi.deleteSession(sessionId);
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

  clearAllState: () => {
    // Clear all state when user logs out/switches
    set({
      sessions: [],
      currentSession: null,
      models: [],
      selectedModel: '',
      systemMessage: '',
      loading: false,
      error: null,
    });
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

    set(state => {
      // Prevent adding duplicate messages
      const session = state.sessions.find(s => s.id === sessionId);
      if (session) {
        const existingMessage = session.messages.find(
          m => m.id === newMessage.id
        );
        if (existingMessage) {
          return state;
        }
      }

      const updatedSessions = state.sessions.map(session => {
        if (session.id === sessionId) {
          let updatedMessages = [...session.messages];

          // If this is a branch message (has parentId), update sibling messages
          if (newMessage.parentId) {
            const parentId = newMessage.parentId;

            // Mark all sibling messages (including the parent) as inactive
            updatedMessages = updatedMessages.map(msg => {
              // Check if this message is a sibling (same parent or is the parent itself)
              const isSibling =
                msg.id === parentId || msg.parentId === parentId;
              if (isSibling) {
                return {
                  ...msg,
                  isActive: false,
                  // Ensure the parent has branchIndex 0 if it doesn't have one
                  branchIndex: msg.branchIndex ?? 0,
                  // Update siblingCount for all siblings
                  siblingCount: (newMessage.branchIndex || 0) + 1,
                };
              }
              return msg;
            });
          }

          // Add the new message
          updatedMessages.push(newMessage);

          return {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now(),
          };
        }
        return session;
      });

      return {
        sessions: updatedSessions,
        currentSession:
          state.currentSession?.id === sessionId
            ? (() => {
                const updatedSession =
                  updatedSessions.find(s => s.id === sessionId) ||
                  state.currentSession;
                return updatedSession;
              })()
            : state.currentSession,
      };
    });
  },

  updateMessage: (sessionId: string, messageId: string, content: string) => {
    set(state => {
      // Only update if this is for the current session
      if (state.currentSession?.id !== sessionId) {
        return state;
      }

      // Find the session directly instead of mapping all sessions
      const targetSession = state.sessions.find(s => s.id === sessionId);
      if (!targetSession) {
        return state;
      }

      // Find the message directly instead of mapping all messages
      const targetMessage = targetSession.messages.find(
        m => m.id === messageId
      );
      if (!targetMessage || targetMessage.content === content) {
        return state; // No changes needed
      }

      // Create optimized update - only update the specific session and message
      const updatedSessions = state.sessions.map(session => {
        if (session.id === sessionId) {
          const updatedMessages = session.messages.map(msg => {
            if (msg.id === messageId) {
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
      // Only update if this is for the current session
      if (state.currentSession?.id !== sessionId) {
        return state;
      }

      const updatedSessions = state.sessions.map(session => {
        if (session.id === sessionId) {
          const updatedMessages = session.messages.map(msg => {
            if (msg.id === messageId) {
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

      let allModels: OllamaModel[] = [];

      if (ollamaResponse.success && ollamaResponse.data) {
        allModels = [...ollamaResponse.data];
        console.log('Ollama models loaded:', ollamaResponse.data.length);
      }

      // Load plugin models
      try {
        const pluginsResponse = await pluginApi.getAllPlugins();
        if (pluginsResponse.success && pluginsResponse.data) {
          // Find ALL active plugins and add their models (excluding TTS and image generation plugins)
          const activePlugins = pluginsResponse.data.filter(
            plugin =>
              plugin.active && plugin.type !== 'tts' && plugin.type !== 'image'
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

      // Load personas and add them as special models
      try {
        const { personaApi } = await import('@/utils/api');
        const personasResponse = await personaApi.getPersonas();
        if (personasResponse.success && personasResponse.data) {
          // Store personas in the personas object for easy lookup
          const personasMap = personasResponse.data.reduce(
            (acc: { [key: string]: Persona }, persona: Persona) => {
              acc[persona.id] = persona;
              return acc;
            },
            {}
          );

          const personaModels: OllamaModel[] = personasResponse.data.map(
            persona => ({
              name: `persona:${persona.id}`,
              model: persona.model,
              size: 0,
              digest: '',
              details: {
                parent_model: persona.model,
                format: 'persona',
                family: 'persona',
                families: ['persona'],
                parameter_size: '',
                quantization_level: '',
              },
              modified_at: new Date(persona.updated_at).toISOString(),
              expires_at: new Date().toISOString(),
              size_vram: 0,
              isPersona: true,
              personaName: persona.name,
              personaDescription: persona.description,
            })
          );

          allModels.push(...personaModels);

          // Update personas store
          set(state => ({ ...state, personas: personasMap }));
        }
      } catch (personaError) {
        console.error('❌ Failed to load personas:', personaError);
        // Continue without personas
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
      const response = await preferencesApi.getPreferences();

      if (response.success && response.data) {
        const { defaultModel, systemMessage } = response.data;

        if (defaultModel) {
          set({ selectedModel: defaultModel });
          console.log('✅ Loaded default model from backend:', defaultModel);
        }

        if (systemMessage !== undefined) {
          set({ systemMessage: systemMessage });
          console.log('✅ Loaded system message from backend');
        }
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

  // Personas
  personas: {},
  loadPersonas: async () => {
    try {
      set({ loading: true, error: null });
      const response = await personaApi.getPersonas();

      if (response.success && response.data) {
        const personas = response.data;

        set({
          personas: personas.reduce(
            (acc: { [key: string]: Persona }, persona: Persona) => {
              acc[persona.id] = persona;
              return acc;
            },
            {}
          ),
          loading: false,
        });

        console.log('✅ Personas loaded:', personas.length);
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to load personas');
      set({ error: errorMessage, loading: false });
      console.error('❌ Failed to load personas:', errorMessage);
    }
  },

  getCurrentPersona: () => {
    const state = get();
    if (
      !state.currentSession ||
      !state.currentSession.model?.startsWith('persona:')
    ) {
      return null;
    }

    // Extract persona ID from the model string
    const personaId = state.currentSession.model.replace('persona:', '');
    return state.personas[personaId] || null;
  },

  // System Message
  systemMessage: '',
  setSystemMessage: message => {
    const state = get();
    set({ systemMessage: message });

    // Save to backend preferences when system message is updated
    preferencesApi.setSystemMessage(message).catch(_error => {
      console.warn('Failed to save system message to backend:', _error);
    });

    // Update the system message in the current session if it exists
    if (state.currentSession) {
      const systemMessageIndex = state.currentSession.messages.findIndex(
        msg => msg.role === 'system'
      );

      if (systemMessageIndex !== -1) {
        // Update existing system message in the store
        set(state => {
          const updatedSessions = state.sessions.map(session => {
            if (session.id === state.currentSession?.id) {
              const updatedMessages = session.messages.map((msg, index) => {
                if (index === systemMessageIndex && msg.role === 'system') {
                  return {
                    ...msg,
                    content: message,
                    timestamp: Date.now(),
                  };
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

          const updatedCurrentSession = state.currentSession
            ? updatedSessions.find(s => s.id === state.currentSession!.id) ||
              state.currentSession
            : null;

          return {
            sessions: updatedSessions,
            currentSession: updatedCurrentSession,
          };
        });

        // Also update the system message on the backend
        const systemMessage = state.currentSession.messages[systemMessageIndex];
        chatApi
          .updateMessage(state.currentSession.id, systemMessage.id, {
            content: message,
          })
          .catch(_error => {
            console.warn(
              'Failed to sync system message update to backend:',
              _error
            );
          });

        console.log('✅ Updated system message in current session');
      }
    }
  },

  // UI state
  loading: false,
  error: null,
  setError: error => set({ error }),

  // Title generation state
  generatingTitleForSession: null,
  setGeneratingTitleForSession: sessionId =>
    set({ generatingTitleForSession: sessionId }),

  // Add a global test function for debugging
  ...(typeof window !== 'undefined' && {
    testPluginApi: async () => {
      try {
        console.log('🧪 Testing plugin API...');
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

// Export a function to clear state (for use by auth store)
export const clearChatState = () => {
  const state = useChatStore.getState();
  state.clearAllState();
};
