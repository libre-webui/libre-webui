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
import { useParams, useNavigate } from 'react-router-dom';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { Logo } from '@/components/Logo';
import { useChatStore } from '@/store/chatStore';
import { useChat } from '@/hooks/useChat';
import { Select } from '@/components/ui';

export const ChatPage: React.FC = () => {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
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
  }, [loadSessions, sessions.length]); // Include sessions.length as dependency

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
          // Session not found, redirect to most recent session or root
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
  }, [sessionId, sessions, setCurrentSession, navigate, currentSession?.id]); // Include currentSession?.id as dependency

  const handleModelChange = async (model: string) => {
    setSelectedModel(model);
    if (!currentSession) {
      const newSession = await createSession(model);
      if (newSession) {
        navigate(`/c/${newSession.id}`, { replace: true });
      }
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
              {selectedModel && (
                <div className='p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-xl'>
                  <p className='text-sm text-gray-700 dark:text-dark-700'>
                    Click &quot;New Chat&quot; in the sidebar to begin your
                    conversation
                  </p>
                </div>
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
