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
import agentCliService from './services/agentCliService.js';
import chatGenerationService from './services/chatGenerationService.js';
import assistantCompletionService from './services/assistantCompletionService.js';
import { personaService } from './services/personaService.js';
import {
  buildDocumentEnhancedContent,
  ChatRequestService,
} from './services/chatRequestService.js';
import { streamOllamaChatResponse } from './utils/ollamaStreaming.js';
import { streamPluginResponse } from './utils/pluginStreaming.js';
import { createLogger } from './utils/logger.js';
import {
  sendAssistantComplete,
  sendConnected,
  sendError,
  sendUserMessage,
  streamAssistantFakeChunks,
} from './utils/websocketMessages.js';
import { verifyToken } from './utils/jwt.js';
import {
  createWorkTerminalServer,
  WORK_TERMINAL_WS_PATH,
} from './workTerminalServer.js';
import { OllamaChatRequest, ChatSession } from './types/index.js';
import { normalizeChatProviderSelection } from './utils/chatProviderSelection.js';

const chatRequestService = new ChatRequestService({
  chatGenerationService,
  personaService,
});
const logger = createLogger('websocket');

export function registerWebSocketServer(server: Server): void {
  // WebSocket server for real-time chat streaming. Upgrades are dispatched by
  // path in index.ts so the Work terminal can share the same HTTP server.
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws, req) => {
    logger.debug('WebSocket client connected');

    // Extract and verify auth token from query parameters
    let userId = 'default';
    try {
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (token) {
        // Verify JWT token using the same logic as the auth middleware
        const decoded = verifyToken(token);
        userId = decoded.userId;
        logger.debug('WebSocket authenticated for user:', userId);
      } else {
        logger.debug(
          'WebSocket connection without auth token, using default user'
        );
      }
    } catch (error) {
      // An expired/invalid token here is expected (e.g. a stale browser token);
      // fall back to the default user without dumping a stack trace.
      logger.warn(
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
            providerType,
            providerId,
            messageHistory,
          } = message.data;
          const requestProviderSelection = isPrivate
            ? normalizeChatProviderSelection({ providerType, providerId })
            : undefined;

          logger.debug(
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
              ...requestProviderSelection,
            };
          } else {
            // Get session with user authentication
            session = chatService.getSession(sessionId, userId);
            if (!session) {
              logger.debug(
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
            logger.debug(
              `Found ${relevantContext.length} relevant document chunks for query`
            );

            // Update the user message with enhanced content that includes document context
            // We'll create a new message with the enhanced content for the AI model
            logger.debug('Enhanced user message with document context');
          }

          let assistantContent = '';
          let assistantProviderMetadata: Record<string, unknown> | undefined;

          logger.debug(
            'Backend: Using assistantMessageId:',
            assistantMessageId
          );

          const persistedMessages = isPrivate
            ? []
            : chatService.getMessagesForContext(sessionId);
          const preparedGeneration =
            await chatRequestService.prepareGenerationRequest({
              session,
              userId,
              options,
              providerType: isPrivate ? providerType : undefined,
              providerId: isPrivate ? providerId : undefined,
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
          logger.debug(
            `[WebSocket] Looking for plugin for model: ${actualModelName}`
          );
          logger.debug(
            `[WebSocket] Found plugin:`,
            activePlugin ? activePlugin.id : 'none'
          );

          const agentProviderId =
            generationTarget.providerType === 'agent'
              ? generationTarget.providerId
              : undefined;

          if (activePlugin || agentProviderId) {
            logger.debug(
              `[WebSocket] Using ${
                agentProviderId
                  ? `agent CLI ${agentProviderId}`
                  : `plugin ${activePlugin?.id}`
              } for model ${actualModelName}`
            );

            // ---------------------------------------------------------------
            // Standard plugin path (stateless HTTP completions) — agent CLI
            // targets reuse it by yielding the same stream chunk shape.
            // ---------------------------------------------------------------

            try {
              if (agentProviderId || shouldStreamPlugin) {
                const streamResult = await streamPluginResponse({
                  ws,
                  chunks: agentProviderId
                    ? agentCliService.executeAgentStreamRequest(
                        agentProviderId,
                        pluginMessages,
                        userId
                      )
                    : pluginService.executePluginStreamRequest(
                        actualModelName,
                        pluginMessages,
                        mergedOptions,
                        userId,
                        (activePlugin as NonNullable<typeof activePlugin>).id
                      ),
                  messageId: assistantMessageId,
                });
                assistantContent = streamResult.content;
                assistantProviderMetadata = streamResult.providerMetadata;
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
                assistantProviderMetadata =
                  generationResult.response.message.providerMetadata;

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
                    providerMetadata: assistantProviderMetadata,
                  });

                if (isPrivate) {
                  // For private sessions, just send completion without saving
                  logger.debug(
                    'Backend: Private session - skipping message save'
                  );
                  sendAssistantComplete(ws, completion.privateMessage);
                } else {
                  logger.debug(
                    'Backend: Saving complete assistant message with ID:',
                    assistantMessageId,
                    'regenerate:',
                    !!regenerate
                  );

                  if (Object.keys(completion.branchingFields).length > 0) {
                    logger.debug(
                      'Backend: Setting branching fields:',
                      completion.branchingFields
                    );
                  }

                  logger.debug(
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
              logger.error(
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
                logger.error('Plugin HTTP response status:', resp.status);
                logger.error(
                  'Plugin HTTP response data:',
                  JSON.stringify(resp.data)
                );
              }
              if ('cause' in err) {
                logger.error(
                  'Plugin error cause:',
                  (err as { cause: unknown }).cause
                );
              }
              // If a plugin/agent was matched but failed, don't fall through
              // to Ollama with a model name it cannot serve.
              if (activePlugin || agentProviderId) {
                logger.error(
                  `[WebSocket] ${
                    agentProviderId
                      ? `Agent CLI "${agentProviderId}"`
                      : `Plugin "${activePlugin?.name}"`
                  } failed for model ${actualModelName}, not falling back to Ollama`
                );
                sendError(ws, {
                  error: agentProviderId
                    ? `Agent request failed: ${err.message}`
                    : `Plugin request failed: ${err.message}`,
                });
                return;
              }
              // Continue to Ollama fallback below (no plugin was matched)
            }
          }

          logger.debug(
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
              logger.debug(
                'Backend: Private session - skipping Ollama message save'
              );
              sendAssistantComplete(ws, {
                ...completion.privateMessage,
                messageId: assistantMessageId,
                statistics: ollamaStream.statistics,
              });
            } else {
              logger.debug(
                'Backend: Saving complete assistant message with ID:',
                assistantMessageId,
                'regenerate:',
                !!regenerate
              );

              if (Object.keys(completion.branchingFields).length > 0) {
                logger.debug(
                  'Backend: Setting branching fields:',
                  completion.branchingFields
                );
              }

              logger.debug('Backend: About to save assistant message:', {
                sessionId,
                messageId: assistantMessageId,
                contentLength: assistantContent.length,
                hasBranchingFields:
                  Object.keys(completion.branchingFields).length > 0,
                branchingFields: completion.branchingFields,
              });

              logger.debug(
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
        logger.error('WebSocket error:', error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        sendError(ws, { error: errorMessage });
      }
    });

    ws.on('close', () => {
      logger.debug('WebSocket client disconnected');
    });

    ws.on('error', error => {
      logger.error('WebSocket error:', error);
    });

    // Send initial connection confirmation
    sendConnected(ws);
  });

  const terminalServer = createWorkTerminalServer();

  server.on('upgrade', (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url || '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === WORK_TERMINAL_WS_PATH) {
      terminalServer.handleUpgrade(request, socket, head, ws => {
        terminalServer.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request);
      });
      return;
    }
    socket.destroy();
  });
}
