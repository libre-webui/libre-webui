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
  streamingThinking?: string;
  streamingMessageId?: string; // ID of the message being streamed
  isLastAssistantMessage?: boolean;
  onRegenerate?: () => void;
  onSelectBranch?: (messageId: string) => void;
  className?: string;
}

const MessageBranchBase: React.FC<MessageBranchProps> = ({
  messages,
  isStreaming = false,
  streamingMessage,
  streamingThinking,
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
    const displayMessage = isThisMessageStreaming
      ? {
          ...message,
          content: streamingMessage ?? message.content,
          thinking: streamingThinking || message.thinking,
        }
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
    <div className={cn('relative py-2', className)}>
      {/* Branch indicator - minimal */}
      <div className='flex items-center gap-1.5 pb-3 text-[10px] font-medium uppercase tracking-[0.12em] text-gray-400 dark:text-dark-500'>
        <GitBranch className='h-3 w-3' />
        <span>{messages.length} variants</span>
      </div>

      {/* Branch container */}
      <div className='grid grid-cols-1 gap-3 md:grid-cols-2'>
        {messages.map((message, index) => {
          const isActive = message.isActive !== false;
          const isThisMessageStreaming =
            isStreaming && streamingMessageId === message.id;
          const displayMessage = isThisMessageStreaming
            ? {
                ...message,
                content: streamingMessage ?? message.content,
                thinking: streamingThinking || message.thinking,
              }
            : message;

          return (
            <div
              key={message.id}
              className={cn(
                'relative overflow-hidden rounded-2xl border bg-white/45 transition-colors duration-150 dark:bg-dark-200/35',
                isActive || isThisMessageStreaming
                  ? 'border-primary-500/30 ring-1 ring-primary-500/10 dark:border-primary-400/30'
                  : 'border-black/[0.07] hover:bg-white/80 dark:border-white/[0.07] dark:hover:bg-dark-200/70',
                !isActive && !isThisMessageStreaming && 'cursor-pointer'
              )}
              role={!isActive && !isThisMessageStreaming ? 'button' : undefined}
              tabIndex={!isActive && !isThisMessageStreaming ? 0 : undefined}
              onClick={() =>
                !isActive &&
                !isThisMessageStreaming &&
                onSelectBranch?.(message.id)
              }
              onKeyDown={event => {
                if (
                  !isActive &&
                  !isThisMessageStreaming &&
                  (event.key === 'Enter' || event.key === ' ')
                ) {
                  event.preventDefault();
                  onSelectBranch?.(message.id);
                }
              }}
            >
              {/* Branch header */}
              <div
                className={cn(
                  'flex items-center justify-between border-b px-3 py-2 text-[10px] font-medium uppercase tracking-[0.12em]',
                  isActive || isThisMessageStreaming
                    ? 'border-primary-500/10 bg-primary-50/50 text-primary-600 dark:border-primary-400/10 dark:bg-primary-900/10 dark:text-primary-400'
                    : 'border-black/[0.05] text-gray-400 dark:border-white/[0.05] dark:text-dark-500'
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
                  !isActive && !isThisMessageStreaming && 'opacity-75'
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
                  className='px-3 pb-3 !text-sm'
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export const MessageBranch = React.memo(MessageBranchBase);
MessageBranch.displayName = 'MessageBranch';

export default MessageBranch;
