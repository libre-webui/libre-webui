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

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChatMessage as ChatMessageType } from '@/types';
import { MessageContent } from '@/components/ui';
import { GenerationStats } from '@/components/GenerationStats';
import { ArtifactContainer } from '@/components/ArtifactContainer';
import { TTSButton } from '@/components/TTSButton';
import { formatTimestamp, cn, parseThinkingContent } from '@/utils';
import { parseArtifacts } from '@/utils/artifactParser';
import { findTTSModel, resolveTTSModel, ttsApi } from '@/utils/api';
import {
  Settings,
  Edit3,
  Save,
  X,
  ChevronDown,
  ChevronUp,
  Brain,
  RefreshCw,
  Copy,
  Check,
} from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:chat-message');

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  className?: string;
  isLastAssistantMessage?: boolean;
  onRegenerate?: () => void;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  isStreaming = false,
  className,
  isLastAssistantMessage = false,
  onRegenerate,
}) => {
  const { t, i18n } = useTranslation();
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const { preferences } = useAppStore();
  const { user } = useAuthStore();
  const { setSystemMessage, getCurrentPersona } = useChatStore();
  const currentPersona = getCurrentPersona();
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSystemMessageExpanded, setIsSystemMessageExpanded] = useState(false);
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [isAutoPlaying, setIsAutoPlaying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const autoPlayAudioRef = useRef<HTMLAudioElement | null>(null);
  const wasStreamingRef = useRef(isStreaming);
  const hasAutoPlayedRef = useRef(false);

  const handleCopyMessage = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      logger.error('Failed to copy message:', err);
    }
  };

  // Derive thinking content, parsed content, and artifacts from message content
  const { thinkingContent, parsedContent, artifacts } = useMemo(() => {
    if (isUser || isSystem || !message.content) {
      return {
        thinkingContent: null as string | null,
        parsedContent: message.content,
        artifacts: message.artifacts || [],
      };
    }

    const thinkingParsed = parseThinkingContent(message.content);
    const contentAfterThinking = thinkingParsed.content;

    if (message.artifacts && message.artifacts.length > 0) {
      return {
        thinkingContent: thinkingParsed.thinking,
        parsedContent: contentAfterThinking,
        artifacts: message.artifacts,
      };
    }

    if (!isStreaming) {
      const parsed = parseArtifacts(contentAfterThinking);
      return {
        thinkingContent: thinkingParsed.thinking,
        parsedContent: parsed.content,
        artifacts: parsed.artifacts,
      };
    }

    return {
      thinkingContent: thinkingParsed.thinking,
      parsedContent: contentAfterThinking,
      artifacts: [],
    };
  }, [message.content, message.artifacts, isUser, isSystem, isStreaming]);

  // Auto-play TTS when streaming completes (if enabled)
  useEffect(() => {
    // Check if streaming just completed (was streaming, now not streaming)
    const streamingJustCompleted = wasStreamingRef.current && !isStreaming;
    wasStreamingRef.current = isStreaming;

    // Only auto-play once per message
    if (
      streamingJustCompleted &&
      !hasAutoPlayedRef.current &&
      !isUser &&
      !isSystem &&
      parsedContent &&
      preferences.ttsSettings?.enabled &&
      preferences.ttsSettings?.autoPlay
    ) {
      hasAutoPlayedRef.current = true;

      // Auto-play the message (parsedContent already has thinking removed)
      const playMessage = async () => {
        setIsAutoPlaying(true);
        try {
          const modelsResponse = await ttsApi.getModels();
          const availableModels =
            modelsResponse.success && modelsResponse.data
              ? modelsResponse.data
              : [];
          const savedSettings = preferences.ttsSettings;
          const selectedModel = resolveTTSModel(
            availableModels,
            savedSettings?.model,
            savedSettings?.pluginId
          );
          const savedSelection = findTTSModel(
            availableModels,
            savedSettings?.model,
            savedSettings?.pluginId
          );

          const response = await ttsApi.generateBase64({
            model: selectedModel?.model || savedSettings?.model || 'tts-1',
            pluginId: selectedModel?.plugin || savedSettings?.pluginId,
            input: parsedContent,
            voice: savedSelection
              ? savedSettings?.voice ||
                selectedModel?.config?.default_voice ||
                'alloy'
              : selectedModel?.config?.default_voice || 'alloy',
            speed: savedSettings?.speed || 1.0,
            response_format: selectedModel?.config?.default_format,
          });

          if (response.success && response.data?.audio) {
            const audioUrl = `data:${response.data.mimeType};base64,${response.data.audio}`;
            const audio = new Audio(audioUrl);
            autoPlayAudioRef.current = audio;

            audio.onended = () => {
              setIsAutoPlaying(false);
              autoPlayAudioRef.current = null;
            };

            audio.onerror = () => {
              setIsAutoPlaying(false);
              autoPlayAudioRef.current = null;
            };

            await audio.play();
          }
        } catch (error) {
          logger.error('Auto-play TTS failed:', error);
          setIsAutoPlaying(false);
        }
      };

      playMessage();
    }

    // Cleanup on unmount
    return () => {
      if (autoPlayAudioRef.current) {
        autoPlayAudioRef.current.pause();
        autoPlayAudioRef.current = null;
      }
    };
  }, [isStreaming, isUser, isSystem, parsedContent, preferences.ttsSettings]);

  // Determine display name for messages
  const getDisplayName = () => {
    if (isSystem) return t('chatMessage.system');
    if (isUser) {
      if (preferences.showUsername && user?.username) {
        return user.username;
      }
      return t('chatMessage.you');
    }
    // For assistant messages, use persona name if available, otherwise model name
    if (currentPersona?.name) {
      return currentPersona.name;
    }
    return message.model || t('chatMessage.assistant');
  };

  const handleEditSystemMessage = () => {
    setIsEditing(true);
    setEditedContent(message.content);
  };

  const handleSaveSystemMessage = async () => {
    setIsSaving(true);
    try {
      setSystemMessage(editedContent);
      setIsEditing(false);
      logger.debug('✅ System message updated:', editedContent);
    } catch (error) {
      logger.error('Failed to save system message:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedContent(message.content);
  };

  // Helper function to truncate system message for display
  const truncateSystemMessage = (content: string, maxLength: number = 100) => {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  };

  // Determine if system message should show expand/collapse button
  const shouldShowExpandButton = isSystem && message.content.length > 100;

  return (
    <div
      className={cn(
        'group flex py-3 transition-colors sm:py-4',
        isUser ? 'justify-end' : 'justify-start',
        className
      )}
    >
      <div
        className={cn(
          'flex min-w-0',
          isUser ? 'max-w-[88%] sm:max-w-[72%]' : isSystem ? 'w-full' : 'w-full'
        )}
      >
        {/* Content */}
        <div
          className={cn(
            'min-w-0 flex-1',
            isUser
              ? 'rounded-[1.35rem] rounded-ee-md border border-black/[0.06] bg-gray-900 px-4 py-3 text-white shadow-sm dark:border-white/[0.07] dark:bg-dark-300'
              : isSystem
                ? 'bg-transparent py-2'
                : 'bg-transparent py-1'
          )}
        >
          {/* Header - hide for system messages as they have their own label */}
          {!isSystem && (
            <div
              className={cn(
                'mb-2 flex items-center gap-2.5',
                isUser && 'justify-end'
              )}
            >
              <span
                dir='auto'
                className={cn(
                  'text-[11px] font-semibold uppercase tracking-[0.1em] rtl:tracking-normal',
                  isUser ? 'text-white/70' : 'text-gray-700 dark:text-dark-700'
                )}
              >
                {getDisplayName()}
              </span>
              {message.model && !isUser && currentPersona?.name && (
                <span
                  dir='ltr'
                  className='max-w-32 truncate rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-dark-200 dark:text-dark-600 sm:max-w-48'
                  title={message.model}
                >
                  {message.model}
                </span>
              )}
              <span
                dir='auto'
                className={cn(
                  'text-[10px] tabular-nums',
                  isUser ? 'text-white/45' : 'text-gray-400 dark:text-dark-500'
                )}
              >
                {formatTimestamp(message.timestamp, i18n.language)}
              </span>
            </div>
          )}

          <div
            className={cn(
              isUser
                ? 'text-[15px] text-white'
                : 'text-[15px] leading-7 text-gray-800 dark:text-dark-800 sm:text-base'
            )}
          >
            {/* Display images if present (for user messages) */}
            {message.images && message.images.length > 0 && (
              <div className='mb-3 grid max-w-lg grid-cols-2 gap-2 sm:grid-cols-3'>
                {message.images.map((image, index) => (
                  <div
                    key={index}
                    className='aspect-square overflow-hidden rounded-xl border border-white/10 bg-gray-100 dark:bg-gray-800'
                  >
                    <img
                      src={image}
                      alt={`Uploaded image ${index + 1}`}
                      className='w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity'
                      onClick={() => setLightboxImage(image)}
                    />
                  </div>
                ))}
              </div>
            )}

            {isUser ? (
              <p dir='auto' className='whitespace-pre-wrap leading-relaxed'>
                {message.content}
              </p>
            ) : isSystem ? (
              <div className='relative z-0 rounded-2xl border border-black/[0.06] bg-white/55 p-3 dark:border-white/[0.06] dark:bg-dark-200/45'>
                <div className='mb-2 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-gray-500 dark:text-dark-500'>
                  <div className='flex items-center gap-1'>
                    <Settings className='h-2.5 w-2.5 opacity-50' />
                    {t('chatMessage.system')}
                  </div>
                  <div className='flex items-center gap-1'>
                    {isEditing ? (
                      <>
                        <button
                          onClick={handleSaveSystemMessage}
                          disabled={isSaving}
                          className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-dark-300'
                          title={t('chatMessage.saveChanges')}
                        >
                          <Save className='h-3 w-3 text-green-600 dark:text-green-400' />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          disabled={isSaving}
                          className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-dark-300'
                          title={t('chatMessage.cancelEditing')}
                        >
                          <X className='h-3 w-3 text-red-600 dark:text-red-400' />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleEditSystemMessage}
                        className='rounded-lg p-1.5 transition-colors hover:bg-gray-100 dark:hover:bg-dark-300'
                        title={t('chatMessage.editSystemMessage')}
                      >
                        <Edit3 className='h-3 w-3 text-gray-600 dark:text-gray-400' />
                      </button>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <textarea
                    dir='auto'
                    value={editedContent}
                    onChange={e => setEditedContent(e.target.value)}
                    className='min-h-[100px] w-full resize-none rounded-xl border border-black/[0.08] bg-white p-3 text-sm text-gray-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary-500 dark:border-white/[0.08] dark:bg-dark-100 dark:text-dark-900 dark:focus:ring-primary-400'
                    placeholder={t('chatMessage.systemMessagePlaceholder')}
                    disabled={isSaving}
                  />
                ) : (
                  <div>
                    <p
                      dir='auto'
                      className='whitespace-pre-wrap text-xs leading-relaxed text-gray-500 dark:text-dark-600'
                    >
                      {isSystemMessageExpanded
                        ? message.content
                        : truncateSystemMessage(message.content)}
                    </p>
                    {shouldShowExpandButton && (
                      <button
                        onClick={() =>
                          setIsSystemMessageExpanded(!isSystemMessageExpanded)
                        }
                        className='mt-2 flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-900 dark:text-dark-500 dark:hover:text-dark-900'
                      >
                        {isSystemMessageExpanded ? (
                          <>
                            <ChevronUp className='h-3 w-3' />
                            {t('chatMessage.showLess')}
                          </>
                        ) : (
                          <>
                            <ChevronDown className='h-3 w-3' />
                            {t('chatMessage.showMore')}
                          </>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className='relative'>
                {/* Collapsible Thinking/CoT Section */}
                {thinkingContent && (
                  <div className='mb-4 border-s border-gray-200 ps-3 dark:border-dark-300'>
                    <button
                      onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                      className='flex items-center gap-2 text-xs text-gray-500 transition-colors hover:text-gray-900 dark:text-dark-600 dark:hover:text-dark-900'
                    >
                      <Brain className='h-4 w-4' />
                      <span className='font-medium'>
                        {t('chatMessage.thinking')}
                      </span>
                      {isThinkingExpanded ? (
                        <ChevronUp className='h-4 w-4' />
                      ) : (
                        <ChevronDown className='h-4 w-4' />
                      )}
                    </button>
                    {isThinkingExpanded && (
                      <div className='mt-3 rounded-xl bg-gray-100/60 p-3 dark:bg-dark-200/60'>
                        <p
                          dir='auto'
                          className='whitespace-pre-wrap text-sm leading-relaxed text-gray-600 dark:text-dark-700'
                        >
                          {thinkingContent}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                <MessageContent
                  content={parsedContent}
                  isStreaming={isStreaming}
                />
              </div>
            )}

            {/* Render artifacts for assistant messages */}
            {!isUser && !isSystem && artifacts.length > 0 && (
              <div className='mt-4'>
                <ArtifactContainer artifacts={artifacts} />
              </div>
            )}

            {/* Display generation statistics for assistant messages */}
            {!isUser && !isSystem && message.statistics && (
              <div className='mt-3'>
                <GenerationStats statistics={message.statistics} />
              </div>
            )}

            {/* Persistent, quiet action row for completed messages */}
            {!isSystem && !isStreaming && (
              <div
                className={cn(
                  'mt-3 flex items-center gap-1',
                  isUser
                    ? 'justify-end border-t border-white/10 pt-2 text-white/65'
                    : 'text-gray-400 dark:text-dark-500'
                )}
              >
                {!isUser && parsedContent && (
                  <TTSButton
                    text={parsedContent}
                    size='sm'
                    className={cn(
                      'transition-colors',
                      isAutoPlaying &&
                        'bg-primary-50 text-primary-600 dark:bg-primary-900/20 dark:text-primary-400'
                    )}
                  />
                )}
                <button
                  onClick={handleCopyMessage}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                    isUser
                      ? 'hover:bg-white/10 hover:text-white'
                      : 'hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                  )}
                  title={
                    isCopied
                      ? t('chatMessage.copied')
                      : t('chatMessage.copyMessage')
                  }
                >
                  {isCopied ? (
                    <Check className='h-3.5 w-3.5 text-green-400' />
                  ) : (
                    <Copy className='h-3.5 w-3.5' />
                  )}
                </button>
                {!isUser && isLastAssistantMessage && onRegenerate && (
                  <button
                    onClick={onRegenerate}
                    className='flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-gray-100 hover:text-gray-800 dark:hover:bg-dark-200 dark:hover:text-dark-800'
                    title={t('chatMessage.regenerateResponse')}
                  >
                    <RefreshCw className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Image Lightbox Modal - rendered via portal to escape stacking context */}
      {lightboxImage &&
        createPortal(
          <div
            role='dialog'
            aria-modal='true'
            aria-label={t('chatMessage.fullSizeImage')}
            className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/85 p-6 backdrop-blur-md'
            onClick={() => setLightboxImage(null)}
          >
            <button
              className='absolute end-6 top-6 rounded-full border border-white/15 bg-white/10 p-3 text-white transition-colors hover:bg-white/20'
              onClick={e => {
                e.stopPropagation();
                setLightboxImage(null);
              }}
            >
              <X className='h-7 w-7' />
            </button>
            <img
              src={lightboxImage}
              alt={t('chatMessage.fullSizeImage')}
              className='max-h-[90vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl'
              onClick={e => e.stopPropagation()}
            />
          </div>,
          document.body
        )}
    </div>
  );
};
