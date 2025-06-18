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

import express, { Request, Response } from 'express';
import chatService from '../services/chatService';
import ollamaService from '../services/ollamaService';
import {
  ApiResponse,
  ChatSession,
  ChatMessage,
  getErrorMessage,
} from '../types';

const router = express.Router();

// Get all chat sessions
router.get(
  '/sessions',
  async (
    req: Request,
    res: Response<ApiResponse<ChatSession[]>>
  ): Promise<void> => {
    try {
      const sessions = chatService.getAllSessions();
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
    req: Request,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const { model, title } = req.body;

      if (!model) {
        res.status(400).json({
          success: false,
          error: 'Model is required',
        });
        return;
      }

      const session = chatService.createSession(model, title);
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
    req: Request,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const session = chatService.getSession(sessionId);

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
    req: Request,
    res: Response<ApiResponse<ChatSession>>
  ): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const updates = req.body;

      const updatedSession = chatService.updateSession(sessionId, updates);

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
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      const { sessionId } = req.params;
      const deleted = chatService.deleteSession(sessionId);

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
  async (req: Request, res: Response<ApiResponse>): Promise<void> => {
    try {
      chatService.clearAllSessions();
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
    req: Request,
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

      const session = chatService.getSession(sessionId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      const message = chatService.addMessage(sessionId, {
        role,
        content,
        model,
        id, // Use provided ID if available
      });

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
    req: Request,
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

      const session = chatService.getSession(sessionId);
      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found',
        });
        return;
      }

      // Add user message to session
      const userMessage = chatService.addMessage(sessionId, {
        role: 'user',
        content: message,
      });

      if (!userMessage) {
        res.status(500).json({
          success: false,
          error: 'Failed to add user message',
        });
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

      const chatRequest = {
        model: session.model,
        messages: ollamaMessages,
        stream: false,
        ...options,
      };

      // Generate response using Ollama
      const response = await ollamaService.generateChatResponse(chatRequest);

      // Add assistant response to session
      const assistantMessage = chatService.addMessage(sessionId, {
        role: 'assistant',
        content: response.message.content,
        model: session.model,
      });

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
  async (req: Request, res: Response): Promise<void> => {
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

      const session = chatService.getSession(sessionId);
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
      const userMessage = chatService.addMessage(sessionId, {
        role: 'user',
        content: message,
      });

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

      const chatRequest = {
        model: session.model,
        messages: ollamaMessages,
        stream: true,
        ...options,
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
              content: chunk.message?.content || '',
              done: chunk.done,
            })}\n\n`
          );

          // Accumulate response content
          if (chunk.message?.content) {
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
            chatService.addMessage(sessionId, {
              role: 'assistant',
              content: fullResponse,
              model: session.model,
            });
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
