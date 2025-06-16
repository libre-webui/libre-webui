import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

import { errorHandler, notFoundHandler, requestLogger } from './middleware';
import ollamaRoutes from './routes/ollama';
import chatRoutes from './routes/chat';
import preferencesRoutes from './routes/preferences';
import ollamaService from './services/ollamaService';
import chatService from './services/chatService';

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
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: false,
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

        // Use the modern chat completion API instead of legacy generate API
        // This supports multimodal input and structured outputs
        const contextMessages = chatService.getMessagesForContext(sessionId);

        // Convert our messages to Ollama format
        const ollamaMessages = contextMessages.map(msg => {
          const ollamaMessage: any = {
            role: msg.role,
            content: msg.content,
          };

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
        });

        let assistantContent = '';

        console.log('Backend: Using assistantMessageId:', assistantMessageId);

        // Create chat request with advanced features
        const chatRequest: any = {
          model: session.model,
          messages: ollamaMessages,
          stream: true,
          options: options || {},
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
              });

              console.log(
                'Backend: Assistant message saved:',
                !!assistantMessage
              );

              // Send completion signal
              ws.send(
                JSON.stringify({
                  type: 'assistant_complete',
                  data: {
                    content: assistantContent,
                    role: 'assistant',
                    timestamp: Date.now(),
                    messageId: assistantMessageId,
                  },
                })
              );
            }
          }
        );
      }
    } catch (error: any) {
      console.error('WebSocket error:', error);
      ws.send(
        JSON.stringify({
          type: 'error',
          data: { error: error.message },
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
