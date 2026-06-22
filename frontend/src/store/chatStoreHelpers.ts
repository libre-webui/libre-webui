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

import type { ChatMessage, ChatSession, OllamaModel, Persona } from '@/types';
import { generateId } from '@/utils';

interface ChatMessageState {
  sessions: ChatSession[];
  currentSession: ChatSession | null;
}

interface PluginModelSource {
  active?: boolean;
  type?: string;
  name: string;
  model_map?: string[];
}

export const getErrorMessage = (error: unknown, fallback: string): string => {
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

export function createChatMessage(
  message: Omit<ChatMessage, 'id' | 'timestamp'> & { id?: string }
): ChatMessage {
  return {
    ...message,
    id: message.id || generateId(),
    timestamp: Date.now(),
  };
}

export function isPrivateSession(state: ChatMessageState, sessionId: string) {
  return (
    state.currentSession?.isPrivate && state.currentSession?.id === sessionId
  );
}

export function hasSession(state: ChatMessageState, sessionId: string) {
  return state.sessions.some(session => session.id === sessionId);
}

export function hasValidCurrentSession(
  state: ChatMessageState,
  sessionId: string
) {
  return (
    !!state.currentSession &&
    (isPrivateSession(state, sessionId) ||
      hasSession(state, state.currentSession.id))
  );
}

export function appendMessageToChatState<T extends ChatMessageState>(
  state: T,
  sessionId: string,
  newMessage: ChatMessage
): T | Pick<T, 'sessions' | 'currentSession'> {
  if (isPrivateSession(state, sessionId)) {
    const existingMessage = state.currentSession!.messages.find(
      message => message.id === newMessage.id
    );
    if (existingMessage) {
      return state;
    }

    return {
      currentSession: {
        ...state.currentSession!,
        messages: [...state.currentSession!.messages, newMessage],
        updatedAt: Date.now(),
      },
      sessions: state.sessions,
    };
  }

  const session = state.sessions.find(item => item.id === sessionId);
  if (session?.messages.some(message => message.id === newMessage.id)) {
    return state;
  }

  const updatedSessions = state.sessions.map(session => {
    if (session.id !== sessionId) {
      return session;
    }

    let updatedMessages = [...session.messages];
    if (newMessage.parentId) {
      const parentId = newMessage.parentId;
      updatedMessages = updatedMessages.map(message => {
        const isSibling =
          message.id === parentId || message.parentId === parentId;
        if (!isSibling) {
          return message;
        }
        return {
          ...message,
          isActive: false,
          branchIndex: message.branchIndex ?? 0,
          siblingCount: (newMessage.branchIndex || 0) + 1,
        };
      });
    }

    return {
      ...session,
      messages: [...updatedMessages, newMessage],
      updatedAt: Date.now(),
    };
  });

  return {
    sessions: updatedSessions,
    currentSession:
      state.currentSession?.id === sessionId
        ? updatedSessions.find(session => session.id === sessionId) ||
          state.currentSession
        : state.currentSession,
  };
}

export function updateMessageContentInChatState<T extends ChatMessageState>(
  state: T,
  sessionId: string,
  messageId: string,
  content: string
): T | Pick<T, 'sessions' | 'currentSession'> {
  if (state.currentSession?.id !== sessionId) {
    return state;
  }

  if (state.currentSession?.isPrivate) {
    const targetMessage = state.currentSession.messages.find(
      message => message.id === messageId
    );
    if (!targetMessage || targetMessage.content === content) {
      return state;
    }

    return {
      sessions: state.sessions,
      currentSession: {
        ...state.currentSession,
        messages: state.currentSession.messages.map(message =>
          message.id === messageId ? { ...message, content } : message
        ),
        updatedAt: Date.now(),
      },
    };
  }

  const targetSession = state.sessions.find(
    session => session.id === sessionId
  );
  const targetMessage = targetSession?.messages.find(
    message => message.id === messageId
  );
  if (!targetSession || !targetMessage || targetMessage.content === content) {
    return state;
  }

  const updatedSessions = state.sessions.map(session =>
    session.id === sessionId
      ? {
          ...session,
          messages: session.messages.map(message =>
            message.id === messageId ? { ...message, content } : message
          ),
          updatedAt: Date.now(),
        }
      : session
  );

  return {
    sessions: updatedSessions,
    currentSession:
      state.currentSession?.id === sessionId
        ? updatedSessions.find(session => session.id === sessionId) ||
          state.currentSession
        : state.currentSession,
  };
}

export function updateMessageStatisticsInChatState<T extends ChatMessageState>(
  state: T,
  sessionId: string,
  messageId: string,
  content: string,
  statistics?: ChatMessage['statistics']
): T | Pick<T, 'sessions' | 'currentSession'> {
  if (state.currentSession?.id !== sessionId) {
    return state;
  }

  if (state.currentSession?.isPrivate) {
    return {
      sessions: state.sessions,
      currentSession: {
        ...state.currentSession,
        messages: state.currentSession.messages.map(message =>
          message.id === messageId
            ? { ...message, content, statistics }
            : message
        ),
        updatedAt: Date.now(),
      },
    };
  }

  const updatedSessions = state.sessions.map(session =>
    session.id === sessionId
      ? {
          ...session,
          messages: session.messages.map(message =>
            message.id === messageId
              ? { ...message, content, statistics }
              : message
          ),
          updatedAt: Date.now(),
        }
      : session
  );

  return {
    sessions: updatedSessions,
    currentSession:
      state.currentSession?.id === sessionId
        ? updatedSessions.find(session => session.id === sessionId) ||
          state.currentSession
        : state.currentSession,
  };
}

export function buildPersonasById(personas: Persona[]) {
  return personas.reduce(
    (acc: { [key: string]: Persona }, persona: Persona) => {
      acc[persona.id] = persona;
      return acc;
    },
    {}
  );
}

export function buildPersonaModels(personas: Persona[]): OllamaModel[] {
  return personas.map(persona => ({
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
  }));
}

export function buildPluginModels(plugins: PluginModelSource[]): OllamaModel[] {
  return plugins
    .filter(
      plugin =>
        plugin.active && plugin.type !== 'tts' && plugin.type !== 'image'
    )
    .flatMap(plugin =>
      (plugin.model_map || []).map(modelName => ({
        name: modelName,
        model: modelName,
        size: 0,
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
        pluginName: plugin.name,
      }))
    );
}
