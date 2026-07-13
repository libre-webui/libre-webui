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

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Square, Paperclip, Plus, Minus } from 'lucide-react';
import { Button } from '@/components/ui';
import { CodeAwareTextarea } from './CodeAwareTextarea';
import { MediaUpload } from './MediaUpload';
import { DocumentIndicator } from './DocumentIndicator';
import { StructuredOutput } from './StructuredOutput';
import { ModelSelector } from './ModelSelector';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { personaApi, chatApi, imageGenApi } from '@/utils/api';
import { toast } from 'react-hot-toast';
import { cn } from '@/utils';
import { Persona } from '@/types';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:chat-input');

interface ChatInputProps {
  onSendMessage: (
    message: string,
    images?: string[],
    format?: string | Record<string, unknown>
  ) => void;
  onStopGeneration: () => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  onStopGeneration,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [format, setFormat] = useState<string | Record<string, unknown> | null>(
    null
  );
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null);
  const [hasImageGenPlugins, setHasImageGenPlugins] = useState(false);
  const { isGenerating, setBackgroundImage } = useAppStore();
  const { currentSession, models } = useChatStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check if image generation plugins are available
  useEffect(() => {
    const checkImageGenPlugins = async () => {
      try {
        const response = await imageGenApi.getPlugins();
        setHasImageGenPlugins(
          !!(response.success && response.data && response.data.length > 0)
        );
      } catch {
        setHasImageGenPlugins(false);
      }
    };
    checkImageGenPlugins();
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!message.trim() || isGenerating) return;

    onSendMessage(
      message.trim(),
      images.length > 0 ? images : undefined,
      format || undefined
    );
    setMessage('');
    setImages([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleStopGeneration = () => {
    onStopGeneration();
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }, [message]);

  // Load current persona when session changes
  useEffect(() => {
    const loadCurrentPersona = async () => {
      if (currentSession?.personaId) {
        try {
          const response = await personaApi.getPersona(
            currentSession.personaId
          );
          if (response.success && response.data) {
            setCurrentPersona(response.data);
          } else {
            logger.warn(
              `Persona ${currentSession.personaId} not found, clearing reference`
            );
            setCurrentPersona(null);
            // Clear the personaId from the session to prevent repeated requests
            const { setCurrentSession } = useChatStore.getState();
            setCurrentSession({
              ...currentSession,
              personaId: undefined,
            });
          }
        } catch (error) {
          logger.error('Failed to load current persona:', error);
          setCurrentPersona(null);
          // Clear the personaId from the session to prevent repeated requests
          if (currentSession) {
            const { setCurrentSession } = useChatStore.getState();
            setCurrentSession({
              ...currentSession,
              personaId: undefined,
            });
          }
        }
      } else {
        setCurrentPersona(null);
      }
    };

    loadCurrentPersona();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.personaId]);

  const handleModelOrPersonaChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const value = event.target.value;
    if (!currentSession) return;

    try {
      // Check if the selected value is a persona
      if (value.startsWith('persona:')) {
        const personaId = value.replace('persona:', '');

        // Get persona details to use its model
        const personaResponse = await personaApi.getPersona(personaId);
        if (!personaResponse.success || !personaResponse.data) {
          toast.error('Failed to load persona details');
          return;
        }

        const persona = personaResponse.data;

        // Update session with persona and its model
        const response = await chatApi.updateSession(currentSession.id, {
          personaId: personaId,
          model: value, // Keep the persona model string (persona:xxx)
        });

        if (response.success && response.data) {
          // Update both currentSession and the sessions array
          const { sessions } = useChatStore.getState();
          const updatedSessions = sessions.map(s =>
            s.id === currentSession.id ? response.data! : s
          );
          useChatStore.setState({
            sessions: updatedSessions,
            currentSession: response.data,
          });

          // Apply persona background if it has one
          if (persona.background) {
            setBackgroundImage(persona.background);
          }

          toast.success(t('chat.persona.applied'));
        }
      } else {
        // It's a regular model - update the model and clear persona
        const response = await chatApi.updateSession(currentSession.id, {
          model: value,
          personaId: undefined,
        });

        if (response.success && response.data) {
          // Update both currentSession and the sessions array
          const { sessions } = useChatStore.getState();
          const updatedSessions = sessions.map(s =>
            s.id === currentSession.id ? response.data! : s
          );
          useChatStore.setState({
            sessions: updatedSessions,
            currentSession: response.data,
          });

          setBackgroundImage(null);
          toast.success(t('chat.model.updated'));
        }
      }
    } catch (error) {
      logger.error('Failed to update session:', error);
      toast.error('Failed to update session');
    }
  };

  const hasAdvancedFeatures = images.length > 0 || format !== null;
  return (
    <div className='pointer-events-none'>
      {/* Centered container matching chat messages width */}
      <div className='pointer-events-auto mx-auto w-full max-w-4xl px-4 sm:px-6 md:px-8'>
        {/* Advanced Features Panel */}
        {showAdvanced && (
          <div className='mb-2 animate-slide-up rounded-2xl border border-black/[0.07] bg-white/90 p-4 shadow-[0_12px_40px_rgba(15,23,42,0.08)] backdrop-blur-xl dark:border-white/[0.08] dark:bg-dark-200/90'>
            <MediaUpload
              images={images}
              onImagesChange={setImages}
              maxImages={5}
              sessionId={currentSession?.id}
              disabled={disabled}
            />
            <StructuredOutput format={format} onFormatChange={setFormat} />
          </div>
        )}

        {/* Main Input Area - Unified Input Bar */}
        <div className='pb-3 pt-2 sm:pb-4'>
          <form onSubmit={handleSubmit}>
            {/* Unified Input Container */}
            <div
              className={cn(
                'flex items-end gap-2 rounded-[1.55rem] border p-2.5 transition-[border-color,box-shadow,background-color] duration-200 sm:p-3',
                'bg-white/[0.92] dark:bg-dark-200/[0.92] backdrop-blur-xl',
                'border-black/[0.08] dark:border-white/[0.09]',
                'shadow-[0_1px_2px_rgba(0,0,0,0.03),0_14px_42px_rgba(15,23,42,0.08)]',
                'focus-within:border-primary-500/35 focus-within:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_52px_rgba(15,23,42,0.11)]'
              )}
            >
              {/* Advanced Features Toggle - Integrated Left */}
              <Button
                type='button'
                variant='ghost'
                size='sm'
                onClick={() => setShowAdvanced(!showAdvanced)}
                className={cn(
                  'h-9 w-9 sm:h-10 sm:w-10 !p-0 rounded-full flex-shrink-0',
                  'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
                  'transition-colors duration-150 touch-manipulation',
                  hasAdvancedFeatures &&
                    'text-primary-600 dark:text-primary-400',
                  showAdvanced && 'bg-gray-100 dark:bg-dark-300'
                )}
                title={t('chat.input.attachments')}
              >
                {hasAdvancedFeatures ? (
                  <div className='relative flex items-center justify-center'>
                    <Paperclip className='h-4 w-4' />
                    <div className='absolute -top-0.5 -right-0.5 h-2 w-2 bg-primary-500 dark:bg-primary-400 rounded-full ring-2 ring-white dark:ring-dark-50' />
                  </div>
                ) : showAdvanced ? (
                  <Minus className='h-4 w-4' />
                ) : (
                  <Plus className='h-4 w-4' />
                )}
              </Button>

              {/* Text Input Area */}
              <div className='flex-1 min-w-0'>
                <CodeAwareTextarea
                  ref={textareaRef}
                  value={message}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setMessage(e.target.value)
                  }
                  onKeyDown={handleKeyDown}
                  placeholder={t('chat.input.placeholder')}
                  disabled={disabled}
                  className='!m-0 min-h-[40px] max-h-[160px] resize-none !rounded-none !border-0 !bg-transparent !p-2 !shadow-none scrollbar-thin scrollbar-thumb-gray-300 placeholder:text-gray-400 focus:!border-0 focus:!bg-transparent focus:!shadow-none focus:!ring-0 dark:scrollbar-thumb-dark-400 dark:placeholder:text-dark-500 text-base leading-relaxed touch-manipulation'
                  rows={1}
                />
              </div>

              {/* Integrated Controls Row */}
              <div className='flex flex-shrink-0 items-center gap-1 sm:gap-2'>
                {/* Model Selector - Integrated */}
                {currentSession && models.length > 0 && (
                  <div className='hidden sm:block'>
                    <ModelSelector
                      models={models}
                      selectedModel={
                        currentSession.personaId
                          ? `persona:${currentSession.personaId}`
                          : currentSession.model
                      }
                      onModelChange={handleModelOrPersonaChange}
                      currentPersona={currentPersona}
                      className='min-w-[150px] max-w-[230px]'
                      compact
                      showImageGen={hasImageGenPlugins}
                    />
                  </div>
                )}

                {/* Send/Stop Button - Integrated Right */}
                {isGenerating ? (
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={handleStopGeneration}
                    className={cn(
                      'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                      'bg-red-50 dark:bg-red-900/20',
                      'text-red-500 dark:text-red-400',
                      'hover:bg-red-100 dark:hover:bg-red-900/30',
                      'transition-colors duration-150 touch-manipulation'
                    )}
                    title={t('chat.input.stopGeneration')}
                  >
                    <Square className='h-4 w-4' />
                  </Button>
                ) : (
                  <Button
                    type='submit'
                    variant='ghost'
                    size='sm'
                    disabled={!message.trim() || disabled}
                    className={cn(
                      'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
                      'bg-gray-100 text-gray-400 dark:bg-dark-300 dark:text-dark-500',
                      'disabled:cursor-not-allowed disabled:opacity-70',
                      'transition-colors duration-150 touch-manipulation',
                      message.trim() &&
                        !disabled && [
                          'bg-gray-950 text-white hover:bg-gray-800',
                          'dark:bg-white dark:text-gray-950 dark:hover:bg-gray-100',
                          'shadow-sm',
                        ]
                    )}
                    title={t('chat.input.sendMessage')}
                  >
                    <Send className='h-4 w-4' />
                  </Button>
                )}
              </div>
            </div>
          </form>

          {/* Mobile-only Model Selector */}
          {currentSession && models.length > 0 && (
            <div className='mt-3 sm:hidden'>
              <ModelSelector
                models={models}
                selectedModel={
                  currentSession.personaId
                    ? `persona:${currentSession.personaId}`
                    : currentSession.model
                }
                onModelChange={handleModelOrPersonaChange}
                currentPersona={currentPersona}
                className='w-full'
                compact
                showImageGen={hasImageGenPlugins}
              />
            </div>
          )}

          <div className='mt-2 flex min-h-4 items-center justify-center gap-2 text-[10px] text-gray-400 dark:text-dark-500'>
            <DocumentIndicator sessionId={currentSession?.id} />
            <div className='text-center leading-relaxed'>
              <span>{t('chat.footer.disclaimer')}</span>
              {hasAdvancedFeatures && (
                <span className='ml-2 text-primary-600 dark:text-primary-400'>
                  •{' '}
                  {images.length > 0 &&
                    t('chat.footer.images', { count: images.length })}
                  {images.length > 0 && format && ' • '}
                  {format && t('chat.footer.structuredOutput')}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
