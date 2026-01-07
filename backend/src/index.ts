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

// Load environment variables FIRST before any other imports
import './env.js';

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
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Try to load package.json from multiple locations
let pkg = { version: '0.0.0' };
try {
  // Development: ../package.json (backend/package.json doesn't exist, but root does via symlink)
  pkg = require('../package.json');
} catch {
  try {
    // npm install: package is at node_modules/libre-webui, package.json is at root
    pkg = require('../../package.json');
  } catch {
    console.warn('Could not read version from package.json, using default');
  }
}

import {
  errorHandler,
  notFoundHandler,
  requestLogger,
} from './middleware/index.js';
import { optionalAuth } from './middleware/auth.js';
import ollamaRoutes from './routes/ollama.js';
import chatRoutes from './routes/chat.js';
import preferencesRoutes from './routes/preferences.js';
import pluginRoutes from './routes/plugins.js';
import documentRoutes from './routes/documents.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import personaRoutes from './routes/personas.js';
import ttsRoutes from './routes/tts.js';
import ollamaService from './services/ollamaService.js';
import chatService from './services/chatService.js';
import { GitHubOAuthService } from './services/simpleGitHubOAuth.js';
import { HuggingFaceOAuthService } from './services/simpleHuggingFaceOAuth.js';
import pluginService from './services/pluginService.js';
import preferencesService from './services/preferencesService.js';
import documentService from './services/documentService.js';
import { encryptionService as _encryptionService } from './services/encryptionService.js';
import { mergeGenerationOptions } from './utils/generationUtils.js';
import { verifyToken } from './utils/jwt.js';
import {
  OllamaChatRequest,
  OllamaChatMessage,
  GenerationStatistics,
} from './types/index.js';

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || (isProduction ? 8080 : 3001);
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
  `http://localhost:${port}`, // Allow same-origin when serving frontend
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
      // In development mode, allow network access (when --host is used)
      // This allows access from network IPs like http://192.168.x.x:8080 or http://10.x.x.x:8080
      const isDevelopment = process.env.NODE_ENV !== 'production';
      const isNetworkOrigin =
        origin &&
        /^https?:\/\/(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|127\.|localhost)/.test(
          origin
        );

      if (isDevelopment && isNetworkOrigin) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
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

// Rate limiter for the /api/personas route
const personasRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the /api/preferences route
const preferencesRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the /api/ollama route
const ollamaRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // limit each IP to 10000 requests per windowMs (very high limit for streaming chunks)
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the /api/documents route
const documentsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the /api/auth route (general limit, specific limits applied within route)
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs (higher level limit)
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the /api/users route (general limit, specific limits applied within route)
const usersRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // limit each IP to 50 requests per windowMs (moderate limit for user management)
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for the /api/chat route (general limit, specific limits applied within route)
const chatRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs (high limit for chat interactions)
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for TTS routes (higher limit for info endpoints, generation has stricter limits in route)
const ttsRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // limit each IP to 500 requests per windowMs
  message: {
    success: false,
    error: 'Too many TTS requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// API routes
app.use('/api/auth', authRateLimiter, optionalAuth, authRoutes);
app.use('/api/users', usersRateLimiter, optionalAuth, usersRoutes);
app.use('/api/ollama', ollamaRateLimiter, ollamaRoutes);
app.use('/api/chat', chatRateLimiter, optionalAuth, chatRoutes);
app.use(
  '/api/preferences',
  preferencesRateLimiter,
  optionalAuth,
  preferencesRoutes
);
app.use('/api/plugins', pluginRoutes);
app.use('/api/documents', documentsRateLimiter, documentRoutes);
app.use('/api/personas', personasRateLimiter, optionalAuth, personaRoutes);
app.use('/api/tts', ttsRateLimiter, optionalAuth, ttsRoutes);

// Serve frontend static files in production (for npx libre-webui)
if (
  process.env.NODE_ENV === 'production' ||
  process.env.SERVE_FRONTEND === 'true'
) {
  const pathModule = await import('path');
  const urlModule = await import('url');
  const fsModule = await import('fs');

  const __filename = urlModule.fileURLToPath(import.meta.url);
  const __dirname = pathModule.dirname(__filename);

  // Try multiple possible frontend locations
  const possiblePaths = [
    pathModule.join(__dirname, '../../frontend/dist'), // npm package structure
    pathModule.join(__dirname, '../../../frontend/dist'), // development
    pathModule.join(process.cwd(), 'frontend/dist'), // running from project root
  ];

  let frontendPath = '';
  for (const p of possiblePaths) {
    if (fsModule.existsSync(pathModule.join(p, 'index.html'))) {
      frontendPath = p;
      break;
    }
  }

  if (frontendPath) {
    console.log(`Serving frontend from: ${frontendPath}`);

    // Rate limiter for static files
    const staticRateLimiter = rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 1000, // limit each IP to 1000 requests per windowMs
      message: 'Too many requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });

    app.use(staticRateLimiter, express.static(frontendPath));

    // SPA fallback - serve index.html for all non-API routes
    const indexPath = pathModule.join(frontendPath, 'index.html');

    // Root route
    app.get('/', staticRateLimiter, (_req, res) => {
      res.sendFile(indexPath);
    });

    // All other non-API routes (Express 5 wildcard syntax)
    app.get('/{*splat}', staticRateLimiter, (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        return next();
      }
      res.sendFile(indexPath);
    });
  } else {
    console.warn(
      'Frontend build not found. Run `npm run build:frontend` first.'
    );
  }
}

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
          regenerate,
          originalMessageId,
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
          originalMessageId
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
              data: {
                error: 'Session not found',
                code: 'SESSION_NOT_FOUND',
                message:
                  'The requested session does not exist or does not belong to the current user. Please create a new session.',
                sessionId: sessionId,
                userId: userId,
              },
            })
          );
          return;
        }

        // Add user message with images if provided (skip for regenerations)
        let userMessage;
        if (!regenerate) {
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
        const contextMessages = chatService.getMessagesForContext(sessionId);

        // Convert our messages to Ollama format
        const ollamaMessages: OllamaChatMessage[] = contextMessages.map(
          (msg, index) => {
            const ollamaMessage: OllamaChatMessage = {
              role: msg.role as OllamaChatMessage['role'],
              content: msg.content,
            };

            // Debug: Log what we're sending to Ollama
            if (msg.role === 'system') {
              console.log(
                `🚀 [DEBUG] Sending to Ollama - System message: "${msg.content.substring(0, 150)}${msg.content.length > 150 ? '...' : ''}"`
              );
            }

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

        // Resolve the actual model name (handles persona IDs)
        let actualModelName = session.model;
        if (session.model.startsWith('persona:')) {
          try {
            const personaId = session.model.replace('persona:', '');
            console.log(
              `[WebSocket] DEBUG: Resolving persona ${personaId} for user ${userId}`
            );
            const { personaService } =
              await import('./services/personaService.js');

            // Try to get persona for the current user first, then fallback to 'default'
            let persona = await personaService.getPersonaById(
              personaId,
              userId
            );
            if (!persona && userId !== 'default') {
              console.log(
                `[WebSocket] DEBUG: Persona not found for user ${userId}, trying default user`
              );
              persona = await personaService.getPersonaById(
                personaId,
                'default'
              );
            }

            console.log(
              `[WebSocket] DEBUG: Persona lookup result:`,
              persona
                ? `Found persona with model: ${persona.model}`
                : 'Persona not found'
            );
            if (persona && persona.model) {
              actualModelName = persona.model;
              console.log(
                `[WebSocket] Resolved persona ${personaId} to model: ${actualModelName}`
              );
            } else {
              console.warn(
                `[WebSocket] Persona ${personaId} not found, using original model: ${session.model}`
              );
            }
          } catch (error) {
            console.error(`[WebSocket] Error resolving persona model:`, error);
          }
        }

        // Check if there's an active plugin for this model
        console.log(
          `[WebSocket] Looking for plugin for model: ${actualModelName}`
        );
        const activePlugin =
          pluginService.getActivePluginForModel(actualModelName);
        console.log(
          `[WebSocket] Found plugin:`,
          activePlugin ? activePlugin.id : 'none'
        );

        if (activePlugin) {
          console.log(
            `[WebSocket] Using plugin ${activePlugin.id} for model ${actualModelName}`
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
            // For regenerations, the user message is already in context; for new messages, we need to add it
            const messagesForPlugin = regenerate
              ? contextMessages
              : contextMessages.concat([userMessage!]);
            const pluginResponse = await pluginService.executePluginRequest(
              actualModelName,
              messagesForPlugin,
              mergedOptions
            );

            // Get the content from plugin response
            assistantContent =
              pluginResponse.choices[0]?.message?.content || '';

            // Send the complete response as chunks to simulate streaming
            const words = assistantContent.split(' ');
            const BATCH_SIZE = 3; // Send 3 words at a time to reduce message frequency

            for (let i = 0; i < words.length; i += BATCH_SIZE) {
              const batch = words.slice(i, i + BATCH_SIZE);
              const chunk = words.slice(0, i + batch.length).join(' ');
              const isLast = i + BATCH_SIZE >= words.length;

              ws.send(
                JSON.stringify({
                  type: 'assistant_chunk',
                  data: {
                    content: batch.join(' ') + (isLast ? '' : ' '),
                    total: chunk,
                    done: isLast,
                    messageId: assistantMessageId,
                  },
                })
              );

              // Small delay to simulate streaming but with better batching
              if (!isLast) {
                await new Promise(resolve => setTimeout(resolve, 100));
              }
            }

            // Save the complete assistant message
            if (assistantContent && assistantMessageId) {
              console.log(
                'Backend: Saving complete assistant message with ID:',
                assistantMessageId,
                'regenerate:',
                !!regenerate
              );

              // Calculate branching fields if this is a regeneration
              let branchingFields: {
                parentId?: string;
                branchIndex?: number;
                isActive?: boolean;
              } = {};
              if (regenerate && originalMessageId) {
                // Find the original message to get its parentId or use its ID as parent
                const originalMsg = session.messages.find(
                  m => m.id === originalMessageId
                );
                const parentId = originalMsg?.parentId || originalMessageId;

                // Count existing siblings to determine branch index
                const siblingCount = session.messages.filter(
                  m => m.id === parentId || m.parentId === parentId
                ).length;

                branchingFields = {
                  parentId,
                  branchIndex: siblingCount, // New branch gets next index
                  isActive: true,
                };
                console.log(
                  'Backend: Setting branching fields:',
                  branchingFields
                );
              }

              const assistantMessage = chatService.addMessage(
                sessionId,
                {
                  role: 'assistant',
                  content: assistantContent,
                  model: session.model,
                  id: assistantMessageId,
                  ...branchingFields,
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
          `[WebSocket] No plugin found or plugin failed, using Ollama for model: ${actualModelName}`
        );

        // Reuse the actualModelName variable that was already resolved above
        // If we're here, it means either there was no plugin or plugin failed
        // The actualModelName was already resolved in the earlier code block

        // Get user's preferred generation options
        const userGenerationOptions = preferencesService.getGenerationOptions();

        // Merge user preferences with request options
        const mergedOptions = mergeGenerationOptions(
          userGenerationOptions,
          options
        );

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

        // Stream response from Ollama using chat completion
        await ollamaService.generateChatStreamResponse(
          chatRequest,
          chunk => {
            if (chunk.message?.content) {
              assistantContent += chunk.message.content;

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
                assistantMessageId,
                'regenerate:',
                !!regenerate
              );

              // Calculate branching fields if this is a regeneration
              let branchingFields: {
                parentId?: string;
                branchIndex?: number;
                isActive?: boolean;
              } = {};
              if (regenerate && originalMessageId) {
                // Find the original message to get its parentId or use its ID as parent
                const originalMsg = session.messages.find(
                  m => m.id === originalMessageId
                );
                const parentId = originalMsg?.parentId || originalMessageId;

                // Count existing siblings to determine branch index
                const siblingCount = session.messages.filter(
                  m => m.id === parentId || m.parentId === parentId
                ).length;

                branchingFields = {
                  parentId,
                  branchIndex: siblingCount, // New branch gets next index
                  isActive: true,
                };
                console.log(
                  'Backend: Setting branching fields:',
                  branchingFields
                );
              }

              console.log('Backend: About to save assistant message:', {
                sessionId,
                messageId: assistantMessageId,
                contentLength: assistantContent.length,
                hasBranchingFields: Object.keys(branchingFields).length > 0,
                branchingFields,
              });

              const assistantMessage = chatService.addMessage(
                sessionId,
                {
                  role: 'assistant',
                  content: assistantContent,
                  model: session.model,
                  id: assistantMessageId,
                  statistics: finalStatistics,
                  ...branchingFields,
                },
                userId
              );

              console.log(
                'Backend: Assistant message saved:',
                !!assistantMessage,
                assistantMessage
                  ? {
                      id: assistantMessage.id,
                      contentLength: assistantMessage.content.length,
                    }
                  : 'FAILED TO SAVE'
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
                    ...branchingFields,
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
  const url = `http://localhost:${port}`;
  console.log(`\n🚀 Libre WebUI v${pkg.version}`);
  console.log(`   ${url}\n`);

  // Open browser in production mode
  if (process.env.SERVE_FRONTEND === 'true') {
    import('child_process').then(({ exec }) => {
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      exec(`${cmd} ${url}`);
    });
  }

  // Check OAuth providers configuration on startup
  const githubOAuth = new GitHubOAuthService();
  const hfOAuth = new HuggingFaceOAuthService();

  const githubConfigured = githubOAuth.isConfigured();
  const hfConfigured = hfOAuth.isConfigured();

  if (githubConfigured || hfConfigured) {
    console.log('🔐 SSO Configuration:');
    if (githubConfigured) {
      console.log('  ✅ GitHub OAuth configured and ready');
    }
    if (hfConfigured) {
      console.log('  ✅ Hugging Face OAuth configured and ready');
    }
  } else {
    console.log('ℹ️  No SSO providers configured (optional)');
  }

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
