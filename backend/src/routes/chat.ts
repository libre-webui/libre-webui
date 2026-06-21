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
import chatGenerationService from '../services/chatGenerationService.js';
import { ChatRequestService } from '../services/chatRequestService.js';
import { TitleGenerationService } from '../services/titleGenerationService.js';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  getErrorMessage,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { buildChatDocumentContext } from '../utils/chatDocumentContext.js';

const logger = createLogger('routes:chat');

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
      const { model, title, personaId } = req.body;

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
        extractedPersonaId
      );
      res.json({
        success: true,
        data: session,
      });
    } catch (error: unknown) {
      res.status(500).json({
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
      res.status(500).json({
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

      let documentContext = {
        enhancedContent: message,
        hasRelevantContext: false,
      };
      try {
        documentContext = await buildChatDocumentContext(message, sessionId);
      } catch (error) {
        logger.error('Error during document search:', error);
      }

      const preparedGeneration =
        await chatRequestService.prepareGenerationRequest({
          session,
          userId,
          options,
          persistedMessages: session.messages,
          content: message,
          hasRelevantContext: documentContext.hasRelevantContext,
          enhancedContent: documentContext.enhancedContent,
        });

      const generationResult = await chatGenerationService.executeNonStreaming({
        target: preparedGeneration.target,
        ollamaMessages: preparedGeneration.ollamaMessages,
        pluginMessages: preparedGeneration.pluginMessages,
        userId,
        pluginFallbackPolicy: 'allow',
      });

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
          model: session.model,
          statistics,
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
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate response'),
      });
    }
  }
);

// Generate a chat response with streaming
router.post(
  '/sessions/:sessionId/generate/stream',
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

      const { actualModelName, mergedOptions, ollamaMessages } =
        await chatRequestService.prepareGenerationRequest({
          session,
          userId,
          options,
          persistedMessages: session.messages,
          content: message,
        });

      const chatRequest = {
        model: actualModelName,
        messages: ollamaMessages,
        stream: true,
        options: mergedOptions as Record<string, unknown>,
      };

      let fullResponse = '';

      // Generate streaming response using Ollama
      await ollamaService.generateChatStreamResponse(
        chatRequest,
        chunk => {
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
          res.write(
            `data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`
          );
          res.end();
        },
        () => {
          // Add complete assistant response to session
          if (fullResponse) {
            chatService.addMessage(
              sessionId,
              {
                role: 'assistant',
                content: fullResponse,
                model: session.model,
              },
              userId
            );
          }

          res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
          res.end();
        }
      );
    } catch (error: unknown) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', error: getErrorMessage(error, 'Failed to generate stream response') })}\n\n`
      );
      res.end();
    }
  }
);

// Generate a title for a chat session based on the first message
router.post(
  '/sessions/:sessionId/generate-title',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse<{ title: string }>>
  ): Promise<void> => {
    try {
      const sessionId = req.params.sessionId as string;
      const { model, message } = req.body;

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
        data: { title: titleResult.title },
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to generate title'),
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
