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

import React, {
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChatMessage } from '@/components/ChatMessage';
import {
  ConversationHistoryItem,
  ConversationHistoryRail,
} from '@/components/ConversationHistoryRail';
import { MessageBranch } from '@/components/MessageBranch';
import { ChatMessage as ChatMessageType, ToolActivity } from '@/types';
import { ToolActivityIndicator } from '@/components/ToolActivityIndicator';
import { cn } from '@/utils';
import { ArrowDown, Sparkles } from 'lucide-react';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:chat-messages');

interface ChatMessagesProps {
  messages: ChatMessageType[];
  streamingMessage?: string;
  streamingMessageId?: string | null;
  isStreaming?: boolean;
  toolActivities?: ToolActivity[];
  className?: string;
  onRegenerate?: () => void;
  onSelectBranch?: (messageId: string) => void;
  onEditResend?: (messageId: string, content: string) => void;
}

// Group messages by their position in the conversation, handling branches
interface MessageGroup {
  id: string; // The parent message ID or the message ID itself
  messages: ChatMessageType[]; // All variants at this position
  messageIndex: number; // Original position in conversation
}

const getActiveGroupMessage = (group: MessageGroup) =>
  group.messages.find(message => message.isActive === true) ||
  group.messages.find(message => message.isActive !== false) ||
  group.messages[0];

const preferredScrollBehavior = (): ScrollBehavior =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';

const getHistoryReadingOffset = (viewportHeight: number) =>
  Math.min(120, viewportHeight * 0.28);

export const ChatMessages: React.FC<ChatMessagesProps> = ({
  messages,
  streamingMessage,
  streamingMessageId,
  isStreaming = false,
  toolActivities = [],
  className,
  onRegenerate,
  onSelectBranch,
  onEditResend,
}) => {
  const { t } = useTranslation();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesContentRef = useRef<HTMLDivElement>(null);
  const historyGroupRefs = useRef(new Map<string, HTMLDivElement>());
  const historyFrameRef = useRef<number | null>(null);
  const activeHistoryIndexRef = useRef(0);
  const isHistoryNavigatingRef = useRef(false);
  const isUserScrolledUpRef = useRef<boolean>(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Group messages by their branch parent for side-by-side display
  const messageGroups = useMemo(() => {
    const groups: MessageGroup[] = [];
    const processedIds = new Set<string>();

    // Debug: Log messages with branching info (verbose, disabled by default)
    if (import.meta.env.DEV && import.meta.env.VITE_DEBUG_VERBOSE) {
      logger.debug(
        '[ChatMessages] Grouping messages:',
        messages.map(m => ({
          id: m.id?.substring(0, 8),
          role: m.role,
          parentId: m.parentId?.substring(0, 8),
          branchIndex: m.branchIndex,
          isActive: m.isActive,
        }))
      );
    }

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

  const historyItems = useMemo<ConversationHistoryItem[]>(() => {
    const items: ConversationHistoryItem[] = [];

    for (let index = 0; index < messageGroups.length; index++) {
      const group = messageGroups[index];
      const userMessage = getActiveGroupMessage(group);
      if (userMessage.role !== 'user') continue;

      let response: string | undefined;
      for (
        let nextIndex = index + 1;
        nextIndex < messageGroups.length;
        nextIndex++
      ) {
        const nextMessage = getActiveGroupMessage(messageGroups[nextIndex]);
        if (nextMessage.role === 'user') break;
        if (nextMessage.role !== 'assistant') continue;

        response = nextMessage.content;
        break;
      }

      items.push({
        id: group.id,
        prompt: userMessage.content,
        response,
      });
    }

    return items;
  }, [messageGroups]);

  const historyIdsKey = historyItems.map(item => item.id).join('\u001f');
  const historyIds = useMemo(
    () => (historyIdsKey ? historyIdsKey.split('\u001f') : []),
    [historyIdsKey]
  );
  const historyIdSet = useMemo(() => new Set(historyIds), [historyIds]);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);

  const updateActiveHistory = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || historyIds.length === 0) {
      setActiveHistoryId(null);
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    let activeIndex = Math.min(
      activeHistoryIndexRef.current,
      historyIds.length - 1
    );

    if (distanceFromBottom <= 2) {
      activeIndex = historyIds.length - 1;
    } else {
      const readingLine =
        container.scrollTop + getHistoryReadingOffset(container.clientHeight);

      while (activeIndex < historyIds.length - 1) {
        const nextAnchor = historyGroupRefs.current.get(
          historyIds[activeIndex + 1]
        );
        if (!nextAnchor || nextAnchor.offsetTop > readingLine) break;
        activeIndex++;
      }

      while (activeIndex > 0) {
        const activeAnchor = historyGroupRefs.current.get(
          historyIds[activeIndex]
        );
        if (!activeAnchor || activeAnchor.offsetTop <= readingLine) break;
        activeIndex--;
      }
    }

    activeHistoryIndexRef.current = activeIndex;
    const nextActiveId = historyIds[activeIndex];
    setActiveHistoryId(current =>
      current === nextActiveId ? current : nextActiveId
    );
  }, [historyIds]);

  const scheduleHistoryUpdate = useCallback(() => {
    if (historyFrameRef.current !== null) return;

    historyFrameRef.current = window.requestAnimationFrame(() => {
      historyFrameRef.current = null;
      updateActiveHistory();
    });
  }, [updateActiveHistory]);

  const finishHistoryNavigation = useCallback(() => {
    const container = scrollContainerRef.current;
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    isHistoryNavigatingRef.current = false;
    scrollTimeoutRef.current = undefined;
    if (!container) return;

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const isAtBottom = distanceFromBottom < 100;
    isUserScrolledUpRef.current = !isAtBottom;
    setShowScrollButton(!isAtBottom && messages.length > 0);
    scheduleHistoryUpdate();
  }, [messages.length, scheduleHistoryUpdate]);

  const queueHistoryNavigationFinish = useCallback(() => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(finishHistoryNavigation, 180);
  }, [finishHistoryNavigation]);

  const scrollToBottom = useCallback((force: boolean = false) => {
    // Respect user scroll position unless forced
    if (isUserScrolledUpRef.current && !force) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: preferredScrollBehavior(),
    });
  }, []);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const { scrollTop, scrollHeight, clientHeight } = container;
    // Show button when scrolled up more than 100px from bottom
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    const isAtBottom = distanceFromBottom < 100;

    if (isHistoryNavigatingRef.current) {
      isUserScrolledUpRef.current = true;
      setShowScrollButton(!isAtBottom && messages.length > 0);
      scheduleHistoryUpdate();
      queueHistoryNavigationFinish();
      return;
    }

    isUserScrolledUpRef.current = !isAtBottom;
    setShowScrollButton(!isAtBottom && messages.length > 0);
    if (distanceFromBottom <= 2 && historyIds.length > 0) {
      activeHistoryIndexRef.current = historyIds.length - 1;
      setActiveHistoryId(historyIds[historyIds.length - 1]);
    } else {
      scheduleHistoryUpdate();
    }
  }, [
    historyIds,
    messages.length,
    queueHistoryNavigationFinish,
    scheduleHistoryUpdate,
  ]);

  const scrollToHistoryItem = useCallback(
    (id: string) => {
      const container = scrollContainerRef.current;
      const anchor = historyGroupRefs.current.get(id);
      if (!container || !anchor) return;

      const behavior = preferredScrollBehavior();
      isHistoryNavigatingRef.current = true;
      isUserScrolledUpRef.current = true;
      container.scrollTo({
        top: Math.max(
          0,
          anchor.offsetTop - getHistoryReadingOffset(container.clientHeight)
        ),
        behavior,
      });
      scheduleHistoryUpdate();

      if (behavior === 'auto') {
        finishHistoryNavigation();
      } else {
        queueHistoryNavigationFinish();
      }
    },
    [
      finishHistoryNavigation,
      queueHistoryNavigationFinish,
      scheduleHistoryUpdate,
    ]
  );

  // Only scroll to bottom when a NEW message is added (not on every render)
  const prevMessagesLengthRef = useRef(messages.length);
  useEffect(() => {
    // Only auto-scroll if messages were added AND user is at bottom
    if (
      messages.length > prevMessagesLengthRef.current &&
      !isUserScrolledUpRef.current
    ) {
      scrollToBottom();
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages.length, scrollToBottom]);

  useEffect(() => {
    // Only auto-scroll during streaming if user hasn't scrolled up
    if (isStreaming && streamingMessage && !isUserScrolledUpRef.current) {
      requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) {
          container.scrollTop = container.scrollHeight;
        }
      });
    }
  }, [isStreaming, streamingMessage]);

  useEffect(() => {
    scheduleHistoryUpdate();

    const content = messagesContentRef.current;
    const container = scrollContainerRef.current;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(scheduleHistoryUpdate);
    if (content) observer?.observe(content);
    if (container) observer?.observe(container);
    window.addEventListener('resize', scheduleHistoryUpdate);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', scheduleHistoryUpdate);
    };
  }, [historyIdsKey, scheduleHistoryUpdate]);

  useEffect(
    () => () => {
      if (historyFrameRef.current !== null) {
        window.cancelAnimationFrame(historyFrameRef.current);
        historyFrameRef.current = null;
      }
    },
    []
  );

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
          'flex-1 flex items-center justify-center p-6 sm:p-10',
          className
        )}
      >
        <div className='max-w-sm text-center text-gray-500 dark:text-dark-600'>
          <div className='mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-2xl border border-black/[0.06] bg-surface/70 text-gray-500 shadow-sm dark:border-white/[0.07] dark:bg-dark-200/70 dark:text-dark-600'>
            <Sparkles className='h-4 w-4' />
          </div>
          <h3 className='mb-2 text-lg font-medium tracking-[-0.02em] text-gray-900 dark:text-dark-900 sm:text-xl'>
            {t('chatMessage.startConversation')}
          </h3>
          <p className='px-4 text-sm leading-relaxed'>
            {t('chatMessage.startConversationDescription')}
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

  const handleScrollToBottom = () => {
    isHistoryNavigatingRef.current = false;
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = undefined;
    }
    isUserScrolledUpRef.current = false;
    messagesEndRef.current?.scrollIntoView({
      behavior: preferredScrollBehavior(),
    });
    setShowScrollButton(false);
  };

  return (
    <div
      className={cn('relative min-h-0 flex-1', className)}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      <div
        ref={scrollContainerRef}
        data-testid='chat-scroll-viewport'
        onScroll={handleScroll}
        className={cn(
          'h-full overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600',
          'scrollbar-track-transparent hover:scrollbar-thumb-gray-400 dark:hover:scrollbar-thumb-gray-500',
          'overscroll-behavior-y-contain',
          '[-webkit-overflow-scrolling:touch]'
        )}
        style={
          {
            WebkitOverflowScrolling: 'touch',
            overscrollBehaviorY: 'contain',
          } as React.CSSProperties
        }
      >
        <div
          ref={messagesContentRef}
          className='mx-auto w-full min-w-0 max-w-3xl px-4 sm:px-6 md:px-8'
        >
          {messageGroups.map((group, groupIndex) => {
            const isLastAssistantGroup = groupIndex === lastAssistantGroupIndex;
            const isHistoryItem = historyIdSet.has(group.id);
            // Check if any message in this group is being streamed
            const isStreamingThisGroup =
              isStreaming &&
              group.messages.some(m => m.id === streamingMessageId);

            let renderedMessage: React.ReactNode;

            // For single messages (no branches), render normally
            if (group.messages.length === 1) {
              const message = group.messages[0];
              const isThisMessageStreaming =
                isStreaming && message.id === streamingMessageId;
              const displayMessage =
                isThisMessageStreaming && streamingMessage
                  ? { ...message, content: streamingMessage }
                  : message;

              renderedMessage = (
                <ChatMessage
                  message={displayMessage}
                  isStreaming={isThisMessageStreaming}
                  isLastAssistantMessage={isLastAssistantGroup}
                  onRegenerate={isLastAssistantGroup ? onRegenerate : undefined}
                  onEditResend={isStreaming ? undefined : onEditResend}
                  className={groupIndex === 0 ? 'mt-3 sm:mt-4' : ''}
                />
              );
            } else {
              // For branched messages, use MessageBranch component
              renderedMessage = (
                <MessageBranch
                  messages={group.messages}
                  isStreaming={isStreamingThisGroup}
                  streamingMessage={streamingMessage}
                  streamingMessageId={streamingMessageId || undefined}
                  isLastAssistantMessage={isLastAssistantGroup}
                  onRegenerate={isLastAssistantGroup ? onRegenerate : undefined}
                  onSelectBranch={onSelectBranch}
                  className={groupIndex === 0 ? 'mt-3 sm:mt-4' : ''}
                />
              );
            }

            return (
              <div
                key={group.id}
                ref={element => {
                  if (!isHistoryItem) return;
                  if (element) historyGroupRefs.current.set(group.id, element);
                  else historyGroupRefs.current.delete(group.id);
                }}
                data-testid={
                  isHistoryItem ? 'conversation-turn-anchor' : undefined
                }
                data-history-id={isHistoryItem ? group.id : undefined}
              >
                {renderedMessage}
              </div>
            );
          })}
          {isStreaming && toolActivities.length > 0 && (
            <ToolActivityIndicator tools={toolActivities} className='px-0' />
          )}
          <div ref={messagesEndRef} className='h-4 sm:h-6' />
        </div>
      </div>

      <ConversationHistoryRail
        items={historyItems}
        activeId={activeHistoryId}
        onSelect={scrollToHistoryItem}
      />

      {/* Scroll to bottom button */}
      {showScrollButton && (
        <button
          onClick={handleScrollToBottom}
          className={cn(
            'absolute bottom-4 left-1/2 -translate-x-1/2 z-10',
            'flex items-center justify-center gap-1.5',
            'px-3.5 py-2 rounded-full',
            'bg-surface/90 dark:bg-dark-200/90',
            'border border-black/[0.07] dark:border-white/[0.08]',
            'shadow-[0_8px_28px_rgba(15,23,42,0.12)] backdrop-blur-xl',
            'text-gray-600 dark:text-dark-600',
            'hover:bg-surface-raised dark:hover:bg-dark-200',
            'hover:text-gray-900 dark:hover:text-dark-800',
            'transition-colors duration-150'
          )}
          title={t('chatMessage.scrollToBottom')}
        >
          <ArrowDown className='h-4 w-4' />
          <span className='text-xs font-medium'>
            {t('chatMessage.newMessages')}
          </span>
        </button>
      )}
    </div>
  );
};
