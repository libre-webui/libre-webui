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

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ChatMessage as ChatMessageType } from '@/types';
import { MessageContent } from '@/components/ui';
import { GenerationStats } from '@/components/GenerationStats';
import { ArtifactContainer } from '@/components/ArtifactContainer';
import { TTSButton } from '@/components/TTSButton';
import { formatTimestamp, cn, parseThinkingContent } from '@/utils';
import { parseArtifacts } from '@/utils/artifactParser';
import { ttsApi } from '@/utils/api';
import {
  User,
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
  const [parsedContent, setParsedContent] = useState(message.content);
  const [isSystemMessageExpanded, setIsSystemMessageExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState(message.artifacts || []);
  const [thinkingContent, setThinkingContent] = useState<string | null>(null);
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
      console.error('Failed to copy message:', err);
    }
  };

  // Parse thinking content and artifacts from message content on mount or when content changes
  useEffect(() => {
    if (!isUser && !isSystem && message.content) {
      // First, parse thinking content
      const thinkingParsed = parseThinkingContent(message.content);
      setThinkingContent(thinkingParsed.thinking);

      const contentAfterThinking = thinkingParsed.content;

      // Use existing artifacts from the message if available
      if (message.artifacts && message.artifacts.length > 0) {
        setParsedContent(contentAfterThinking);
        setArtifacts(message.artifacts);
      } else if (!isStreaming) {
        // Only parse when not streaming to avoid duplicates
        const parsed = parseArtifacts(contentAfterThinking);
        setParsedContent(parsed.content);
        setArtifacts(parsed.artifacts);
      } else {
        // During streaming, just show the content without parsing
        setParsedContent(contentAfterThinking);
        setArtifacts([]);
      }
    }
  }, [message.content, message.artifacts, isUser, isSystem, isStreaming]);

  // Parse artifacts when streaming completes
  useEffect(() => {
    if (!isUser && !isSystem && message.content && !isStreaming) {
      // Parse thinking content first
      const thinkingParsed = parseThinkingContent(message.content);
      setThinkingContent(thinkingParsed.thinking);

      const contentAfterThinking = thinkingParsed.content;

      // Parse artifacts when streaming finishes
      if (!message.artifacts || message.artifacts.length === 0) {
        const parsed = parseArtifacts(contentAfterThinking);
        setParsedContent(parsed.content);
        setArtifacts(parsed.artifacts);
      }
    }
  }, [isStreaming, message.content, message.artifacts, isUser, isSystem]);

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
          const response = await ttsApi.generateBase64({
            model: preferences.ttsSettings?.model || 'tts-1',
            input: parsedContent,
            voice: preferences.ttsSettings?.voice || 'alloy',
            speed: preferences.ttsSettings?.speed || 1.0,
            response_format: 'mp3',
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
          console.error('Auto-play TTS failed:', error);
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
    if (isSystem) return 'System';
    if (isUser) {
      if (preferences.showUsername && user?.username) {
        return user.username;
      }
      return 'You';
    }
    // For assistant messages, use persona name if available, otherwise model name
    if (currentPersona?.name) {
      return currentPersona.name;
    }
    return message.model || 'Assistant';
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
      console.log('✅ System message updated:', editedContent);
    } catch (error) {
      console.error('Failed to save system message:', error);
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
        'flex transition-colors group my-2',
        isUser ? 'justify-end' : 'justify-start',
        className
      )}
    >
      <div
        className={cn(
          'flex gap-3 sm:gap-4',
          isUser
            ? 'flex-row-reverse max-w-[85%] sm:max-w-[75%]'
            : isSystem
              ? 'w-full'
              : 'max-w-[85%] sm:max-w-[75%]'
        )}
      >
        {/* Avatar - hidden for system messages */}
        {!isSystem && (
          <div
            className={cn(
              'flex shrink-0 items-start justify-center rounded-full shadow-sm overflow-hidden mt-1',
              isUser
                ? 'h-8 w-8 bg-primary-600 ophelia:bg-[#9333ea] text-white'
                : 'h-8 w-8 bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]'
            )}
          >
            {isUser ? (
              user?.avatar ? (
                <img
                  src={user.avatar}
                  alt={user.username}
                  className='w-full h-full object-cover'
                />
              ) : (
                <User className='h-4 w-4' />
              )
            ) : currentPersona?.avatar ? (
              <img
                src={currentPersona.avatar}
                alt={currentPersona.name || 'Assistant'}
                className='w-full h-full object-cover'
              />
            ) : (
              <span className='libre-brand text-sm text-gray-700 dark:text-gray-200 ophelia:text-[#e5e5e5]'>
                L
              </span>
            )}
          </div>
        )}
        {/* Content */}
        <div
          className={cn(
            'flex-1 min-w-0 rounded-2xl sm:rounded-3xl p-4 sm:p-5',
            isUser
              ? 'bg-primary-600/90 dark:bg-primary-700/90 ophelia:bg-[#9333ea]/90 text-white'
              : isSystem
                ? 'bg-transparent p-2 py-3'
                : 'bg-white/95 dark:bg-dark-100/95 ophelia:bg-[#0a0a0a]/95 backdrop-blur-md shadow-sm border border-gray-200/50 dark:border-dark-300/50 ophelia:border-[#262626]/60'
          )}
        >
          {/* Header - hide for system messages as they have their own label */}
          {!isSystem && (
            <div
              className={cn(
                'flex items-center gap-3 mb-2',
                isUser && 'flex-row-reverse'
              )}
            >
              <span
                className={cn(
                  'text-sm font-semibold',
                  isUser
                    ? 'text-white/90'
                    : 'text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'
                )}
              >
                {getDisplayName()}
              </span>
              {message.model && !isUser && currentPersona?.name && (
                <span
                  className='text-xs text-gray-500 dark:text-dark-600 ophelia:text-[#737373] bg-gray-100 dark:bg-dark-200 ophelia:bg-[#121212] px-2 py-0.5 rounded-full truncate max-w-32 sm:max-w-48'
                  title={message.model}
                >
                  {message.model}
                </span>
              )}
              <span
                className={cn(
                  'text-xs',
                  isUser
                    ? 'text-white/60'
                    : 'text-gray-400 dark:text-dark-500 ophelia:text-[#525252]'
                )}
              >
                {formatTimestamp(message.timestamp)}
              </span>
              {/* TTS Button for assistant messages */}
              {!isUser && !isSystem && !isStreaming && parsedContent && (
                <TTSButton
                  text={parsedContent}
                  size='sm'
                  className={cn(
                    'transition-opacity',
                    isAutoPlaying
                      ? 'opacity-100 text-primary-600 dark:text-primary-400'
                      : 'opacity-0 group-hover:opacity-100'
                  )}
                />
              )}
              {/* Copy Button for all messages */}
              {!isSystem && !isStreaming && (
                <button
                  onClick={handleCopyMessage}
                  className='p-1 rounded hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[rgba(147,51,234,0.2)] transition-opacity opacity-0 group-hover:opacity-100'
                  title={isCopied ? 'Copied!' : 'Copy message'}
                >
                  {isCopied ? (
                    <Check className='h-3.5 w-3.5 text-green-500 dark:text-green-400' />
                  ) : (
                    <Copy className='h-3.5 w-3.5 text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3]' />
                  )}
                </button>
              )}
              {/* Regenerate Button for last assistant message */}
              {!isUser &&
                !isSystem &&
                !isStreaming &&
                isLastAssistantMessage &&
                onRegenerate && (
                  <button
                    onClick={onRegenerate}
                    className='p-1 rounded hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[rgba(147,51,234,0.2)] transition-opacity opacity-0 group-hover:opacity-100'
                    title='Regenerate response'
                  >
                    <RefreshCw className='h-3.5 w-3.5 text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3]' />
                  </button>
                )}
            </div>
          )}

          <div
            className={cn(
              isUser
                ? 'text-white'
                : 'text-gray-700 dark:text-dark-700 ophelia:text-[#e5e5e5]'
            )}
          >
            {/* Display images if present (for user messages) */}
            {message.images && message.images.length > 0 && (
              <div className='mb-3 grid grid-cols-2 sm:grid-cols-3 gap-2 max-w-lg'>
                {message.images.map((image, index) => (
                  <div
                    key={index}
                    className='aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
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
              <p className='whitespace-pre-wrap leading-relaxed'>
                {message.content}
              </p>
            ) : isSystem ? (
              <div className='bg-gray-50/30 dark:bg-dark-50/30 ophelia:bg-[rgba(5,5,5,0.8)] rounded-md p-2 border border-gray-100/50 dark:border-dark-200/50 ophelia:border-[rgba(26,26,26,0.5)] relative z-0'>
                <div className='text-xs font-medium mb-1 text-gray-500 dark:text-gray-400 ophelia:text-[#737373] flex items-center justify-between'>
                  <div className='flex items-center gap-1'>
                    <Settings className='h-2.5 w-2.5 opacity-50' />
                    System
                  </div>
                  <div className='flex items-center gap-1'>
                    {isEditing ? (
                      <>
                        <button
                          onClick={handleSaveSystemMessage}
                          disabled={isSaving}
                          className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[rgba(147,51,234,0.2)] rounded transition-colors disabled:opacity-50'
                          title='Save changes'
                        >
                          <Save className='h-3 w-3 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
                        </button>
                        <button
                          onClick={handleCancelEdit}
                          disabled={isSaving}
                          className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[rgba(239,68,68,0.15)] rounded transition-colors disabled:opacity-50'
                          title='Cancel editing'
                        >
                          <X className='h-3 w-3 text-red-600 dark:text-red-400 ophelia:text-[#f87171]' />
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleEditSystemMessage}
                        className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[rgba(147,51,234,0.2)] rounded transition-colors'
                        title='Edit system message'
                      >
                        <Edit3 className='h-3 w-3 text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3] ophelia:hover:text-[#c084fc]' />
                      </button>
                    )}
                  </div>
                </div>
                {isEditing ? (
                  <textarea
                    value={editedContent}
                    onChange={e => setEditedContent(e.target.value)}
                    className='w-full min-h-[100px] p-3 text-sm text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] bg-gray-50 dark:bg-dark-50 ophelia:bg-[#0a0a0a] border border-gray-200 dark:border-dark-300 ophelia:border-[#262626] rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 ophelia:focus:ring-[#a855f7] focus:border-transparent'
                    placeholder='Enter your system message...'
                    disabled={isSaving}
                  />
                ) : (
                  <div>
                    <p className='whitespace-pre-wrap leading-relaxed text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
                      {isSystemMessageExpanded
                        ? message.content
                        : truncateSystemMessage(message.content)}
                    </p>
                    {shouldShowExpandButton && (
                      <button
                        onClick={() =>
                          setIsSystemMessageExpanded(!isSystemMessageExpanded)
                        }
                        className='mt-1 flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 ophelia:text-[#737373] hover:text-primary-600 dark:hover:text-primary-400 ophelia:hover:text-[#c084fc] transition-colors'
                      >
                        {isSystemMessageExpanded ? (
                          <>
                            <ChevronUp className='h-3 w-3' />
                            Show less
                          </>
                        ) : (
                          <>
                            <ChevronDown className='h-3 w-3' />
                            Show more
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
                  <div className='mb-3'>
                    <button
                      onClick={() => setIsThinkingExpanded(!isThinkingExpanded)}
                      className='flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3] hover:text-primary-600 dark:hover:text-primary-400 ophelia:hover:text-[#c084fc] transition-colors'
                    >
                      <Brain className='h-4 w-4' />
                      <span className='font-medium'>Thinking</span>
                      {isThinkingExpanded ? (
                        <ChevronUp className='h-4 w-4' />
                      ) : (
                        <ChevronDown className='h-4 w-4' />
                      )}
                    </button>
                    {isThinkingExpanded && (
                      <div className='mt-2 p-3 bg-gray-50 dark:bg-dark-100 ophelia:bg-[#0a0a0a] rounded-lg border border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'>
                        <p className='text-sm text-gray-600 dark:text-gray-300 ophelia:text-[#a3a3a3] whitespace-pre-wrap leading-relaxed'>
                          {thinkingContent}
                        </p>
                      </div>
                    )}
                  </div>
                )}
                <MessageContent content={parsedContent} />
                {isStreaming && (
                  <div className='inline-block w-2 h-5 bg-primary-500 animate-pulse ml-1 rounded-sm' />
                )}
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
          </div>
        </div>
      </div>

      {/* Image Lightbox Modal - rendered via portal to escape stacking context */}
      {lightboxImage &&
        createPortal(
          <div
            className='fixed inset-0 z-[9999] flex items-center justify-center bg-black/80 backdrop-blur-sm'
            onClick={() => setLightboxImage(null)}
          >
            <button
              className='absolute top-6 right-6 p-3 bg-white/20 hover:bg-white/40 rounded-full text-white transition-all shadow-lg border border-white/30'
              onClick={e => {
                e.stopPropagation();
                setLightboxImage(null);
              }}
            >
              <X className='h-7 w-7' />
            </button>
            <img
              src={lightboxImage}
              alt='Full size image'
              className='max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl'
              onClick={e => e.stopPropagation()}
            />
          </div>,
          document.body
        )}
    </div>
  );
};
