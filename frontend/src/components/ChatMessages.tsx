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

import React, { useEffect, useRef, useCallback } from 'react';
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
  const scrollTimeoutRef = useRef<NodeJS.Timeout>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef<boolean>(false);

  const scrollToBottom = useCallback(
    (force: boolean = false) => {
      // During streaming, always scroll to bottom unless explicitly prevented
      if (isStreaming || force) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        return;
      }

      // For non-streaming, respect user scroll position
      if (isUserScrolledUpRef.current) {
        return; // Don't auto-scroll if user has manually scrolled up
      }

      // Use throttled approach for normal scrolling
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      scrollTimeoutRef.current = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    },
    [isStreaming]
  );

  // Check if user has scrolled up manually - but only when not actively streaming
  const handleScroll = useCallback(() => {
    // Don't interfere with auto-scroll during active streaming
    if (isStreaming) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 20; // 20px threshold

    isUserScrolledUpRef.current = !isAtBottom;
  }, [isStreaming]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  // Enhanced streaming scroll - direct scroll manipulation for reliability
  useEffect(() => {
    if (isStreaming && streamingMessage) {
      // Use requestAnimationFrame for smooth, consistent scrolling
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    }
  }, [isStreaming, streamingMessage]);

  // Reset scroll tracking when streaming starts
  useEffect(() => {
    if (isStreaming) {
      isUserScrolledUpRef.current = false; // Allow auto-scroll during new streaming
    }
  }, [isStreaming]); // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

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
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className={cn(
        'flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600',
        'scrollbar-track-transparent hover:scrollbar-thumb-gray-400 dark:hover:scrollbar-thumb-gray-500',
        // Better mobile scrolling
        'overscroll-behavior-y-contain scroll-smooth',
        // iOS momentum scrolling
        '[-webkit-overflow-scrolling:touch]',
        className
      )}
      style={{
        // Ensure proper touch scrolling on mobile
        WebkitOverflowScrolling: 'touch',
        // Prevent rubber banding on iOS
        overscrollBehaviorY: 'contain',
      }}
    >
      <div className='max-w-4xl mx-auto px-3 sm:px-4 md:px-6'>
        {messages.map((message, index) => {
          const isLastMessage = index === messages.length - 1;
          const isStreamingThisMessage =
            isStreaming && isLastMessage && message.role === 'assistant';

          // For the last assistant message during streaming, use streamingMessage content
          const displayMessage =
            isStreamingThisMessage && streamingMessage
              ? { ...message, content: streamingMessage }
              : message;

          return (
            <ChatMessage
              key={message.id}
              message={displayMessage}
              isStreaming={isStreamingThisMessage}
              className={index === 0 ? 'mt-3 sm:mt-4 md:mt-6' : ''}
            />
          );
        })}
        <div ref={messagesEndRef} className='h-3 sm:h-4 md:h-6' />
      </div>
    </div>
  );
};
