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
import { GenerationStatistics } from '@/types';
import websocketService from '@/utils/websocket';
import { generateId } from '@/utils';
import { chatApi } from '@/utils/api';
import toast from 'react-hot-toast';

export const useChat = (sessionId: string) => {
  const [streamingMessage, setStreamingMessage] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const {
    addMessage,
    updateMessage,
    updateMessageWithStatistics,
    updateSessionTitle,
    setGeneratingTitleForSession,
  } = useChatStore();
  const { setIsGenerating, preferences } = useAppStore();
  const streamingMessageIdRef = useRef<string | null>(null);

  // Track the first user message for auto-title generation
  const firstUserMessageRef = useRef<string | null>(null);

  // Buffer for streaming content to reduce state updates
  const streamingContentRef = useRef<string>('');

  // Store update batching with debounced timer approach
  const lastStoreUpdate = useRef<number>(0);
  const storeUpdateTimer = useRef<NodeJS.Timeout>();

  // Clean up handlers when component unmounts or sessionId changes
  useEffect(() => {
    return () => {
      // Clean up WebSocket handlers when component unmounts
      websocketService.offMessage('user_message');
      websocketService.offMessage('assistant_chunk');
      websocketService.offMessage('assistant_complete');
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
        done: boolean;
        messageId?: string;
      };

      // Use messageId from backend if provided, otherwise fall back to current streaming ID
      const messageId = chunkData.messageId || streamingMessageIdRef.current;

      if (messageId) {
        // Always update the content buffer and UI immediately for responsive streaming
        streamingContentRef.current = chunkData.total;
        setStreamingMessage(chunkData.total);

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

    websocketService.onMessage('assistant_complete', (data: unknown) => {
      const completeData = data as {
        content: string;
        role: string;
        timestamp: number;
        messageId?: string;
        statistics?: GenerationStatistics; // Generation statistics from Ollama
      };
      console.log(
        'Hook: Received assistant_complete for session:',
        sessionId,
        'messageId:',
        completeData.messageId,
        'with statistics:',
        !!completeData.statistics
      );

      // Clear streaming state immediately for better UX
      setIsStreaming(false);
      setStreamingMessage('');
      setIsGenerating(false);

      // Use messageId from backend if provided, otherwise fall back to current streaming ID
      const messageId = completeData.messageId || streamingMessageIdRef.current;

      if (completeData && messageId) {
        // Ensure final update with the complete content
        const finalContent =
          streamingContentRef.current || completeData.content;

        // Use updateMessageWithStatistics to include generation statistics
        updateMessageWithStatistics(
          sessionId,
          messageId,
          finalContent,
          completeData.statistics
        );
      }

      // Auto-title generation: Check if this is the first message and auto-title is enabled
      // Get fresh values from stores to avoid stale closure issues
      const currentPrefs = useAppStore.getState().preferences;
      const titleSettings = currentPrefs.titleSettings;
      const currentSess = useChatStore.getState().currentSession;
      const firstMessage = firstUserMessageRef.current;

      console.log('Auto-title check:', {
        firstMessage,
        autoTitle: titleSettings?.autoTitle,
        taskModel: titleSettings?.taskModel,
        sessionTitle: currentSess?.title,
      });

      if (
        firstMessage &&
        titleSettings?.autoTitle &&
        titleSettings?.taskModel &&
        currentSess?.title === 'New Chat'
      ) {
        console.log('Triggering auto-title generation...');
        // Set generating state for animation
        setGeneratingTitleForSession(sessionId);

        // Generate title asynchronously (don't block the UI)
        chatApi
          .generateTitle(sessionId, titleSettings.taskModel, firstMessage)
          .then(response => {
            console.log('Title generation response:', response);
            if (response.success && response.data?.title) {
              updateSessionTitle(sessionId, response.data.title);
            }
          })
          .catch(error => {
            console.error('Failed to generate title:', error);
          })
          .finally(() => {
            // Clear generating state
            setGeneratingTitleForSession(null);
          });
        // Clear the first message ref after triggering title generation
        firstUserMessageRef.current = null;
      }

      streamingMessageIdRef.current = null;
      streamingContentRef.current = '';

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
      setStreamingMessage('');
      setIsGenerating(false);
      streamingMessageIdRef.current = null;

      // Handle session not found error by redirecting to home
      if (errorData.code === 'SESSION_NOT_FOUND') {
        console.warn('Session not found, redirecting to create new session...');
        toast.error('Session not found. Creating a new session...');
        // Navigate to home to create a new session
        window.location.href = '/';
        return;
      }

      toast.error(errorData.error);
    });

    // Reset streaming state when switching sessions
    // Using a function to avoid setState-in-effect linting error
    const resetStreamingState = () => {
      setIsStreaming(false);
      setStreamingMessage('');
      streamingMessageIdRef.current = null;
    };
    resetStreamingState();

    // Cleanup function
    return () => {
      if (storeUpdateTimer.current) {
        clearTimeout(storeUpdateTimer.current);
      }
    };
  }, [
    sessionId,
    updateMessage,
    updateMessageWithStatistics,
    setIsGenerating,
    updateSessionTitle,
    setGeneratingTitleForSession,
  ]);

  const sendMessage = useCallback(
    async (
      content: string,
      images?: string[],
      format?: string | Record<string, unknown>
    ) => {
      if (!sessionId || !content.trim()) return;

      try {
        setIsGenerating(true);
        setIsStreaming(true);
        setStreamingMessage('');

        // Reset batching timers for new stream
        if (storeUpdateTimer.current) {
          clearTimeout(storeUpdateTimer.current);
        }
        lastStoreUpdate.current = Date.now();

        // Track the first user message for auto-title generation BEFORE adding message
        // Only set if it's the first message in this session (no existing user messages)
        const session = useChatStore.getState().currentSession;
        const hasExistingUserMessages = session?.messages?.some(
          m => m.role === 'user'
        );
        if (!hasExistingUserMessages && session?.title === 'New Chat') {
          firstUserMessageRef.current = content.trim();
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

        addMessage(sessionId, {
          role: 'assistant',
          content: '',
          id: assistantMessageId,
        });

        // Connect WebSocket if not connected
        if (!websocketService.isConnected) {
          await websocketService.connect();
        }

        // Send chat stream request with new parameters
        websocketService.send({
          type: 'chat_stream',
          data: {
            sessionId,
            content: content.trim(),
            images: images,
            format: format,
            options: preferences.generationOptions,
            assistantMessageId, // Send the message ID to backend
          },
        });
      } catch (error: unknown) {
        console.error('Failed to send message:', error);
        setIsStreaming(false);
        setStreamingMessage('');
        setIsGenerating(false);
        streamingMessageIdRef.current = null;
        toast.error('Failed to send message');
      }
    },
    [sessionId, addMessage, setIsGenerating, preferences.generationOptions]
  );

  const stopGeneration = useCallback(() => {
    setIsStreaming(false);
    setStreamingMessage('');
    setIsGenerating(false);
    streamingMessageIdRef.current = null;
    // Note: WebSocket connection doesn't have a built-in stop mechanism
    // You might want to implement this on the backend
  }, [setIsGenerating]);

  return {
    sendMessage,
    stopGeneration,
    isStreaming,
    streamingMessage,
  };
};
