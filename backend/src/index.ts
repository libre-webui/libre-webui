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
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { join as pathJoin } from 'path';

import {
  errorHandler,
  notFoundHandler,
  requestLogger,
} from './middleware/index.js';
import {
  authenticate,
  optionalAuth,
  type AuthenticatedRequest,
} from './middleware/auth.js';
import ollamaRoutes from './routes/ollama.js';
import chatRoutes from './routes/chat.js';
import agentCliRoutes from './routes/agentCli.js';
import preferencesRoutes from './routes/preferences.js';
import pluginRoutes from './routes/plugins.js';
import documentRoutes from './routes/documents.js';
import notesRoutes from './routes/notes.js';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import personaRoutes from './routes/personas.js';
import ttsRoutes from './routes/tts.js';
import imageGenRoutes from './routes/imageGen.js';
import mediaRoutes from './routes/media.js';
import embeddingsRoutes from './routes/embeddings.js';
import huggingfaceHubRoutes from './routes/huggingfaceHub.js';
import libreClawRoutes from './routes/libreClaw.js';
import workRoutes from './routes/work.js';
import systemDiagnosticsRoutes from './routes/systemDiagnostics.js';
import artifactsRoutes from './routes/artifacts.js';
import ollamaService from './services/ollamaService.js';
import workRuntimeService from './services/workRuntimeService.js';
import workTaskService from './services/workTaskService.js';
import workAgentService from './services/workAgentService.js';
import workPreviewProxyService, {
  WORK_PREVIEW_PROXY_PREFIX,
} from './services/workPreviewProxyService.js';
import { GitHubOAuthService } from './services/simpleGitHubOAuth.js';
import { HuggingFaceOAuthService } from './services/simpleHuggingFaceOAuth.js';
import { encryptionService as _encryptionService } from './services/encryptionService.js';
import { loadAppPackage, resolveFrontendDist } from './utils/packagePaths.js';
import { registerWebSocketServer } from './websocketServer.js';
import { createLogger } from './utils/logger.js';

const pkg = loadAppPackage(import.meta.url);
const app = express();
const logger = createLogger('server');

// Containers are execution state, while each task's named volume is durable.
// Stop all known Work containers on backend startup so an interrupted command
// or loopback preview cannot continue running without a supervising process.
const workRecovery = workTaskService.recoverOnStartup();
if (workRecovery.tasks.length > 0) {
  const cleanup = await workRuntimeService.beginRecovery(workRecovery.tasks);
  if (cleanup.failed > 0) {
    logger.warn(
      `Work is fail-closed while ${cleanup.failed} startup container cleanup(s) are retried.`
    );
  }
  if (workRecovery.interruptedRuns > 0 || workRecovery.activePreviews > 0) {
    logger.info(
      `Recovered ${workRecovery.interruptedRuns} interrupted Work run(s) and ${workRecovery.activePreviews} preview(s).`
    );
  }
}

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

// Generated Work apps listen on Docker host loopback. Proxy their signed
// capability URLs before body parsing and the application's Helmet policy so
// request streams, dev-server assets, and preview-specific sandbox headers are
// preserved end to end.
app.use(WORK_PREVIEW_PROXY_PREFIX, workPreviewProxyService.handleHttp);

const isProduction = process.env.NODE_ENV === 'production';
const port = process.env.PORT || (isProduction ? 8080 : 3001);
const host =
  process.env.WEBUI_HOST?.trim() ||
  (process.env.DOCKER_ENV === 'true' ? '0.0.0.0' : '127.0.0.1');
const corsOrigins = process.env.CORS_ORIGIN?.split(',') || [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8080',
  `http://localhost:${port}`, // Allow same-origin when serving frontend
  `http://127.0.0.1:${port}`,
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
    // Work previews have their own sandboxed proxy response policy and do not
    // normally emit CORP.
    crossOriginEmbedderPolicy: false,

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
          // No font CDN: Inter is vendored into the frontend bundle, so the
          // browser never needs to reach a third-party host for a stylesheet.
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
        fontSrc: ["'self'", 'data:'],
        mediaSrc: ["'self'", 'data:', 'blob:'],
        objectSrc: ["'none'"],
        frameSrc: ["'self'", 'https://challenges.cloudflare.com'],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        // npx desktop mode serves the application and signed preview proxy over
        // plain localhost HTTP.
        upgradeInsecureRequests: null,
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

// The artifact sandbox runs on an opaque origin, so it fetches the vendored
// runtime with `Origin: null` and, because module scripts are always fetched
// in CORS mode, needs an explicit grant. This is mounted ahead of the
// application CORS gate, which would reject that origin, and serves nothing
// but uncredentialed static bundles.
{
  const runtimeRoot = resolveFrontendDist(import.meta.url);
  if (runtimeRoot) {
    app.use(
      '/artifact-runtime',
      express.static(pathJoin(runtimeRoot, 'artifact-runtime'), {
        setHeaders: res => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          // Revalidate every time. These files change with each release but
          // keep the same paths, and a cached copy from before an update
          // leaves artifacts running against a runtime that no longer matches
          // the application. The ETag makes an unchanged file a 304.
          res.setHeader('Cache-Control', 'no-cache');
        },
      })
    );
  }
}

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

// Rate limiter for Libre Claw agent routes
const libreClawRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // agent dashboards poll run/event state while active
  message: {
    success: false,
    error: 'Too many Libre Claw requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for isolated Work task APIs
const workRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // The active pane currently polls both the task list and selected task once
  // per second; keep useful abuse protection without throttling normal runs.
  max: 3000,
  message: {
    success: false,
    error: 'Too many Work requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Bound authentication work before parsing bearer tokens without accumulating
// successful requests into one long-lived shared-proxy quota.
const pluginAuthBurstRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    error: 'Too many concurrent plugin requests, please try again later.',
  },
  standardHeaders: false,
  legacyHeaders: false,
});

// Authenticated users receive independent discovery quotas, while writes retain
// stricter route-specific limits.
const pluginRouteRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  keyGenerator: req => {
    const userId = (req as AuthenticatedRequest).user?.userId;
    return userId
      ? `user:${userId}`
      : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
  },
  message: {
    success: false,
    error: 'Too many plugin requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// API routes
app.use('/api/auth', authRateLimiter, optionalAuth, authRoutes);
app.use('/api/users', usersRateLimiter, optionalAuth, usersRoutes);
app.use('/api/ollama', ollamaRateLimiter, ollamaRoutes);
app.use('/api/chat', chatRateLimiter, optionalAuth, chatRoutes);
app.use('/api/agent-clis', chatRateLimiter, optionalAuth, agentCliRoutes);
app.use(
  '/api/preferences',
  preferencesRateLimiter,
  optionalAuth,
  preferencesRoutes
);
app.use(
  '/api/plugins',
  pluginAuthBurstRateLimiter,
  authenticate,
  pluginRouteRateLimiter,
  pluginRoutes
);
app.use('/api/embeddings', embeddingsRoutes);
app.use('/api/documents', documentsRateLimiter, documentRoutes);
app.use('/api/notes', documentsRateLimiter, notesRoutes);
app.use('/api/personas', personasRateLimiter, optionalAuth, personaRoutes);
app.use('/api/tts', ttsRateLimiter, optionalAuth, ttsRoutes);
app.use('/api/image-gen', imageGenRateLimiter, optionalAuth, imageGenRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/huggingface-hub', huggingfaceHubRoutes);
app.use('/api/libre-claw', libreClawRateLimiter, libreClawRoutes);
app.use('/api/work', workRateLimiter, workRoutes);
app.use('/api/system', systemDiagnosticsRoutes);
app.use('/api/artifacts', artifactsRoutes);

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
server.listen({ port, host }, () => {
  const displayHost = ['0.0.0.0', '::'].includes(host)
    ? 'localhost'
    : host.includes(':')
      ? `[${host}]`
      : host;
  const url = `http://${displayHost}:${port}`;
  logger.info(`Libre WebUI v${pkg.version}`);
  logger.info(url);

  // Open browser in production mode
  if (
    process.env.SERVE_FRONTEND === 'true' &&
    process.env.OPEN_BROWSER !== 'false'
  ) {
    import('child_process').then(({ spawn }) => {
      const opener =
        process.platform === 'darwin'
          ? { command: 'open', args: [url] }
          : process.platform === 'win32'
            ? {
                command: 'rundll32',
                args: ['url.dll,FileProtocolHandler', url],
              }
            : { command: 'xdg-open', args: [url] };
      const browser = spawn(opener.command, opener.args, {
        detached: true,
        stdio: 'ignore',
      });
      browser.on('error', error => {
        logger.debug(`Unable to open the browser automatically: ${error}`);
      });
      browser.unref();
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
let shutdownStarted = false;
const shutdown = (signal: 'SIGTERM' | 'SIGINT'): void => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info(`${signal} signal received: stopping Work containers`);
  server.close(() => {
    logger.info('HTTP server closed');
  });
  const timeout = new Promise<'timeout'>(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 15_000);
    timer.unref();
  });
  void Promise.race([workAgentService.shutdown(), timeout]).then(result => {
    if (result === 'timeout') {
      logger.warn('Timed out waiting for Work containers to stop.');
    } else if (result.failed > 0) {
      logger.warn(
        `Failed to stop ${result.failed} Work container(s) during shutdown.`
      );
    } else {
      logger.info(`Stopped ${result.stopped} Work container(s).`);
    }
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
