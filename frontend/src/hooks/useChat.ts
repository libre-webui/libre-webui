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
import toast from 'react-hot-toast';

export const useChat = (sessionId: string) => {
  const [streamingMessage, setStreamingMessage] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const { addMessage, updateMessage, updateMessageWithStatistics } =
    useChatStore();
  const { setIsGenerating, preferences } = useAppStore();
  const streamingMessageIdRef = useRef<string | null>(null);

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

    console.log('Hook: Setting up handlers for session:', sessionId);

    // Clear existing handlers
    websocketService.offMessage('user_message');
    websocketService.offMessage('assistant_chunk');
    websocketService.offMessage('assistant_complete');
    websocketService.offMessage('error');

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
      console.log(
        'Hook: Received assistant_chunk for session:',
        sessionId,
        'total length:',
        chunkData.total.length,
        'messageId:',
        chunkData.messageId
      );

      // Use messageId from backend if provided, otherwise fall back to current streaming ID
      const messageId = chunkData.messageId || streamingMessageIdRef.current;

      if (messageId) {
        setStreamingMessage(chunkData.total);
        console.log(
          'Hook: Updating message',
          messageId,
          'with content length:',
          chunkData.total.length
        );
        updateMessage(sessionId, messageId, chunkData.total);
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
      setIsStreaming(false);
      setStreamingMessage('');
      setIsGenerating(false);

      // Use messageId from backend if provided, otherwise fall back to current streaming ID
      const messageId = completeData.messageId || streamingMessageIdRef.current;

      if (completeData && messageId) {
        console.log(
          'Hook: Final update for message',
          messageId,
          'with content length:',
          completeData.content.length,
          'and statistics:',
          !!completeData.statistics
        );

        // Use updateMessageWithStatistics to include generation statistics
        updateMessageWithStatistics(
          sessionId,
          messageId,
          completeData.content,
          completeData.statistics
        );

        // No need to save to backend - backend already saved it
        console.log('Hook: Message completed and saved by backend');
      }

      streamingMessageIdRef.current = null;
    });

    websocketService.onMessage('error', (data: unknown) => {
      const errorData = data as { error: string };
      console.log(
        'Hook: Received error for session:',
        sessionId,
        errorData.error
      );
      setIsStreaming(false);
      setStreamingMessage('');
      setIsGenerating(false);
      streamingMessageIdRef.current = null;
      toast.error(errorData.error);
    });

    // Reset streaming state when switching sessions
    setIsStreaming(false);
    setStreamingMessage('');
    streamingMessageIdRef.current = null;
  }, [sessionId, updateMessage, updateMessageWithStatistics, setIsGenerating]);

  const sendMessage = useCallback(
    async (
      content: string,
      images?: string[],
      format?: string | Record<string, unknown>
    ) => {
      if (!sessionId || !content.trim()) return;

      console.log(
        'Hook: sendMessage called with sessionId:',
        sessionId,
        'content:',
        content.slice(0, 50),
        '...'
      );

      try {
        setIsGenerating(true);
        setIsStreaming(true);
        setStreamingMessage('');

        // Add user message immediately
        addMessage(sessionId, {
          role: 'user',
          content: content.trim(),
          images: images, // Store images in the message if provided
        });

        // Create placeholder for assistant message
        const assistantMessageId = generateId();
        streamingMessageIdRef.current = assistantMessageId;

        console.log(
          'Hook: Creating assistant message with ID:',
          assistantMessageId
        );

        addMessage(sessionId, {
          role: 'assistant',
          content: '',
          id: assistantMessageId,
        });

        // Connect WebSocket if not connected
        if (!websocketService.isConnected) {
          console.log('Hook: WebSocket not connected, connecting...');
          await websocketService.connect();
        }

        console.log('Hook: Sending chat_stream message via WebSocket');
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
