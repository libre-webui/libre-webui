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
import { authService } from '../services/authService.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';

const router = express.Router();

/**
 * Login endpoint
 */
router.post('/login', async (req, res) => {
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
router.post('/logout', authenticate, async (req: AuthenticatedRequest, res) => {
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
});

/**
 * Verify token endpoint
 */
router.get('/verify', authenticate, async (req: AuthenticatedRequest, res) => {
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
});

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
router.post('/signup', async (req, res) => {
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

export default router;
