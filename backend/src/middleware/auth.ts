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
import { authService, AuthTokenPayload } from '../services/authService.js';

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

    req.user = payload;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
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
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({
      success: false,
      message: 'Admin access required',
    });
    return;
  }

  next();
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
    console.log(
      '[OPTIONAL-AUTH-DEBUG] Request details - method:',
      req.method,
      'path:',
      req.path,
      'authHeader:',
      authHeader ? 'Present' : 'Missing'
    );

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      console.log('[OPTIONAL-AUTH-DEBUG] Token found, length:', token.length);
      console.log(
        '[OPTIONAL-AUTH-DEBUG] Token preview:',
        token.length > 20 ? `${token.substring(0, 20)}...` : token
      );

      try {
        const payload = authService.verifyToken(token);
        if (payload) {
          req.user = payload;
          console.log(
            '[OPTIONAL-AUTH-DEBUG] Auth successful for user:',
            payload.userId
          );
        } else {
          console.log('[OPTIONAL-AUTH-DEBUG] Token verification returned null');
        }
      } catch (error) {
        console.log(
          '[OPTIONAL-AUTH-DEBUG] Token verification failed:',
          (error as Error).message
        );
      }
    } else {
      console.log('[OPTIONAL-AUTH-DEBUG] No valid auth header found');
    }
  } catch (error) {
    console.error('Optional auth error:', error);
  }

  next();
};
