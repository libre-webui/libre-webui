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
import openclawSessionService, {
  extractTextFromMessage,
  type ToolStreamEvent,
  type ChatDeltaEvent,
} from './services/openclawSessionService.js';
import chatGenerationService from './services/chatGenerationService.js';
import assistantCompletionService from './services/assistantCompletionService.js';
import { toOllamaMessages } from './utils/chatContext.js';
import { streamOllamaChatResponse } from './utils/ollamaStreaming.js';
import { preparePluginChatContext } from './utils/pluginChatContext.js';
import { streamPluginResponse } from './utils/pluginStreaming.js';
import {
  sendAssistantChunk,
  sendAssistantComplete,
  sendConnected,
  sendError,
  sendToolStatus,
  sendUserMessage,
  streamAssistantFakeChunks,
} from './utils/websocketMessages.js';
import { verifyToken } from './utils/jwt.js';
import { OllamaChatRequest, ChatSession } from './types/index.js';

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
          let enhancedContent = content;

          if (relevantContext.length > 0) {
            console.log(
              `Found ${relevantContext.length} relevant document chunks for query`
            );

            // Inject document context into the user message
            const contextString = relevantContext.join('\n\n---\n\n');
            enhancedContent = `Context from uploaded documents:\n\n${contextString}\n\n---\n\nUser question: ${content}`;

            // Update the user message with enhanced content that includes document context
            // We'll create a new message with the enhanced content for the AI model
            console.log('Enhanced user message with document context');
          }

          // Use the modern chat completion API instead of legacy generate API
          // This supports multimodal input and structured outputs
          // For private sessions, use the message history sent from frontend
          type ContextMessage = {
            role: 'user' | 'assistant' | 'system';
            content: string;
            images?: string[];
          };
          const contextMessages: ContextMessage[] = isPrivate
            ? (messageHistory || []).concat([
                { role: 'user' as const, content, images: images || undefined },
              ])
            : chatService.getMessagesForContext(sessionId);

          // Convert our messages to Ollama format.
          const ollamaMessages = toOllamaMessages(contextMessages, {
            latestUserContent:
              relevantContext.length > 0 ? enhancedContent : undefined,
          });

          let assistantContent = '';

          console.log('Backend: Using assistantMessageId:', assistantMessageId);

          const generationTarget =
            await chatGenerationService.prepareGenerationTarget(
              session.model,
              userId,
              options
            );
          const {
            actualModelName,
            mergedOptions,
            activePlugin,
            pluginVariables: pluginVars,
          } = generationTarget;

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
            // OpenClaw Session Mode — route through WebSocket gateway
            // ---------------------------------------------------------------
            // OpenClaw session routing now handled via x-openclaw-session-key HTTP header
            // in pluginService — no WebSocket needed
            const isOpenClawSession = false; // Disabled: WS approach replaced by HTTP header

            if (isOpenClawSession) {
              console.log(
                '[WebSocket] OpenClaw session mode: routing through gateway WS'
              );

              try {
                // Ensure the gateway WS connection is established
                const endpoint =
                  (pluginVars.endpoint as string) ||
                  activePlugin.endpoint ||
                  'http://127.0.0.1:18789/v1/chat/completions';
                const apiKey =
                  pluginService.getApiKey(activePlugin, userId) || '';
                const ocSessionKey =
                  (pluginVars.session_key as string) || 'main';

                if (!openclawSessionService.isConnected) {
                  openclawSessionService.connect({
                    gatewayUrl: endpoint,
                    token: apiKey,
                    sessionKey: ocSessionKey,
                  });
                  // Wait a bit for connection
                  await new Promise<void>(resolve => {
                    const maxWait = 8000;
                    const start = Date.now();
                    const check = () => {
                      if (openclawSessionService.isConnected) {
                        resolve();
                      } else if (Date.now() - start > maxWait) {
                        resolve(); // proceed anyway, will error on send
                      } else {
                        setTimeout(check, 200);
                      }
                    };
                    check();
                  });
                }

                if (!openclawSessionService.isConnected) {
                  throw new Error(
                    'Failed to connect to OpenClaw gateway WebSocket'
                  );
                }

                // Build the message to send
                const messageText = userMessage?.content || content;

                // Set up event listener for this run
                let totalContent = '';
                let currentRunId: string | null = null;
                let runDone = false;
                const toolCalls: Array<{
                  id: string;
                  name: string;
                  phase: string;
                  args?: string;
                  result?: string;
                }> = [];

                const cleanup = openclawSessionService.subscribe(
                  (type, data) => {
                    if (runDone) return;

                    if (type === 'chat') {
                      const chatEvent = data as ChatDeltaEvent;
                      if (
                        currentRunId &&
                        chatEvent.runId &&
                        chatEvent.runId !== currentRunId
                      )
                        return;

                      if (chatEvent.state === 'delta') {
                        const text = extractTextFromMessage(chatEvent.message);
                        if (
                          typeof text === 'string' &&
                          text.length > totalContent.length
                        ) {
                          // Send incremental delta
                          const newContent = text.slice(totalContent.length);
                          totalContent = text;
                          sendAssistantChunk(
                            ws,
                            {
                              content: newContent,
                              total: totalContent,
                              done: false,
                              messageId: assistantMessageId,
                            },
                            { ignoreClosedSocket: true }
                          );
                        }
                      } else if (
                        chatEvent.state === 'final' ||
                        chatEvent.state === 'aborted' ||
                        chatEvent.state === 'error'
                      ) {
                        runDone = true;

                        if (chatEvent.state === 'error') {
                          const errMsg =
                            chatEvent.errorMessage || 'Agent error';
                          if (!totalContent) totalContent = `Error: ${errMsg}`;
                        }

                        // Append tool call summaries
                        if (toolCalls.length > 0) {
                          let toolContent = '\n\n---\n**🔧 Tools Used:**\n';
                          for (const tc of toolCalls) {
                            const statusIcon =
                              tc.phase === 'result' ? '✅' : '⏳';
                            toolContent += `\n${statusIcon} **${tc.name}**`;
                            if (tc.result) {
                              const resultStr =
                                typeof tc.result === 'string'
                                  ? tc.result
                                  : JSON.stringify(tc.result);
                              if (resultStr.length <= 500) {
                                toolContent += `\n<details><summary>Result</summary>\n\n\`\`\`\n${resultStr}\n\`\`\`\n</details>\n`;
                              } else {
                                toolContent += `\n<details><summary>Result (${resultStr.length} chars)</summary>\n\n\`\`\`\n${resultStr.slice(0, 500)}…\n\`\`\`\n</details>\n`;
                              }
                            }
                          }
                          totalContent += toolContent;
                        }

                        // Send final chunk
                        sendAssistantChunk(
                          ws,
                          {
                            content: '',
                            total: totalContent,
                            done: true,
                            messageId: assistantMessageId,
                          },
                          { ignoreClosedSocket: true }
                        );
                      }
                    } else if (type === 'tool') {
                      const toolEvent = data as ToolStreamEvent;
                      // Track tool calls
                      const existing = toolCalls.find(
                        t => t.id === toolEvent.toolCallId
                      );
                      if (existing) {
                        existing.phase = toolEvent.phase;
                        if (toolEvent.result)
                          existing.result =
                            typeof toolEvent.result === 'string'
                              ? toolEvent.result
                              : JSON.stringify(toolEvent.result);
                      } else {
                        toolCalls.push({
                          id: toolEvent.toolCallId,
                          name: toolEvent.name,
                          phase: toolEvent.phase,
                          args: toolEvent.args
                            ? JSON.stringify(toolEvent.args)
                            : undefined,
                          result: toolEvent.result
                            ? typeof toolEvent.result === 'string'
                              ? toolEvent.result
                              : JSON.stringify(toolEvent.result)
                            : undefined,
                        });
                      }

                      // Send tool status to frontend
                      // Send tool_status event for the activity indicator
                      sendToolStatus(
                        ws,
                        {
                          toolCallId: toolEvent.toolCallId,
                          name: toolEvent.name,
                          phase:
                            toolEvent.phase === 'start'
                              ? 'running'
                              : toolEvent.phase,
                        },
                        { ignoreClosedSocket: true }
                      );

                      const toolStatusMsg =
                        toolEvent.phase === 'start'
                          ? `\n\n🔧 *Using tool: ${toolEvent.name}…*\n`
                          : '';
                      if (toolStatusMsg) {
                        totalContent += toolStatusMsg;
                        sendAssistantChunk(
                          ws,
                          {
                            content: toolStatusMsg,
                            total: totalContent,
                            done: false,
                            messageId: assistantMessageId,
                          },
                          { ignoreClosedSocket: true }
                        );
                      }
                    }
                  }
                );

                // Send the message
                const result = await openclawSessionService.sendMessage(
                  messageText,
                  ocSessionKey
                );
                currentRunId = result.runId;

                // Wait for completion (max 5 minutes)
                await new Promise<void>(resolve => {
                  const timeout = setTimeout(() => {
                    runDone = true;
                    resolve();
                  }, 300000);

                  const checkDone = setInterval(() => {
                    if (runDone) {
                      clearInterval(checkDone);
                      clearTimeout(timeout);
                      resolve();
                    }
                  }, 100);
                });

                // Clean up listener
                cleanup();

                // Save the assistant message
                assistantContent = totalContent;
              } catch (error) {
                console.error('[WebSocket] OpenClaw session error:', error);
                const errorMsg =
                  error instanceof Error ? error.message : String(error);
                assistantContent = `Error: ${errorMsg}`;
                sendAssistantChunk(ws, {
                  content: assistantContent,
                  total: assistantContent,
                  done: true,
                  messageId: assistantMessageId,
                });
              }

              // Save assistant message from session mode
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
                  sendAssistantComplete(ws, completion.privateMessage);
                } else {
                  sendAssistantComplete(ws, completion.assistantMessage);
                }
              }
              return; // Exit early — handled via OpenClaw session
            } else {
              // ---------------------------------------------------------------
              // Standard plugin path (stateless HTTP completions)
              // ---------------------------------------------------------------

              try {
                const { messages: messagesForPlugin, shouldStream } =
                  preparePluginChatContext({
                    isPrivate,
                    persistedMessages: isPrivate
                      ? []
                      : chatService.getMessagesForContext(sessionId),
                    messageHistory: (messageHistory || []) as ContextMessage[],
                    regenerate,
                    content,
                    images: images || undefined,
                    hasRelevantContext: relevantContext.length > 0,
                    enhancedContent,
                    pluginVariables: pluginVars,
                  });

                if (shouldStream) {
                  assistantContent = await streamPluginResponse({
                    ws,
                    chunks: pluginService.executePluginStreamRequest(
                      actualModelName,
                      messagesForPlugin,
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
                      pluginMessages: messagesForPlugin,
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
            } // close else (standard plugin path)
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
