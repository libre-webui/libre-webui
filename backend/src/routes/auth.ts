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
import { githubOAuthService } from '../services/simpleGitHubOAuth.js';
import { huggingFaceOAuthService } from '../services/simpleHuggingFaceOAuth.js';
import { authService } from '../services/authService.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import { encryptionService } from '../services/encryptionService.js';
import { turnstileService } from '../services/turnstileService.js';
import {
  beginOAuthFlow,
  consumeOAuthSessionCookie,
  consumeOAuthState,
  setOAuthSessionCookie,
} from '../services/oauthSecurity.js';
import { validatePasswordStrength } from '../utils/hash.js';
import { createLogger } from '../utils/logger.js';
import {
  WebSocketTicketRateLimitError,
  websocketTicketService,
} from '../services/websocketTicketService.js';
import { coordinatedRateLimit } from '../middleware/coordinatedRateLimit.js';

const router = express.Router();
const logger = createLogger('auth-routes');

// Fallback frontend URL for OAuth redirects
const FALLBACK_FRONTEND_URL = 'http://localhost:5173';
const getFrontendUrl = (): string =>
  (process.env.CORS_ORIGIN || FALLBACK_FRONTEND_URL)
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
const frontendRedirect = (search: string): string =>
  `${getFrontendUrl()}${search}`;
const pendingApprovalRedirect = (): string =>
  frontendRedirect('/login?approval=pending');
const oauthErrorRedirect = (error: string): string =>
  frontendRedirect(`?error=${encodeURIComponent(error)}`);

const getClientIp = (req: express.Request): string | undefined => {
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    return cfConnectingIp.trim();
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0]?.trim();
  }

  return req.ip || undefined;
};

// Rate limiter for authentication routes: 5 login attempts per 15 minutes
const loginRateLimiter = coordinatedRateLimit({
  keyPrefix: 'security.login',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many authentication attempts, please try again later',
});

const signupRateLimiter = coordinatedRateLimit({
  keyPrefix: 'security.signup',
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: 'Too many authentication attempts, please try again later',
});

// Rate limiter for general auth routes: 100 requests per 15 minutes
const generalAuthRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Exchange the normal Authorization header for a short-lived, one-use
 * WebSocket ticket. This keeps the durable JWT out of URLs, proxy logs, and
 * browser history while retaining browser-compatible WebSocket authentication.
 */
router.post(
  '/websocket-ticket',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    res.set('Cache-Control', 'no-store');
    const audience = req.body?.audience;
    const taskId = req.body?.taskId;
    if (audience !== 'chat' && audience !== 'work-terminal') {
      res.status(400).json({
        success: false,
        message: 'WebSocket ticket audience must be chat or work-terminal',
      });
      return;
    }
    if (
      audience === 'work-terminal' &&
      (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 256)
    ) {
      res.status(400).json({
        success: false,
        message: 'A valid taskId is required for a Work terminal ticket',
      });
      return;
    }
    const sessionExpiresAt = (req.user?.exp ?? 0) * 1000;
    try {
      const ticket = await websocketTicketService.issue(
        req.user!.userId,
        sessionExpiresAt,
        audience,
        audience === 'work-terminal' ? taskId.trim() : undefined
      );
      res.json({ success: true, data: ticket });
    } catch (error) {
      if (error instanceof WebSocketTicketRateLimitError) {
        res.status(429).json({ success: false, message: error.message });
        return;
      }
      logger.warn('Shared WebSocket ticket storage is unavailable');
      res.status(503).json({
        success: false,
        message: 'WebSocket authentication is temporarily unavailable',
      });
    }
  }
);

/**
 * Login endpoint
 */
router.post('/login', loginRateLimiter, async (req, res) => {
  try {
    const { username, password, turnstileToken } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
      return;
    }

    const turnstileValid = await turnstileService.verify(
      turnstileToken,
      getClientIp(req),
      'login'
    );

    if (!turnstileValid) {
      res.status(400).json({
        success: false,
        message: 'Verification failed. Please try again.',
      });
      return;
    }

    const result = await authService.login(username, password);
    if (!result) {
      res.status(401).json({
        success: false,
        message: 'Invalid credentials',
      });
      return;
    }
    if (result.status === 'pending') {
      res.status(403).json({
        success: false,
        code: 'ACCOUNT_PENDING',
        message: 'Your account is waiting for administrator approval',
      });
      return;
    }

    const systemInfo = await authService.getSystemInfo();

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo,
      },
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * Logout endpoint
 */
router.post(
  '/logout',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      // In a stateless JWT system, logout is handled client-side
      // But we can log it for audit purposes
      logger.debug(`User ${req.user?.username} logged out`);

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      logger.error('Logout error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Verify token endpoint
 */
router.get(
  '/verify',
  generalAuthRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const user = await authService.getUserFromToken(
        req.headers.authorization!.substring(7)
      );
      if (!user) {
        res.status(401).json({
          success: false,
          message: 'Invalid token',
        });
        return;
      }

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      logger.error('Token verification error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Get system information
 */
router.get('/system-info', async (req, res) => {
  try {
    const systemInfo = await authService.getSystemInfo();
    res.json({
      success: true,
      data: systemInfo,
    });
  } catch (error) {
    logger.error('System info error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * Get encryption key for first-time setup
 * Only accessible during initial setup (when only one user exists - the newly created admin)
 */
router.get(
  '/encryption-key',
  generalAuthRateLimiter,
  authenticate,
  requireAdmin,
  async (_req, res) => {
    try {
      const systemInfo = await authService.getSystemInfo();

      // Keep the first-time setup behavior, but bind disclosure to the
      // authenticated administrator created by that setup.
      if (systemInfo.userCount !== 1) {
        res.status(403).json({
          success: false,
          message: 'Encryption key is only available during first-time setup',
        });
        return;
      }

      const encryptionKey = encryptionService.getKeyForDisplay();
      res.json({
        success: true,
        data: { encryptionKey },
      });
    } catch (error) {
      logger.error('Encryption key retrieval error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Signup endpoint
 */
router.post('/signup', signupRateLimiter, async (req, res) => {
  try {
    if (!(await authService.canCreateLocalAccount())) {
      res.status(403).json({
        success: false,
        message: 'Registration is disabled',
      });
      return;
    }

    const { username, password, email, turnstileToken } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
      });
      return;
    }

    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      res.status(400).json({
        success: false,
        message: 'Password does not meet security requirements',
        errors: passwordValidation.errors,
      });
      return;
    }

    // Check if user already exists
    const existingUser = await authService.getUserByUsername(username);
    if (existingUser) {
      res.status(409).json({
        success: false,
        message: 'Username already exists',
      });
      return;
    }

    const turnstileValid = await turnstileService.verify(
      turnstileToken,
      getClientIp(req),
      'signup'
    );

    if (!turnstileValid) {
      res.status(400).json({
        success: false,
        message: 'Verification failed. Please try again.',
      });
      return;
    }

    const result = await authService.signup(username, password, email);
    if (!result) {
      res.status(500).json({
        success: false,
        message: 'Failed to create account',
      });
      return;
    }

    const systemInfo = await authService.getSystemInfo();

    if (result.status === 'pending') {
      res.status(202).json({
        success: true,
        data: {
          user: result.user,
          approvalRequired: true,
          systemInfo,
        },
      });
      return;
    }

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo,
      },
    });
  } catch (error) {
    logger.error('Signup error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * GitHub OAuth Routes
 * These routes integrate GitHub OAuth with the existing JWT authentication system
 */

// GitHub OAuth setup if credentials are provided
const isGitHubConfigured = githubOAuthService.isConfigured();

/**
 * GitHub OAuth - Start authentication
 */
router.get('/oauth/github', generalAuthRateLimiter, (req, res) => {
  if (!isGitHubConfigured) {
    return res.status(404).json({ error: 'GitHub OAuth not configured' });
  }

  const state = beginOAuthFlow(req, res, 'github');
  const authUrl = githubOAuthService.getAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * GitHub OAuth - Handle callback and generate JWT
 */
router.get(
  '/oauth/github/callback',
  generalAuthRateLimiter,
  async (req, res) => {
    try {
      if (!isGitHubConfigured) {
        return res.redirect(oauthErrorRedirect('oauth_not_configured'));
      }

      const { code, state } = req.query;
      const stateIsValid = consumeOAuthState(
        req,
        res,
        'github',
        typeof state === 'string' ? state : ''
      );

      if (!code || typeof code !== 'string' || !stateIsValid) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Exchange code for access token
      const accessToken = await githubOAuthService.exchangeCodeForToken(code);
      if (!accessToken) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Get user profile
      const profile = await githubOAuthService.getUserProfile(accessToken);
      if (!profile) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Process user with GitHub OAuth service
      const user = await githubOAuthService.processUser(profile);

      if (!user) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      if (user.status !== 'active') {
        return res.redirect(pendingApprovalRedirect());
      }

      // Generate JWT token using existing auth service
      const token = authService.generateToken(user);

      logger.debug('GitHub OAuth successful for user:', user.username);

      setOAuthSessionCookie(req, res, token);
      res.redirect(frontendRedirect('?auth=success'));
    } catch (error) {
      logger.error('GitHub OAuth callback error:', error);
      res.redirect(oauthErrorRedirect('oauth_failed'));
    }
  }
);

/**
 * Check if GitHub OAuth is configured
 */
router.get('/oauth/github/status', generalAuthRateLimiter, (req, res) => {
  res.json({ configured: isGitHubConfigured });
});

/**
 * Hugging Face OAuth Routes
 * These routes integrate Hugging Face OAuth with the existing JWT authentication system
 */

// Hugging Face OAuth setup if credentials are provided
const isHuggingFaceConfigured = huggingFaceOAuthService.isConfigured();

/**
 * Hugging Face OAuth - Start authentication
 */
router.get('/oauth/huggingface', generalAuthRateLimiter, (req, res) => {
  if (!isHuggingFaceConfigured) {
    return res.status(404).json({ error: 'Hugging Face OAuth not configured' });
  }

  const state = beginOAuthFlow(req, res, 'huggingface');
  const authUrl = huggingFaceOAuthService.getAuthUrl(state);
  res.redirect(authUrl);
});

/**
 * Hugging Face OAuth - Handle callback and generate JWT
 */
router.get(
  '/oauth/huggingface/callback',
  generalAuthRateLimiter,
  async (req, res) => {
    try {
      if (!isHuggingFaceConfigured) {
        return res.redirect(oauthErrorRedirect('oauth_not_configured'));
      }

      const { code, state } = req.query;
      const stateIsValid = consumeOAuthState(
        req,
        res,
        'huggingface',
        typeof state === 'string' ? state : ''
      );

      if (!code || typeof code !== 'string' || !stateIsValid) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Exchange code for access token
      const accessToken =
        await huggingFaceOAuthService.exchangeCodeForToken(code);
      if (!accessToken) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Get user profile
      const profile = await huggingFaceOAuthService.getUserProfile(accessToken);
      if (!profile) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      // Process user with Hugging Face OAuth service
      const user = await huggingFaceOAuthService.processUser(profile);

      if (!user) {
        return res.redirect(oauthErrorRedirect('oauth_failed'));
      }

      if (user.status !== 'active') {
        return res.redirect(pendingApprovalRedirect());
      }

      // Generate JWT token
      const token = authService.generateToken(user);

      logger.debug('Hugging Face OAuth successful for user:', user.username);

      setOAuthSessionCookie(req, res, token);
      res.redirect(frontendRedirect('?auth=success'));
    } catch (error) {
      logger.error('Hugging Face OAuth callback error:', error);
      res.redirect(oauthErrorRedirect('oauth_failed'));
    }
  }
);

/**
 * Check if Hugging Face OAuth is configured
 */
router.get('/oauth/huggingface/status', generalAuthRateLimiter, (req, res) => {
  res.json({ configured: isHuggingFaceConfigured });
});

/**
 * Exchange the short-lived HttpOnly OAuth transfer cookie for the application's
 * normal bearer-token response. The cookie is cleared even when it is invalid.
 */
router.post('/oauth/exchange', generalAuthRateLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = consumeOAuthSessionCookie(req, res);
  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'OAuth session is missing or expired',
    });
  }

  const user = await authService.getUserFromToken(token);
  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'OAuth session is invalid or expired',
    });
  }

  return res.json({
    success: true,
    data: {
      user,
      token,
      systemInfo: await authService.getSystemInfo(),
    },
  });
});

/**
 * Get current user info (works with both regular JWT and GitHub OAuth JWT)
 */
router.get(
  '/me',
  generalAuthRateLimiter,
  // We can't use the existing authenticate middleware due to type conflicts
  // So we'll do manual JWT verification
  async (req, res) => {
    try {
      const token = req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.substring(7)
        : null;

      if (!token) {
        return res.status(401).json({
          success: false,
          message: 'No token provided',
        });
      }

      const user = await authService.getUserFromToken(token);
      if (!user) {
        return res.status(401).json({
          success: false,
          message: 'Invalid token',
        });
      }

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      logger.error('Get user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

export default router;
