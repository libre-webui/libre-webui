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

import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { ChatHeader } from '@/components/ChatHeader';
import { PersonaSelector } from '@/components/PersonaSelector';
import { Logo } from '@/components/Logo';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { useChat } from '@/hooks/useChat';
import { personaApi, chatApi } from '@/utils/api';
import { Select } from '@/components/ui';
import toast from 'react-hot-toast';

export const ChatPage: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [selectedPersonaId, setSelectedPersonaId] = useState<
    string | undefined
  >();
  const { setBackgroundImage } = useAppStore();
  const {
    currentSession,
    sessions,
    models,
    selectedModel,
    setSelectedModel,
    createSession,
    setCurrentSession,
    loadSessions,
  } = useChatStore();
  const { sendMessage, stopGeneration, isStreaming } = useChat(
    currentSession?.id || ''
  );

  // Load sessions on mount
  useEffect(() => {
    if (sessions.length === 0) {
      loadSessions();
    }
  }, [loadSessions, sessions.length]); // Include both dependencies

  // Handle URL session parameter
  useEffect(() => {
    const handleSessionFromUrl = () => {
      // Only proceed if sessions are loaded
      if (sessions.length === 0) {
        return; // Sessions not loaded yet, wait for them
      }

      if (sessionId) {
        // Find the session in the loaded sessions
        const foundSession = sessions.find(s => s.id === sessionId);
        if (foundSession && foundSession.id !== currentSession?.id) {
          setCurrentSession(foundSession);
        } else if (!foundSession) {
          // Session not found for this user, redirect to most recent session or root
          console.warn(
            `Session ${sessionId} not found for current user, redirecting...`
          );
          if (sessions.length > 0) {
            navigate(`/c/${sessions[0].id}`, { replace: true });
          } else {
            navigate('/', { replace: true });
          }
        }
      } else if (!sessionId && sessions.length > 0) {
        // No sessionId in URL but we have sessions, redirect to the most recent session
        navigate(`/c/${sessions[0].id}`, { replace: true });
      }
    };

    handleSessionFromUrl();
  }, [sessionId, sessions, setCurrentSession, navigate, currentSession?.id]); // Include currentSession?.id

  // Apply persona background when session changes
  useEffect(() => {
    const applyPersonaBackground = async () => {
      if (currentSession?.personaId) {
        try {
          const response = await personaApi.getPersona(
            currentSession.personaId
          );
          if (response.success && response.data?.background) {
            setBackgroundImage(response.data.background);
          }
        } catch (error) {
          console.error('Failed to load persona background:', error);
        }
      } else {
        // Clear background if no persona
        setBackgroundImage(null);
      }
    };

    applyPersonaBackground();
  }, [currentSession?.personaId, setBackgroundImage]);

  const handleCreateSession = async () => {
    if (selectedPersonaId) {
      // If persona is selected, use persona's model and create session
      try {
        const response = await personaApi.getPersona(selectedPersonaId);
        if (response.success && response.data) {
          const persona = response.data;
          const newSession = await createSession(
            persona.model,
            `Chat with ${persona.name}`,
            selectedPersonaId
          );
          if (newSession) {
            navigate(`/c/${newSession.id}`, { replace: true });
          }
        }
      } catch (error) {
        console.error('Error creating session with persona:', error);
      }
    } else if (selectedModel) {
      // No persona selected, use selected model
      const newSession = await createSession(selectedModel);
      if (newSession) {
        navigate(`/c/${newSession.id}`, { replace: true });
      }
    }
  };

  const handleModelChange = async (model: string) => {
    setSelectedModel(model);
    // Don't auto-create session on model change, let user click "New Chat"
  };

  const handlePersonaChange = async (personaId: string | undefined) => {
    if (!currentSession) return;

    try {
      // Update the session with the new persona
      const response = await chatApi.updateSession(currentSession.id, {
        personaId: personaId,
      });

      if (response.success && response.data) {
        // Update the session in the store
        setCurrentSession(response.data);

        // Apply the new persona's background if it has one
        if (personaId) {
          const personaResponse = await personaApi.getPersona(personaId);
          if (personaResponse.success && personaResponse.data?.background) {
            setBackgroundImage(personaResponse.data.background);
          }
        } else {
          // Clear background if no persona
          setBackgroundImage(null);
        }

        toast.success(
          personaId
            ? 'Persona applied to session'
            : 'Persona removed from session'
        );
      }
    } catch (error) {
      console.error('Error updating session persona:', error);
      toast.error('Failed to update session persona');
    }
  };

  const handleSendMessage = (
    message: string,
    images?: string[],
    format?: string | Record<string, unknown>
  ) => {
    if (!currentSession) return;
    sendMessage(message, images, format);
  };

  if (!currentSession) {
    return (
      <div className='flex-1 flex items-center justify-center p-8'>
        <div className='text-center max-w-md mx-auto'>
          <Logo size='lg' className='mx-auto mb-6' />
          <h2
            className='libre-brand text-4xl sm:text-5xl font-normal text-gray-900 dark:text-dark-800 mb-3'
            style={{ fontWeight: 300, letterSpacing: '0.01em' }}
          >
            Welcome to Libre WebUI
          </h2>
          <p className='text-gray-600 dark:text-dark-600 mb-8 leading-relaxed'>
            Select a model and start a conversation with your AI assistant
          </p>

          {models.length > 0 ? (
            <div className='space-y-6'>
              <div className='space-y-3'>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                  Choose a persona (recommended)
                </label>
                <PersonaSelector
                  selectedPersonaId={selectedPersonaId}
                  onPersonaChange={setSelectedPersonaId}
                  className='justify-start'
                />
                <p className='text-xs text-gray-500 dark:text-gray-400'>
                  {selectedPersonaId
                    ? 'Persona selected! The persona will determine the AI model, personality, and behavior.'
                    : 'Select a persona for enhanced AI interactions with custom instructions and personality.'}
                  <span className='block mt-1'>
                    <a
                      href='/personas'
                      className='text-blue-500 hover:text-blue-600'
                    >
                      Create new personas
                    </a>{' '}
                    in the Personas tab.
                  </span>
                </p>
              </div>

              {!selectedPersonaId && (
                <div className='space-y-3'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Or choose a model directly
                  </label>
                  <Select
                    label='Choose a model'
                    value={selectedModel}
                    onChange={e => handleModelChange(e.target.value)}
                    options={models.map(model => ({
                      value: model.name,
                      label: model.name,
                    }))}
                    className='text-left'
                  />
                  <p className='text-xs text-gray-500 dark:text-gray-400'>
                    Use a raw model without persona customization.
                  </p>
                </div>
              )}

              {(selectedPersonaId || selectedModel) && (
                <button
                  onClick={handleCreateSession}
                  className='w-full bg-primary-600 hover:bg-primary-700 text-white font-medium py-3 px-4 rounded-lg transition-colors'
                >
                  Start Chat {selectedPersonaId ? 'with Persona' : 'with Model'}
                </button>
              )}
            </div>
          ) : (
            <div className='space-y-6'>
              <div className='p-6 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-xl'>
                <p className='text-sm text-gray-700 dark:text-dark-700 mb-4'>
                  No models available. Make sure Ollama is running and has
                  models installed.
                </p>
                <code className='block text-xs bg-gray-100 dark:bg-dark-200 p-3 rounded-lg font-mono text-gray-800 dark:text-dark-600'>
                  ollama pull llama3.2:3b
                </code>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full'>
      <ChatHeader
        session={currentSession}
        onPersonaChange={handlePersonaChange}
      />

      <ChatMessages
        messages={currentSession.messages}
        isStreaming={isStreaming}
        className='flex-1'
      />
      <ChatInput
        onSendMessage={handleSendMessage}
        onStopGeneration={stopGeneration}
        disabled={!currentSession}
      />
    </div>
  );
};

export default ChatPage;
