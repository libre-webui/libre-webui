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
import imageGenRoutes from './routes/imageGen.js';
import embeddingsRoutes from './routes/embeddings.js';
import huggingfaceHubRoutes from './routes/huggingfaceHub.js';
import ollamaService from './services/ollamaService.js';
import { GitHubOAuthService } from './services/simpleGitHubOAuth.js';
import { HuggingFaceOAuthService } from './services/simpleHuggingFaceOAuth.js';
import { encryptionService as _encryptionService } from './services/encryptionService.js';
import { loadAppPackage, resolveFrontendDist } from './utils/packagePaths.js';
import { registerWebSocketServer } from './websocketServer.js';
import { createLogger } from './utils/logger.js';

const pkg = loadAppPackage(import.meta.url);
const app = express();
const logger = createLogger('server');

// Trust proxy setting for running behind reverse proxies (Nginx, Caddy, etc.)
// Set TRUST_PROXY=1 or TRUST_PROXY=loopback or TRUST_PROXY=uniquelocal etc.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  const numVal = Number(trustProxy);
  if (!isNaN(numVal)) {
    app.set('trust proxy', numVal);
  } else if (trustProxy.toLowerCase() === 'true') {
    app.set('trust proxy', true);
  } else {
    app.set('trust proxy', trustProxy);
  }
}

const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || (isProduction ? 8080 : 3001);
const hasTurnstile =
  Boolean(process.env.TURNSTILE_SITE_KEY?.trim()) &&
  Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
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

    // Allow all origins if CORS_ORIGIN is set to '*'
    if (corsOrigins.includes('*')) {
      return callback(null, true);
    }

    // Check if the origin is in our allowed list
    if (corsOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      // Allow network access in development mode or Docker environment
      // This allows access from network IPs like http://192.168.x.x:8080 or http://10.x.x.x:8080
      const allowNetworkAccess =
        process.env.NODE_ENV !== 'production' ||
        process.env.DOCKER_ENV === 'true';
      const isNetworkOrigin =
        origin &&
        /^https?:\/\/(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|localhost)/.test(
          origin
        );

      if (allowNetworkAccess && isNetworkOrigin) {
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
      process.env.NODE_ENV === 'production' &&
      !process.env.DOCKER_ENV &&
      !hasTurnstile
        ? true
        : false,

    // Content Security Policy - Docker-aware configuration
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://challenges.cloudflare.com',
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
        mediaSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
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

// Rate limiter for image generation routes (stricter limits applied within route)
const imageGenRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  message: {
    success: false,
    error:
      'Too many image generation requests from this IP, please try again later.',
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
app.use('/api/embeddings', embeddingsRoutes);
app.use('/api/documents', documentsRateLimiter, documentRoutes);
app.use('/api/personas', personasRateLimiter, optionalAuth, personaRoutes);
app.use('/api/tts', ttsRateLimiter, optionalAuth, ttsRoutes);
app.use('/api/image-gen', imageGenRateLimiter, optionalAuth, imageGenRoutes);
app.use('/api/huggingface-hub', huggingfaceHubRoutes);

// Serve frontend static files in production (for npx libre-webui)
if (
  process.env.NODE_ENV === 'production' ||
  process.env.SERVE_FRONTEND === 'true'
) {
  const pathModule = await import('path');

  const frontendPath = resolveFrontendDist(import.meta.url);

  if (frontendPath) {
    logger.info(`Serving frontend from: ${frontendPath}`);

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
    logger.warn(
      'Frontend build not found. Run `npm run build:frontend` first.'
    );
  }
}

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

// Create HTTP server
const server = createServer(app);

registerWebSocketServer(server);

// Start server
server.listen({ port, host: '0.0.0.0' }, () => {
  const url = `http://localhost:${port}`;
  logger.info(`Libre WebUI v${pkg.version}`);
  logger.info(url);

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
    logger.info('SSO configuration:');
    if (githubConfigured) {
      logger.info('GitHub OAuth configured and ready');
    }
    if (hfConfigured) {
      logger.info('Hugging Face OAuth configured and ready');
    }
  } else {
    logger.info('No SSO providers configured (optional)');
  }

  // Check Ollama connection on startup
  ollamaService.isHealthy().then(isHealthy => {
    if (isHealthy) {
      logger.info('Ollama service is connected and ready');
    } else {
      logger.warn(
        "Ollama service is not available - make sure it's running on http://localhost:11434"
      );
    }
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT signal received: closing HTTP server');
  server.close(() => {
    logger.info('HTTP server closed');
  });
});

export default app;
