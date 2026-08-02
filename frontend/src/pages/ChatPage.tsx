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

import React, {
  useCallback,
  useEffect,
  useState,
  useRef,
  useMemo,
} from 'react';
import { useParams, useNavigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Send, Plus, Paperclip, Minus, Ghost } from 'lucide-react';
import { ChatMessages } from '@/components/ChatMessages';
import { ChatInput } from '@/components/ChatInput';
import { CodeAwareTextarea } from '@/components/CodeAwareTextarea';
import { ModelSelector } from '@/components/ModelSelector';
import { PersonaIndicator } from '@/components/PersonaIndicator';
import { Button } from '@/components/ui';
import { ImageUpload } from '@/components/ImageUpload';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import { useChat } from '@/hooks/useChat';
import { chatApi, imageGenApi } from '@/utils/api';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { isRTL } from '@/i18n';
import {
  chatModelOptionKey,
  chatModelSelectionFromKey,
  chatModelSelectionFromModel,
  chatModelSelectionKeyForModels,
  isChatModelSelectionAvailable,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';
import toast from 'react-hot-toast';
import {
  getWelcomePromptId,
  getWelcomePromptIndex,
  WELCOME_PROMPT_CHANGE_EVENT,
  type WelcomePromptId,
} from '@/utils/welcomePrompts';

const logger = createLogger('pages:chat-page');

interface WelcomePrompt {
  id: WelcomePromptId;
  title: string;
  subtitle: string;
}

const getTimeWelcomePrompt = (
  username?: string,
  t?: (key: string) => string,
  rtl = false
): WelcomePrompt => {
  const hour = new Date().getHours();
  const name = username ? `${rtl ? '،' : ','} \u2068${username}\u2069` : '';

  if (hour >= 5 && hour < 12) {
    const greetingText = t ? t('chat.greeting.morning') : 'Good morning';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t ? t('chat.welcome.helpToday') : 'What can I help with today?',
    };
  } else if (hour >= 12 && hour < 17) {
    const greetingText = t ? t('chat.greeting.afternoon') : 'Good afternoon';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t ? t('chat.welcome.helpToday') : 'What can I help with today?',
    };
  } else if (hour >= 17 && hour < 21) {
    const greetingText = t ? t('chat.greeting.evening') : 'Good evening';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t
        ? t('chat.welcome.helpTonight')
        : 'What can I help with tonight?',
    };
  } else {
    const greetingText = t ? t('chat.greeting.night') : 'Good night';
    return {
      id: 'time',
      title: `${greetingText}${name}`,
      subtitle: t
        ? t('chat.welcome.helpTonight')
        : 'What can I help with tonight?',
    };
  }
};

const getWelcomePrompt = (
  index: number,
  username?: string,
  t?: (key: string) => string,
  rtl = false
): WelcomePrompt => {
  const id = getWelcomePromptId(index);

  if (id === 'time') {
    return getTimeWelcomePrompt(username, t, rtl);
  }

  return {
    id,
    title: t ? t(`chat.welcome.variety.${id}.title`) : 'What should we make?',
    subtitle: t
      ? t(`chat.welcome.variety.${id}.subtitle`)
      : 'Start with a thought, a sketch, or a stubborn problem.',
  };
};

export const ChatPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    currentSession,
    sessions,
    models,
    selectedModel,
    selectedProviderType,
    selectedProviderId,
    setSelectedModel,
    createSession,
    setCurrentSession,
    loadSessions,
    getCurrentPersona,
  } = useChatStore();
  const { user } = useAuthStore();
  const imageGenerationEnabled = useAppStore(
    state => state.preferences.imageGenSettings?.enabled === true
  );
  const {
    sendMessage,
    stopGeneration,
    regenerateLastMessage,
    selectBranch,
    isStreaming,
    streamingMessage,
    streamingMessageId,
    toolActivities,
  } = useChat(currentSession?.id || '');
  const currentPersona = getCurrentPersona();
  const selectedModelState = useMemo(
    () => ({
      model: selectedModel,
      providerType: selectedProviderType,
      providerId: selectedProviderId,
    }),
    [selectedModel, selectedProviderId, selectedProviderType]
  );
  const welcomeModels = useMemo(
    () => withUnavailableChatModel(models, selectedModelState),
    [models, selectedModelState]
  );
  const selectedModelKey = selectedModel
    ? chatModelSelectionKeyForModels(welcomeModels, selectedModelState)
    : '';
  const selectedModelAvailable = isChatModelSelectionAvailable(
    models,
    selectedModelState
  );
  const incognitoRequested =
    new URLSearchParams(location.search).get('incognito') === '1';

  const [welcomePromptIndex, setWelcomePromptIndex] = useState(
    getWelcomePromptIndex
  );
  const welcomePrompt = useMemo(
    () =>
      getWelcomePrompt(
        welcomePromptIndex,
        user?.username,
        t,
        isRTL(i18n.language)
      ),
    [i18n.language, t, user?.username, welcomePromptIndex]
  );

  // Welcome screen state
  const [welcomeMessage, setWelcomeMessage] = useState('');
  const [welcomeImages, setWelcomeImages] = useState<string[]>([]);
  const [showWelcomeAdvanced, setShowWelcomeAdvanced] = useState(false);
  const welcomeTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleWelcomePromptChange = () => {
      setWelcomePromptIndex(getWelcomePromptIndex());
    };

    window.addEventListener(
      WELCOME_PROMPT_CHANGE_EVENT,
      handleWelcomePromptChange
    );
    return () =>
      window.removeEventListener(
        WELCOME_PROMPT_CHANGE_EVENT,
        handleWelcomePromptChange
      );
  }, []);

  // Image generation state
  const [hasImageGenPlugins, setHasImageGenPlugins] = useState(false);
  const showImageGeneration = imageGenerationEnabled && hasImageGenPlugins;

  const startPrivateSession = useCallback(
    (notifyWhenUnavailable = true) => {
      const privateSelection = selectedModel
        ? selectedModelState
        : models[0]
          ? chatModelSelectionFromModel(models[0])
          : null;
      if (
        !privateSelection ||
        !isChatModelSelectionAvailable(models, privateSelection)
      ) {
        if (notifyWhenUnavailable) {
          toast.error(t('chat.model.selectBeforePrivateChat'));
        }
        return false;
      }

      const now = Date.now();
      setCurrentSession({
        id: `private-${now}`,
        title: t('chat.session.incognito', 'Incognito Chat'),
        model: privateSelection.model,
        providerType: privateSelection.providerType,
        providerId: privateSelection.providerId,
        messages: [],
        createdAt: now,
        updatedAt: now,
        isPrivate: true,
      });
      return true;
    },
    [models, selectedModel, selectedModelState, setCurrentSession, t]
  );

  // Load sessions on mount
  useEffect(() => {
    if (sessions.length === 0) {
      loadSessions();
    }
  }, [loadSessions, sessions.length]); // Include both dependencies

  useEffect(() => {
    if (!incognitoRequested || currentSession?.isPrivate) return;
    startPrivateSession(false);
  }, [currentSession?.isPrivate, incognitoRequested, startPrivateSession]);

  // Check for available image generation plugins
  useEffect(() => {
    let cancelled = false;

    const checkImageGenPlugins = async () => {
      try {
        const response = await imageGenApi.getPlugins();
        if (cancelled) return;
        setHasImageGenPlugins(
          !!(response.success && response.data && response.data.length > 0)
        );
      } catch {
        if (cancelled) return;
        setHasImageGenPlugins(false);
      }
    };

    if (imageGenerationEnabled) {
      void checkImageGenPlugins();
    }

    return () => {
      cancelled = true;
    };
  }, [imageGenerationEnabled]);

  // Handle URL session parameter
  useEffect(() => {
    const handleSessionFromUrl = () => {
      // Check if we should force welcome screen (from sidebar click)
      const forceWelcome = sessionStorage.getItem('forceWelcomeScreen');
      if (forceWelcome) {
        sessionStorage.removeItem('forceWelcomeScreen');
        return; // Don't load any session, show welcome screen
      }

      // Keep an incognito session on the unsaved /chat route, but allow an
      // explicit saved-session URL to leave incognito mode.
      if (currentSession?.isPrivate && !sessionId) {
        return;
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
          logger.warn(
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
    currentSession?.isPrivate,
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
          logger.error('Failed to parse pending message:', e);
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
      const newSession = await createSession(
        selectedModel,
        undefined,
        selectedModel.startsWith('persona:')
          ? selectedModel.slice('persona:'.length)
          : undefined,
        selectedProviderType,
        selectedProviderId
      );
      if (newSession) {
        navigate(`/c/${newSession.id}`, { replace: true });
      }
    }
  };

  // Handle welcome screen message submission
  const handleWelcomeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!welcomeMessage.trim() || !selectedModel) return;
    if (!selectedModelAvailable) {
      toast.error('Select an available model before sending');
      return;
    }

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
    const newSession = await createSession(
      selectedModel,
      undefined,
      selectedModel.startsWith('persona:')
        ? selectedModel.slice('persona:'.length)
        : undefined,
      selectedProviderType,
      selectedProviderId
    );
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
    const selection = chatModelSelectionFromKey(
      welcomeModels,
      event.target.value
    );
    if (!selection) return;
    setSelectedModel(
      selection.model,
      selection.providerType,
      selection.providerId
    );
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
      <div className='relative h-full flex-1 overflow-y-auto overflow-x-hidden px-4 py-20 sm:px-8 sm:py-24'>
        <div
          aria-hidden='true'
          className='pointer-events-none absolute inset-0'
        >
          <div className='absolute left-[12%] top-[18%] h-56 w-56 rounded-full bg-primary-500/[0.035] blur-3xl dark:bg-primary-400/[0.04]' />
          <div className='absolute bottom-[16%] right-[10%] h-72 w-72 rounded-full bg-gray-900/[0.025] blur-3xl dark:bg-white/[0.025]' />
          <div className='absolute left-1/2 top-0 h-16 w-px bg-gray-300/60 dark:bg-white/10' />
        </div>

        {/* Private Mode Button - Top Right Corner */}
        <button
          onClick={() => startPrivateSession()}
          disabled={
            (!selectedModel && models.length === 0) ||
            (Boolean(selectedModel) && !selectedModelAvailable)
          }
          className='absolute end-4 top-4 z-10 flex items-center gap-2 rounded-full border border-black/[0.07] bg-surface/65 px-3 py-2 text-xs font-medium text-gray-500 backdrop-blur-md transition-colors duration-150 hover:bg-surface-raised hover:text-gray-950 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/[0.08] dark:bg-dark-200/65 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 sm:end-6 sm:top-6'
          title={t('chat.session.privateTooltip')}
        >
          <Ghost className='h-3.5 w-3.5' />
          <span>{t('chat.session.incognito', 'Incognito Chat')}</span>
        </button>

        <div className='relative z-[1] mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center'>
          <div
            key={welcomePrompt.id}
            className='mb-10 flex flex-col items-center text-center animate-fade-in sm:mb-12'
            aria-live='polite'
          >
            <h1 className='mb-4 max-w-3xl text-balance text-[clamp(2.65rem,7vw,5.25rem)] font-light leading-[0.98] tracking-[-0.055em] text-gray-950 dark:text-dark-950 rtl:leading-[1.12] rtl:tracking-normal'>
              {welcomePrompt.title}
            </h1>
            <p className='max-w-xl text-balance text-base leading-relaxed text-gray-500 dark:text-dark-600 sm:text-lg'>
              {welcomePrompt.subtitle}
            </p>
          </div>

          {welcomeModels.length > 0 ? (
            <div className='w-full'>
              {/* Advanced Features Panel */}
              {showWelcomeAdvanced && (
                <div className='mb-3 animate-slide-up rounded-2xl border border-black/[0.07] bg-surface/80 p-4 shadow-sm backdrop-blur-xl dark:border-white/[0.08] dark:bg-dark-200/80'>
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
                    'flex items-end gap-2 rounded-[1.35rem] border p-2 transition-[border-color,box-shadow,background-color] duration-200',
                    'border-black/[0.08] bg-surface/90 dark:border-white/[0.09] dark:bg-dark-200/90',
                    'shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_50px_rgba(15,23,42,0.08)] backdrop-blur-xl',
                    'focus-within:border-primary-500/35 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_22px_65px_rgba(15,23,42,0.12)]'
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
                      'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300 transition-colors touch-manipulation',
                      hasAdvancedFeatures &&
                        'text-primary-600 dark:text-primary-400',
                      showWelcomeAdvanced && 'bg-gray-100 dark:bg-dark-300'
                    )}
                    title={t('chat.input.attachImages')}
                  >
                    {hasAdvancedFeatures ? (
                      <div className='relative flex items-center justify-center'>
                        <Paperclip className='h-4 w-4' />
                        <div className='absolute -top-0.5 -end-0.5 h-1.5 w-1.5 bg-primary-500 rounded-full' />
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
                      placeholder={t('chat.input.messagePlaceholder')}
                      className='!m-0 min-h-[36px] max-h-[160px] resize-none !rounded-none !border-0 !bg-transparent !p-1.5 !shadow-none scrollbar-thin scrollbar-thumb-gray-300 placeholder:text-gray-400 focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!ring-0 dark:scrollbar-thumb-dark-400 dark:placeholder:text-dark-500 text-[0.9375rem] leading-relaxed touch-manipulation'
                      rows={1}
                    />
                  </div>

                  {/* Model selector (compact) */}
                  <div className='hidden sm:block'>
                    <ModelSelector
                      models={welcomeModels}
                      selectedModel={selectedModelKey}
                      onModelChange={handleModelChange}
                      getModelValue={chatModelOptionKey}
                      className='min-w-[140px] max-w-[210px]'
                      compact
                      showImageGen={showImageGeneration}
                    />
                  </div>

                  {/* Send button */}
                  <Button
                    type='submit'
                    variant='ghost'
                    size='sm'
                    disabled={
                      !welcomeMessage.trim() ||
                      !selectedModel ||
                      !selectedModelAvailable
                    }
                    className={cn(
                      'h-8 w-8 sm:h-9 sm:w-9 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                      'bg-gray-950 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100',
                      'disabled:bg-gray-100 disabled:text-gray-400 dark:disabled:bg-dark-300 dark:disabled:text-dark-500 disabled:hover:bg-gray-100 dark:disabled:hover:bg-dark-300',
                      'transition-colors duration-150 touch-manipulation',
                      welcomeMessage.trim() && selectedModel && 'shadow-sm'
                    )}
                    title={t('chat.input.sendMessage')}
                  >
                    <Send className='h-4 w-4' />
                  </Button>
                </div>
              </form>

              {/* Mobile model selector */}
              <div className='sm:hidden mt-4'>
                <ModelSelector
                  models={welcomeModels}
                  selectedModel={selectedModelKey}
                  onModelChange={handleModelChange}
                  getModelValue={chatModelOptionKey}
                  className='w-full'
                  compact
                  showImageGen={showImageGeneration}
                />
              </div>

              <p className='mt-4 text-center text-[10px] leading-relaxed text-gray-400 dark:text-dark-500'>
                {t('chat.footer.disclaimer')}
              </p>
            </div>
          ) : (
            <div className='w-full max-w-lg'>
              <div className='rounded-2xl border border-black/[0.07] bg-surface/70 p-6 backdrop-blur-xl dark:border-white/[0.08] dark:bg-dark-200/70'>
                <p className='mb-4 text-sm leading-relaxed text-gray-600 dark:text-dark-700'>
                  {t('chat.model.noModelsDescription')}
                </p>
                <code className='block rounded-xl bg-gray-100 p-3 font-mono text-xs text-gray-800 dark:bg-dark-300 dark:text-dark-700'>
                  {t('chat.model.pullCommand')}
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
      className='relative flex h-full flex-col'
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
        <div className='absolute inset-0 bg-gray-50/[0.88] backdrop-blur-sm dark:bg-dark-100/[0.88]' />
      )}

      <div className='relative z-10 flex h-full flex-col'>
        {/* Private mode indicator */}
        {currentSession?.isPrivate && (
          <div className='flex-shrink-0 border-b border-black/[0.05] bg-surface/55 px-4 py-2 backdrop-blur-xl dark:border-white/[0.06] dark:bg-dark-100/55'>
            <div className='flex items-center justify-center gap-2 text-gray-500 dark:text-dark-600'>
              <Ghost className='h-3.5 w-3.5' />
              <span className='text-xs font-medium'>
                {t('chat.session.privateMode')}
              </span>
              <span className='hidden text-[11px] text-gray-400 dark:text-dark-500 sm:inline'>
                — {t('chat.session.privateDescription')}
              </span>
            </div>
          </div>
        )}
        {/* Persona indicator header */}
        {currentPersona && !currentSession?.isPrivate && (
          <div className='flex-shrink-0 border-b border-black/[0.05] bg-surface/55 px-4 py-2 backdrop-blur-xl dark:border-white/[0.06] dark:bg-dark-100/55'>
            <PersonaIndicator
              persona={currentPersona}
              onClear={() => {
                if (!currentSession) return;
                void chatApi
                  .updateSession(currentSession.id, {
                    model: currentPersona.model,
                    providerType: 'ollama',
                    providerId: null,
                    personaId: null,
                  })
                  .then(response => {
                    if (!response.success || !response.data) {
                      throw new Error(
                        response.error || 'Failed to remove persona'
                      );
                    }
                    useChatStore.setState(state => ({
                      sessions: state.sessions.map(session =>
                        session.id === currentSession.id
                          ? response.data!
                          : session
                      ),
                      currentSession: response.data!,
                    }));
                  })
                  .catch(error => {
                    logger.error('Failed to remove persona:', error);
                    toast.error('Failed to remove persona');
                  });
              }}
            />
          </div>
        )}
        <ChatMessages
          messages={currentSession.messages}
          streamingMessage={streamingMessage}
          streamingMessageId={streamingMessageId}
          isStreaming={isStreaming}
          toolActivities={toolActivities}
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
