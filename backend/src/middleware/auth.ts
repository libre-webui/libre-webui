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

import { Request, Response, NextFunction } from 'express';
import { userModel } from '../models/userModel.js';
import { authService, AuthTokenPayload } from '../services/authService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('middleware:auth');

// Extend Request interface to include user
export interface AuthenticatedRequest extends Request {
  user?: AuthTokenPayload;
}

/**
 * Authentication middleware
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        message: 'No authorization token provided',
      });
      return;
    }

    const token = authHeader.substring(7);
    const payload = authService.verifyToken(token);

    if (!payload) {
      res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
      });
      return;
    }

    const currentUser = userModel.getUserById(payload.userId);
    if (!currentUser) {
      res.status(401).json({
        success: false,
        message: 'The account for this session no longer exists',
      });
      return;
    }
    if (currentUser.status !== 'active') {
      res.status(403).json({
        success: false,
        code: 'ACCOUNT_PENDING',
        message: 'Your account is waiting for administrator approval',
      });
      return;
    }

    // Refresh identity and role from the database on every request. A deleted
    // account is rejected above, and role changes take effect without waiting
    // for the JWT to expire.
    req.user = {
      userId: currentUser.id,
      username: currentUser.username,
      role: currentUser.role,
      ...(payload.iat !== undefined ? { iat: payload.iat } : {}),
      ...(payload.exp !== undefined ? { exp: payload.exp } : {}),
    };
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(401).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

/**
 * Admin only middleware
 */
export const requireAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    res.status(403).json({
      success: false,
      message: 'Admin access required',
    });
    return;
  }

  try {
    const currentUser = userModel.getUserById(req.user.userId);
    if (
      !currentUser ||
      currentUser.status !== 'active' ||
      currentUser.role !== 'admin'
    ) {
      res.status(403).json({
        success: false,
        message: 'Admin access required',
      });
      return;
    }

    // Authorization follows current database state rather than the role cached
    // in a still-valid JWT, so demotion or deletion takes effect immediately.
    req.user = {
      ...req.user,
      username: currentUser.username,
      role: currentUser.role,
    };
    next();
  } catch (error) {
    logger.error('Admin authorization error:', error);
    res.status(500).json({
      success: false,
      message: 'Authorization check failed',
    });
  }
};

/**
 * Optional authentication middleware - doesn't block if no token
 */
export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      const payload = authService.verifyToken(token);
      if (payload) {
        const currentUser = userModel.getUserById(payload.userId);
        if (currentUser?.status === 'active') {
          req.user = {
            userId: currentUser.id,
            username: currentUser.username,
            role: currentUser.role,
            ...(payload.iat !== undefined ? { iat: payload.iat } : {}),
            ...(payload.exp !== undefined ? { exp: payload.exp } : {}),
          };
        }
      }
    }
  } catch (error) {
    logger.error('Optional auth error:', error);
  }

  next();
};
