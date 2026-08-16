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
  GenerationOptions,
  ChatSession,
  ChatMessage,
  OllamaModel,
  GenerationStatistics,
  Persona,
  ChatProviderType,
  SessionFolder,
} from '@/types';
import { chatApi, ollamaApi, preferencesApi, personaApi } from '@/utils/api';
import { pluginApi } from '@/utils/api';
import { createLogger } from '@/utils/logger';
import i18n from '@/i18n';
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
import { modelVisibilityKey } from '@/utils/modelVisibility';
import type { ModelPresentation } from '@/utils/api/modelApi';

const logger = createLogger('chat-store');

/**
 * Chat settings chosen before a session exists. The welcome screen edits these
 * so a conversation can start with its own system prompt and sampling, rather
 * than being created first and adjusted afterwards.
 */
export interface DraftSessionSettings {
  systemPrompt?: string;
  generationOptions?: Partial<GenerationOptions>;
}

interface ChatState {
  // Sessions
  sessions: ChatSession[];
  draftSessionSettings: DraftSessionSettings;
  setDraftSessionSettings: (settings: DraftSessionSettings) => void;
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
  removeMessage: (sessionId: string, messageId: string) => void;
  updateMessageWithStatistics: (
    sessionId: string,
    messageId: string,
    content: string,
    statistics?: GenerationStatistics,
    providerMetadata?: ChatMessage['providerMetadata'],
    thinking?: string
  ) => void;
  rateMessage: (
    sessionId: string,
    messageId: string,
    rating: number | undefined
  ) => Promise<void>;
  setSessionArchived: (sessionId: string, archived: boolean) => Promise<void>;
  setSessionPinned: (sessionId: string, pinned: boolean) => Promise<void>;

  // Session folders
  folders: SessionFolder[];
  loadFolders: () => Promise<void>;
  createFolder: (name: string) => Promise<SessionFolder | undefined>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  moveSessionToFolder: (
    sessionId: string,
    folderId: string | null
  ) => Promise<void>;
  truncateMessagesFrom: (sessionId: string, messageId: string) => void;

  // Models
  models: OllamaModel[];
  /**
   * Model keys an administrator hid from the pickers (Ollama models by name,
   * plugin models as `${pluginId}/${modelName}`). Non-administrators never
   * see hidden entries in `models`; administrators keep the full list and
   * use this set to show visibility state.
   */
  hiddenModels: string[];
  setHiddenModels: (keys: string[]) => void;
  /** Administrator-set name and picture per model key, for the pickers. */
  modelMetadata: Record<string, ModelPresentation>;
  /** False when the last model load could not reach the Ollama endpoint. */
  ollamaConnected: boolean;
  loadModels: (options?: { quiet?: boolean }) => Promise<void>;
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

  draftSessionSettings: {},

  setDraftSessionSettings: (settings: DraftSessionSettings) => {
    set({ draftSessionSettings: settings });
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

        toast.success(i18n.t('chat.toasts.chatCreated'));
        return newSession;
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.createFailed')
      );
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
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.loadFailed')
      );
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
        toast.success(i18n.t('chat.toasts.chatDeleted'));
      } else {
        logger.error('Store: deleteSession failed:', response);
        toast.error(i18n.t('chat.toasts.deleteFailed'));
      }
    } catch (error: unknown) {
      logger.error('Store: deleteSession error:', error);
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.deleteSessionFailed')
      );
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
        toast.success(i18n.t('chat.toasts.historyCleared'));
      } else {
        logger.error('Store: clearAllSessions failed:', response);
        toast.error(i18n.t('chat.toasts.historyClearFailed'));
        set({ loading: false });
      }
    } catch (error: unknown) {
      logger.error('Store: clearAllSessions error:', error);
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.historyClearFailed')
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
      hiddenModels: [],
      modelMetadata: {},
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
        toast.success(i18n.t('chat.toasts.titleUpdated'));
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.updateFailed')
      );
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
      toast.error(i18n.t('chat.toasts.noValidSession'));
      logger.error(
        'addMessage blocked: currentSession is not valid',
        state.currentSession?.id
      );
      return;
    }

    if (!isPrivate && !hasSession(state, sessionId)) {
      toast.error(i18n.t('chat.toasts.sessionNotFound'));
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

  removeMessage: (sessionId: string, messageId: string) => {
    const remove = (messages: ChatMessage[]): ChatMessage[] => {
      const removed = messages.find(message => message.id === messageId);
      const remaining = messages.filter(message => message.id !== messageId);
      if (!removed?.parentId) return remaining;

      const siblings = remaining.filter(
        message =>
          message.id === removed.parentId ||
          message.parentId === removed.parentId
      );
      const activeSibling = siblings.reduce<ChatMessage | undefined>(
        (latest, message) =>
          !latest || (message.branchIndex ?? 0) > (latest.branchIndex ?? 0)
            ? message
            : latest,
        undefined
      );
      return remaining.map(message =>
        siblings.some(sibling => sibling.id === message.id)
          ? {
              ...message,
              isActive: message.id === activeSibling?.id,
              siblingCount: siblings.length,
            }
          : message
      );
    };

    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId
          ? {
              ...session,
              messages: remove(session.messages),
              updatedAt: Date.now(),
            }
          : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? {
              ...state.currentSession,
              messages: remove(state.currentSession.messages),
              updatedAt: Date.now(),
            }
          : state.currentSession,
    }));
  },

  updateMessageWithStatistics: (
    sessionId: string,
    messageId: string,
    content: string,
    statistics?: GenerationStatistics,
    providerMetadata?: ChatMessage['providerMetadata'],
    thinking?: string
  ) => {
    set(state =>
      updateMessageStatisticsInChatState(
        state,
        sessionId,
        messageId,
        content,
        statistics,
        providerMetadata,
        thinking
      )
    );
  },

  rateMessage: async (
    sessionId: string,
    messageId: string,
    rating: number | undefined
  ) => {
    const applyRating = (messages: ChatMessage[]) =>
      messages.map(message =>
        message.id === messageId ? { ...message, rating } : message
      );

    const isPrivate = get().currentSession?.isPrivate;
    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId
          ? { ...session, messages: applyRating(session.messages) }
          : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? {
              ...state.currentSession,
              messages: applyRating(state.currentSession.messages),
            }
          : state.currentSession,
    }));

    if (isPrivate) {
      return;
    }

    try {
      await chatApi.updateMessage(sessionId, messageId, {
        rating: rating ?? null,
      } as Partial<ChatMessage>);
    } catch (error) {
      logger.error('Failed to save message rating:', error);
    }
  },

  folders: [],

  loadFolders: async () => {
    try {
      const response = await chatApi.getFolders();
      if (response.success && response.data) {
        set({ folders: response.data });
      }
    } catch (error) {
      logger.error('Failed to load folders:', error);
    }
  },

  createFolder: async (name: string) => {
    try {
      const response = await chatApi.createFolder(name);
      if (response.success && response.data) {
        const folder = response.data;
        set(state => ({
          folders: [...state.folders, folder].sort((a, b) =>
            a.name.localeCompare(b.name)
          ),
        }));
        return folder;
      }
    } catch (error) {
      logger.error('Failed to create folder:', error);
    }
    return undefined;
  },

  renameFolder: async (folderId: string, name: string) => {
    try {
      const response = await chatApi.renameFolder(folderId, name);
      if (response.success && response.data) {
        const folder = response.data;
        set(state => ({
          folders: state.folders
            .map(item => (item.id === folderId ? folder : item))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }));
      }
    } catch (error) {
      logger.error('Failed to rename folder:', error);
    }
  },

  deleteFolder: async (folderId: string) => {
    try {
      const response = await chatApi.deleteFolder(folderId);
      if (response.success) {
        set(state => ({
          folders: state.folders.filter(item => item.id !== folderId),
          sessions: state.sessions.map(session =>
            session.folderId === folderId
              ? { ...session, folderId: null }
              : session
          ),
          currentSession:
            state.currentSession?.folderId === folderId
              ? { ...state.currentSession, folderId: null }
              : state.currentSession,
        }));
      }
    } catch (error) {
      logger.error('Failed to delete folder:', error);
    }
  },

  moveSessionToFolder: async (sessionId: string, folderId: string | null) => {
    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId ? { ...session, folderId } : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? { ...state.currentSession, folderId }
          : state.currentSession,
    }));
    try {
      await chatApi.updateSession(sessionId, {
        folderId,
      } as Partial<ChatSession>);
    } catch (error) {
      logger.error('Failed to move session to folder:', error);
    }
  },

  setSessionArchived: async (sessionId: string, archived: boolean) => {
    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId ? { ...session, archived } : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? { ...state.currentSession, archived }
          : state.currentSession,
    }));

    try {
      await chatApi.updateSession(sessionId, {
        archived,
      } as Partial<ChatSession>);
    } catch (error) {
      logger.error('Failed to update session archive state:', error);
      // Roll back the optimistic update so the UI stays truthful.
      set(state => ({
        sessions: state.sessions.map(session =>
          session.id === sessionId
            ? { ...session, archived: !archived }
            : session
        ),
      }));
    }
  },

  setSessionPinned: async (sessionId: string, pinned: boolean) => {
    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId ? { ...session, pinned } : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? { ...state.currentSession, pinned }
          : state.currentSession,
    }));

    try {
      await chatApi.updateSession(sessionId, {
        pinned,
      } as Partial<ChatSession>);
    } catch (error) {
      logger.error('Failed to update session pin state:', error);
      // Roll back the optimistic update so the UI stays truthful.
      set(state => ({
        sessions: state.sessions.map(session =>
          session.id === sessionId ? { ...session, pinned: !pinned } : session
        ),
      }));
    }
  },

  truncateMessagesFrom: (sessionId: string, messageId: string) => {
    const truncate = (messages: ChatMessage[]) => {
      const index = messages.findIndex(message => message.id === messageId);
      return index === -1 ? messages : messages.slice(0, index);
    };

    set(state => ({
      sessions: state.sessions.map(session =>
        session.id === sessionId
          ? {
              ...session,
              messages: truncate(session.messages),
              updatedAt: Date.now(),
            }
          : session
      ),
      currentSession:
        state.currentSession?.id === sessionId
          ? {
              ...state.currentSession,
              messages: truncate(state.currentSession.messages),
              updatedAt: Date.now(),
            }
          : state.currentSession,
    }));
  },

  // Models
  models: [],
  hiddenModels: [],
  setHiddenModels: (keys: string[]) => set({ hiddenModels: keys }),
  modelMetadata: {},
  ollamaConnected: false,
  loadModels: async (options?: { quiet?: boolean }) => {
    const quiet = options?.quiet === true;
    try {
      if (!quiet) {
        set({ loading: true, error: null });
      }
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

      // Which models an administrator hid from the pickers. Administrators
      // keep the full list; everyone else's selectable models drop the
      // hidden entries (Ollama and plugin alike). Fail open: visibility is a
      // listing refinement, never a reason to blank the picker.
      let hiddenModels: string[] = [];
      let modelOrder: string[] = [];
      let modelMetadata: Record<string, ModelPresentation> = {};
      try {
        const visibilityResponse = await ollamaApi.getModelVisibility();
        if (visibilityResponse.success && visibilityResponse.data) {
          hiddenModels = visibilityResponse.data.hidden ?? [];
          modelOrder = visibilityResponse.data.order ?? [];
          modelMetadata = visibilityResponse.data.metadata ?? {};
        }
      } catch (visibilityError) {
        logger.warn(
          'Model visibility unavailable; showing all models:',
          visibilityError
        );
      }
      try {
        const { useAuthStore } = await import('@/store/authStore');
        const authState = useAuthStore.getState();
        const viewerIsAdmin =
          authState.isAdmin() || authState.systemInfo?.requiresAuth === false;
        if (!viewerIsAdmin && hiddenModels.length > 0) {
          const hidden = new Set(hiddenModels);
          allModels = allModels.filter(
            model => !hidden.has(modelVisibilityKey(model))
          );
        }
      } catch (authError) {
        logger.warn('Could not resolve viewer role for model list:', authError);
      }
      // The order an administrator arranged, with anything newer after it.
      if (modelOrder.length > 0) {
        const rank = new Map(modelOrder.map((key, index) => [key, index]));
        allModels = [...allModels].sort((a, b) => {
          const left =
            rank.get(modelVisibilityKey(a)) ?? Number.MAX_SAFE_INTEGER;
          const right =
            rank.get(modelVisibilityKey(b)) ?? Number.MAX_SAFE_INTEGER;
          return left - right;
        });
      }
      set({ hiddenModels, modelMetadata });

      logger.debug('Total models loaded:', allModels.length);
      const providerLoadError =
        providerModelCount === 0 && ollamaLoadError
          ? getErrorMessage(
              ollamaLoadError,
              i18n.t('chat.toasts.noModelProvider')
            )
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
        const unavailableError = i18n.t('chat.toasts.modelUnavailable', {
          model: currentSelectedModel,
          provider: providerLabel,
        });
        set({
          models: allModels,
          ollamaConnected: !ollamaLoadError,
          loading: false,
          error: unavailableError,
        });
        if (!quiet) {
          toast.error(unavailableError);
        }
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
          ollamaConnected: !ollamaLoadError,
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
          i18n.t('chat.toasts.modelSwitched', {
            model: fallbackSelection.model,
          })
        );
      } else {
        set({
          models: allModels,
          ollamaConnected: !ollamaLoadError,
          loading: false,
          error: providerLoadError,
        });
      }
      if (providerLoadError && !quiet) {
        toast.error(providerLoadError);
      }
    } catch (error: unknown) {
      logger.error('Error loading models:', error);
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.modelsLoadFailed')
      );
      set({ ollamaConnected: false, error: errorMessage, loading: false });
      if (!quiet) {
        toast.error(errorMessage);
      }
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
        toast.success(i18n.t('chat.toasts.modelUpdated'));
      }
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(
        error,
        i18n.t('chat.toasts.modelUpdateFailed')
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
