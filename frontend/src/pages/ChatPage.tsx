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

import React, { useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { Logo } from '@/components/Logo';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { useChat } from '@/hooks/useChat';
import { Select } from '@/components/ui';

export const ChatPage: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    currentSession,
    sessions,
    models,
    selectedModel,
    setSelectedModel,
    createSession,
    setCurrentSession,
    loadSessions,
    getCurrentPersona,
  } = useChatStore();
  const { setBackgroundImage } = useAppStore();
  const { sendMessage, stopGeneration, isStreaming } = useChat(
    currentSession?.id || ''
  );
  const currentPersona = getCurrentPersona();

  // Load sessions on mount
  useEffect(() => {
    if (sessions.length === 0) {
      loadSessions();
    }
  }, [loadSessions, sessions.length]); // Include both dependencies

  // Handle URL session parameter
  useEffect(() => {
    const handleSessionFromUrl = () => {
      // Check if we should force welcome screen (from sidebar click)
      const forceWelcome = sessionStorage.getItem('forceWelcomeScreen');
      if (forceWelcome) {
        sessionStorage.removeItem('forceWelcomeScreen');
        return; // Don't load any session, show welcome screen
      }

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
      } else if (
        !sessionId &&
        sessions.length > 0 &&
        location.pathname === '/'
      ) {
        // No sessionId in URL but we have sessions, redirect to the most recent session
        // Only redirect from root path (/), not from /chat (which should show welcome screen)
        navigate(`/c/${sessions[0].id}`, { replace: true });
      }
    };

    handleSessionFromUrl();
  }, [
    sessionId,
    sessions,
    setCurrentSession,
    navigate,
    currentSession?.id,
    location.pathname,
  ]);

  // Manage background image state based on current persona
  useEffect(() => {
    if (currentPersona?.background) {
      // Set persona background - this will override general background settings
      setBackgroundImage(currentPersona.background);
    } else {
      // Clear persona background when no persona or persona has no background
      // This allows the general background settings to work independently
      setBackgroundImage(null);
    }
  }, [currentPersona?.background, setBackgroundImage]);

  const handleCreateSession = async () => {
    if (selectedModel) {
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
            Select a model or persona and start a conversation with your AI
            assistant
          </p>

          {models.length > 0 ? (
            <div className='space-y-6'>
              <div className='space-y-3'>
                <Select
                  label='Choose a model or persona'
                  value={selectedModel}
                  onChange={e => handleModelChange(e.target.value)}
                  options={models.map(model => ({
                    value: model.name,
                    label: model.name,
                  }))}
                  className='text-left'
                />
                <p className='text-xs text-gray-500 dark:text-gray-400'>
                  Personas are shown with a purple indicator in the chat header
                  when active.
                  <span className='block mt-1'>
                    <a
                      href='/personas'
                      className='text-blue-500 hover:text-blue-600'
                    >
                      Create and manage personas
                    </a>{' '}
                    in the Personas tab.
                  </span>
                </p>
              </div>

              {selectedModel && (
                <button
                  onClick={handleCreateSession}
                  className='w-full bg-primary-600 hover:bg-primary-700 text-white font-medium py-3 px-4 rounded-lg transition-colors'
                >
                  Start Chat with {selectedModel}
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
    <div
      className='flex flex-col h-full relative'
      style={
        currentPersona?.background
          ? {
              backgroundImage: `url(${currentPersona.background})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
            }
          : undefined
      }
    >
      {/* Background overlay for better readability when persona background is active */}
      {currentPersona?.background && (
        <div className='absolute inset-0 bg-white/80 dark:bg-black/80 backdrop-blur-sm' />
      )}

      <div className='flex flex-col h-full relative z-10'>
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
    </div>
  );
};

export default ChatPage;
