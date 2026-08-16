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
import { ipKeyGenerator } from 'express-rate-limit';
import rateLimit from './middleware/sharedRateLimit.js';
import { isChatCancellationSafetyRequest } from './middleware/chatCancellationAdmission.js';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { createServer } from 'http';
import { join as pathJoin } from 'path';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

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
import sttRoutes from './routes/stt.js';
import imageGenRoutes from './routes/imageGen.js';
import mediaRoutes from './routes/media.js';
import embeddingsRoutes from './routes/embeddings.js';
import huggingfaceHubRoutes from './routes/huggingfaceHub.js';
import libreClawRoutes from './routes/libreClaw.js';
import workRoutes from './routes/work.js';
import systemDiagnosticsRoutes from './routes/systemDiagnostics.js';
import artifactsRoutes from './routes/artifacts.js';
import searchRoutes from './routes/search.js';
import healthRoutes from './routes/health.js';
import jobsRoutes from './routes/jobs.js';
import groupsRoutes from './routes/groups.js';
import accessRoutes from './routes/access.js';
import auditRoutes from './routes/audit.js';
import openaiCompatRoutes from './routes/openaiCompat.js';
import ollamaService from './services/ollamaService.js';
import workRuntimeService from './services/workRuntimeService.js';
import workTaskService from './services/workTaskService.js';
import workAgentService from './services/workAgentService.js';
import healthService from './services/healthService.js';
import { groupVectorPrincipalResolver } from './services/groupVectorPrincipalResolver.js';
import workPreviewProxyService, {
  WORK_PREVIEW_PROXY_PREFIX,
} from './services/workPreviewProxyService.js';
import { GitHubOAuthService } from './services/simpleGitHubOAuth.js';
import { HuggingFaceOAuthService } from './services/simpleHuggingFaceOAuth.js';
import { encryptionService as _encryptionService } from './services/encryptionService.js';
import { closePersistence, getPersistence } from './persistence/index.js';
import { loadAppPackage, resolveFrontendDist } from './utils/packagePaths.js';
import { registerWebSocketServer } from './websocketServer.js';
import { createLogger } from './utils/logger.js';
import {
  closeCoordinator,
  getPlatformRuntimeConfig,
  initializeCoordinator,
} from './platform/coordination/service.js';
import {
  closeDurableJobRuntime,
  createDomainDurableJobHandlers,
  initializeDurableJobRuntime,
  JOB_CANCELLATION_WAKE_TOPIC,
} from './platform/jobs/index.js';
import {
  closeDurableEventGateway,
  initializeDurableEventGateway,
} from './platform/events/index.js';
import workEventService from './services/workEventService.js';
import {
  closePlatformStorageRuntime,
  initializePlatformStorageRuntime,
} from './platform/storage/index.js';
import {
  getSystemSetting,
  setSystemSetting,
} from './services/systemSettingsService.js';
import {
  closePluginCacheInvalidation,
  probePluginCacheInvalidationHealth,
} from './services/pluginCacheInvalidation.js';

const pkg = loadAppPackage(import.meta.url);
const app = express();
const logger = createLogger('server');

// Coordination is an explicit platform dependency. Solo mode uses one local
// coordinator; Redis selections fail startup/readiness instead of silently
// falling back to process-local state.
const platformCoordinator = await initializeCoordinator();
healthService.registerDependencyCheck({
  id: 'coordination',
  required: true,
  check: async () => {
    const health = await platformCoordinator.health();
    return {
      status: health.ready ? 'pass' : 'fail',
      ...(health.message ? { message: health.message } : {}),
      details: {
        backend: health.backend,
        providerLatencyMs: health.latencyMs,
      },
    };
  },
});
healthService.registerDependencyCheck({
  id: 'plugin-cache-invalidation',
  required: true,
  check: async () => {
    const health = await probePluginCacheInvalidationHealth();
    return {
      status: health.ready ? 'pass' : 'fail',
      ...(health.message ? { message: health.message } : {}),
    };
  },
});

// Containers are execution state, while each task's named volume is durable.
// On startup, reconcile the labeled Work containers Docker actually has
// against the task inventory: running containers are stopped so an
// interrupted command or loopback preview cannot continue without a
// supervising process, containers at rest are left alone, and labeled
// containers whose task row is gone are removed. Runs even with an empty
// task table, so a restored database still sweeps leftover containers.
if (getPlatformRuntimeConfig().jobs.workerMode === 'embedded') {
  const workRecovery = await workTaskService.recoverOnStartup();
  const workCleanup = await workRuntimeService.beginRecovery(
    workRecovery.tasks
  );
  if (workCleanup.failed > 0) {
    logger.warn(
      `Work is fail-closed while ${workCleanup.failed} startup container cleanup(s) are retried.`
    );
  }
  if (workRecovery.interruptedRuns > 0 || workRecovery.activePreviews > 0) {
    logger.info(
      `Recovered ${workRecovery.interruptedRuns} interrupted Work run(s) and ${workRecovery.activePreviews} preview(s).`
    );
  }
} else {
  logger.info(
    'External worker owns Work startup recovery and global runtime sweeps.'
  );
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

/**
 * Hashes of the inline scripts in the served page.
 *
 * The application ships one: a few lines in index.html that apply the saved
 * theme before React mounts, so a light-mode user does not see a dark flash.
 * A strict policy blocks it, which is why every page load has been logging a
 * violation. Hashing the file that is actually served keeps the allowance
 * exact and impossible to drift from the build.
 */
const inlineScriptHashes = (): string[] => {
  const frontendPath = resolveFrontendDist(import.meta.url);
  if (!frontendPath) return [];

  try {
    const html = readFileSync(pathJoin(frontendPath, 'index.html'), 'utf8');
    const inline = [
      ...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
    ];

    return inline
      .map(match => match[1])
      .filter(source => source.trim().length > 0)
      .map(
        source =>
          `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`
      );
  } catch {
    // No built frontend to read; nothing to allow.
    return [];
  }
};

const INLINE_SCRIPT_HASHES = inlineScriptHashes();

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
          // The theme script in index.html, allowed by hash rather than by
          // opening the policy to inline script.
          ...INLINE_SCRIPT_HASHES,
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

// Process liveness, dependency readiness, and authenticated deep diagnostics.
// These routes are intentionally outside /api so deployment probes do not
// depend on API rate limits or optional provider configuration.
app.use('/health', healthRoutes);

// Static files are served by a separate frontend server on port 8080
// Backend only serves API endpoints

// Rate limiter for the /api/personas route
const personasRateLimiter = rateLimit({
  keyPrefix: 'api-personas',
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
  keyPrefix: 'api-preferences',
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
  keyPrefix: 'api-ollama',
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
  keyPrefix: 'api-documents',
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
  keyPrefix: 'api-auth',
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
  keyPrefix: 'api-users',
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
  keyPrefix: 'api-chat',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs (high limit for chat interactions)
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: isChatCancellationSafetyRequest,
});

// Rate limiter for TTS routes (higher limit for info endpoints, generation has stricter limits in route)
const ttsRateLimiter = rateLimit({
  keyPrefix: 'api-tts',
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
  keyPrefix: 'api-image-gen',
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
  keyPrefix: 'api-libre-claw',
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
  keyPrefix: 'api-work',
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
  keyPrefix: 'api-plugin-auth-burst',
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
  keyPrefix: 'api-plugins',
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
app.use('/api/stt', sttRoutes);
app.use('/api/image-gen', imageGenRateLimiter, optionalAuth, imageGenRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/huggingface-hub', huggingfaceHubRoutes);
app.use('/api/libre-claw', libreClawRateLimiter, libreClawRoutes);
app.use('/api/work', workRateLimiter, workRoutes);
app.use('/api/system', systemDiagnosticsRoutes);
app.use('/api/artifacts', artifactsRoutes);
app.use('/api/search', chatRateLimiter, searchRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/audit', auditRoutes);
// OpenAI-compatible surface for external SDKs; authenticated by scoped
// personal API keys (or a normal session token).
app.use('/v1', openaiCompatRoutes);

// Serve frontend static files in production (for npx libre-webui)
if (
  process.env.NODE_ENV === 'production' ||
  process.env.SERVE_FRONTEND === 'true'
) {
  const frontendPath = resolveFrontendDist(import.meta.url);

  if (frontendPath) {
    logger.info(`Serving frontend from: ${frontendPath}`);

    // Rate limiter for static files
    const staticRateLimiter = rateLimit({
      keyPrefix: 'static-assets',
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 1000, // limit each IP to 1000 requests per windowMs
      message: 'Too many requests, please try again later.',
      standardHeaders: true,
      legacyHeaders: false,
    });

    app.use(staticRateLimiter, express.static(frontendPath));

    // SPA fallback - serve index.html for all non-API routes. Pass the file
    // relative to a root instead of as an absolute path: send() rejects
    // absolute paths that contain a dot-segment, and the npx cache lives
    // under ~/.npm/_npx, so every `npx libre-webui` install 500s on deep
    // links without the root option.
    const indexFile = 'index.html';
    const sendIndex = (res: express.Response) => {
      res.sendFile(indexFile, { root: frontendPath });
    };

    // Root route
    app.get('/', staticRateLimiter, (_req, res) => {
      sendIndex(res);
    });

    // All other non-API routes (Express 5 wildcard syntax)
    app.get('/{*splat}', staticRateLimiter, (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
        return next();
      }
      sendIndex(res);
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

// main.ts initializes the selected database before importing this module.
// Direct SQLite test entrypoints retain the repository's legacy lazy path, but
// PostgreSQL can never create a local fallback here.
const applicationPersistence = getPersistence(_encryptionService);
const persistenceHealth = await applicationPersistence.health();
if (!persistenceHealth.ready) {
  throw new Error(
    persistenceHealth.message ||
      `${applicationPersistence.dialect} persistence is not ready.`
  );
}
const platformStorage = await initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: _encryptionService,
  env: process.env,
  principalResolver: groupVectorPrincipalResolver,
});
healthService.registerDependencyCheck({
  id: 'platform-storage',
  required: true,
  check: async () => {
    const health = await platformStorage.health();
    return {
      status: health.ready ? 'pass' : 'fail',
      ...(health.message ? { message: health.message } : {}),
      details: {
        dialect: health.dialect,
        blobs: health.blobs,
        vectors: health.vectors,
      },
    };
  },
});
const durableJobRuntime = initializeDurableJobRuntime({
  role: getPlatformRuntimeConfig().jobs.workerMode,
  runWorker: getPlatformRuntimeConfig().jobs.workerMode === 'embedded',
  maxConcurrentJobs: getPlatformRuntimeConfig().jobs.concurrency,
  retention: getPlatformRuntimeConfig().jobs.retention,
  handlers: createDomainDurableJobHandlers(),
  onCancellationRequested: jobId => {
    // The durable request already committed. Abort an embedded handler at
    // once and wake external workers; a lost wake falls back to the
    // per-side-effect and heartbeat checks.
    queueMicrotask(() => {
      try {
        durableJobRuntime.abortActiveJob(jobId);
      } catch {
        // Best effort only.
      }
    });
    void platformCoordinator
      .publish(JOB_CANCELLATION_WAKE_TOPIC, { jobId })
      .catch(() => undefined);
  },
});
const durableEventGateway = initializeDurableEventGateway(
  durableJobRuntime.service,
  platformCoordinator
);
workEventService.initializeDurableGateway(durableEventGateway);
healthService.registerDependencyCheck({
  id: 'durable-jobs',
  required: true,
  check: async () => {
    const status = durableJobRuntime.status();
    const workerExpected = status.role === 'embedded';
    const externalWorkers = workerExpected
      ? []
      : await platformCoordinator.listPresence('durable-workers');
    return {
      status:
        status.started &&
        (workerExpected ? status.workerId !== null : externalWorkers.length > 0)
          ? 'pass'
          : 'fail',
      details: {
        workerMode: status.role,
        workerRunning: status.workerId !== null,
        externalWorkerCount: externalWorkers.length,
        registeredJobTypes: status.registeredJobTypes,
      },
    };
  },
});
healthService.registerDependencyCheck({
  id: 'ollama-provider',
  required: false,
  depths: ['deep'],
  check: async () => {
    const healthy = await ollamaService.isHealthy();
    return {
      status: healthy ? 'pass' : 'warn',
      ...(!healthy
        ? { message: 'The optional Ollama provider is unavailable.' }
        : {}),
      details: { provider: 'ollama' },
    };
  },
});
// Create HTTP server
const server = createServer(app);

const registeredWebSockets = registerWebSocketServer(server);

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

  // One quiet line on the very first boot, never repeated. Not a nag, not a
  // modal, no telemetry — the flag lives in the local database only.
  void (async () => {
    try {
      const seen = await getSystemSetting('first_run_star_note');
      if (!seen) {
        await setSystemSetting('first_run_star_note', 'shown');
        logger.info(
          'If Libre WebUI is useful to you, a star helps others find it: https://github.com/libre-webui/libre-webui'
        );
      }
    } catch {
      // A read-only database must never affect startup.
    }
  })();

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
const shutdown = async (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info(`${signal} signal received: shutting down`);
  const httpClosed = new Promise<void>(resolve => {
    server.close(() => {
      logger.info('HTTP server closed');
      resolve();
    });
  });
  server.closeIdleConnections?.();
  const timeout = new Promise<'timeout'>(resolve => {
    const timer = setTimeout(() => resolve('timeout'), 15_000);
    timer.unref();
  });
  const stopWork =
    getPlatformRuntimeConfig().jobs.workerMode === 'embedded'
      ? workAgentService.shutdown().then(summary => {
          if (summary.failed > 0) {
            throw new Error(
              `Failed to stop ${summary.failed} Work container${summary.failed === 1 ? '' : 's'} during shutdown.`
            );
          }
          logger.info(`Stopped ${summary.stopped} Work container(s).`);
        })
      : Promise.resolve();
  const cleanup = Promise.allSettled([
    registeredWebSockets.close(),
    stopWork,
    closeDurableJobRuntime(),
    httpClosed,
  ]).then(async initialResults => {
    const pluginCacheResults = await Promise.allSettled([
      closePluginCacheInvalidation(),
    ]);
    const platformResults = await Promise.allSettled([
      closeDurableEventGateway(),
      closeCoordinator(),
      closePlatformStorageRuntime(),
    ]);
    // Close the selected persistence backend only after request, socket, and
    // Work users have drained so SQL state is settled before backup.
    const databaseResults = await Promise.allSettled([closePersistence()]);
    return [
      ...initialResults,
      ...pluginCacheResults,
      ...platformResults,
      ...databaseResults,
    ];
  });
  const result = await Promise.race([cleanup, timeout]);
  if (result === 'timeout') {
    logger.error(
      'Shutdown exceeded 15 seconds; forcing remaining sockets closed.'
    );
    server.closeAllConnections?.();
    process.exit(1);
  }
  const rejected = result.filter(item => item.status === 'rejected');
  if (rejected.length > 0) {
    logger.warn(`${rejected.length} shutdown operation(s) failed.`);
    process.exitCode = 1;
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export default app;
