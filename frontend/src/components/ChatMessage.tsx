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

import React from 'react';
import { ChatMessage as ChatMessageType } from '@/types';
import { MessageContent } from '@/components/ui';
import { GenerationStats } from '@/components/GenerationStats';
import { formatTimestamp, cn } from '@/utils';
import { User, Bot } from 'lucide-react';

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

  return (
    <div
      className={cn(
        'flex gap-4 p-6 transition-colors group',
        isUser ? 'bg-transparent' : 'bg-gray-25 dark:bg-dark-100/50',
        className
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full shadow-sm',
          isUser
            ? 'bg-primary-600 text-white'
            : 'bg-gray-700 text-white dark:bg-dark-600'
        )}
      >
        {isUser ? <User className='h-4 w-4' /> : <Bot className='h-4 w-4' />}
      </div>

      {/* Content */}
      <div className='flex-1 min-w-0'>
        <div className='flex items-center gap-3 mb-2'>
          <span className='text-sm font-semibold text-gray-900 dark:text-dark-800'>
            {isUser ? 'You' : 'Assistant'}
          </span>
          {message.model && !isUser && (
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
          ) : (
            <div className='relative'>
              <MessageContent content={message.content} />
              {isStreaming && (
                <div className='inline-block w-2 h-5 bg-primary-500 animate-pulse ml-1 rounded-sm' />
              )}
            </div>
          )}

          {/* Display generation statistics for assistant messages */}
          {!isUser && message.statistics && (
            <div className='mt-3'>
              <GenerationStats statistics={message.statistics} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
