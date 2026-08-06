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

import { useState, useCallback, useRef, useEffect } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { GenerationStatistics, ToolActivity } from '@/types';
import websocketService from '@/utils/websocket';
import { generateId } from '@/utils';
import {
  trackThinkingProgress,
  takeThinkingDuration,
} from '@/utils/thinkingTimer';
import { chatApi } from '@/utils/api';
import { isDemoMode } from '@/utils/demoMode';
import { createLogger } from '@/utils/logger';
import toast from 'react-hot-toast';
import { isChatModelSelectionAvailable } from '@/utils/chatModelSelection';

const logger = createLogger('use-chat');
const DEFAULT_SESSION_TITLES = new Set(['New Chat', 'New Demo Session']);

const isDefaultSessionTitle = (title?: string) =>
  !title || DEFAULT_SESSION_TITLES.has(title);

export const useChat = (sessionId: string) => {
  const [streamingMessage, setStreamingMessage] = useState<string>('');
  const [streamingThinking, setStreamingThinking] = useState<string>('');
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(
    null
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const {
    addMessage,
    updateMessage,
    updateMessageWithStatistics,
    applySessionTitle,
    setGeneratingTitleForSession,
  } = useChatStore();
  const { setIsGenerating } = useAppStore();
  const streamingMessageIdRef = useRef<string | null>(null);

  // Track the first user message for auto-title generation
  const firstUserMessageRef = useRef<string | null>(null);
  const shouldGenerateTitleRef = useRef(false);
  const titleGenerationSessionRef = useRef<string | null>(null);

  // Buffer for streaming content to reduce state updates
  const streamingContentRef = useRef<string>('');
  const streamingThinkingRef = useRef<string>('');

  // Store update batching with debounced timer approach
  const lastStoreUpdate = useRef<number>(0);
  const storeUpdateTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  const streamingFrameRef = useRef<number | null>(null);
  const pendingStreamingContentRef = useRef<string>('');
  const pendingStreamingThinkingRef = useRef<string>('');

  const cancelQueuedStreamingFrame = useCallback(() => {
    if (streamingFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(streamingFrameRef.current);
    }
    streamingFrameRef.current = null;
  }, []);

  const publishStreamingMessage = useCallback(
    (content: string, immediate = false, thinking: string = '') => {
      pendingStreamingContentRef.current = content;
      pendingStreamingThinkingRef.current = thinking;

      if (immediate || typeof window === 'undefined') {
        cancelQueuedStreamingFrame();
        setStreamingMessage(content);
        setStreamingThinking(thinking);
        return;
      }

      if (streamingFrameRef.current !== null) {
        return;
      }

      streamingFrameRef.current = window.requestAnimationFrame(() => {
        streamingFrameRef.current = null;
        setStreamingMessage(pendingStreamingContentRef.current);
        setStreamingThinking(pendingStreamingThinkingRef.current);
      });
    },
    [cancelQueuedStreamingFrame]
  );

  const resetVisibleStreamingMessage = useCallback(() => {
    cancelQueuedStreamingFrame();
    pendingStreamingContentRef.current = '';
    pendingStreamingThinkingRef.current = '';
    setStreamingMessage('');
    setStreamingThinking('');
  }, [cancelQueuedStreamingFrame]);

  const clearQueuedTitleGeneration = useCallback(() => {
    firstUserMessageRef.current = null;
    shouldGenerateTitleRef.current = false;
    titleGenerationSessionRef.current = null;
  }, []);

  const maybeGenerateTitle = useCallback(
    async (targetSessionId: string) => {
      const currentPrefs = useAppStore.getState().preferences;
      const titleSettings = currentPrefs.titleSettings;
      const firstMessage = firstUserMessageRef.current;
      const shouldGenerateTitle =
        shouldGenerateTitleRef.current &&
        titleGenerationSessionRef.current === targetSessionId;

      logger.debug('Auto-title check:', {
        firstMessage,
        autoTitle: titleSettings?.autoTitle,
        taskModel: titleSettings?.taskModel,
        shouldGenerateTitle,
      });

      if (
        !firstMessage ||
        !shouldGenerateTitle ||
        !titleSettings?.autoTitle ||
        !titleSettings?.taskModel
      ) {
        clearQueuedTitleGeneration();
        return;
      }

      clearQueuedTitleGeneration();
      logger.debug('Triggering auto-title generation...');
      setGeneratingTitleForSession(targetSessionId);

      try {
        const response = await chatApi.generateTitle(
          targetSessionId,
          titleSettings.taskModel,
          firstMessage,
          titleSettings.taskProviderType,
          titleSettings.taskProviderId
        );
        logger.debug('Title generation response:', response);

        if (!response.success || !response.data?.title) {
          throw new Error(
            response.error || 'Title generation returned no title'
          );
        }

        applySessionTitle(
          targetSessionId,
          response.data.title,
          response.data.updatedAt
        );

        if (response.data.source === 'fallback') {
          toast.error('Could not generate a title; using the message preview');
        } else {
          toast.success('Chat title generated');
        }
      } catch (error) {
        logger.error('Failed to generate title:', error);
        toast.error('Failed to generate chat title');
      } finally {
        setGeneratingTitleForSession(null);
      }
    },
    [
      applySessionTitle,
      clearQueuedTitleGeneration,
      setGeneratingTitleForSession,
    ]
  );

  // Clean up handlers when component unmounts or sessionId changes
  useEffect(() => {
    return () => {
      // Clean up WebSocket handlers when component unmounts
      websocketService.offMessage('user_message');
      websocketService.offMessage('assistant_chunk');
      websocketService.offMessage('assistant_complete');
      websocketService.offMessage('tool_status');
      websocketService.offMessage('error');
    };
  }, [sessionId]);

  // Set up WebSocket handlers once per session
  useEffect(() => {
    if (!sessionId) {
      // Clear handlers when no session
      websocketService.offMessage('user_message');
      websocketService.offMessage('assistant_chunk');
      websocketService.offMessage('assistant_complete');
      websocketService.offMessage('tool_status');
      websocketService.offMessage('error');
      return;
    }

    // Set up handlers for this session
    websocketService.onMessage('user_message', () => {
      // User message confirmation - already handled in sendMessage
    });

    websocketService.onMessage('assistant_chunk', (data: unknown) => {
      // Type guard to ensure data has the expected structure
      const chunkData = data as {
        content: string;
        total: string;
        thinking?: string;
        thinkingTotal?: string;
        done: boolean;
        messageId?: string;
      };

      // Use messageId from backend if provided, otherwise fall back to current streaming ID
      const messageId = chunkData.messageId || streamingMessageIdRef.current;

      if (messageId) {
        // Always update the content buffer and UI immediately for responsive streaming
        streamingContentRef.current = chunkData.total;
        if (typeof chunkData.thinkingTotal === 'string') {
          streamingThinkingRef.current = chunkData.thinkingTotal;
        }
        trackThinkingProgress(
          messageId,
          chunkData.total,
          streamingThinkingRef.current
        );
        publishStreamingMessage(
          chunkData.total,
          chunkData.done,
          streamingThinkingRef.current
        );

        // Debounced store updates - only update when streaming slows down or finishes
        if (storeUpdateTimer.current) {
          clearTimeout(storeUpdateTimer.current);
        }

        storeUpdateTimer.current = setTimeout(
          () => {
            updateMessage(sessionId, messageId, streamingContentRef.current);
            lastStoreUpdate.current = Date.now();
          },
          chunkData.done ? 0 : 200
        ); // Immediate on completion, 200ms debounce otherwise
      }
    });

    websocketService.onMessage('tool_status', (data: unknown) => {
      const toolData = data as {
        toolCallId: string;
        name: string;
        phase: string;
        args?: unknown;
        result?: unknown;
        partialResult?: unknown;
      };

      setToolActivities(prev => {
        const existing = prev.find(t => t.toolCallId === toolData.toolCallId);
        if (existing) {
          return prev.map(t =>
            t.toolCallId === toolData.toolCallId
              ? { ...t, phase: toolData.phase }
              : t
          );
        }
        return [
          ...prev,
          {
            toolCallId: toolData.toolCallId,
            name: toolData.name,
            phase: toolData.phase,
            startedAt: Date.now(),
          },
        ];
      });
    });

    websocketService.onMessage('assistant_complete', (data: unknown) => {
      const completeData = data as {
        content: string;
        role: string;
        timestamp: number;
        messageId?: string;
        thinking?: string;
        statistics?: GenerationStatistics; // Generation statistics from Ollama
        providerMetadata?: Record<string, unknown>;
      };
      logger.debug(
        'Hook: Received assistant_complete for session:',
        sessionId,
        'messageId:',
        completeData.messageId,
        'with statistics:',
        !!completeData.statistics
      );

      // Clear streaming state immediately for better UX
      setIsStreaming(false);
      resetVisibleStreamingMessage();
      setIsGenerating(false);
      setToolActivities([]);

      // Use messageId from backend if provided, otherwise fall back to current streaming ID
      const messageId = completeData.messageId || streamingMessageIdRef.current;

      if (completeData && messageId) {
        // Ensure final update with the complete content
        const finalContent =
          streamingContentRef.current || completeData.content;
        const finalThinking =
          streamingThinkingRef.current || completeData.thinking;

        // Use updateMessageWithStatistics to include generation statistics
        // The backend times the thinking phase for Ollama streams; the local
        // timer covers providers that stream without statistics.
        const thinkingDurationMs = takeThinkingDuration(messageId);
        const statistics =
          completeData.statistics?.thinking_duration_ms === undefined &&
          thinkingDurationMs !== undefined
            ? {
                ...completeData.statistics,
                thinking_duration_ms: thinkingDurationMs,
              }
            : completeData.statistics;
        updateMessageWithStatistics(
          sessionId,
          messageId,
          finalContent,
          statistics,
          completeData.providerMetadata,
          finalThinking
        );
      }

      maybeGenerateTitle(sessionId);

      streamingMessageIdRef.current = null;
      streamingContentRef.current = '';
      streamingThinkingRef.current = '';

      // Clear any pending store update timers
      if (storeUpdateTimer.current) {
        clearTimeout(storeUpdateTimer.current);
      }
      lastStoreUpdate.current = 0;
    });

    websocketService.onMessage('error', (data: unknown) => {
      const errorData = data as {
        error: string;
        code?: string;
        sessionId?: string;
      };
      setIsStreaming(false);
      resetVisibleStreamingMessage();
      setIsGenerating(false);
      streamingMessageIdRef.current = null;
      streamingThinkingRef.current = '';

      // Handle session not found error by redirecting to home
      if (errorData.code === 'SESSION_NOT_FOUND') {
        logger.warn('Session not found, redirecting to create new session...');
        toast.error('Session not found. Creating a new session...');
        // Navigate to home to create a new session
        window.location.href = '/';
        return;
      }

      toast.error(errorData.error);
      clearQueuedTitleGeneration();
    });

    // Reset streaming state when switching sessions
    // Using a function to avoid setState-in-effect linting error
    const resetStreamingState = () => {
      setIsStreaming(false);
      resetVisibleStreamingMessage();
      streamingMessageIdRef.current = null;
      streamingThinkingRef.current = '';
    };
    resetStreamingState();

    // Cleanup function
    return () => {
      if (storeUpdateTimer.current) {
        clearTimeout(storeUpdateTimer.current);
      }
      cancelQueuedStreamingFrame();
    };
  }, [
    sessionId,
    updateMessage,
    updateMessageWithStatistics,
    setIsGenerating,
    publishStreamingMessage,
    resetVisibleStreamingMessage,
    cancelQueuedStreamingFrame,
    maybeGenerateTitle,
    clearQueuedTitleGeneration,
  ]);

  const sendMessage = useCallback(
    async (
      content: string,
      images?: string[],
      format?: string | Record<string, unknown>
    ) => {
      // Allow sending if there's content OR if there are images
      if (!sessionId || (!content.trim() && (!images || images.length === 0)))
        return;

      try {
        const chatState = useChatStore.getState();
        const session = chatState.currentSession;
        const selection = {
          model: session?.personaId
            ? `persona:${session.personaId}`
            : session?.model || '',
          providerType: session?.providerType,
          providerId: session?.providerId,
        };
        if (!isChatModelSelectionAvailable(chatState.models, selection)) {
          toast.error('Select an available model before sending');
          return;
        }

        setIsGenerating(true);
        setIsStreaming(true);
        resetVisibleStreamingMessage();

        // Reset batching timers for new stream
        if (storeUpdateTimer.current) {
          clearTimeout(storeUpdateTimer.current);
        }
        lastStoreUpdate.current = Date.now();

        // Track the first user message for auto-title generation BEFORE adding message
        // Only set if it's the first message in this session (no existing user messages)
        const isPrivateSession = session?.isPrivate === true;
        const hasExistingUserMessages = session?.messages?.some(
          m => m.role === 'user'
        );
        const shouldTrackFirstMessage =
          !isPrivateSession &&
          !hasExistingUserMessages &&
          isDefaultSessionTitle(session?.title);

        if (shouldTrackFirstMessage) {
          firstUserMessageRef.current = content.trim();
          shouldGenerateTitleRef.current = true;
          titleGenerationSessionRef.current = sessionId;
        } else {
          firstUserMessageRef.current = null;
          shouldGenerateTitleRef.current = false;
          titleGenerationSessionRef.current = null;
        }

        // Add user message immediately
        addMessage(sessionId, {
          role: 'user',
          content: content.trim(),
          images: images, // Store images in the message if provided
        });

        // Create placeholder for assistant message
        const assistantMessageId = generateId();
        streamingMessageIdRef.current = assistantMessageId;
        streamingThinkingRef.current = '';
        setStreamingMessageId(assistantMessageId);

        addMessage(sessionId, {
          role: 'assistant',
          content: '',
          id: assistantMessageId,
        });

        if (isDemoMode()) {
          const demoResponse = `Demo response for: ${content.trim()}`;

          window.setTimeout(() => {
            updateMessage(sessionId, assistantMessageId, demoResponse);
            setIsStreaming(false);
            resetVisibleStreamingMessage();
            setStreamingMessageId(null);
            setIsGenerating(false);
            maybeGenerateTitle(sessionId);
            streamingMessageIdRef.current = null;
            streamingContentRef.current = '';
            streamingThinkingRef.current = '';
          }, 500);
          return;
        }

        // Connect WebSocket if not connected
        if (!websocketService.isConnected) {
          await websocketService.connect();
        }

        // For private sessions, send the message history since it's not stored on backend
        const messageHistory = isPrivateSession
          ? session?.messages
              ?.filter(m => m.role !== 'system' && m.id !== assistantMessageId)
              .map(m => ({
                role: m.role,
                content: m.content,
                thinking: m.thinking,
                images: m.images,
                providerMetadata: m.providerMetadata,
              }))
          : undefined;

        // Send chat stream request with new parameters
        websocketService.send({
          type: 'chat_stream',
          data: {
            sessionId,
            content: content.trim(),
            images: images,
            format: format,
            // Only this chat's own overrides. The global settings are applied
            // by the server, which also knows what the model recommends and
            // what was pinned for it — sending them here would outrank both.
            options: session?.settings?.generationOptions ?? {},
            assistantMessageId, // Send the message ID to backend
            isPrivate: isPrivateSession, // Private sessions don't persist to DB
            ...(isPrivateSession
              ? {
                  model: session?.model,
                  providerType: session?.providerType,
                  providerId: session?.providerId,
                  messageHistory,
                }
              : {}),
          },
        });
      } catch (error: unknown) {
        logger.error('Failed to send message:', error);
        setIsStreaming(false);
        resetVisibleStreamingMessage();
        setStreamingMessageId(null);
        setIsGenerating(false);
        streamingMessageIdRef.current = null;
        streamingThinkingRef.current = '';
        toast.error('Failed to send message');
      }
    },
    [
      sessionId,
      addMessage,
      updateMessage,
      setIsGenerating,
      resetVisibleStreamingMessage,
      maybeGenerateTitle,
    ]
  );

  const stopGeneration = useCallback(() => {
    setIsStreaming(false);
    resetVisibleStreamingMessage();
    setStreamingMessageId(null);
    setIsGenerating(false);
    streamingMessageIdRef.current = null;
    streamingThinkingRef.current = '';
    // Note: WebSocket connection doesn't have a built-in stop mechanism
    // You might want to implement this on the backend
  }, [setIsGenerating, resetVisibleStreamingMessage]);

  // Regenerate the last assistant message (creates a new branch)
  const regenerateLastMessage = useCallback(async () => {
    const chatState = useChatStore.getState();
    const session = chatState.currentSession;
    if (!session || !sessionId) return;
    if (
      !isChatModelSelectionAvailable(chatState.models, {
        model: session.personaId
          ? `persona:${session.personaId}`
          : session.model,
        providerType: session.providerType,
        providerId: session.providerId,
      })
    ) {
      toast.error('Select an available model before regenerating');
      return;
    }

    // Find the last user message (before the last assistant message)
    const messages = session.messages;
    let lastUserMessageIndex = -1;
    let lastAssistantMessageIndex = -1;

    // Find the last assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantMessageIndex = i;
        break;
      }
    }

    // Find the user message before that assistant message
    if (lastAssistantMessageIndex > 0) {
      for (let i = lastAssistantMessageIndex - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          lastUserMessageIndex = i;
          break;
        }
      }
    }

    if (lastUserMessageIndex === -1 || lastAssistantMessageIndex === -1) {
      toast.error('No message to regenerate');
      return;
    }

    const lastUserMessage = messages[lastUserMessageIndex];
    const lastAssistantMessage = messages[lastAssistantMessageIndex];

    try {
      setIsGenerating(true);
      setIsStreaming(true);
      resetVisibleStreamingMessage();

      // Reset batching timers for new stream
      if (storeUpdateTimer.current) {
        clearTimeout(storeUpdateTimer.current);
      }
      lastStoreUpdate.current = Date.now();

      // Generate a new message ID for the branch
      const newBranchMessageId = generateId();
      streamingMessageIdRef.current = newBranchMessageId;
      streamingThinkingRef.current = '';
      setStreamingMessageId(newBranchMessageId);

      // Create a placeholder for the new branch message in the store
      // This will replace the current assistant message in the UI
      addMessage(sessionId, {
        role: 'assistant',
        content: '',
        id: newBranchMessageId,
        parentId: lastAssistantMessage.parentId || lastAssistantMessage.id, // Link to original or parent
        branchIndex: lastAssistantMessage.siblingCount || 1, // New branch index
        isActive: true,
      });

      // Connect WebSocket if not connected
      if (!websocketService.isConnected) {
        await websocketService.connect();
      }

      // Send chat stream request to regenerate with branching
      const isPrivateSession = session.isPrivate === true;
      const messageHistory = isPrivateSession
        ? messages
            .filter(message => message.role !== 'system')
            .map(message => ({
              role: message.role,
              content: message.content,
              thinking: message.thinking,
              images: message.images,
              providerMetadata: message.providerMetadata,
            }))
        : undefined;
      websocketService.send({
        type: 'chat_stream',
        data: {
          sessionId,
          content: lastUserMessage.content,
          images: lastUserMessage.images,
          options: session.settings?.generationOptions ?? {},
          assistantMessageId: newBranchMessageId,
          regenerate: true,
          originalMessageId: lastAssistantMessage.id, // For branching
          isPrivate: isPrivateSession,
          ...(isPrivateSession
            ? {
                model: session.model,
                providerType: session.providerType,
                providerId: session.providerId,
                messageHistory,
              }
            : {}),
        },
      });
    } catch (error: unknown) {
      logger.error('Failed to regenerate message:', error);
      setIsStreaming(false);
      resetVisibleStreamingMessage();
      setStreamingMessageId(null);
      setIsGenerating(false);
      streamingMessageIdRef.current = null;
      streamingThinkingRef.current = '';
      toast.error('Failed to regenerate message');
    }
  }, [sessionId, setIsGenerating, resetVisibleStreamingMessage, addMessage]);

  // Select a specific branch by message ID (for side-by-side UI)
  const selectBranch = useCallback(
    async (messageId: string) => {
      const state = useChatStore.getState();
      const session = state.currentSession;
      if (!session || !sessionId) return;

      // Find the message in the current session
      const message = session.messages.find(m => m.id === messageId);
      if (!message) {
        toast.error('Message not found');
        return;
      }

      // If this message is already active, do nothing
      if (message.isActive !== false) {
        return;
      }

      // Find the parent ID for this branch group
      const parentId = message.parentId || message.id;
      const branchIndex = message.branchIndex || 0;

      try {
        const response = await chatApi.switchMessageBranch(
          sessionId,
          messageId,
          branchIndex
        );

        if (response.success && response.data) {
          // Update local state immediately for better UX
          // Mark all siblings as inactive, then mark the target as active
          const updatedMessages = session.messages.map(msg => {
            const isSibling = msg.id === parentId || msg.parentId === parentId;
            if (isSibling) {
              return {
                ...msg,
                isActive: msg.id === messageId,
              };
            }
            return msg;
          });

          // Update the session in the store
          const updatedSession = {
            ...session,
            messages: updatedMessages,
            updatedAt: Date.now(),
          };

          // Update both sessions array and currentSession
          useChatStore.setState(prevState => ({
            sessions: prevState.sessions.map(s =>
              s.id === sessionId ? updatedSession : s
            ),
            currentSession: updatedSession,
          }));

          toast.success(`Switched to variant ${branchIndex + 1}`);
        } else {
          toast.error(response.error || 'Failed to select branch');
        }
      } catch (error) {
        logger.error('Failed to select branch:', error);
        toast.error('Failed to select branch');
      }
    },
    [sessionId]
  );

  // Edit a user message: drop it and everything after, then resend the
  // edited content as a fresh turn.
  const editAndResendMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!sessionId || !newContent.trim()) return;

      const state = useChatStore.getState();
      const session = state.currentSession;
      if (!session || session.id !== sessionId) return;

      const index = session.messages.findIndex(m => m.id === messageId);
      if (index === -1 || session.messages[index].role !== 'user') return;

      const editedMessage = session.messages[index];
      const truncatedMessages = session.messages.slice(0, index);

      try {
        if (!session.isPrivate) {
          await chatApi.updateSession(sessionId, {
            messages: truncatedMessages,
          });
        }
        state.truncateMessagesFrom(sessionId, messageId);
        await sendMessage(newContent, editedMessage.images);
      } catch (error) {
        logger.error('Failed to edit message:', error);
        toast.error('Failed to edit message');
      }
    },
    [sessionId, sendMessage]
  );

  return {
    sendMessage,
    stopGeneration,
    regenerateLastMessage,
    editAndResendMessage,
    selectBranch,
    isStreaming,
    streamingMessage,
    streamingThinking,
    streamingMessageId,
    toolActivities,
  };
};
