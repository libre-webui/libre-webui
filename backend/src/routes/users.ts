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
import rateLimit from '../middleware/sharedRateLimit.js';
import { userModel, UserPublic } from '../models/userModel.js';
import {
  authenticate,
  requireAdmin,
  AuthenticatedRequest,
} from '../middleware/auth.js';
import workAgentService from '../services/workAgentService.js';
import { createLogger } from '../utils/logger.js';
import { validatePasswordStrength } from '../utils/hash.js';

const logger = createLogger('routes:users');

const router = express.Router();

// Rate limiter for user management routes: 30 requests per 15 minutes
const userRateLimiter = rateLimit({
  keyPrefix: 'users-admin',
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
      const users = await userModel.getAllUsers();
      res.json({
        success: true,
        data: users,
      });
    } catch (error) {
      logger.error('Get users error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Get the pending-account summary used by administrator notifications.
 */
router.get(
  '/pending-approvals',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (_req: AuthenticatedRequest, res) => {
    try {
      res.json({
        success: true,
        data: await userModel.getPendingApprovalSummary(),
      });
    } catch (error) {
      logger.error('Get pending user approvals error:', error);
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

      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.isValid) {
        res.status(400).json({
          success: false,
          message: 'Password does not meet security requirements',
          errors: passwordValidation.errors,
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
      if (await userModel.usernameExists(username)) {
        res.status(400).json({
          success: false,
          message: 'Username already exists',
        });
        return;
      }

      // Check if email exists
      if (await userModel.emailExists(email)) {
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
      logger.error('Create user error:', error);
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
      logger.error('Update avatar error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Approve a pending public registration (admin only).
 */
router.patch(
  '/:id/approve',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = req.params.id as string;
      const existingUser = await userModel.getUserById(id);
      if (!existingUser) {
        res.status(404).json({
          success: false,
          message: 'User not found',
        });
        return;
      }
      if (existingUser.status !== 'pending') {
        res.status(409).json({
          success: false,
          message: 'This account is already active',
        });
        return;
      }

      const user = await userModel.approveUser(id, req.user!.userId);
      if (!user) {
        res.status(409).json({
          success: false,
          message: 'The account could not be approved',
        });
        return;
      }

      logger.info(
        `Administrator ${req.user!.username} approved account ${user.username}`
      );
      res.json({ success: true, data: user });
    } catch (error) {
      logger.error('Approve user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

/**
 * Reset a user's second factor (admin account recovery). Removes the TOTP
 * enrollment and recovery codes so the user can sign in with their password
 * and re-enroll. Passkeys are left in place: they are sign-in credentials
 * the user manages from settings.
 */
router.post(
  '/:id/mfa/reset',
  userRateLimiter,
  authenticate,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    try {
      const id = req.params.id as string;
      const existingUser = await userModel.getUserById(id);
      if (!existingUser) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      const { adminResetMfa } = await import('../services/mfaService.js');
      const removed = await adminResetMfa(id);
      const { recordAuditEvent } =
        await import('../services/securityAuditService.js');
      void recordAuditEvent({
        action: 'admin.mfa.reset',
        result: 'success',
        actorUserId: req.user!.userId,
        targetType: 'user',
        targetId: id,
        details: { removed },
      });
      logger.info(
        `Administrator ${req.user!.username} reset MFA for ${existingUser.username}`
      );
      res.json({ success: true, data: { removed } });
    } catch (error) {
      logger.error('MFA reset error:', error);
      res
        .status(500)
        .json({ success: false, message: 'Internal server error' });
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
      const existingUser = await userModel.getUserById(id);
      if (!existingUser) {
        res.status(404).json({
          success: false,
          message: 'User not found',
        });
        return;
      }

      if (password !== undefined) {
        const passwordValidation = validatePasswordStrength(password);
        if (!passwordValidation.isValid) {
          res.status(400).json({
            success: false,
            message: 'Password does not meet security requirements',
            errors: passwordValidation.errors,
          });
          return;
        }
      }

      // Validate role if provided
      if (role && role !== 'admin' && role !== 'user') {
        res.status(400).json({
          success: false,
          message: 'Role must be either "admin" or "user"',
        });
        return;
      }

      // Check if username exists (and is not the current user)
      if (username && (await userModel.usernameExists(username))) {
        if (existingUser.username !== username) {
          res.status(400).json({
            success: false,
            message: 'Username already exists',
          });
          return;
        }
      }

      // Check if email exists (and is not the current user)
      if (email && (await userModel.emailExists(email))) {
        if (existingUser.email !== email) {
          res.status(400).json({
            success: false,
            message: 'Email already exists',
          });
          return;
        }
      }

      const updateUser = (): Promise<UserPublic | null> =>
        userModel.updateUser(id, {
          username,
          email,
          password,
          role,
          avatar,
        });
      // Persist a requested non-admin role before depending on Docker
      // teardown. Existing JWTs are checked against the current database role,
      // so access remains revoked even if cleanup fails and an administrator
      // has to retry this same update later.
      const user =
        role === 'user'
          ? await workAgentService.revokeWorkAccessForUser(id, updateUser)
          : await updateUser();

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
      logger.error('Update user error:', error);
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

      if (!(await userModel.getUserById(id))) {
        res.status(404).json({
          success: false,
          message: 'User not found',
        });
        return;
      }

      // Retirement is durable and cross-replica. A failed job drain or Work
      // resource teardown leaves the account fail-closed and retryable; the
      // identity delete and owner-cleanup enqueue remain one transaction.
      const deleted = await workAgentService.retireAndDeleteUser(
        id,
        req.user!.userId
      );
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
      logger.error('Delete user error:', error);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    }
  }
);

export default router;
