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

import express, { Response } from 'express';
import rateLimit from 'express-rate-limit';
import chatService from '../services/chatService.js';
import ollamaService from '../services/ollamaService.js';
import pluginService from '../services/pluginService.js';
import { personaService } from '../services/personaService.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import { extractStatistics } from '../utils/generationUtils.js';
import agentCliService from '../services/agentCliService.js';
import {
  buildWebSearchEnhancedContent,
  isWebSearchAvailable,
  userCanUseWebSearch,
  webSearch as runWebSearch,
  type WebSearchResult,
} from '../services/webSearchService.js';
import { userModel } from '../models/userModel.js';
import chatGenerationService from '../services/chatGenerationService.js';
import preferencesService from '../services/preferencesService.js';
import { ChatRequestService } from '../services/chatRequestService.js';
import { TitleGenerationService } from '../services/titleGenerationService.js';
import { FollowUpService } from '../services/followUpService.js';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  getErrorMessage,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  buildChatDocumentContext,
  EMPTY_CHAT_DOCUMENT_CONTEXT,
} from '../utils/chatDocumentContext.js';
import { ChatProviderSelectionError } from '../utils/chatProviderSelection.js';
import { formatPluginStreamToolCalls } from '../utils/pluginStreaming.js';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import {
  abortChatGenerationOnResponseClose,
  isChatGenerationCancelled,
  throwIfChatGenerationCancelled,
} from '../utils/chatCancellation.js';

const logger = createLogger('routes:chat');

function sendSessionFolderError(
  res: Response<ApiResponse>,
  error: unknown,
  fallback: string
) {
  if (error instanceof ResourcePolicyError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: getErrorMessage(error, fallback),
  });
}

const router = express.Router();
const titleGenerationService = new TitleGenerationService({
  chatService,
  chatGenerationService,
  pluginService,
  ollamaService,
});
const chatRequestService = new ChatRequestService({
  chatGenerationService,
  personaService,
  preferencesService,
});
const followUpService = new FollowUpService({
  chatService,
  chatGenerationService,
  pluginService,
  ollamaService,
});

// Rate limiter for chat routes: 60 requests per minute (reasonable for chat)
const chatRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per minute
  message: {
    success: false,
    message: 'Too many chat requests, please slow down',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiter to all chat routes
router.use(chatRateLimiter);

// Apply authentication middleware to all chat routes
router.use(authenticate);

// Get all chat sessions
router.get(
  '/sessions',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession[]>>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      const sessions = chatService.getAllSessions(userId);
      res.json({
        success: true,
        data: sessions,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load sessions'),
      });
    }
  }
);

// Create a new chat session
router.post(
  '/sessions',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const { model, title, personaId, providerType, providerId } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required',
        });
        return;
      }

      const userId = req.user?.userId || 'default';

      // Extract persona ID from model string if it starts with "persona:"
      let extractedPersonaId = personaId;
      if (model.startsWith('persona:') && !extractedPersonaId) {
        extractedPersonaId = model.replace('persona:', '');
      }

      const session = await chatService.createSession(
        model,
        title,
        userId,
        extractedPersonaId,
        { providerType, providerId }
      );
      res.json({
        success: true,
        data: session,
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to create session'),
      });
    }
  }
);

// Get a specific chat session
router.get(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = req.user?.userId || 'default';
      const session = chatService.getSession(sessionId, userId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: session,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get session'),
      });
    }
  }
);

// Update a chat session
router.put(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const updates = req.body;

      const userId = req.user?.userId || 'default';
      const updatedSession = await chatService.updateSession(
        sessionId,
        updates,
        userId
      );

      if (!updatedSession) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: updatedSession,
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update session'),
      });
    }
  }
);

// Update a message in a chat session
router.put(
  '/sessions/:sessionId/messages/:messageId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatMessage>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const updates = req.body;
      const userId = req.user?.userId || 'default';

      const updatedMessage = chatService.updateMessage(
        sessionId,
        messageId,
        updates,
        userId
      );

      if (!updatedMessage) {
        res.status(404).json({
          success: false,
          error: 'Session or message not found',
        });
        return;
      }

      res.json({
        success: true,
        data: updatedMessage,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update message'),
      });
    }
  }
);

// Delete a chat session
router.delete(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = req.user?.userId || 'default';
      const deleted = chatService.deleteSession(sessionId, userId);

      if (!deleted) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Session deleted successfully',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete session'),
      });
    }
  }
);

// Clear all chat sessions
router.delete(
  '/sessions',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const userId = req.user?.userId || 'default';
      chatService.clearAllSessions(userId);
      res.json({
        success: true,
        message: 'All chat sessions cleared successfully',
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to clear sessions'),
      });
    }
  }
);

// Add a message to a session
router.post(
  '/sessions/:sessionId/messages',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatMessage>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const { role, content, id, model } = req.body;

      if (!role || !content) {
        res.status(400).json({
          success: false,
          error: 'Role and content are required',
        });
        return;
      }

      const userId = req.user?.userId || 'default';
      const session = chatService.getSession(sessionId, userId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      const message = chatService.addMessage(
        sessionId,
        {
          role,
          content,
          model,
          id, // Use provided ID if available
        },
        userId
      );

      if (!message) {
        res.status(500).json({
          success: false,
          error: 'Failed to add message',
        });
        return;
      }
      res.json({
        success: true,
        data: message,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to add message'),
      });
    }
  }
);

// Generate a chat response
router.post(
  '/sessions/:sessionId/generate',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<ChatMessage>>
  ): Promise<void> => {
    const { controller, cleanup } = abortChatGenerationOnResponseClose(res);
    const signal = controller.signal;
    try {
      const sessionId = req.params.sessionId as string;
      const { message, options = {} } = req.body;

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Message is required',
        });
        return;
      }
      const userId = req.user?.userId || 'default';
      const session = chatService.getSession(sessionId, userId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      // Add user message to session
      const userMessage = chatService.addMessage(
        sessionId,
        {
          role: 'user',
          content: message,
        },
        userId
      );

      if (!userMessage) {
        res.status(500).json({
          success: false,
          error: 'Failed to add user message',
        });
        return;
      }

      let documentContext = EMPTY_CHAT_DOCUMENT_CONTEXT(message);
      try {
        documentContext = await buildChatDocumentContext(
          message,
          sessionId,
          userId,
          signal
        );
      } catch (error) {
        throwIfChatGenerationCancelled(signal);
        logger.error('Error during document search:', error);
      }

      // Requested web search composes on top of any document context; a
      // failed search degrades to a normal reply rather than failing it.
      let webSearchSources: Array<{ title: string; url: string }> | undefined;
      let enhancedContent = documentContext.enhancedContent;
      let hasRelevantContext = documentContext.hasRelevantContext;
      if (
        req.body?.webSearch === true &&
        isWebSearchAvailable() &&
        userCanUseWebSearch(await userModel.getUserById(userId))
      ) {
        try {
          const results: WebSearchResult[] = await runWebSearch(
            message,
            undefined,
            signal
          );
          if (results.length > 0) {
            enhancedContent = buildWebSearchEnhancedContent(
              enhancedContent,
              results,
              message
            );
            hasRelevantContext = true;
            webSearchSources = results.map(({ title, url }) => ({
              title,
              url,
            }));
          }
        } catch (error) {
          throwIfChatGenerationCancelled(signal);
          logger.error('Web search failed; answering without it:', error);
        }
      }

      const preparedGeneration =
        await chatRequestService.prepareGenerationRequest({
          session,
          userId,
          options,
          persistedMessages: chatService.getMessagesForContext(sessionId),
          content: message,
          hasRelevantContext,
          enhancedContent,
          signal,
        });

      const generationResult = await chatGenerationService.executeNonStreaming({
        target: preparedGeneration.target,
        ollamaMessages: preparedGeneration.ollamaMessages,
        pluginMessages: preparedGeneration.pluginMessages,
        userId,
        pluginFallbackPolicy: 'allow',
        signal,
      });

      throwIfChatGenerationCancelled(signal);

      if (generationResult.pluginError) {
        logger.error(
          'Plugin failed, falling back to Ollama:',
          generationResult.pluginError
        );
      }

      // Add assistant response to session with statistics
      const statistics = extractStatistics(generationResult.response);
      const assistantMessage = chatService.addMessage(
        sessionId,
        {
          role: 'assistant',
          content: generationResult.assistantContent,
          thinking: generationResult.assistantThinking,
          model: session.model,
          statistics,
          providerMetadata:
            webSearchSources?.length || documentContext.sources.length > 0
              ? {
                  ...(generationResult.response.message.providerMetadata ?? {}),
                  ...(webSearchSources?.length ? { webSearchSources } : {}),
                  ...(documentContext.sources.length > 0
                    ? { ragSources: documentContext.sources }
                    : {}),
                }
              : generationResult.response.message.providerMetadata,
        },
        userId
      );

      if (!assistantMessage) {
        res.status(500).json({
          success: false,
          error: 'Failed to add assistant message',
        });
        return;
      }

      res.json({
        success: true,
        data: assistantMessage,
      });
    } catch (error: unknown) {
      if (isChatGenerationCancelled(error, signal)) {
        if (!res.writableEnded) res.status(499).end();
        return;
      }
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate response'),
      });
    } finally {
      cleanup();
    }
  }
);

// Generate a chat response with streaming
router.post(
  '/sessions/:sessionId/generate/stream',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { controller, cleanup } = abortChatGenerationOnResponseClose(res);
    const signal = controller.signal;
    try {
      const sessionId = req.params.sessionId as string;
      const { message, options = {} } = req.body;

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Message is required',
        });
        return;
      }
      const userId = req.user?.userId || 'default';
      const session = chatService.getSession(sessionId, userId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      // Set up SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Add user message to session
      const userMessage = chatService.addMessage(
        sessionId,
        {
          role: 'user',
          content: message,
        },
        userId
      );

      if (!userMessage) {
        res.write(
          `data: ${JSON.stringify({ error: 'Failed to add user message' })}\n\n`
        );
        res.end();
        return;
      }

      // Document context first, matching the WebSocket and non-stream
      // paths; search composes on top of it.
      let documentContext = EMPTY_CHAT_DOCUMENT_CONTEXT(message);
      try {
        documentContext = await buildChatDocumentContext(
          message,
          sessionId,
          userId,
          signal
        );
      } catch (contextError) {
        throwIfChatGenerationCancelled(signal);
        logger.error('Error during document search:', contextError);
      }

      // Requested web search runs before generation and reports its own
      // progress so the interface can show a searching state; failure
      // degrades to a normal reply.
      let webSearchSources: Array<{ title: string; url: string }> | undefined;
      let searchEnhancedContent: string | undefined;
      if (
        req.body?.webSearch === true &&
        isWebSearchAvailable() &&
        userCanUseWebSearch(await userModel.getUserById(userId))
      ) {
        res.write(
          `data: ${JSON.stringify({ type: 'search', status: 'searching' })}\n\n`
        );
        try {
          const results: WebSearchResult[] = await runWebSearch(
            message,
            undefined,
            signal
          );
          if (results.length > 0) {
            searchEnhancedContent = buildWebSearchEnhancedContent(
              documentContext.enhancedContent,
              results,
              message
            );
            webSearchSources = results.map(({ title, url }) => ({
              title,
              url,
            }));
          }
          res.write(
            `data: ${JSON.stringify({
              type: 'search',
              status: 'done',
              sources: webSearchSources ?? [],
            })}\n\n`
          );
        } catch (searchError) {
          throwIfChatGenerationCancelled(signal);
          logger.error('Web search failed; answering without it:', searchError);
          res.write(
            `data: ${JSON.stringify({
              type: 'search',
              status: 'failed',
              error: getErrorMessage(searchError, 'Web search failed.'),
            })}\n\n`
          );
        }
      }
      const withSearchSources = (
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

      const preparedGeneration =
        await chatRequestService.prepareGenerationRequest({
          session,
          userId,
          options,
          persistedMessages: chatService.getMessagesForContext(sessionId),
          content: message,
          enhancedContent:
            searchEnhancedContent ?? documentContext.enhancedContent,
          hasRelevantContext: Boolean(
            searchEnhancedContent ?? documentContext.hasRelevantContext
          ),
          signal,
        });
      throwIfChatGenerationCancelled(signal);
      const {
        target,
        actualModelName,
        mergedOptions,
        activePlugin,
        ollamaMessages,
        pluginMessages,
        shouldStreamPlugin,
      } = preparedGeneration;

      const chatRequest = {
        model: actualModelName,
        messages: ollamaMessages,
        stream: true,
        options: mergedOptions as Record<string, unknown>,
      };

      let fullResponse = '';
      let fullThinking = '';
      let assistantProviderMetadata: Record<string, unknown> | undefined;

      if (target.providerType === 'agent' && target.providerId) {
        for await (const chunk of agentCliService.executeAgentStreamRequest(
          target.providerId,
          pluginMessages,
          userId,
          { model: target.actualModelName, signal }
        )) {
          if (chunk.type === 'content' && chunk.content) {
            fullResponse += chunk.content;
            res.write(
              `data: ${JSON.stringify({
                type: 'chunk',
                content: chunk.content,
                done: false,
              })}\n\n`
            );
          } else if (chunk.type === 'reasoning' && chunk.content) {
            fullThinking += chunk.content;
            res.write(
              `data: ${JSON.stringify({
                type: 'reasoning',
                content: chunk.content,
                done: false,
              })}\n\n`
            );
          } else if (chunk.type === 'done' && chunk.providerMetadata) {
            assistantProviderMetadata = chunk.providerMetadata;
          }
        }

        throwIfChatGenerationCancelled(signal);

        if (fullResponse || fullThinking) {
          chatService.addMessage(
            sessionId,
            {
              role: 'assistant',
              content: fullResponse,
              thinking: fullThinking || undefined,
              model: session.model,
              providerMetadata: withSearchSources(assistantProviderMetadata),
            },
            userId
          );
        }
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }

      if (activePlugin) {
        if (shouldStreamPlugin) {
          const toolCalls: Array<{
            id: string;
            name: string;
            arguments: string;
          }> = [];
          for await (const chunk of pluginService.executePluginStreamRequest(
            actualModelName,
            pluginMessages,
            mergedOptions,
            userId,
            activePlugin.id,
            signal
          )) {
            if (chunk.type === 'content' && chunk.content) {
              fullResponse += chunk.content;
              res.write(
                `data: ${JSON.stringify({
                  type: 'chunk',
                  content: chunk.content,
                  done: false,
                })}\n\n`
              );
            } else if (chunk.type === 'reasoning' && chunk.content) {
              fullThinking += chunk.content;
              res.write(
                `data: ${JSON.stringify({
                  type: 'reasoning',
                  content: chunk.content,
                  done: false,
                })}\n\n`
              );
            } else if (chunk.type === 'tool_call' && chunk.toolCall) {
              toolCalls.push(chunk.toolCall);
            } else if (chunk.type === 'done') {
              if (chunk.doneReason?.startsWith('incomplete:')) {
                const reason =
                  chunk.doneReason.slice('incomplete:'.length) || 'unknown';
                throw new Error(
                  `Provider returned an incomplete response (${reason})`
                );
              }
              assistantProviderMetadata = chunk.providerMetadata
                ? {
                    ...assistantProviderMetadata,
                    ...chunk.providerMetadata,
                  }
                : assistantProviderMetadata;
            }
          }

          throwIfChatGenerationCancelled(signal);

          const toolContent = formatPluginStreamToolCalls(toolCalls);
          if (toolContent) {
            fullResponse += toolContent;
            res.write(
              `data: ${JSON.stringify({
                type: 'chunk',
                content: toolContent,
                done: false,
              })}\n\n`
            );
          }
        } else {
          const generationResult =
            await chatGenerationService.executeNonStreaming({
              target,
              ollamaMessages,
              pluginMessages,
              userId,
              pluginFallbackPolicy: 'allow',
              signal,
            });
          fullResponse = generationResult.assistantContent;
          fullThinking = generationResult.assistantThinking || '';
          assistantProviderMetadata =
            generationResult.response.message.providerMetadata;
          if (fullThinking) {
            res.write(
              `data: ${JSON.stringify({
                type: 'reasoning',
                content: fullThinking,
                done: false,
              })}\n\n`
            );
          }
          res.write(
            `data: ${JSON.stringify({
              type: 'chunk',
              content: fullResponse,
              done: false,
            })}\n\n`
          );
        }

        throwIfChatGenerationCancelled(signal);

        if (fullResponse || fullThinking) {
          chatService.addMessage(
            sessionId,
            {
              role: 'assistant',
              content: fullResponse,
              thinking: fullThinking || undefined,
              model: session.model,
              providerMetadata: withSearchSources(assistantProviderMetadata),
            },
            userId
          );
        }
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }

      // Generate streaming response using Ollama
      await ollamaService.generateChatStreamResponse(
        chatRequest,
        chunk => {
          const thinkingDelta = chunk.message.thinking || '';
          if (thinkingDelta) {
            fullThinking += thinkingDelta;
            res.write(
              `data: ${JSON.stringify({
                type: 'reasoning',
                content: thinkingDelta,
                done: false,
              })}\n\n`
            );
          }

          // Send chunk to client
          res.write(
            `data: ${JSON.stringify({
              type: 'chunk',
              content: chunk.message.content || '',
              done: chunk.done,
            })}\n\n`
          );

          // Accumulate response content
          if (chunk.message.content) {
            fullResponse += chunk.message.content;
          }
        },
        error => {
          if (signal.aborted || res.writableEnded) return;
          res.write(
            `data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`
          );
          res.end();
        },
        () => {
          if (signal.aborted || res.writableEnded) return;
          // Add complete assistant response to session
          if (fullResponse || fullThinking) {
            chatService.addMessage(
              sessionId,
              {
                role: 'assistant',
                content: fullResponse,
                thinking: fullThinking || undefined,
                model: session.model,
                providerMetadata: withSearchSources(undefined),
              },
              userId
            );
          }

          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
        },
        signal,
        { userId }
      );
    } catch (error: unknown) {
      if (isChatGenerationCancelled(error, signal)) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (!res.headersSent) {
        res
          .status(error instanceof ChatProviderSelectionError ? 400 : 500)
          .json({
            success: false,
            error: getErrorMessage(error, 'Failed to generate stream response'),
          });
        return;
      }
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: getErrorMessage(error, 'Failed to generate stream response') })}\n\n`
      );
      res.end();
    } finally {
      cleanup();
    }
  }
);

// Generate a title for a chat session based on the first message
router.post(
  '/sessions/:sessionId/generate-title',
  async (
    req: AuthenticatedRequest,
    res: Response<
      ApiResponse<{
        title: string;
        source: 'plugin' | 'ollama' | 'fallback';
        updatedAt: number;
      }>
    >
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const { model, message, providerType, providerId } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required for title generation',
        });
        return;
      }

      if (!message) {
        res.status(400).json({
          success: false,
          error: 'Message is required for title generation',
        });
        return;
      }

      const userId = req.user?.userId || 'default';
      const titleResult = await titleGenerationService.generateTitleForSession({
        sessionId,
        requestedModel: model,
        message,
        userId,
        providerType,
        providerId,
      });

      if (!titleResult) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: {
          title: titleResult.title,
          source: titleResult.source,
          updatedAt: titleResult.session.updatedAt,
        },
      });
    } catch (error: unknown) {
      res.status(error instanceof ChatProviderSelectionError ? 400 : 500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate title'),
      });
    }
  }
);

// Session folders
router.get(
  '/folders',
  (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const userId = req.user?.userId || 'default';
      res.json({ success: true, data: chatService.getSessionFolders(userId) });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load folders'),
      });
    }
  }
);

router.post(
  '/folders',
  (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const { name } = req.body as { name?: unknown };
      const userId = req.user?.userId || 'default';
      res.json({
        success: true,
        data: chatService.createSessionFolder(name, userId),
      });
    } catch (error: unknown) {
      sendSessionFolderError(res, error, 'Failed to create folder');
    }
  }
);

router.put(
  '/folders/:folderId',
  (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const { name } = req.body as { name?: unknown };
      const userId = req.user?.userId || 'default';
      const folder = chatService.renameSessionFolder(
        req.params.folderId as string,
        name,
        userId
      );
      if (!folder) {
        res.status(404).json({ success: false, error: 'Folder not found' });
        return;
      }
      res.json({ success: true, data: folder });
    } catch (error: unknown) {
      sendSessionFolderError(res, error, 'Failed to rename folder');
    }
  }
);

router.delete(
  '/folders/:folderId',
  (req: AuthenticatedRequest, res: Response<ApiResponse>) => {
    try {
      const userId = req.user?.userId || 'default';
      const deleted = chatService.deleteSessionFolder(
        req.params.folderId as string,
        userId
      );
      if (!deleted) {
        res.status(404).json({ success: false, error: 'Folder not found' });
        return;
      }
      res.json({ success: true, message: 'Folder deleted' });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete folder'),
      });
    }
  }
);

// Suggest follow-up messages for the latest exchange in a session
router.post(
  '/sessions/:sessionId/followups',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ suggestions: string[] }>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const userId = req.user?.userId || 'default';

      const suggestions = await followUpService.generateFollowUpsForSession(
        sessionId,
        userId
      );

      if (suggestions === null) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      res.json({
        success: true,
        data: { suggestions },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate follow-ups'),
      });
    }
  }
);

/**
 * Switch to a different branch of a message
 * POST /api/chat/sessions/:sessionId/messages/:messageId/branch
 */
router.post(
  '/sessions/:sessionId/messages/:messageId/branch',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const { branchIndex } = req.body;
      const userId = req.user?.userId || 'default';

      if (typeof branchIndex !== 'number') {
        res.status(400).json({
          success: false,
          error: 'branchIndex is required and must be a number',
        });
        return;
      }

      const updatedMessage = chatService.switchMessageBranch(
        sessionId,
        messageId,
        branchIndex,
        userId
      );

      if (!updatedMessage) {
        res.status(404).json({
          success: false,
          error: 'Message or branch not found',
        });
        return;
      }

      // Return the updated session
      const session = chatService.getSession(sessionId, userId);
      res.json({
        success: true,
        data: session,
      });
    } catch (error) {
      logger.error('Switch branch error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to switch branch'),
      });
    }
  }
);

/**
 * Get all branches for a message
 * GET /api/chat/sessions/:sessionId/messages/:messageId/branches
 */
router.get(
  '/sessions/:sessionId/messages/:messageId/branches',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const userId = req.user?.userId || 'default';

      const branches = chatService.getMessageBranches(
        sessionId,
        messageId,
        userId
      );

      res.json({
        success: true,
        data: branches,
      });
    } catch (error) {
      logger.error('Get branches error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get branches'),
      });
    }
  }
);

/**
 * Create a new branch for a message (for regeneration)
 * POST /api/chat/sessions/:sessionId/messages/:messageId/branches
 */
router.post(
  '/sessions/:sessionId/messages/:messageId/branches',
  authenticate,
  chatRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const messageId = req.params.messageId as string;
      const userId = req.user?.userId || 'default';
      const messageData = req.body;

      if (!messageData || !messageData.role || !messageData.content) {
        res.status(400).json({
          success: false,
          error: 'Message data with role and content is required',
        });
        return;
      }

      const newBranch = chatService.createMessageBranch(
        sessionId,
        messageId,
        messageData,
        userId
      );

      if (!newBranch) {
        res.status(404).json({
          success: false,
          error: 'Failed to create branch - session or message not found',
        });
        return;
      }

      res.json({
        success: true,
        data: newBranch,
      });
    } catch (error) {
      logger.error('Create branch error:', error);
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to create branch'),
      });
    }
  }
);

export default router;
