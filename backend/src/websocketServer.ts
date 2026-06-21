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

import type { Server } from 'http';
import { WebSocketServer } from 'ws';

import ollamaService from './services/ollamaService.js';
import chatService from './services/chatService.js';
import pluginService from './services/pluginService.js';
import documentService from './services/documentService.js';
import chatGenerationService from './services/chatGenerationService.js';
import assistantCompletionService from './services/assistantCompletionService.js';
import { personaService } from './services/personaService.js';
import {
  buildDocumentEnhancedContent,
  ChatRequestService,
} from './services/chatRequestService.js';
import { streamOllamaChatResponse } from './utils/ollamaStreaming.js';
import { streamPluginResponse } from './utils/pluginStreaming.js';
import {
  sendAssistantComplete,
  sendConnected,
  sendError,
  sendUserMessage,
  streamAssistantFakeChunks,
} from './utils/websocketMessages.js';
import { verifyToken } from './utils/jwt.js';
import { OllamaChatRequest, ChatSession } from './types/index.js';

const chatRequestService = new ChatRequestService({
  chatGenerationService,
  personaService,
});

export function registerWebSocketServer(server: Server): void {
  // WebSocket server for real-time chat streaming
  const wss = new WebSocketServer({
    server,
    path: '/ws',
  });

  wss.on('connection', (ws, req) => {
    console.log('WebSocket client connected');

    // Extract and verify auth token from query parameters
    let userId = 'default';
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (token) {
        // Verify JWT token using the same logic as the auth middleware
        const decoded = verifyToken(token);
        userId = decoded.userId;
        console.log('WebSocket authenticated for user:', userId);
      } else {
        console.log(
          'WebSocket connection without auth token, using default user'
        );
      }
    } catch (error) {
      // An expired/invalid token here is expected (e.g. a stale browser token);
      // fall back to the default user without dumping a stack trace.
      console.warn(
        'WebSocket auth failed, using default user:',
        error instanceof Error ? error.message : error
      );
      // Continue with default user for backward compatibility
    }

    ws.on('message', async data => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'chat_stream') {
          const {
            sessionId,
            content,
            images,
            format,
            options,
            assistantMessageId,
            regenerate,
            originalMessageId,
            isPrivate,
            model: privateModel,
            messageHistory,
          } = message.data;

          console.log(
            'Backend: Received chat_stream for session:',
            sessionId,
            'with images:',
            !!images,
            'format:',
            !!format,
            'regenerate:',
            !!regenerate,
            'originalMessageId:',
            originalMessageId,
            'isPrivate:',
            !!isPrivate
          );

          // For private sessions, skip database operations
          let session: ChatSession | undefined;
          if (isPrivate) {
            // Create a temporary in-memory session object for private mode
            session = {
              id: sessionId,
              model: privateModel || 'private',
              messages: [],
              title: 'Private Chat',
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };
          } else {
            // Get session with user authentication
            session = chatService.getSession(sessionId, userId);
            if (!session) {
              console.log(
                'Backend: Session not found:',
                sessionId,
                'for user:',
                userId
              );
              sendError(ws, {
                error: 'Session not found',
                code: 'SESSION_NOT_FOUND',
                message:
                  'The requested session does not exist or does not belong to the current user. Please create a new session.',
                sessionId: sessionId,
                userId: userId,
              });
              return;
            }
          }

          // Add user message with images if provided (skip for regenerations and private sessions)
          let userMessage;
          if (!regenerate && !isPrivate) {
            userMessage = chatService.addMessage(
              sessionId,
              {
                role: 'user',
                content,
                images: images || undefined,
              },
              userId
            );

            if (!userMessage) {
              sendError(ws, { error: 'Failed to add user message' });
              return;
            }

            // Send user message confirmation
            sendUserMessage(ws, userMessage);
          } else if (!regenerate && isPrivate) {
            // For private sessions, just send a confirmation without saving
            sendUserMessage(ws, {
              id: `private-msg-${Date.now()}`,
              role: 'user',
              content,
              images: images || undefined,
              timestamp: Date.now(),
            });
          }

          // RAG: Get relevant document context for the user's query
          const relevantContext = await documentService.getRelevantContext(
            content,
            sessionId
          );
          const enhancedContent = buildDocumentEnhancedContent(
            content,
            relevantContext
          );

          if (relevantContext.length > 0) {
            console.log(
              `Found ${relevantContext.length} relevant document chunks for query`
            );

            // Update the user message with enhanced content that includes document context
            // We'll create a new message with the enhanced content for the AI model
            console.log('Enhanced user message with document context');
          }

          let assistantContent = '';

          console.log('Backend: Using assistantMessageId:', assistantMessageId);

          const persistedMessages = isPrivate
            ? []
            : chatService.getMessagesForContext(sessionId);
          const preparedGeneration =
            await chatRequestService.prepareGenerationRequest({
              session,
              userId,
              options,
              isPrivate,
              persistedMessages,
              messageHistory: messageHistory || [],
              regenerate,
              content,
              images: images || undefined,
              hasRelevantContext: relevantContext.length > 0,
              enhancedContent,
            });

          const generationTarget = preparedGeneration.target;
          const {
            actualModelName,
            mergedOptions,
            activePlugin,
            ollamaMessages,
            pluginMessages,
            shouldStreamPlugin,
          } = preparedGeneration;

          // Check if there's an active plugin for this model
          console.log(
            `[WebSocket] Looking for plugin for model: ${actualModelName}`
          );
          console.log(
            `[WebSocket] Found plugin:`,
            activePlugin ? activePlugin.id : 'none'
          );

          if (activePlugin) {
            console.log(
              `[WebSocket] Using plugin ${activePlugin.id} for model ${actualModelName}`
            );

            // ---------------------------------------------------------------
            // Standard plugin path (stateless HTTP completions)
            // ---------------------------------------------------------------

            try {
              if (shouldStreamPlugin) {
                assistantContent = await streamPluginResponse({
                  ws,
                  chunks: pluginService.executePluginStreamRequest(
                    actualModelName,
                    pluginMessages,
                    mergedOptions,
                    userId
                  ),
                  messageId: assistantMessageId,
                });
              } else {
                const generationResult =
                  await chatGenerationService.executeNonStreaming({
                    target: generationTarget,
                    ollamaMessages,
                    pluginMessages,
                    userId,
                    pluginFallbackPolicy: 'disabled',
                  });

                assistantContent = generationResult.assistantContent;

                await streamAssistantFakeChunks(
                  ws,
                  assistantContent,
                  assistantMessageId
                );
              }

              // Save the complete assistant message (skip for private sessions)
              if (assistantContent && assistantMessageId) {
                const completion =
                  assistantCompletionService.completeAssistantMessage({
                    sessionId,
                    session,
                    content: assistantContent,
                    model: session.model,
                    messageId: assistantMessageId,
                    userId,
                    isPrivate,
                    regenerate,
                    originalMessageId,
                  });

                if (isPrivate) {
                  // For private sessions, just send completion without saving
                  console.log(
                    'Backend: Private session - skipping message save'
                  );
                  sendAssistantComplete(ws, completion.privateMessage);
                } else {
                  console.log(
                    'Backend: Saving complete assistant message with ID:',
                    assistantMessageId,
                    'regenerate:',
                    !!regenerate
                  );

                  if (Object.keys(completion.branchingFields).length > 0) {
                    console.log(
                      'Backend: Setting branching fields:',
                      completion.branchingFields
                    );
                  }

                  console.log(
                    'Backend: Assistant message saved:',
                    !!completion.assistantMessage
                  );

                  // Send completion signal
                  sendAssistantComplete(ws, completion.assistantMessage);
                }
              }
              return; // Exit early since we handled the request via plugin
            } catch (pluginError: unknown) {
              const err =
                pluginError instanceof Error
                  ? pluginError
                  : new Error(String(pluginError));
              const errWithResponse = pluginError as Record<
                string,
                unknown
              > | null;
              console.error(
                'Plugin failed, falling back to Ollama:',
                err.message
              );
              if (
                errWithResponse &&
                typeof errWithResponse === 'object' &&
                'response' in errWithResponse
              ) {
                const resp = errWithResponse.response as Record<
                  string,
                  unknown
                >;
                console.error('Plugin HTTP response status:', resp.status);
                console.error(
                  'Plugin HTTP response data:',
                  JSON.stringify(resp.data)
                );
              }
              if ('cause' in err) {
                console.error(
                  'Plugin error cause:',
                  (err as { cause: unknown }).cause
                );
              }
              // If a plugin was found but failed, don't fall through to Ollama
              if (activePlugin) {
                console.error(
                  `[WebSocket] Plugin "${activePlugin.name}" failed for model ${actualModelName}, not falling back to Ollama`
                );
                sendError(ws, {
                  error: `Plugin request failed: ${err.message}`,
                });
                return;
              }
              // Continue to Ollama fallback below (no plugin was matched)
            }
          }

          console.log(
            `[WebSocket] No plugin found, using Ollama for model: ${actualModelName}`
          );

          // Reuse the actualModelName variable that was already resolved above
          // If we're here, it means either there was no plugin or plugin failed
          // The actualModelName was already resolved in the earlier code block

          // Create chat request with advanced features
          const chatRequest: OllamaChatRequest = {
            model: actualModelName,
            messages: ollamaMessages,
            stream: true,
            options: mergedOptions as Record<string, unknown>,
          };

          // Add structured output format if specified
          if (format) {
            chatRequest.format = format;
          }

          const ollamaStream = await streamOllamaChatResponse({
            ws,
            request: chatRequest,
            streamSource: ollamaService,
            messageId: assistantMessageId,
          });

          assistantContent = ollamaStream.content;

          if (!ollamaStream.completed) {
            return;
          }

          // Save the complete assistant message with the provided ID (skip for private sessions)
          if (assistantContent && assistantMessageId) {
            const completion =
              assistantCompletionService.completeAssistantMessage({
                sessionId,
                session,
                content: assistantContent,
                model: session.model,
                messageId: assistantMessageId,
                userId,
                isPrivate,
                regenerate,
                originalMessageId,
                statistics: ollamaStream.statistics,
              });

            if (isPrivate) {
              // For private sessions, just send completion without saving
              console.log(
                'Backend: Private session - skipping Ollama message save'
              );
              sendAssistantComplete(ws, {
                ...completion.privateMessage,
                messageId: assistantMessageId,
                statistics: ollamaStream.statistics,
              });
            } else {
              console.log(
                'Backend: Saving complete assistant message with ID:',
                assistantMessageId,
                'regenerate:',
                !!regenerate
              );

              if (Object.keys(completion.branchingFields).length > 0) {
                console.log(
                  'Backend: Setting branching fields:',
                  completion.branchingFields
                );
              }

              console.log('Backend: About to save assistant message:', {
                sessionId,
                messageId: assistantMessageId,
                contentLength: assistantContent.length,
                hasBranchingFields:
                  Object.keys(completion.branchingFields).length > 0,
                branchingFields: completion.branchingFields,
              });

              console.log(
                'Backend: Assistant message saved:',
                !!completion.assistantMessage,
                completion.assistantMessage
                  ? {
                      id: completion.assistantMessage.id,
                      contentLength: completion.assistantMessage.content.length,
                    }
                  : 'FAILED TO SAVE'
              );

              // Send completion signal with statistics
              sendAssistantComplete(ws, {
                content: assistantContent,
                role: 'assistant',
                timestamp: Date.now(),
                messageId: assistantMessageId,
                statistics: ollamaStream.statistics,
                ...completion.branchingFields,
              });
            }
          }
        }
      } catch (error: unknown) {
        console.error('WebSocket error:', error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        sendError(ws, { error: errorMessage });
      }
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
    });

    ws.on('error', error => {
      console.error('WebSocket error:', error);
    });

    // Send initial connection confirmation
    sendConnected(ws);
  });
}
