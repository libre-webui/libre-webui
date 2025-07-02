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

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import {
  errorHandler,
  notFoundHandler,
  requestLogger,
} from './middleware/index.js';
import ollamaRoutes from './routes/ollama.js';
import chatRoutes from './routes/chat.js';
import preferencesRoutes from './routes/preferences.js';
import pluginRoutes from './routes/plugins.js';
import documentRoutes from './routes/documents.js';
import ollamaService from './services/ollamaService.js';
import chatService from './services/chatService.js';
import pluginService from './services/pluginService.js';
import preferencesService from './services/preferencesService.js';
import documentService from './services/documentService.js';
import { mergeGenerationOptions } from './utils/generationUtils.js';
import {
  OllamaChatRequest,
  OllamaChatMessage,
  GenerationStatistics,
} from './types/index.js';

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3001;
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || [
  'http://localhost:5173',
];

// Security middleware
app.use(
  helmet({
    crossOriginEmbedderPolicy: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
  })
);

// CORS configuration
app.use(
  cors({
    origin: corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Logging
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined'));
}
app.use(requestLogger);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Libre WebUI Backend is running',
    timestamp: new Date().toISOString(),
  });
});

// API routes
app.use('/api/ollama', ollamaRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/preferences', preferencesRoutes);
app.use('/api/plugins', pluginRoutes);
app.use('/api/documents', documentRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

// WebSocket server for real-time chat streaming
const wss = new WebSocketServer({
  server,
  path: '/ws',
});

wss.on('connection', ws => {
  console.log('WebSocket client connected');

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
        } = message.data;

        console.log(
          'Backend: Received chat_stream for session:',
          sessionId,
          'with images:',
          !!images,
          'format:',
          !!format
        );

        // Get session
        const session = chatService.getSession(sessionId);
        if (!session) {
          console.log('Backend: Session not found:', sessionId);
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { error: 'Session not found' },
            })
          );
          return;
        }

        // Add user message with images if provided
        const userMessage = chatService.addMessage(sessionId, {
          role: 'user',
          content,
          images: images || undefined,
        });

        if (!userMessage) {
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { error: 'Failed to add user message' },
            })
          );
          return;
        }

        // Send user message confirmation
        ws.send(
          JSON.stringify({
            type: 'user_message',
            data: userMessage,
          })
        );

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
        const contextMessages = chatService.getMessagesForContext(sessionId);

        // Convert our messages to Ollama format
        const ollamaMessages: OllamaChatMessage[] = contextMessages.map(
          (msg, index) => {
            const ollamaMessage: OllamaChatMessage = {
              role: msg.role as OllamaChatMessage['role'],
              content: msg.content,
            };

            // Use enhanced content for the last user message if we have document context
            if (
              msg.role === 'user' &&
              index === contextMessages.length - 1 &&
              relevantContext.length > 0
            ) {
              ollamaMessage.content = enhancedContent;
            }

            // Process images: strip data URL prefix if present
            if (msg.images && msg.images.length > 0) {
              ollamaMessage.images = msg.images.map(img => {
                // Strip data URL prefix if present (e.g., "data:image/png;base64,")
                if (typeof img === 'string' && img.includes(',')) {
                  const base64Index = img.indexOf(',');
                  if (base64Index !== -1) {
                    return img.substring(base64Index + 1);
                  }
                }
                return img;
              });
            }

            return ollamaMessage;
          }
        );

        let assistantContent = '';
        let finalStatistics: GenerationStatistics | undefined = undefined;

        console.log('Backend: Using assistantMessageId:', assistantMessageId);

        // Check if there's an active plugin for this model
        console.log(
          `[WebSocket] Looking for plugin for model: ${session.model}`
        );
        const activePlugin = pluginService.getActivePluginForModel(
          session.model
        );
        console.log(
          `[WebSocket] Found plugin:`,
          activePlugin ? activePlugin.id : 'none'
        );

        if (activePlugin) {
          console.log(
            `[WebSocket] Using plugin ${activePlugin.id} for model ${session.model}`
          );
          try {
            // Get user's preferred generation options
            const userGenerationOptions =
              preferencesService.getGenerationOptions();

            // Merge user preferences with request options
            const mergedOptions = mergeGenerationOptions(
              userGenerationOptions,
              options
            );

            // Get messages for context
            const contextMessages =
              chatService.getMessagesForContext(sessionId);

            // Use plugin for generation (non-streaming for now)
            const pluginResponse = await pluginService.executePluginRequest(
              session.model,
              contextMessages.concat([userMessage]),
              mergedOptions
            );

            // Get the content from plugin response
            assistantContent =
              pluginResponse.choices[0]?.message?.content || '';

            // Send the complete response as chunks to simulate streaming
            const words = assistantContent.split(' ');
            for (let i = 0; i < words.length; i++) {
              const chunk = words.slice(0, i + 1).join(' ');
              const isLast = i === words.length - 1;

              ws.send(
                JSON.stringify({
                  type: 'assistant_chunk',
                  data: {
                    content: isLast
                      ? ''
                      : ' ' + words[i] + (i < words.length - 1 ? '' : ''),
                    total: chunk,
                    done: isLast,
                    messageId: assistantMessageId,
                  },
                })
              );

              // Small delay to simulate streaming
              if (!isLast) {
                await new Promise(resolve => setTimeout(resolve, 50));
              }
            }

            // Save the complete assistant message
            if (assistantContent && assistantMessageId) {
              console.log(
                'Backend: Saving complete assistant message with ID:',
                assistantMessageId
              );

              const assistantMessage = chatService.addMessage(sessionId, {
                role: 'assistant',
                content: assistantContent,
                model: session.model,
                id: assistantMessageId,
              });

              console.log(
                'Backend: Assistant message saved:',
                !!assistantMessage
              );

              // Send completion signal
              ws.send(
                JSON.stringify({
                  type: 'assistant_complete',
                  data: assistantMessage,
                })
              );
            }
            return; // Exit early since we handled the request via plugin
          } catch (pluginError) {
            console.error(
              'Plugin failed, falling back to Ollama:',
              pluginError
            );
            // Continue to Ollama fallback below
          }
        }

        console.log(
          `[WebSocket] No plugin found or plugin failed, using Ollama for model: ${session.model}`
        );

        // Get user's preferred generation options
        const userGenerationOptions = preferencesService.getGenerationOptions();

        // Merge user preferences with request options
        const mergedOptions = mergeGenerationOptions(
          userGenerationOptions,
          options
        );

        // Create chat request with advanced features
        const chatRequest: OllamaChatRequest = {
          model: session.model,
          messages: ollamaMessages,
          stream: true,
          options: mergedOptions as Record<string, unknown>,
        };

        // Add structured output format if specified
        if (format) {
          chatRequest.format = format;
        }

        // Stream response from Ollama using chat completion
        await ollamaService.generateChatStreamResponse(
          chatRequest,
          chunk => {
            if (chunk.message?.content) {
              assistantContent += chunk.message.content;

              console.log(
                'Backend: Sending chunk, total length:',
                assistantContent.length
              );

              // Send streaming chunk with the provided message ID
              ws.send(
                JSON.stringify({
                  type: 'assistant_chunk',
                  data: {
                    content: chunk.message.content,
                    total: assistantContent,
                    done: chunk.done,
                    messageId: assistantMessageId,
                  },
                })
              );
            }

            // Capture final statistics when streaming is done
            if (chunk.done) {
              finalStatistics = {
                total_duration: chunk.total_duration,
                load_duration: chunk.load_duration,
                prompt_eval_count: chunk.prompt_eval_count,
                prompt_eval_duration: chunk.prompt_eval_duration,
                eval_count: chunk.eval_count,
                eval_duration: chunk.eval_duration,
                created_at: chunk.created_at,
                model: chunk.model,
              };

              // Calculate tokens per second if we have the necessary data
              if (chunk.eval_count && chunk.eval_duration) {
                finalStatistics.tokens_per_second =
                  Math.round(
                    (chunk.eval_count / (chunk.eval_duration / 1e9)) * 100
                  ) / 100;
              }
            }
          },
          error => {
            ws.send(
              JSON.stringify({
                type: 'error',
                data: { error: error.message },
              })
            );
          },
          () => {
            // Save the complete assistant message with the provided ID
            if (assistantContent && assistantMessageId) {
              console.log(
                'Backend: Saving complete assistant message with ID:',
                assistantMessageId
              );

              const assistantMessage = chatService.addMessage(sessionId, {
                role: 'assistant',
                content: assistantContent,
                model: session.model,
                id: assistantMessageId,
                statistics: finalStatistics,
              });

              console.log(
                'Backend: Assistant message saved:',
                !!assistantMessage
              );

              // Send completion signal with statistics
              ws.send(
                JSON.stringify({
                  type: 'assistant_complete',
                  data: {
                    content: assistantContent,
                    role: 'assistant',
                    timestamp: Date.now(),
                    messageId: assistantMessageId,
                    statistics: finalStatistics,
                  },
                })
              );
            }
          }
        );
      }
    } catch (error: unknown) {
      console.error('WebSocket error:', error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      ws.send(
        JSON.stringify({
          type: 'error',
          data: { error: errorMessage },
        })
      );
    }
  });

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });

  ws.on('error', error => {
    console.error('WebSocket error:', error);
  });

  // Send initial connection confirmation
  ws.send(
    JSON.stringify({
      type: 'connected',
      data: { message: 'Connected to Libre WebUI' },
    })
  );
});

// Start server
server.listen(port, () => {
  console.log(`🚀 Libre WebUI Backend running on port ${port}`);
  console.log(`📡 WebSocket server running on ws://localhost:${port}/ws`);
  console.log(`🌐 CORS enabled for: ${corsOrigins.join(', ')}`);

  // Check Ollama connection on startup
  ollamaService.isHealthy().then(isHealthy => {
    if (isHealthy) {
      console.log('✅ Ollama service is connected and ready');
    } else {
      console.log(
        "⚠️  Ollama service is not available - make sure it's running on http://localhost:11434"
      );
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

export default app;
