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

// Load environment variables first
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

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
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import personaRoutes from './routes/personas.js';
import ollamaService from './services/ollamaService.js';
import chatService from './services/chatService.js';
import pluginService from './services/pluginService.js';
import preferencesService from './services/preferencesService.js';
import documentService from './services/documentService.js';
import { mergeGenerationOptions } from './utils/generationUtils.js';
import { verifyToken } from './utils/jwt.js';
import {
  OllamaChatRequest,
  OllamaChatMessage,
  GenerationStatistics,
} from './types/index.js';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3001;
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
];

// Multi-user safe CORS configuration
const corsConfig = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) => {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);

    // Check if the origin is in our allowed list
    if (corsOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
};

// Security middleware
app.use(
  helmet({
    // COEP - disable in Docker/development to avoid proxy issues
    crossOriginEmbedderPolicy:
      process.env.NODE_ENV === 'production' && !process.env.DOCKER_ENV
        ? true
        : false,

    // Content Security Policy - Docker-aware configuration
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          ...(process.env.NODE_ENV === 'production'
            ? [] // Strict in production
            : ["'unsafe-inline'", "'unsafe-eval'"]), // Allow for dev tools
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // Required for styled-components and CSS-in-JS
          'https://fonts.googleapis.com',
        ],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: [
          "'self'",
          'ws:',
          'wss:',
          'https:',
          'http:',
          // WebSocket connections - flexible for Docker networking
          `ws://localhost:${port}`,
          `wss://localhost:${port}`,
          'ws://libre-webui:3001',
          'wss://libre-webui:3001',
          ...(process.env.NODE_ENV !== 'production'
            ? [
                'http://localhost:*',
                'ws://localhost:*',
                'http://libre-webui:*',
                'ws://libre-webui:*',
              ]
            : []),
        ],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests:
          process.env.NODE_ENV === 'production' && !process.env.DOCKER_ENV
            ? []
            : null,
        baseUri: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },

    // HSTS - disabled in Docker to avoid reverse proxy conflicts
    hsts:
      process.env.NODE_ENV === 'production' && !process.env.DOCKER_ENV
        ? {
            maxAge: 31536000, // 1 year
            includeSubDomains: true,
            preload: true,
          }
        : false, // Disabled in Docker/development

    // Prevent clickjacking
    frameguard: { action: 'deny' },
    // Prevent MIME type sniffing
    noSniff: true,
    // Hide X-Powered-By header
    hidePoweredBy: true,
    // Prevent XSS attacks
    xssFilter: true,
  })
);

// CORS configuration
app.use(
  cors({
    ...corsConfig,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
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

// Static files are served by a separate frontend server on port 8080
// Backend only serves API endpoints

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/ollama', ollamaRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/preferences', preferencesRoutes);
app.use('/api/plugins', pluginRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/personas', personaRoutes);

// API-only backend - no static file serving

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
    console.error('WebSocket auth error:', error);
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
        } = message.data;

        console.log(
          'Backend: Received chat_stream for session:',
          sessionId,
          'with images:',
          !!images,
          'format:',
          !!format
        );

        // Get session with user authentication
        const session = chatService.getSession(sessionId, userId);
        if (!session) {
          console.log(
            'Backend: Session not found:',
            sessionId,
            'for user:',
            userId
          );
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { error: 'Session not found' },
            })
          );
          return;
        }

        // Add user message with images if provided
        const userMessage = chatService.addMessage(
          sessionId,
          {
            role: 'user',
            content,
            images: images || undefined,
          },
          userId
        );

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

              const assistantMessage = chatService.addMessage(
                sessionId,
                {
                  role: 'assistant',
                  content: assistantContent,
                  model: session.model,
                  id: assistantMessageId,
                },
                userId
              );

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

              const assistantMessage = chatService.addMessage(
                sessionId,
                {
                  role: 'assistant',
                  content: assistantContent,
                  model: session.model,
                  id: assistantMessageId,
                  statistics: finalStatistics,
                },
                userId
              );

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
server.listen({ port, host: '0.0.0.0' }, () => {
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
