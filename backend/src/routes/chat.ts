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
import preferencesService from '../services/preferencesService.js';
import documentService from '../services/documentService.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import {
  mergeGenerationOptions,
  extractStatistics,
} from '../utils/generationUtils.js';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  OllamaChatResponse,
  getErrorMessage,
} from '../types/index.js';

const router = express.Router();

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
      const session = chatService.createSession(
        model,
        title,
        userId,
        personaId
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
      const { sessionId } = req.params;
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
      const { sessionId } = req.params;
      const updates = req.body;

      const userId = req.user?.userId || 'default';
      const updatedSession = chatService.updateSession(
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

// Delete a chat session
router.delete(
  '/sessions/:sessionId',
  async (
    req: AuthenticatedRequest,
    res: Response<ApiResponse>
  ): Promise<void> => {
    try {
      const { sessionId } = req.params;
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
      const { sessionId } = req.params;
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
      const { sessionId } = req.params;
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

      // Check if document search is available and enabled
      let documentContext = '';
      try {
        const preferences = preferencesService.getPreferences();
        if (preferences.embeddingSettings?.enabled) {
          console.log(
            `[DEBUG] Embeddings enabled, searching documents for: "${message}"`
          );
          const relevantDocuments = await documentService.searchDocuments(
            message,
            sessionId
          );
          console.log(
            `[DEBUG] Found ${relevantDocuments.length} relevant document chunks`
          );

          if (relevantDocuments.length > 0) {
            // Get document info for each chunk
            const documentsMap = new Map();
            for (const chunk of relevantDocuments) {
              if (!documentsMap.has(chunk.documentId)) {
                const doc = documentService.getDocument(chunk.documentId);
                documentsMap.set(chunk.documentId, doc);
              }
            }

            documentContext =
              '\n\n--- RELEVANT DOCUMENTS ---\n' +
              relevantDocuments
                .map((chunk, index) => {
                  const doc = documentsMap.get(chunk.documentId);
                  const docTitle = doc ? doc.filename : 'Unknown Document';
                  return `Document ${index + 1}: ${docTitle} (chunk ${chunk.chunkIndex + 1})\n${chunk.content}\n`;
                })
                .join('\n---\n') +
              '\n--- END DOCUMENTS ---\n\n';
            console.log(
              `[DEBUG] Added ${documentContext.length} characters of document context`
            );
          } else {
            console.log(
              `[DEBUG] No relevant documents found for query: "${message}"`
            );
          }
        } else {
          console.log(`[DEBUG] Embeddings disabled, skipping document search`);
        }
      } catch (error) {
        console.error('[DEBUG] Error during document search:', error);
        // Continue without document context if search fails
      }

      // Convert chat messages to Ollama format
      const ollamaMessages = session.messages.map((msg: ChatMessage) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Add the new user message with document context if available
      const userMessageContent = documentContext
        ? `${documentContext}User question: ${message}`
        : message;

      ollamaMessages.push({
        role: 'user',
        content: userMessageContent,
      });

      let response: OllamaChatResponse;
      let assistantContent: string;

      // Get user's preferred generation options
      const userGenerationOptions = preferencesService.getGenerationOptions();

      // Merge user preferences with request options (request options take precedence)
      const mergedOptions = mergeGenerationOptions(
        userGenerationOptions,
        options
      );

      // Prepare common chat request for Ollama (used in both fallback and direct cases)
      const chatRequest = {
        model: session.model,
        messages: ollamaMessages,
        stream: false,
        options: mergedOptions as Record<string, unknown>,
      };

      // Check if there's an active plugin for this model
      console.log(`[DEBUG] Looking for plugin for model: ${session.model}`);
      const activePlugin = pluginService.getActivePluginForModel(session.model);
      console.log(
        `[DEBUG] Found plugin:`,
        activePlugin ? activePlugin.id : 'none'
      );

      if (activePlugin) {
        console.log(
          `[DEBUG] Using plugin ${activePlugin.id} for model ${session.model}`
        );
        try {
          // Use plugin for generation
          const pluginResponse = await pluginService.executePluginRequest(
            session.model,
            session.messages.concat([userMessage]),
            options
          );

          // Convert plugin response to our format
          assistantContent = pluginResponse.choices[0]?.message?.content || '';

          // Create a mock response in Ollama format
          response = {
            model: session.model,
            created_at: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: assistantContent,
            },
            done: true,
          } as OllamaChatResponse;
        } catch (pluginError) {
          console.error('Plugin failed, falling back to Ollama:', pluginError);

          // Fallback to Ollama
          response = await ollamaService.generateChatResponse(chatRequest);
          assistantContent = response.message.content;
        }
      } else {
        console.log(
          `[DEBUG] No plugin found, using Ollama for model: ${session.model}`
        );
        // Use Ollama directly
        response = await ollamaService.generateChatResponse(chatRequest);
        assistantContent = response.message.content;
      }

      // Add assistant response to session with statistics
      const statistics = extractStatistics(response);
      const assistantMessage = chatService.addMessage(
        sessionId,
        {
          role: 'assistant',
          content: assistantContent,
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
      const { sessionId } = req.params;
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

      // Convert chat messages to Ollama format
      const ollamaMessages = session.messages.map((msg: ChatMessage) => ({
        role: msg.role,
        content: msg.content,
      }));

      // Add the new user message
      ollamaMessages.push({
        role: 'user',
        content: message,
      });

      // Get user's preferred generation options
      const userGenerationOptions = preferencesService.getGenerationOptions();

      // Merge user preferences with request options (request options take precedence)
      const mergedOptions = mergeGenerationOptions(
        userGenerationOptions,
        options
      );

      const chatRequest = {
        model: session.model,
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

export default router;
