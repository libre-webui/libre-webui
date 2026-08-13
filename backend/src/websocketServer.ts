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

import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type RawData } from 'ws';

import ollamaService from './services/ollamaService.js';
import chatService from './services/chatService.js';
import pluginService from './services/pluginService.js';
import agentCliService from './services/agentCliService.js';
import {
  buildWebSearchEnhancedContent,
  isWebSearchAvailable,
  userCanUseWebSearch,
  webSearch as runWebSearch,
} from './services/webSearchService.js';
import {
  buildChatDocumentContext,
  EMPTY_CHAT_DOCUMENT_CONTEXT,
} from './utils/chatDocumentContext.js';
import chatGenerationService from './services/chatGenerationService.js';
import preferencesService from './services/preferencesService.js';
import assistantCompletionService from './services/assistantCompletionService.js';
import { personaService } from './services/personaService.js';
import { ChatRequestService } from './services/chatRequestService.js';
import { streamOllamaChatResponse } from './utils/ollamaStreaming.js';
import { streamPluginResponse } from './utils/pluginStreaming.js';
import { createLogger } from './utils/logger.js';
import {
  sendAssistantChunk,
  sendAssistantCancelled,
  sendAssistantComplete,
  sendConnected,
  sendError,
  sendToolStatus,
  sendUserMessage,
  streamAssistantFakeChunks,
} from './utils/websocketMessages.js';
import {
  createWorkTerminalServer,
  WORK_TERMINAL_WS_PATH,
} from './workTerminalServer.js';
import { OllamaChatRequest, ChatSession } from './types/index.js';
import { normalizeChatProviderSelection } from './utils/chatProviderSelection.js';
import workPreviewProxyService from './services/workPreviewProxyService.js';
import { userModel } from './models/userModel.js';
import { websocketTicketService } from './services/websocketTicketService.js';
import {
  type ActiveChatGeneration,
  ChatGenerationRegistry,
  UserChatGenerationRegistry,
  isChatGenerationCancelled,
  throwIfChatGenerationCancelled,
} from './utils/chatCancellation.js';

const chatRequestService = new ChatRequestService({
  chatGenerationService,
  personaService,
  preferencesService,
});
const logger = createLogger('websocket');
const CHAT_WS_MAX_PAYLOAD_BYTES = positiveInteger(
  process.env.CHAT_WS_MAX_PAYLOAD_BYTES,
  10 * 1024 * 1024
);
const CHAT_WS_MAX_MESSAGES_PER_MINUTE = positiveInteger(
  process.env.CHAT_WS_MAX_MESSAGES_PER_MINUTE,
  120
);
const CHAT_WS_MAX_ACTIVE_GENERATIONS_PER_USER = positiveInteger(
  process.env.CHAT_WS_MAX_ACTIVE_GENERATIONS_PER_USER,
  4
);
const CHAT_WS_MAX_CONNECTIONS_PER_USER = positiveInteger(
  process.env.CHAT_WS_MAX_CONNECTIONS_PER_USER,
  5
);
const activeGenerationsByUser = new UserChatGenerationRegistry(
  CHAT_WS_MAX_ACTIVE_GENERATIONS_PER_USER
);
const activeConnectionsByUser = new Map<string, number>();

interface AuthenticatedChatRequest extends IncomingMessage {
  chatAuth?: {
    userId: string;
    sessionExpiresAt: number;
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function reserveChatConnection(userId: string): (() => void) | null {
  const active = activeConnectionsByUser.get(userId) || 0;
  if (active >= CHAT_WS_MAX_CONNECTIONS_PER_USER) return null;
  activeConnectionsByUser.set(userId, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (activeConnectionsByUser.get(userId) || 1) - 1;
    if (remaining > 0) activeConnectionsByUser.set(userId, remaining);
    else activeConnectionsByUser.delete(userId);
  };
}

export const isAllowedWebSocketOrigin = (
  origin: string | undefined,
  configuredOrigins = [process.env.CORS_ORIGIN, process.env.BASE_URL]
): boolean => {
  if (!origin) return true;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  const allowed = configuredOrigins
    .flatMap(value => value?.split(',') || [])
    .map(value => value.trim())
    .filter(Boolean)
    .flatMap(value => {
      try {
        return [new URL(value).origin];
      } catch {
        return [];
      }
    });
  return allowed.length === 0 || allowed.includes(requestOrigin);
};

const authorizeChatUpgrade = async (
  request: AuthenticatedChatRequest
): Promise<{ userId: string; sessionExpiresAt: number } | null> => {
  try {
    const url = new URL(request.url || '', `http://${request.headers.host}`);
    const ticket = url.searchParams.get('ticket')?.trim() || '';
    if (!ticket) return null;
    const consumed = await websocketTicketService.consume(ticket, 'chat');
    if (!consumed) return null;
    const currentUser = await userModel.getUserById(consumed.userId);
    if (!currentUser || currentUser.status !== 'active') return null;
    return {
      userId: currentUser.id,
      sessionExpiresAt: consumed.sessionExpiresAt,
    };
  } catch {
    return null;
  }
};

const rejectUpgrade = (
  socket: Duplex,
  status: 401 | 403,
  message: string
): void => {
  const body = JSON.stringify({ success: false, message });
  socket.end(
    `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  );
};

export interface RegisteredWebSocketServers {
  close(): Promise<void>;
}

const closeWebSocketServer = (server: WebSocketServer): Promise<void> => {
  for (const client of server.clients) client.terminate();
  return new Promise(resolve => {
    server.close(() => resolve());
  });
};

export function registerWebSocketServer(
  server: Server
): RegisteredWebSocketServers {
  let shuttingDown = false;
  let closePromise: Promise<void> | undefined;
  const activeMessageHandlers = new Set<Promise<void>>();
  const activeUpgradeAuthorizations = new Set<Promise<void>>();

  // WebSocket server for real-time chat streaming. Upgrades are dispatched by
  // path in index.ts so the Work terminal can share the same HTTP server.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: CHAT_WS_MAX_PAYLOAD_BYTES,
  });

  wss.on('connection', (ws, rawRequest) => {
    if (shuttingDown) {
      ws.terminate();
      return;
    }
    logger.debug('WebSocket client connected');
    const req = rawRequest as AuthenticatedChatRequest;
    const chatAuth = req.chatAuth;
    if (!chatAuth) {
      ws.close(1008, 'Authentication required');
      return;
    }
    const { userId, sessionExpiresAt } = chatAuth;
    const releaseConnection = reserveChatConnection(userId);
    if (!releaseConnection) {
      ws.close(1008, 'Too many active Chat connections');
      return;
    }
    const activeGenerations = new ChatGenerationRegistry();
    const sessionExpiryTimer = setTimeout(
      () => ws.close(1008, 'Session expired'),
      Math.max(0, Math.min(sessionExpiresAt - Date.now(), 2_147_483_647))
    );
    let messageWindowStartedAt = Date.now();
    let messageCount = 0;

    const handleMessage = async (data: RawData): Promise<void> => {
      let currentGeneration: ActiveChatGeneration | undefined;
      let globallyReserved = false;
      try {
        const now = Date.now();
        if (now - messageWindowStartedAt >= 60_000) {
          messageWindowStartedAt = now;
          messageCount = 0;
        }
        messageCount += 1;
        if (messageCount > CHAT_WS_MAX_MESSAGES_PER_MINUTE) {
          ws.close(1008, 'Message rate limit exceeded');
          return;
        }

        const currentUser = await userModel.getUserById(userId);
        if (
          !currentUser ||
          currentUser.status !== 'active' ||
          currentUser.id !== userId ||
          sessionExpiresAt <= Date.now()
        ) {
          ws.close(1008, 'Session expired or account unavailable');
          return;
        }

        const message = JSON.parse(data.toString());

        if (message.type === 'chat_cancel') {
          const assistantMessageId = message.data?.assistantMessageId;
          const sessionId = message.data?.sessionId;
          if (!activeGenerations.cancel(sessionId, assistantMessageId)) {
            sendAssistantCancelled(
              ws,
              {
                assistantMessageId,
                sessionId,
                cancelled: false,
              },
              { ignoreClosedSocket: true }
            );
          }
          return;
        }

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
            webSearch: webSearchRequested,
          } = message.data;
          if (
            typeof assistantMessageId !== 'string' ||
            !assistantMessageId.trim()
          ) {
            sendError(ws, { error: 'An assistant message ID is required.' });
            return;
          }
          if (typeof sessionId !== 'string' || !sessionId.trim()) {
            sendError(ws, { error: 'A session ID is required.' });
            return;
          }

          currentGeneration = activeGenerations.start(
            sessionId,
            assistantMessageId
          );
          activeGenerationsByUser.start(userId, currentGeneration);
          globallyReserved = true;
          const generationSignal = currentGeneration.controller.signal;
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
          throwIfChatGenerationCancelled(generationSignal);

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

          // RAG through the same collection-aware builder as the REST
          // routes: session uploads, attached knowledge collections, and
          // the user's standing uploads. Private sessions skip documents —
          // nothing about them should touch persisted per-user state.
          let documentContext = EMPTY_CHAT_DOCUMENT_CONTEXT(content);
          if (!isPrivate) {
            try {
              documentContext = await buildChatDocumentContext(
                content,
                sessionId,
                userId,
                generationSignal
              );
            } catch (contextError) {
              throwIfChatGenerationCancelled(generationSignal);
              logger.error('Error during document search:', contextError);
            }
          }
          if (documentContext.sources.length > 0) {
            logger.debug(
              `Document context drawn from ${documentContext.sources.length} document(s)`
            );
          }

          // Requested web search composes on top of any document context.
          // The tool status feeds the existing activity indicator; a failed
          // search degrades to a normal reply rather than failing the turn.
          let webSearchSources:
            Array<{ title: string; url: string }> | undefined;
          let searchEnhancedContent = documentContext.enhancedContent;
          let searchHasRelevantContext = documentContext.hasRelevantContext;
          if (
            webSearchRequested === true &&
            isWebSearchAvailable() &&
            userCanUseWebSearch(currentUser)
          ) {
            const searchToolCallId = `web-search-${Date.now()}`;
            sendToolStatus(ws, {
              toolCallId: searchToolCallId,
              name: 'web_search',
              phase: 'running',
            });
            try {
              const results = await runWebSearch(
                content,
                undefined,
                generationSignal
              );
              if (results.length > 0) {
                searchEnhancedContent = buildWebSearchEnhancedContent(
                  searchEnhancedContent,
                  results,
                  content
                );
                searchHasRelevantContext = true;
                webSearchSources = results.map(({ title, url }) => ({
                  title,
                  url,
                }));
              }
              sendToolStatus(ws, {
                toolCallId: searchToolCallId,
                name: 'web_search',
                phase: 'completed',
              });
            } catch (searchError) {
              throwIfChatGenerationCancelled(generationSignal);
              logger.error(
                'Web search failed; answering without it:',
                searchError
              );
              sendToolStatus(ws, {
                toolCallId: searchToolCallId,
                name: 'web_search',
                phase: 'failed',
              });
            }
          }
          const withContextSources = (
            metadata: Record<string, unknown> | undefined
          ): Record<string, unknown> | undefined => {
            const extras: Record<string, unknown> = {};
            if (webSearchSources?.length) {
              extras.webSearchSources = webSearchSources;
            }
            if (documentContext.sources.length > 0) {
              extras.ragSources = documentContext.sources;
            }
            return Object.keys(extras).length > 0
              ? { ...(metadata ?? {}), ...extras }
              : metadata;
          };

          let assistantContent = '';
          let assistantThinking = '';
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
              hasRelevantContext: searchHasRelevantContext,
              enhancedContent: searchEnhancedContent,
              signal: generationSignal,
            });
          throwIfChatGenerationCancelled(generationSignal);

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
                        userId,
                        { model: actualModelName, signal: generationSignal }
                      )
                    : pluginService.executePluginStreamRequest(
                        actualModelName,
                        pluginMessages,
                        mergedOptions,
                        userId,
                        (activePlugin as NonNullable<typeof activePlugin>).id,
                        generationSignal
                      ),
                  messageId: assistantMessageId,
                  signal: generationSignal,
                });
                assistantContent = streamResult.content;
                assistantThinking = streamResult.thinking || '';
                assistantProviderMetadata = streamResult.providerMetadata;
              } else {
                const generationResult =
                  await chatGenerationService.executeNonStreaming({
                    target: generationTarget,
                    ollamaMessages,
                    pluginMessages,
                    userId,
                    pluginFallbackPolicy: 'disabled',
                    signal: generationSignal,
                  });

                assistantContent = generationResult.assistantContent;
                assistantThinking = generationResult.assistantThinking || '';
                assistantProviderMetadata =
                  generationResult.response.message.providerMetadata;

                if (assistantThinking) {
                  sendAssistantChunk(ws, {
                    content: '',
                    total: '',
                    thinking: assistantThinking,
                    thinkingTotal: assistantThinking,
                    done: !assistantContent,
                    messageId: assistantMessageId,
                  });
                }

                if (assistantContent) {
                  await streamAssistantFakeChunks(
                    ws,
                    assistantContent,
                    assistantMessageId,
                    100,
                    generationSignal
                  );
                }
              }

              throwIfChatGenerationCancelled(generationSignal);

              // Save the complete assistant message (skip for private sessions)
              if (
                (assistantContent || assistantThinking) &&
                assistantMessageId
              ) {
                const completion =
                  assistantCompletionService.completeAssistantMessage({
                    sessionId,
                    session,
                    content: assistantContent,
                    thinking: assistantThinking || undefined,
                    model: session.model,
                    messageId: assistantMessageId,
                    userId,
                    isPrivate,
                    regenerate,
                    originalMessageId,
                    providerMetadata: withContextSources(
                      assistantProviderMetadata
                    ),
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
              throwIfChatGenerationCancelled(generationSignal);
              const err =
                pluginError instanceof Error
                  ? pluginError
                  : new Error(String(pluginError));
              const errWithResponse = pluginError as Record<
                string,
                unknown
              > | null;
              logger.error('Plugin request failed:', err.message);
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
                  } failed for model ${actualModelName}`
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
            userId,
            signal: generationSignal,
          });

          assistantContent = ollamaStream.content;
          assistantThinking = ollamaStream.thinking || '';

          throwIfChatGenerationCancelled(generationSignal);

          if (!ollamaStream.completed) {
            return;
          }

          // Save the complete assistant message with the provided ID (skip for private sessions)
          if ((assistantContent || assistantThinking) && assistantMessageId) {
            const completion =
              assistantCompletionService.completeAssistantMessage({
                sessionId,
                session,
                content: assistantContent,
                thinking: assistantThinking || undefined,
                model: session.model,
                messageId: assistantMessageId,
                userId,
                isPrivate,
                regenerate,
                originalMessageId,
                statistics: ollamaStream.statistics,
                providerMetadata: withContextSources(undefined),
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
                thinking: assistantThinking || undefined,
                role: 'assistant',
                timestamp: Date.now(),
                messageId: assistantMessageId,
                statistics: ollamaStream.statistics,
                ...(withContextSources(undefined)
                  ? { providerMetadata: withContextSources(undefined) }
                  : {}),
                ...completion.branchingFields,
              });
            }
          }
        }
      } catch (error: unknown) {
        if (
          currentGeneration &&
          isChatGenerationCancelled(error, currentGeneration.controller.signal)
        ) {
          sendAssistantCancelled(
            ws,
            {
              assistantMessageId: currentGeneration.assistantMessageId,
              sessionId: currentGeneration.sessionId,
              cancelled: true,
            },
            { ignoreClosedSocket: true }
          );
          return;
        }
        logger.error('WebSocket error:', error);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        sendError(ws, { error: errorMessage });
      } finally {
        if (currentGeneration) {
          activeGenerations.finish(currentGeneration);
          if (globallyReserved) {
            activeGenerationsByUser.finish(userId, currentGeneration);
          }
        }
      }
    };

    ws.on('message', data => {
      if (shuttingDown) return;

      let trackedHandler: Promise<void>;
      trackedHandler = handleMessage(data)
        .catch(error => {
          // EventEmitter does not observe rejected async listeners. Contain a
          // late send failure after shutdown while retaining the handler in
          // the drain set until every provider and persistence operation has
          // actually settled.
          logger.error('WebSocket message handler failed:', error);
        })
        .finally(() => activeMessageHandlers.delete(trackedHandler));
      activeMessageHandlers.add(trackedHandler);
    });

    ws.on('close', () => {
      clearTimeout(sessionExpiryTimer);
      releaseConnection();
      activeGenerations.cancelAll(
        'The WebSocket closed before generation completed.'
      );
      logger.debug('WebSocket client disconnected');
    });

    ws.on('error', error => {
      logger.error('WebSocket error:', error);
    });

    // Send initial connection confirmation
    sendConnected(ws);
  });

  const terminalServer = createWorkTerminalServer();
  const upgradedSockets = new Set<Duplex>();

  const handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    upgradedSockets.add(socket);
    socket.once('close', () => upgradedSockets.delete(socket));
    if (workPreviewProxyService.tryHandleUpgrade(request, socket, head)) {
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url || '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === WORK_TERMINAL_WS_PATH) {
      if (!isAllowedWebSocketOrigin(request.headers.origin)) {
        rejectUpgrade(socket, 403, 'WebSocket origin is not allowed');
        return;
      }
      terminalServer.handleUpgrade(request, socket, head, ws => {
        terminalServer.emit('connection', ws, request);
      });
      return;
    }
    if (pathname === '/ws') {
      if (!isAllowedWebSocketOrigin(request.headers.origin)) {
        rejectUpgrade(socket, 403, 'WebSocket origin is not allowed');
        return;
      }
      const authenticatedRequest = request as AuthenticatedChatRequest;
      socket.pause();
      let authorization: Promise<void>;
      authorization = authorizeChatUpgrade(authenticatedRequest)
        .then(chatAuth => {
          if (shuttingDown) {
            socket.destroy();
            return;
          }
          if (!chatAuth) {
            rejectUpgrade(socket, 401, 'WebSocket authentication is required');
            return;
          }
          authenticatedRequest.chatAuth = chatAuth;
          wss.handleUpgrade(request, socket, head, ws => {
            wss.emit('connection', ws, request);
          });
          socket.resume();
        })
        .catch(error => {
          logger.error('WebSocket upgrade authorization failed:', error);
          if (!shuttingDown) {
            rejectUpgrade(socket, 401, 'WebSocket authentication is required');
          }
        })
        .finally(() => activeUpgradeAuthorizations.delete(authorization));
      activeUpgradeAuthorizations.add(authorization);
      return;
    }
    socket.destroy();
  };
  server.on('upgrade', handleUpgrade);

  return {
    close: () => {
      if (closePromise) return closePromise;
      shuttingDown = true;
      closePromise = (async () => {
        server.off('upgrade', handleUpgrade);
        for (const socket of upgradedSockets) socket.destroy();
        upgradedSockets.clear();
        await Promise.allSettled([
          closeWebSocketServer(wss),
          closeWebSocketServer(terminalServer),
        ]);
        // Socket close aborts every active generation. Wait for their async
        // handlers to honor that signal (or finish independently) before the
        // caller closes SQLite and snapshots its WAL state.
        await Promise.allSettled([
          ...activeUpgradeAuthorizations,
          ...activeMessageHandlers,
        ]);
      })();
      return closePromise;
    },
  };
}
