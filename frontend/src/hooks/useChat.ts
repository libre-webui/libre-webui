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
import websocketService from '@/utils/websocket';
import { ChatMessage } from '@/types';
import { generateId } from '@/utils';
import toast from 'react-hot-toast';

export const useChat = (sessionId: string) => {
  const [streamingMessage, setStreamingMessage] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const { addMessage, updateMessage } = useChatStore();
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
    websocketService.onMessage('user_message', (_data: ChatMessage) => {
      // User message confirmation - already handled in sendMessage
    });

    websocketService.onMessage(
      'assistant_chunk',
      (data: {
        content: string;
        total: string;
        done: boolean;
        messageId?: string;
      }) => {
        console.log(
          'Hook: Received assistant_chunk for session:',
          sessionId,
          'total length:',
          data.total.length,
          'messageId:',
          data.messageId
        );

        // Use messageId from backend if provided, otherwise fall back to current streaming ID
        const messageId = data.messageId || streamingMessageIdRef.current;

        if (messageId) {
          setStreamingMessage(data.total);
          console.log(
            'Hook: Updating message',
            messageId,
            'with content length:',
            data.total.length
          );
          updateMessage(sessionId, messageId, data.total);
        }
      }
    );

    websocketService.onMessage(
      'assistant_complete',
      (data: {
        content: string;
        role: string;
        timestamp: number;
        messageId?: string;
      }) => {
        console.log(
          'Hook: Received assistant_complete for session:',
          sessionId,
          'messageId:',
          data.messageId
        );
        setIsStreaming(false);
        setStreamingMessage('');
        setIsGenerating(false);

        // Use messageId from backend if provided, otherwise fall back to current streaming ID
        const messageId = data.messageId || streamingMessageIdRef.current;

        if (data && messageId) {
          console.log(
            'Hook: Final update for message',
            messageId,
            'with content length:',
            data.content.length
          );
          updateMessage(sessionId, messageId, data.content);

          // No need to save to backend - backend already saved it
          console.log('Hook: Message completed and saved by backend');
        }

        streamingMessageIdRef.current = null;
      }
    );

    websocketService.onMessage('error', (data: { error: string }) => {
      console.log('Hook: Received error for session:', sessionId, data.error);
      setIsStreaming(false);
      setStreamingMessage('');
      setIsGenerating(false);
      streamingMessageIdRef.current = null;
      toast.error(data.error);
    });

    // Reset streaming state when switching sessions
    setIsStreaming(false);
    setStreamingMessage('');
    streamingMessageIdRef.current = null;
  }, [sessionId, updateMessage, setIsGenerating]);

  const sendMessage = useCallback(
    async (
      content: string,
      images?: string[],
      format?: string | Record<string, any>
    ) => {
      if (!sessionId || !content.trim()) return;

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
      } catch (error: any) {
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
