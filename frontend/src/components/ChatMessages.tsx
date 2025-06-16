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

import React, { useEffect, useRef } from 'react';
import { ChatMessage } from '@/components/ChatMessage';
import { ChatMessage as ChatMessageType } from '@/types';
import { cn } from '@/utils';

interface ChatMessagesProps {
  messages: ChatMessageType[];
  streamingMessage?: string;
  isStreaming?: boolean;
  className?: string;
}

export const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  streamingMessage,
  isStreaming = false,
  className,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingMessage]);

  if (messages.length === 0 && !isStreaming) {
    return (
      <div
        className={cn(
          'flex-1 flex items-center justify-center p-4 sm:p-8',
          className
        )}
      >
        <div className='text-center text-gray-500 dark:text-dark-600 max-w-md'>
          <div className='text-5xl sm:text-7xl mb-4 sm:mb-6 opacity-60'>💬</div>
          <h3 className='text-lg sm:text-xl font-semibold mb-2 sm:mb-3 text-gray-700 dark:text-dark-700'>
            Start a conversation
          </h3>
          <p className='text-sm leading-relaxed px-4'>
            Send a message to begin chatting with your AI assistant. Ask
            questions, get help with code, or have a natural conversation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600',
        'scrollbar-track-transparent hover:scrollbar-thumb-gray-400 dark:hover:scrollbar-thumb-gray-500',
        className
      )}
    >
      <div className='max-w-4xl mx-auto px-4 sm:px-6'>
        {messages.map((message, index) => (
          <ChatMessage
            key={message.id}
            message={message}
            isStreaming={
              isStreaming && message === messages[messages.length - 1]
            }
            className={index === 0 ? 'mt-4 sm:mt-6' : ''}
          />
        ))}
        <div ref={messagesEndRef} className='h-4 sm:h-6' />
      </div>
    </div>
  );
};
