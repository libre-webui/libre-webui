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
import { GitBranch } from 'lucide-react';

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
    <div className={cn('relative', className)}>
      {/* Branch indicator */}
      <div className='flex items-center gap-2 px-4 py-2 text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
        <GitBranch className='h-3.5 w-3.5' />
        <span>{messages.length} response variants</span>
      </div>

      {/* Branch container - horizontal scroll on mobile, grid on desktop */}
      <div className='flex flex-col md:flex-row gap-3 px-4 overflow-x-auto md:overflow-visible pb-2'>
        {messages.map((message, index) => {
          const isActive = message.isActive !== false;
          // Check if THIS specific message is being streamed (by ID)
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
                'flex-shrink-0 md:flex-1 min-w-[280px] md:min-w-0 rounded-xl border-2 transition-all cursor-pointer',
                isActive || isThisMessageStreaming
                  ? 'border-primary-400 dark:border-primary-500 ophelia:border-[#9333ea] bg-white dark:bg-dark-50 ophelia:bg-[#0a0a0a]'
                  : 'border-gray-200 dark:border-dark-300 ophelia:border-[#262626] bg-gray-50/50 dark:bg-dark-100/50 ophelia:bg-[#0a0a0a]/50 opacity-75 hover:opacity-100 hover:border-gray-300 dark:hover:border-dark-400 ophelia:hover:border-[#3f3f46]'
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
                  'flex items-center justify-between px-3 py-1.5 border-b text-xs',
                  isActive || isThisMessageStreaming
                    ? 'border-primary-200 dark:border-primary-800 ophelia:border-[#7c3aed]/30 bg-primary-50 dark:bg-primary-900/20 ophelia:bg-[#9333ea]/10 text-primary-700 dark:text-primary-300 ophelia:text-[#c084fc]'
                    : 'border-gray-200 dark:border-dark-300 ophelia:border-[#262626] bg-gray-100 dark:bg-dark-200 ophelia:bg-[#121212] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'
                )}
              >
                <span className='font-medium'>
                  Variant {index + 1}
                  {isThisMessageStreaming && ' (generating...)'}
                  {isActive && !isThisMessageStreaming && ' (active)'}
                </span>
                {!isActive && !isThisMessageStreaming && (
                  <span className='text-[10px] opacity-70'>
                    Click to select
                  </span>
                )}
              </div>

              {/* Message content */}
              <div className='p-0'>
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
                  className='!bg-transparent !p-4'
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
