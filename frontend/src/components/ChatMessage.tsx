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

import React, { useState, useEffect } from 'react';
import { ChatMessage as ChatMessageType } from '@/types';
import { MessageContent } from '@/components/ui';
import { GenerationStats } from '@/components/GenerationStats';
import { ArtifactContainer } from '@/components/ArtifactContainer';
import { formatTimestamp, cn } from '@/utils';
import { parseArtifacts } from '@/utils/artifactParser';
import {
  User,
  Bot,
  Settings,
  Edit3,
  Save,
  X,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  className?: string;
}

export const ChatMessage: React.FC<ChatMessageProps> = ({
  message,
  isStreaming = false,
  className,
}) => {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const { preferences } = useAppStore();
  const { user } = useAuthStore();
  const { setSystemMessage, getCurrentPersona } = useChatStore();
  const currentPersona = getCurrentPersona();
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(message.content);
  const [isSaving, setIsSaving] = useState(false);
  const [parsedContent, setParsedContent] = useState(message.content);
  const [isSystemMessageExpanded, setIsSystemMessageExpanded] = useState(false);
  const [artifacts, setArtifacts] = useState(message.artifacts || []);

  // Parse artifacts from message content on mount or when content changes
  useEffect(() => {
    if (!isUser && !isSystem && message.content) {
      // Use existing artifacts from the message if available
      if (message.artifacts && message.artifacts.length > 0) {
        setParsedContent(message.content);
        setArtifacts(message.artifacts);
      } else if (!isStreaming) {
        // Only parse when not streaming to avoid duplicates
        const parsed = parseArtifacts(message.content);
        setParsedContent(parsed.content);
        setArtifacts(parsed.artifacts);
      } else {
        // During streaming, just show the content without parsing
        setParsedContent(message.content);
        setArtifacts([]);
      }
    }
  }, [message.content, message.artifacts, isUser, isSystem, isStreaming]);

  // Parse artifacts when streaming completes
  useEffect(() => {
    if (!isUser && !isSystem && message.content && !isStreaming) {
      // Parse artifacts when streaming finishes
      if (!message.artifacts || message.artifacts.length === 0) {
        const parsed = parseArtifacts(message.content);
        setParsedContent(parsed.content);
        setArtifacts(parsed.artifacts);
      }
    }
  }, [isStreaming, message.content, message.artifacts, isUser, isSystem]);

  // Determine display name for messages
  const getDisplayName = () => {
    if (isSystem) return 'System';
    if (isUser) {
      if (preferences.showUsername && user?.username) {
        return user.username;
      }
      return 'You';
    }
    // For assistant messages, use persona name if available
    if (currentPersona?.name) {
      return currentPersona.name;
    }
    return 'Assistant';
  };

  const handleEditSystemMessage = () => {
    setIsEditing(true);
    setEditedContent(message.content);
  };

  const handleSaveSystemMessage = async () => {
    setIsSaving(true);
    try {
      await setSystemMessage(editedContent);
      setIsEditing(false);
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
        'flex gap-4 transition-colors group',
        isUser
          ? 'bg-transparent p-6'
          : isSystem
            ? 'bg-transparent p-2 py-3'
            : 'bg-gray-25 dark:bg-dark-100/50 p-6',
        className
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full shadow-sm overflow-hidden',
          isUser
            ? 'h-8 w-8 bg-primary-600 text-white'
            : isSystem
              ? 'h-5 w-5 bg-gray-400 dark:bg-gray-500 text-white'
              : 'h-8 w-8 bg-gray-700 text-white dark:bg-dark-600'
        )}
      >
        {isUser ? (
          <User className='h-4 w-4' />
        ) : isSystem ? (
          <Settings className='h-2.5 w-2.5' />
        ) : currentPersona?.avatar ? (
          <img
            src={currentPersona.avatar}
            alt={currentPersona.name || 'Assistant'}
            className='w-full h-full object-cover'
          />
        ) : (
          <Bot className='h-4 w-4' />
        )}
      </div>
      {/* Content */}
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-3 mb-2'>
          <span className='text-sm font-semibold text-gray-900 dark:text-dark-800'>
            {getDisplayName()}
          </span>
          {message.model && !isUser && !isSystem && (
            <span className='text-xs text-gray-500 dark:text-dark-600 bg-gray-100 dark:bg-dark-200 px-2 py-0.5 rounded-full'>
              {message.model}
            </span>
          )}
          <span className='text-xs text-gray-400 dark:text-dark-500'>
            {formatTimestamp(message.timestamp)}
          </span>
        </div>

        <div className='text-gray-700 dark:text-dark-700'>
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
                    onClick={() => {
                      // Open image in new tab for full view
                      const win = window.open();
                      if (win) {
                        win.document.write(
                          `<img src="${image}" style="max-width:100%; max-height:100vh; margin:auto; display:block;" />`
                        );
                      }
                    }}
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
            <div className='bg-gray-50/30 dark:bg-dark-50/30 rounded-md p-2 border border-gray-100/50 dark:border-dark-200/50'>
              <div className='text-xs font-medium mb-1 text-gray-500 dark:text-gray-400 flex items-center justify-between'>
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
                        className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 rounded transition-colors disabled:opacity-50'
                        title='Save changes'
                      >
                        <Save className='h-3 w-3 text-green-600 dark:text-green-400' />
                      </button>
                      <button
                        onClick={handleCancelEdit}
                        disabled={isSaving}
                        className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 rounded transition-colors disabled:opacity-50'
                        title='Cancel editing'
                      >
                        <X className='h-3 w-3 text-red-600 dark:text-red-400' />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={handleEditSystemMessage}
                      className='p-1 hover:bg-gray-100 dark:hover:bg-dark-200 rounded transition-colors'
                      title='Edit system message'
                    >
                      <Edit3 className='h-3 w-3 text-gray-600 dark:text-gray-400' />
                    </button>
                  )}
                </div>
              </div>
              {isEditing ? (
                <textarea
                  value={editedContent}
                  onChange={e => setEditedContent(e.target.value)}
                  className='w-full min-h-[100px] p-3 text-sm text-gray-900 dark:text-gray-100 bg-gray-50 dark:bg-dark-50 border border-gray-200 dark:border-dark-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400 focus:border-transparent'
                  placeholder='Enter your system message...'
                  disabled={isSaving}
                />
              ) : (
                <div>
                  <p className='whitespace-pre-wrap leading-relaxed text-xs text-gray-500 dark:text-gray-400'>
                    {isSystemMessageExpanded
                      ? message.content
                      : truncateSystemMessage(message.content)}
                  </p>
                  {shouldShowExpandButton && (
                    <button
                      onClick={() =>
                        setIsSystemMessageExpanded(!isSystemMessageExpanded)
                      }
                      className='mt-1 flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500 hover:text-primary-600 dark:hover:text-primary-400 transition-colors'
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
  );
};
