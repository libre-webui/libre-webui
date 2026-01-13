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
import { userModel } from '../models/userModel.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';

const router = express.Router();

// Rate limiter for user management routes: 30 requests per 15 minutes
const userRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // limit each IP to 30 requests per 15 minutes
  message: {
    success: false,
    message: 'Too many user management requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Get all users (admin only)
 */
router.get(
  '/',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const users = userModel.getAllUsers();
      res.json({
        success: true,
        data: users,
      });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Create a new user (admin only)
 */
router.post(
  '/',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const { username, email, password, role } = req.body;

      // Validate required fields
      if (!username || !email || !password || !role) {
        res.status(400).json({
          success: false,
          message: 'Username, email, password, and role are required',
        });
        return;
      }

      // Validate role
      if (role !== 'admin' && role !== 'user') {
        res.status(400).json({
          success: false,
          message: 'Role must be either "admin" or "user"',
        });
        return;
      }

      // Check if username exists
      if (userModel.usernameExists(username)) {
        res.status(400).json({
          success: false,
          message: 'Username already exists',
        });
        return;
      }

      // Check if email exists
      if (userModel.emailExists(email)) {
        res.status(400).json({
          success: false,
          message: 'Email already exists',
        });
        return;
      }

      const { avatar } = req.body;

      const user = await userModel.createUser({
        username,
        email,
        password,
        role,
        avatar,
      });

      res.status(201).json({
        success: true,
        data: user,
      });
    } catch (error) {
      console.error('Create user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Update current user's profile (self-update, avatar only)
 */
router.patch(
  '/me/avatar',
  userRateLimiter,
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        res.status(401).json({
          success: false,
          message: 'Not authenticated',
        });
        return;
      }

      const { avatar } = req.body;

      const user = await userModel.updateUser(userId, { avatar });

      if (!user) {
        res.status(404).json({
          success: false,
          message: 'User not found',
        });
        return;
      }

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      console.error('Update avatar error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Update a user (admin only)
 */
router.patch(
  '/:id',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = req.params.id as string;
      const { username, email, password, role, avatar } = req.body;

      // Validate role if provided
      if (role && role !== 'admin' && role !== 'user') {
        res.status(400).json({
          success: false,
          message: 'Role must be either "admin" or "user"',
        });
        return;
      }

      // Check if username exists (and is not the current user)
      if (username && userModel.usernameExists(username)) {
        const existingUser = userModel.getUserById(id);
        if (!existingUser || existingUser.username !== username) {
          res.status(400).json({
            success: false,
            message: 'Username already exists',
          });
          return;
        }
      }

      // Check if email exists (and is not the current user)
      if (email && userModel.emailExists(email)) {
        const existingUser = userModel.getUserById(id);
        if (!existingUser || existingUser.email !== email) {
          res.status(400).json({
            success: false,
            message: 'Email already exists',
          });
          return;
        }
      }

      const user = await userModel.updateUser(id, {
        username,
        email,
        password,
        role,
        avatar,
      });

      if (!user) {
        res.status(404).json({
          success: false,
          message: 'User not found',
        });
        return;
      }

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      console.error('Update user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Delete a user (admin only)
 */
router.delete(
  '/:id',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = req.params.id as string;

      // Prevent deleting yourself
      if (req.user?.userId === id) {
        res.status(400).json({
          success: false,
          message: 'You cannot delete your own account',
        });
        return;
      }

      const deleted = userModel.deleteUser(id);
      if (!deleted) {
        res.status(404).json({
          success: false,
          message: 'User not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'User deleted successfully',
      });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

export default router;
