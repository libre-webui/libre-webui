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

import React, { useEffect, useRef, useCallback, useMemo } from 'react';
import { ChatMessage } from '@/components/ChatMessage';
import { MessageBranch } from '@/components/MessageBranch';
import { ChatMessage as ChatMessageType } from '@/types';
import { cn } from '@/utils';

interface ChatMessagesProps {
  messages: ChatMessageType[];
  streamingMessage?: string;
  streamingMessageId?: string | null;
  isStreaming?: boolean;
  className?: string;
  onRegenerate?: () => void;
  onSelectBranch?: (messageId: string) => void;
}

// Group messages by their position in the conversation, handling branches
interface MessageGroup {
  id: string; // The parent message ID or the message ID itself
  messages: ChatMessageType[]; // All variants at this position
  messageIndex: number; // Original position in conversation
}

export const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  streamingMessage,
  streamingMessageId,
  isStreaming = false,
  className,
  onRegenerate,
  onSelectBranch,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<NodeJS.Timeout>();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef<boolean>(false);

  // Group messages by their branch parent for side-by-side display
  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];
    const processedIds = new Set<string>();

    // Debug: Log messages with branching info
    console.log(
      '[ChatMessages] Grouping messages:',
      messages.map(m => ({
        id: m.id?.substring(0, 8),
        role: m.role,
        parentId: m.parentId?.substring(0, 8),
        branchIndex: m.branchIndex,
        isActive: m.isActive,
      }))
    );

    // Sort messages by their original index, then by branch index
    const sortedMessages = [...messages].sort((a, b) => {
      // System messages always come first
      if (a.role === 'system' && b.role !== 'system') return -1;
      if (b.role === 'system' && a.role !== 'system') return 1;
      // Then sort by timestamp or branch index
      if (a.parentId === b.parentId) {
        return (a.branchIndex || 0) - (b.branchIndex || 0);
      }
      return a.timestamp - b.timestamp;
    });

    for (const message of sortedMessages) {
      if (processedIds.has(message.id)) continue;

      // Check if this message is a branch variant
      const parentId = message.parentId;

      if (parentId) {
        // This is a branch variant - find or create a group for its parent
        const existingGroupIndex = groups.findIndex(g => g.id === parentId);

        if (existingGroupIndex >= 0) {
          // Add to existing group
          groups[existingGroupIndex].messages.push(message);
        } else {
          // Find the parent message
          const parentMessage = messages.find(m => m.id === parentId);
          if (parentMessage && !processedIds.has(parentId)) {
            // Create a new group with parent and this variant
            groups.push({
              id: parentId,
              messages: [parentMessage, message],
              messageIndex: groups.length,
            });
            processedIds.add(parentId);
          } else {
            // Parent already processed or not found, add as single message
            groups.push({
              id: message.id,
              messages: [message],
              messageIndex: groups.length,
            });
          }
        }
        processedIds.add(message.id);
      } else {
        // Check if this message has any variants (children that point to it as parent)
        const variants = messages.filter(m => m.parentId === message.id);

        if (variants.length > 0) {
          // This message has variants - create a group with all variants
          groups.push({
            id: message.id,
            messages: [message, ...variants],
            messageIndex: groups.length,
          });
          processedIds.add(message.id);
          variants.forEach(v => processedIds.add(v.id));
        } else {
          // Regular message without branches
          groups.push({
            id: message.id,
            messages: [message],
            messageIndex: groups.length,
          });
          processedIds.add(message.id);
        }
      }
    }

    // Sort groups to ensure proper conversation order
    // System messages first, then by the timestamp of the first message in the group
    return groups.sort((a, b) => {
      const aFirstMsg = a.messages[0];
      const bFirstMsg = b.messages[0];

      if (aFirstMsg.role === 'system' && bFirstMsg.role !== 'system') return -1;
      if (bFirstMsg.role === 'system' && aFirstMsg.role !== 'system') return 1;

      return aFirstMsg.timestamp - bFirstMsg.timestamp;
    });
  }, [messages]);

  const scrollToBottom = useCallback(
    (force: boolean = false) => {
      if (isStreaming || force) {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        return;
      }

      if (isUserScrolledUpRef.current) {
        return;
      }

      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }

      scrollTimeoutRef.current = setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
    },
    [isStreaming]
  );

  const handleScroll = useCallback(() => {
    if (isStreaming) return;

    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    const isAtBottom = scrollTop + clientHeight >= scrollHeight - 20;

    isUserScrolledUpRef.current = !isAtBottom;
  }, [isStreaming]);

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    if (isStreaming && streamingMessage) {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    }
  }, [isStreaming, streamingMessage]);

  useEffect(() => {
    if (isStreaming) {
      isUserScrolledUpRef.current = false;
    }
  }, [isStreaming]);

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

  // Find the last assistant message group for regenerate button
  let lastAssistantGroupIndex = -1;
  for (let i = messageGroups.length - 1; i >= 0; i--) {
    if (messageGroups[i].messages.some(m => m.role === 'assistant')) {
      lastAssistantGroupIndex = i;
      break;
    }
  }

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className={cn(
        'flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600',
        'scrollbar-track-transparent hover:scrollbar-thumb-gray-400 dark:hover:scrollbar-thumb-gray-500',
        'overscroll-behavior-y-contain scroll-smooth',
        '[-webkit-overflow-scrolling:touch]',
        className
      )}
      style={
        {
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorY: 'contain',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties
      }
    >
      <div className='max-w-5xl mx-auto px-3 sm:px-4 md:px-6 w-full min-w-0'>
        {messageGroups.map((group, groupIndex) => {
          const isLastAssistantGroup = groupIndex === lastAssistantGroupIndex;
          // Check if any message in this group is being streamed
          const isStreamingThisGroup =
            isStreaming &&
            group.messages.some(m => m.id === streamingMessageId);

          // For single messages (no branches), render normally
          if (group.messages.length === 1) {
            const message = group.messages[0];
            const isThisMessageStreaming =
              isStreaming && message.id === streamingMessageId;
            const displayMessage =
              isThisMessageStreaming && streamingMessage
                ? { ...message, content: streamingMessage }
                : message;

            return (
              <ChatMessage
                key={message.id}
                message={displayMessage}
                isStreaming={isThisMessageStreaming}
                isLastAssistantMessage={isLastAssistantGroup}
                onRegenerate={isLastAssistantGroup ? onRegenerate : undefined}
                className={groupIndex === 0 ? 'mt-3 sm:mt-4 md:mt-6' : ''}
              />
            );
          }

          // For branched messages, use MessageBranch component
          return (
            <MessageBranch
              key={group.id}
              messages={group.messages}
              isStreaming={isStreamingThisGroup}
              streamingMessage={streamingMessage}
              streamingMessageId={streamingMessageId || undefined}
              isLastAssistantMessage={isLastAssistantGroup}
              onRegenerate={isLastAssistantGroup ? onRegenerate : undefined}
              onSelectBranch={onSelectBranch}
              className={groupIndex === 0 ? 'mt-3 sm:mt-4 md:mt-6' : ''}
            />
          );
        })}
        <div ref={messagesEndRef} className='h-3 sm:h-4 md:h-6' />
      </div>
    </div>
  );
};
