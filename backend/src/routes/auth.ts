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
import { authService } from '../services/authService.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';

const router = express.Router();

// Rate limiter for authentication routes: 5 login attempts per 15 minutes
const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // limit each IP to 5 requests per windowMs for auth
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
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
 * Login endpoint
 */
router.post('/login', authRateLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
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

    const systemInfo = authService.getSystemInfo();

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
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
      console.log(`User ${req.user?.username} logged out`);

      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    } catch (error) {
      console.error('Logout error:', error);
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
      console.error('Token verification error:', error);
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
    const systemInfo = authService.getSystemInfo();
    res.json({
      success: true,
      data: systemInfo,
    });
  } catch (error) {
    console.error('System info error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * Signup endpoint
 */
router.post('/signup', authRateLimiter, async (req, res) => {
  try {
    const { username, password, email } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required',
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

    const result = await authService.signup(username, password, email);
    if (!result) {
      res.status(500).json({
        success: false,
        message: 'Failed to create account',
      });
      return;
    }

    const systemInfo = authService.getSystemInfo();

    res.json({
      success: true,
      data: {
        user: result.user,
        token: result.token,
        systemInfo,
      },
    });
  } catch (error) {
    console.error('Signup error:', error);
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

  const authUrl = githubOAuthService.getAuthUrl();
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
        return res.redirect(
          `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?error=oauth_not_configured`
        );
      }

      const { code } = req.query;

      if (!code || typeof code !== 'string') {
        return res.redirect(
          `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?error=oauth_failed`
        );
      }

      // Exchange code for access token
      const accessToken = await githubOAuthService.exchangeCodeForToken(code);
      if (!accessToken) {
        return res.redirect(
          `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?error=oauth_failed`
        );
      }

      // Get user profile
      const profile = await githubOAuthService.getUserProfile(accessToken);
      if (!profile) {
        return res.redirect(
          `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?error=oauth_failed`
        );
      }

      // Process user with GitHub OAuth service
      const user = await githubOAuthService.processUser(profile);

      if (!user) {
        return res.redirect(
          `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?error=oauth_failed`
        );
      }

      // Generate JWT token using existing auth service
      const token = authService.generateToken(user);

      console.log('GitHub OAuth successful for user:', user.username);

      // Redirect to frontend with token in URL
      res.redirect(
        `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?token=${token}&auth=success`
      );
    } catch (error) {
      console.error('GitHub OAuth callback error:', error);
      res.redirect(
        `${process.env.CORS_ORIGIN || 'http://localhost:5173'}?error=oauth_failed`
      );
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
      console.error('Get user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

export default router;
