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

import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Send, Plus, Paperclip, Minus } from 'lucide-react';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { CodeAwareTextarea } from '@/components/CodeAwareTextarea';
import { ModelSelector } from '@/components/ModelSelector';
import { PersonaIndicator } from '@/components/PersonaIndicator';
import { ImageGenerationPanel } from '@/components/ImageGenerationPanel';
import { Button } from '@/components/ui';
import { ImageUpload } from '@/components/ImageUpload';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { useChat } from '@/hooks/useChat';
import { imageGenApi } from '@/utils/api';
import { cn } from '@/utils';

// Get personalized greeting and time-appropriate suffix based on time of day
const getGreeting = (
  username?: string
): { greeting: string; timeSuffix: string } => {
  const hour = new Date().getHours();
  const name = username ? `, ${username}` : '';

  if (hour >= 5 && hour < 12) {
    return { greeting: `Good morning${name}`, timeSuffix: 'today' };
  } else if (hour >= 12 && hour < 17) {
    return { greeting: `Good afternoon${name}`, timeSuffix: 'today' };
  } else if (hour >= 17 && hour < 21) {
    return { greeting: `Good evening${name}`, timeSuffix: 'tonight' };
  } else {
    return { greeting: `Good night${name}`, timeSuffix: 'tonight' };
  }
};

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
  const { user } = useAuthStore();
  const {
    sendMessage,
    stopGeneration,
    regenerateLastMessage,
    selectBranch,
    isStreaming,
    streamingMessage,
    streamingMessageId,
  } = useChat(currentSession?.id || '');
  const currentPersona = getCurrentPersona();

  // Personalized greeting based on time of day
  const { greeting, timeSuffix } = useMemo(
    () => getGreeting(user?.username),
    [user?.username]
  );

  // Welcome screen state
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [welcomeImages, setWelcomeImages] = useState<string[]>([]);
  const [showWelcomeAdvanced, setShowWelcomeAdvanced] = useState(false);
  const welcomeTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Image generation state
  const [showImageGen, setShowImageGen] = useState(false);
  const [hasImageGenPlugins, setHasImageGenPlugins] = useState(false);

  // Load sessions on mount
  useEffect(() => {
    if (sessions.length === 0) {
      loadSessions();
    }
  }, [loadSessions, sessions.length]); // Include both dependencies

  // Check for available image generation plugins
  useEffect(() => {
    const checkImageGenPlugins = async () => {
      try {
        const response = await imageGenApi.getPlugins();
        setHasImageGenPlugins(!!(response.success && response.data && response.data.length > 0));
      } catch {
        setHasImageGenPlugins(false);
      }
    };
    checkImageGenPlugins();
  }, []);

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

  // Note: Persona backgrounds are handled locally in this component's JSX
  // and should NOT set the global backgroundImage state, which is for user-configured
  // backgrounds in settings. Persona backgrounds only apply to the current chat view.

  // Check for pending message from welcome screen and send it
  useEffect(() => {
    if (currentSession?.id) {
      const pendingMessageStr = sessionStorage.getItem('pendingMessage');
      if (pendingMessageStr) {
        sessionStorage.removeItem('pendingMessage');
        try {
          const pendingMessage = JSON.parse(pendingMessageStr) as {
            content: string;
            images?: string[];
          };
          // Small delay to ensure WebSocket handlers are set up
          setTimeout(() => {
            sendMessage(pendingMessage.content, pendingMessage.images);
          }, 100);
        } catch (e) {
          console.error('Failed to parse pending message:', e);
        }
      }
    }
  }, [currentSession?.id, sendMessage]);

  // Auto-resize welcome textarea
  useEffect(() => {
    const textarea = welcomeTextareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }, [welcomeMessage]);

  const _handleCreateSession = async () => {
    if (selectedModel) {
      const newSession = await createSession(selectedModel);
      if (newSession) {
        navigate(`/c/${newSession.id}`, { replace: true });
      }
    }
  };

  // Handle welcome screen message submission
  const handleWelcomeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!welcomeMessage.trim() || !selectedModel) return;

    // Store the pending message in sessionStorage before creating session
    // This allows the new session page to pick it up and send it
    const pendingMessage = {
      content: welcomeMessage.trim(),
      images: welcomeImages.length > 0 ? welcomeImages : undefined,
    };
    sessionStorage.setItem('pendingMessage', JSON.stringify(pendingMessage));

    // Clear local state
    setWelcomeMessage('');
    setWelcomeImages([]);

    // Create a new session and navigate to it
    const newSession = await createSession(selectedModel);
    if (newSession) {
      navigate(`/c/${newSession.id}`, { replace: true });
    }
  };

  const handleWelcomeKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleWelcomeSubmit(e);
    }
  };

  const handleModelChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const model = event.target.value;
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
    const hasAdvancedFeatures = welcomeImages.length > 0;

    return (
      <div className='h-full flex-1 flex flex-col items-center justify-center p-4 sm:p-8'>
        <div className='w-full max-w-2xl mx-auto flex flex-col items-center justify-center'>
          {/* Personalized greeting based on time of day */}
          <h1
            className='text-2xl sm:text-3xl font-medium text-gray-800 dark:text-gray-100 ophelia:text-[#fafafa] mb-2 text-center'
            style={{ fontWeight: 400 }}
          >
            {greeting}
          </h1>
          <p className='text-base sm:text-lg text-gray-500 dark:text-gray-400 ophelia:text-[#737373] mb-8 text-center'>
            What can I help with {timeSuffix}?
          </p>

          {models.length > 0 ? (
            <div className='w-full'>
              {/* Advanced Features Panel */}
              {showWelcomeAdvanced && (
                <div className='mb-4 p-4 bg-gray-50 dark:bg-dark-100 ophelia:bg-[#121212] border border-gray-200 dark:border-dark-300 ophelia:border-[#262626] rounded-2xl'>
                  <ImageUpload
                    images={welcomeImages}
                    onImagesChange={setWelcomeImages}
                    maxImages={5}
                  />
                </div>
              )}

              {/* ChatGPT-style unified input */}
              <form onSubmit={handleWelcomeSubmit}>
                <div
                  className={cn(
                    'flex items-center gap-2 p-2 sm:p-3 rounded-2xl sm:rounded-3xl border transition-all duration-200',
                    'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#0a0a0a] border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                    'hover:border-gray-300 dark:hover:border-dark-400 ophelia:hover:border-[#3f3f46]',
                    'focus-within:border-primary-400 dark:focus-within:border-primary-500 ophelia:focus-within:border-[#9333ea] focus-within:bg-white dark:focus-within:bg-dark-50 ophelia:focus-within:bg-[#0a0a0a]',
                    'shadow-sm hover:shadow-md focus-within:shadow-lg'
                  )}
                >
                  {/* Attachment button */}
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={() => setShowWelcomeAdvanced(!showWelcomeAdvanced)}
                    className={cn(
                      'h-8 w-8 sm:h-9 sm:w-9 !p-0 rounded-full flex-shrink-0',
                      'hover:bg-gray-200 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a] transition-colors touch-manipulation',
                      hasAdvancedFeatures &&
                        'text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7]',
                      showWelcomeAdvanced &&
                        'bg-gray-200 dark:bg-dark-200 ophelia:bg-[#1a1a1a]'
                    )}
                    title='Attach images'
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: '0',
                    }}
                  >
                    {hasAdvancedFeatures ? (
                      <div className='relative flex items-center justify-center'>
                        <Paperclip className='h-4 w-4' />
                        <div className='absolute -top-0.5 -right-0.5 h-1.5 w-1.5 bg-primary-500 ophelia:bg-[#9333ea] rounded-full' />
                      </div>
                    ) : showWelcomeAdvanced ? (
                      <Minus className='h-4 w-4' />
                    ) : (
                      <Plus className='h-4 w-4' />
                    )}
                  </Button>

                  {/* Text Input */}
                  <div className='flex-1 min-w-0'>
                    <CodeAwareTextarea
                      ref={welcomeTextareaRef}
                      value={welcomeMessage}
                      onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                        setWelcomeMessage(e.target.value)
                      }
                      onKeyDown={handleWelcomeKeyDown}
                      placeholder='Message...'
                      className='!border-0 !bg-transparent !shadow-none !p-0 !m-0 !rounded-none !focus:ring-0 !focus:border-0 !focus:shadow-none !focus:bg-transparent min-h-[32px] sm:min-h-[36px] max-h-[120px] resize-none scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-dark-400 ophelia:scrollbar-thumb-[#3f3f46] focus:outline-none placeholder:text-gray-500 dark:placeholder:text-dark-500 ophelia:placeholder:text-[#737373] text-base sm:text-sm leading-none touch-manipulation'
                      rows={1}
                      style={{
                        boxShadow: 'none !important',
                        border: 'none !important',
                        outline: 'none !important',
                        padding: '0 !important',
                        margin: '0 !important',
                        lineHeight: '1.2 !important',
                        verticalAlign: 'middle',
                      }}
                    />
                  </div>

                  {/* Model selector (compact) */}
                  <div className='hidden sm:block'>
                    <ModelSelector
                      models={models}
                      selectedModel={selectedModel}
                      onModelChange={handleModelChange}
                      className='min-w-[140px] max-w-[200px] border-0 bg-gray-100 dark:bg-dark-100 ophelia:bg-[#121212] rounded-xl text-sm'
                      compact
                      showImageGen={hasImageGenPlugins}
                      onImageGenClick={() => setShowImageGen(true)}
                    />
                  </div>

                  {/* Send button */}
                  <Button
                    type='submit'
                    variant='ghost'
                    size='sm'
                    disabled={!welcomeMessage.trim() || !selectedModel}
                    className={cn(
                      'h-8 w-8 sm:h-9 sm:w-9 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                      'hover:bg-primary-100 dark:hover:bg-primary-900/30 ophelia:hover:bg-[rgba(147,51,234,0.2)] text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7]',
                      'disabled:text-gray-400 dark:disabled:text-dark-500 ophelia:disabled:text-[#525252] disabled:hover:bg-transparent',
                      'transition-all duration-150 touch-manipulation',
                      welcomeMessage.trim() &&
                        selectedModel &&
                        'hover:scale-105 active:scale-95'
                    )}
                    title='Send message'
                  >
                    <Send className='h-4 w-4' />
                  </Button>
                </div>
              </form>

              {/* Mobile model selector */}
              <div className='sm:hidden mt-4'>
                <ModelSelector
                  models={models}
                  selectedModel={selectedModel}
                  onModelChange={handleModelChange}
                  className='w-full rounded-xl bg-gray-100 dark:bg-dark-100 ophelia:bg-[#121212] border-0'
                  compact
                  showImageGen={hasImageGenPlugins}
                  onImageGenClick={() => setShowImageGen(true)}
                />
              </div>

              {/* Footer with Libre WebUI branding */}
              <div className='mt-4 text-center'>
                <a
                  href='https://librewebui.org'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='libre-brand underline hover:text-primary-600 dark:hover:text-primary-400 ophelia:hover:text-[#a855f7] transition-colors text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'
                  style={{ fontSize: '0.75rem', lineHeight: 1 }}
                >
                  Libre WebUI
                </a>{' '}
                <span
                  className='text-gray-400 dark:text-gray-500 ophelia:text-[#525252]'
                  style={{ fontSize: '0.55rem' }}
                >
                  v{import.meta.env.VITE_APP_VERSION || '0.1.3'}
                </span>{' '}
                <span className='text-gray-300 dark:text-gray-600 ophelia:text-[#3f3f46] opacity-50'>
                  •
                </span>{' '}
                <span className='text-xs text-gray-400 dark:text-gray-500 ophelia:text-[#525252]'>
                  LLM can make mistakes - verify important information
                </span>
              </div>
            </div>
          ) : (
            <div className='w-full max-w-md'>
              <div className='p-6 bg-gray-50 dark:bg-dark-100 ophelia:bg-[#121212] border border-gray-200 dark:border-dark-300 ophelia:border-[#262626] rounded-xl'>
                <p className='text-sm text-gray-700 dark:text-dark-700 ophelia:text-[#a3a3a3] mb-4'>
                  No models available. Make sure Ollama is running and has
                  models installed.
                </p>
                <code className='block text-xs bg-gray-100 dark:bg-dark-200 ophelia:bg-[#0a0a0a] p-3 rounded-lg font-mono text-gray-800 dark:text-dark-600 ophelia:text-[#737373]'>
                  ollama pull llama3.2:3b
                </code>
              </div>
            </div>
          )}
        </div>

        {/* Image Generation Panel */}
        <ImageGenerationPanel
          isOpen={showImageGen}
          onClose={() => setShowImageGen(false)}
          onImageGenerated={async (imageData, prompt, model) => {
            if (!selectedModel) return;

            // Store the pending message with the generated image
            const pendingMessage = {
              content: `Generated image using ${model}:\n"${prompt}"`,
              images: [imageData],
            };
            sessionStorage.setItem('pendingMessage', JSON.stringify(pendingMessage));

            // Create a new session and navigate to it
            const newSession = await createSession(selectedModel);
            if (newSession) {
              navigate(`/c/${newSession.id}`, { replace: true });
            }
          }}
        />
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
        {/* Persona indicator header */}
        {currentPersona && (
          <div className='flex-shrink-0 px-4 py-2 border-b border-gray-100 dark:border-dark-200 ophelia:border-[#262626] bg-white/50 dark:bg-dark-100/50 ophelia:bg-[#0a0a0a]/50 backdrop-blur-sm'>
            <PersonaIndicator
              persona={currentPersona}
              onClear={() => {
                // Clear persona from session
                if (currentSession) {
                  const { sessions } = useChatStore.getState();
                  const updatedSession = {
                    ...currentSession,
                    model: currentPersona.model,
                    personaId: undefined,
                  };
                  const updatedSessions = sessions.map(s =>
                    s.id === currentSession.id ? updatedSession : s
                  );
                  useChatStore.setState({
                    sessions: updatedSessions,
                    currentSession: updatedSession,
                  });
                  // Persona background is handled locally - clearing personaId removes the background
                }
              }}
            />
          </div>
        )}
        <ChatMessages
          messages={currentSession.messages}
          streamingMessage={streamingMessage}
          streamingMessageId={streamingMessageId}
          isStreaming={isStreaming}
          onRegenerate={regenerateLastMessage}
          onSelectBranch={selectBranch}
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
