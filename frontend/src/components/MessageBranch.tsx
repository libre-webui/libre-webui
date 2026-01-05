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
import { ChatMessage } from '@/components/ChatMessage';
import { cn } from '@/utils';
import { GitBranch, Check } from 'lucide-react';

interface MessageBranchProps {
  messages: ChatMessageType[]; // All variants of a message (branches)
  isStreaming?: boolean;
  streamingMessage?: string;
  streamingMessageId?: string; // ID of the message being streamed
  isLastAssistantMessage?: boolean;
  onRegenerate?: () => void;
  onSelectBranch?: (messageId: string) => void;
  className?: string;
}

export const MessageBranch: React.FC<MessageBranchProps> = ({
  messages,
  isStreaming = false,
  streamingMessage,
  streamingMessageId,
  isLastAssistantMessage = false,
  onRegenerate,
  onSelectBranch,
  className,
}) => {
  // If there's only one message, render it normally
  if (messages.length === 1) {
    const message = messages[0];
    const isThisMessageStreaming =
      isStreaming && streamingMessageId === message.id;
    const displayMessage =
      isThisMessageStreaming && streamingMessage
        ? { ...message, content: streamingMessage }
        : message;

    return (
      <ChatMessage
        message={displayMessage}
        isStreaming={isThisMessageStreaming}
        isLastAssistantMessage={isLastAssistantMessage}
        onRegenerate={onRegenerate}
        className={className}
      />
    );
  }

  // Multiple messages - render side by side as branches
  return (
    <div className={cn('relative py-1', className)}>
      {/* Branch indicator - minimal */}
      <div className='flex items-center gap-1.5 px-4 pb-2 text-[10px] text-gray-400 dark:text-gray-500 ophelia:text-[#525252]'>
        <GitBranch className='h-3 w-3' />
        <span>{messages.length} variants</span>
      </div>

      {/* Branch container */}
      <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 px-4'>
        {messages.map((message, index) => {
          const isActive = message.isActive !== false;
          const isThisMessageStreaming =
            isStreaming && streamingMessageId === message.id;
          const displayMessage =
            isThisMessageStreaming && streamingMessage
              ? { ...message, content: streamingMessage }
              : message;

          return (
            <div
              key={message.id}
              className={cn(
                'relative rounded-lg overflow-hidden transition-all duration-200',
                'border shadow-sm',
                isActive || isThisMessageStreaming
                  ? 'border-primary-300 dark:border-primary-600 ophelia:border-[#7c3aed] shadow-primary-100 dark:shadow-primary-900/20 ophelia:shadow-[#9333ea]/10'
                  : 'border-gray-200 dark:border-dark-300 ophelia:border-[#262626] hover:border-gray-300 dark:hover:border-dark-400 ophelia:hover:border-[#3f3f46]',
                !isActive &&
                  !isThisMessageStreaming &&
                  'cursor-pointer hover:shadow-md'
              )}
              onClick={() =>
                !isActive &&
                !isThisMessageStreaming &&
                onSelectBranch?.(message.id)
              }
            >
              {/* Branch header */}
              <div
                className={cn(
                  'flex items-center justify-between px-2.5 py-1 text-[11px]',
                  isActive || isThisMessageStreaming
                    ? 'bg-primary-50/80 dark:bg-primary-900/20 ophelia:bg-[#9333ea]/10 text-primary-600 dark:text-primary-400 ophelia:text-[#c084fc]'
                    : 'bg-gray-50/80 dark:bg-dark-100/80 ophelia:bg-[#121212]/80 text-gray-500 dark:text-gray-500 ophelia:text-[#737373]'
                )}
              >
                <div className='flex items-center gap-1.5'>
                  <span className='font-medium'>{index + 1}</span>
                  {isThisMessageStreaming && (
                    <span className='text-[10px] opacity-70 animate-pulse'>
                      generating...
                    </span>
                  )}
                </div>
                {isActive && !isThisMessageStreaming && (
                  <Check className='h-3 w-3' />
                )}
                {!isActive && !isThisMessageStreaming && (
                  <span className='text-[10px] opacity-50'>select</span>
                )}
              </div>

              {/* Message content */}
              <div
                className={cn(
                  'bg-white dark:bg-dark-50 ophelia:bg-[#0a0a0a]',
                  !isActive && !isThisMessageStreaming && 'opacity-80'
                )}
              >
                <ChatMessage
                  message={displayMessage}
                  isStreaming={isThisMessageStreaming}
                  isLastAssistantMessage={
                    isLastAssistantMessage &&
                    (isActive || isThisMessageStreaming)
                  }
                  onRegenerate={
                    isActive && !isStreaming ? onRegenerate : undefined
                  }
                  className='!bg-transparent !p-3 !text-sm'
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MessageBranch;
