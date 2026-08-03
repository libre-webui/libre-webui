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
  ChatProviderType,
} from '@/types';
import { chatApi, ollamaApi, preferencesApi, personaApi } from '@/utils/api';
import { pluginApi } from '@/utils/api';
import { createLogger } from '@/utils/logger';
import toast from 'react-hot-toast';
import {
  appendMessageToChatState,
  buildPersonaModels,
  buildPersonasById,
  buildPluginModels,
  createChatMessage,
  getErrorMessage,
  hasSession,
  hasValidCurrentSession,
  isPrivateSession,
  updateMessageContentInChatState,
  updateMessageStatisticsInChatState,
} from '@/store/chatStoreHelpers';
import {
  chatModelSelectionFromModel,
  findChatModelForSelection,
} from '@/utils/chatModelSelection';

const logger = createLogger('chat-store');

interface ChatState {
  // Sessions
  sessions: ChatSession[];
  currentSession: ChatSession | null;
  setCurrentSession: (session: ChatSession | null) => void;
  createSession: (
    model: string,
    title?: string,
    personaId?: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ) => Promise<ChatSession | undefined>;
  loadSessions: () => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  clearAllSessions: () => Promise<void>;
  clearAllState: () => void; // Clear all store state (for logout)
  applySessionTitle: (
    sessionId: string,
    title: string,
    updatedAt?: number
  ) => void;
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
    statistics?: GenerationStatistics,
    providerMetadata?: ChatMessage['providerMetadata']
  ) => void;

  // Models
  models: OllamaModel[];
  loadModels: () => Promise<void>;
  loadPreferences: () => Promise<void>;
  selectedModel: string;
  selectedProviderType: ChatProviderType | null;
  selectedProviderId: string | null;
  setSelectedModel: (
    model: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ) => void;
  updateCurrentSessionModel: (
    model: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ) => Promise<void>;

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

  createSession: async (
    model: string,
    title?: string,
    personaId?: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ) => {
    try {
      set({ loading: true, error: null });
      const response = await chatApi.createSession(
        model,
        title,
        personaId,
        providerType,
        providerId
      );

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
          // Incognito sessions intentionally never exist in backend history.
          if (prevState.currentSession?.isPrivate) {
            currentSession = prevState.currentSession;
          } else if (
            prevState.currentSession &&
            backendSessionIds.includes(prevState.currentSession.id)
          ) {
            currentSession =
              sessions.find(s => s.id === prevState.currentSession!.id) || null;
          } else if (sessions.length > 0) {
            currentSession = sessions[0];
            if (prevState.currentSession) {
              logger.warn(
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

          logger.debug(
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
        logger.error('Store: deleteSession failed:', response);
        toast.error('Failed to delete chat');
      }
    } catch (error: unknown) {
      logger.error('Store: deleteSession error:', error);
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
        logger.error('Store: clearAllSessions failed:', response);
        toast.error('Failed to clear chat history');
        set({ loading: false });
      }
    } catch (error: unknown) {
      logger.error('Store: clearAllSessions error:', error);
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
      selectedProviderType: null,
      selectedProviderId: null,
      systemMessage: '',
      loading: false,
      error: null,
    });
  },

  applySessionTitle: (
    sessionId: string,
    title: string,
    updatedAt = Date.now()
  ) => {
    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId ? { ...session, title, updatedAt } : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? {
              ...state.currentSession,
              title,
              updatedAt,
            }
          : state.currentSession,
    }));
  },

  updateSessionTitle: async (sessionId: string, title: string) => {
    try {
      const response = await chatApi.updateSession(sessionId, { title });

      if (response.success && response.data) {
        const updatedTitle = response.data.title;
        const updatedAt = response.data.updatedAt ?? Date.now();

        get().applySessionTitle(sessionId, updatedTitle, updatedAt);
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
    const isPrivate = isPrivateSession(state, sessionId);

    if (!hasValidCurrentSession(state, sessionId)) {
      toast.error('No valid chat session. Please create or select a chat.');
      logger.error(
        'addMessage blocked: currentSession is not valid',
        state.currentSession?.id
      );
      return;
    }

    if (!isPrivate && !hasSession(state, sessionId)) {
      toast.error(
        'Session not found or invalid. Please select or create a valid chat session.'
      );
      logger.error(
        'addMessage blocked: sessionId not found in sessions',
        sessionId
      );
      return;
    }

    const newMessage = createChatMessage(message);
    set(state => appendMessageToChatState(state, sessionId, newMessage));
  },

  updateMessage: (sessionId: string, messageId: string, content: string) => {
    set(state =>
      updateMessageContentInChatState(state, sessionId, messageId, content)
    );
  },

  updateMessageWithStatistics: (
    sessionId: string,
    messageId: string,
    content: string,
    statistics?: GenerationStatistics,
    providerMetadata?: ChatMessage['providerMetadata']
  ) => {
    set(state =>
      updateMessageStatisticsInChatState(
        state,
        sessionId,
        messageId,
        content,
        statistics,
        providerMetadata
      )
    );
  },

  // Models
  models: [],
  loadModels: async () => {
    try {
      set({ loading: true, error: null });
      logger.debug('Loading models from API...');

      let allModels: OllamaModel[] = [];
      let ollamaLoadError: unknown;

      // Ollama and plugins are independent providers. Keep loading configured
      // plugin models when the local Ollama endpoint is offline.
      try {
        const ollamaResponse = await ollamaApi.getModels();
        if (ollamaResponse.success && ollamaResponse.data) {
          allModels = [...ollamaResponse.data];
          logger.debug('Ollama models loaded:', ollamaResponse.data.length);
        } else {
          ollamaLoadError = new Error(
            ollamaResponse.error ||
              ollamaResponse.message ||
              'Ollama models are unavailable.'
          );
        }
      } catch (error) {
        ollamaLoadError = error;
        logger.warn(
          'Ollama models are unavailable; continuing with plugin models:',
          error
        );
      }

      // Load plugin models
      try {
        const pluginsResponse = await pluginApi.getAllPlugins();
        if (pluginsResponse.success && pluginsResponse.data) {
          const activePlugins = pluginsResponse.data.filter(
            plugin =>
              plugin.active && plugin.type !== 'tts' && plugin.type !== 'image'
          );
          logger.debug(
            '🔌 Active plugins found:',
            activePlugins.map(p => p.name)
          );

          const pluginModels = buildPluginModels(activePlugins);
          allModels.push(...pluginModels);
          logger.debug('Plugin models added:', pluginModels.length);
        }
      } catch (pluginError) {
        logger.error('❌ Failed to load plugin models:', pluginError);
        if (pluginError instanceof Error) {
          logger.error('❌ Plugin error details:', {
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

      // Installed agent CLIs (admin-only; the endpoint returns [] otherwise)
      try {
        const { agentCliApi } = await import('@/utils/api');
        const agentResponse = await agentCliApi.getModels();
        if (agentResponse.success && agentResponse.data) {
          const agentModels: OllamaModel[] = agentResponse.data.map(agent => ({
            name: agent.id,
            model: agent.id,
            size: 0,
            digest: '',
            modified_at: '',
            details: {},
            isAgent: true,
            agentName: agent.name,
            agentId: agent.agentId,
          }));
          allModels.push(...agentModels);
          logger.debug('Agent CLI models added:', agentModels.length);
        }
      } catch (agentError) {
        logger.warn('Agent CLI models unavailable:', agentError);
      }

      const providerModelCount = allModels.length;

      // Load personas and add them as special models
      try {
        const { personaApi } = await import('@/utils/api');
        const personasResponse = await personaApi.getPersonas();
        if (personasResponse.success && personasResponse.data) {
          const personasMap = buildPersonasById(personasResponse.data);
          const personaModels = buildPersonaModels(personasResponse.data);

          allModels.push(...personaModels);

          set(state => ({ ...state, personas: personasMap }));
        }
      } catch (personaError) {
        logger.error('❌ Failed to load personas:', personaError);
        // Continue without personas
      }

      logger.debug('Total models loaded:', allModels.length);
      const providerLoadError =
        providerModelCount === 0 && ollamaLoadError
          ? getErrorMessage(ollamaLoadError, 'No model provider is available')
          : null;

      // Validate that the currently selected model still exists in the models list
      const currentState = get();
      const currentSelectedModel = currentState.selectedModel;
      const currentSelection = {
        model: currentSelectedModel,
        providerType: currentState.selectedProviderType,
        providerId: currentState.selectedProviderId,
      };
      const modelExists = Boolean(
        findChatModelForSelection(allModels, currentSelection)
      );
      const hasExplicitProvider =
        currentState.selectedProviderType === 'ollama' ||
        currentState.selectedProviderType === 'plugin';

      if (currentSelectedModel && !modelExists && hasExplicitProvider) {
        const providerLabel =
          currentState.selectedProviderType === 'plugin'
            ? currentState.selectedProviderId || 'plugin'
            : 'Ollama';
        const unavailableError = `Selected model "${currentSelectedModel}" is unavailable from ${providerLabel}. Reactivate that provider or select another model.`;
        set({
          models: allModels,
          loading: false,
          error: unavailableError,
        });
        toast.error(unavailableError);
        return;
      }

      if (currentSelectedModel && !modelExists && allModels.length > 0) {
        // Current model is no longer available, fallback to first available model
        const fallbackSelection = chatModelSelectionFromModel(allModels[0]);
        logger.debug(
          `⚠️ Legacy selected model "${currentSelectedModel}" no longer available, falling back to "${fallbackSelection.model}"`
        );
        set({
          models: allModels,
          loading: false,
          selectedModel: fallbackSelection.model,
          selectedProviderType: fallbackSelection.providerType || null,
          selectedProviderId: fallbackSelection.providerId || null,
          error: providerLoadError,
        });
        preferencesApi
          .setDefaultModel(
            fallbackSelection.model,
            fallbackSelection.providerType,
            fallbackSelection.providerId
          )
          .catch(error => {
            logger.warn('Failed to save fallback default model:', error);
          });
        toast.success(
          `Switched to ${fallbackSelection.model} (previous model no longer available)`
        );
      } else {
        set({ models: allModels, loading: false, error: providerLoadError });
      }
      if (providerLoadError) {
        toast.error(providerLoadError);
      }
    } catch (error: unknown) {
      logger.error('Error loading models:', error);
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
        const {
          defaultModel,
          defaultProviderType,
          defaultProviderId,
          systemMessage,
        } = response.data;

        if (defaultModel) {
          set({
            selectedModel: defaultModel,
            selectedProviderType: defaultProviderType || null,
            selectedProviderId:
              defaultProviderType === 'plugin'
                ? defaultProviderId || null
                : null,
          });
          logger.debug('✅ Loaded default model from backend:', defaultModel);
        }

        if (systemMessage !== undefined) {
          set({ systemMessage: systemMessage });
          logger.debug('✅ Loaded system message from backend');
        }
      }
    } catch (_error) {
      logger.warn('❌ Failed to load preferences from backend:', _error);
    }
  },

  selectedModel: '',
  selectedProviderType: null,
  selectedProviderId: null,
  setSelectedModel: (model, providerType = null, providerId = null) => {
    const normalizedProviderId =
      providerType === 'plugin' || providerType === 'agent'
        ? providerId || null
        : null;
    set({
      selectedModel: model,
      selectedProviderType: providerType,
      selectedProviderId: normalizedProviderId,
    });
    // Save to backend preferences when model is selected
    preferencesApi
      .setDefaultModel(model, providerType, normalizedProviderId)
      .catch(_error => {
        logger.warn('Failed to save default model to backend:', _error);
      });
  },

  updateCurrentSessionModel: async (
    model: string,
    providerType: ChatProviderType | null = null,
    providerId: string | null = null
  ) => {
    const state = get();
    if (!state.currentSession) {
      throw new Error('No current session to update');
    }

    try {
      const response = await chatApi.updateSession(state.currentSession.id, {
        model,
        providerType,
        providerId:
          providerType === 'plugin' || providerType === 'agent'
            ? providerId
            : null,
      });

      if (response.success && response.data) {
        set(state => ({
          sessions: state.sessions.map(s =>
            s.id === state.currentSession?.id ? response.data! : s
          ),
          currentSession: response.data,
          selectedModel: model,
          selectedProviderType: providerType,
          selectedProviderId:
            providerType === 'plugin' || providerType === 'agent'
              ? providerId || null
              : null,
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
          personas: buildPersonasById(personas),
          loading: false,
        });

        logger.debug('✅ Personas loaded:', personas.length);
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to load personas');
      set({ error: errorMessage, loading: false });
      logger.error('❌ Failed to load personas:', errorMessage);
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
      logger.warn('Failed to save system message to backend:', _error);
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
            logger.warn(
              'Failed to sync system message update to backend:',
              _error
            );
          });

        logger.debug('✅ Updated system message in current session');
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
        logger.debug('🧪 Testing plugin API...');
        const result = await pluginApi.getAllPlugins();
        logger.debug('✅ Plugin API test result:', result);
        return result;
      } catch (error) {
        logger.error('❌ Plugin API test failed:', error);
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
