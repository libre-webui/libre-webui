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
import { userModel, type UserPublic } from '../models/userModel.js';
import { authService, AuthTokenPayload } from '../services/authService.js';
import {
  getValidSession,
  getTokenInvalidBefore,
  touchSessionThrottled,
} from '../services/authSessionService.js';
import {
  ApiTokenRateLimitError,
  ApiTokenScopeError,
  assertTokenAllowsPath,
  consumeApiTokenRateLimit,
  looksLikeApiToken,
  parseTokenScopes,
  resolveApiToken,
  touchApiTokenUse,
  type ApiTokenScope,
} from '../services/apiTokenService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('middleware:auth');

/** How the request was authenticated; set alongside `req.user`. */
export type AuthContext =
  | { kind: 'session'; sessionId: string }
  | { kind: 'legacy-token' }
  | { kind: 'api-token'; tokenId: string; scopes: ApiTokenScope[] };

// Extend Request interface to include user
export interface AuthenticatedRequest extends Request {
  user?: AuthTokenPayload;
  auth?: AuthContext;
}

const unauthorized = (res: Response, message: string): void => {
  res.status(401).json({ success: false, message });
};

const activeUserFor = async (
  userId: string
): Promise<
  { user: UserPublic } | { error: 'missing' } | { error: 'pending' }
> => {
  const currentUser = await userModel.getUserById(userId);
  if (!currentUser) return { error: 'missing' };
  if (currentUser.status !== 'active') return { error: 'pending' };
  return { user: currentUser };
};

/**
 * Validate a JWT against its server-side session. Returns the auth context
 * on success or a rejection reason.
 */
const resolveJwtContext = async (
  payload: AuthTokenPayload
): Promise<{ context: AuthContext } | { rejected: string }> => {
  if (payload.sid) {
    const session = await getValidSession(payload.sid);
    if (!session || session.user_id !== payload.userId) {
      return { rejected: 'This session has been signed out' };
    }
    await touchSessionThrottled(session);
    return { context: { kind: 'session', sessionId: session.id } };
  }
  // Legacy tokens carry no session id; a full "sign out everywhere"
  // invalidates them through the per-user epoch.
  const invalidBefore = await getTokenInvalidBefore(payload.userId);
  if (
    invalidBefore > 0 &&
    (payload.iat === undefined || payload.iat * 1000 < invalidBefore)
  ) {
    return { rejected: 'This session has been signed out' };
  }
  return { context: { kind: 'legacy-token' } };
};

const authenticateWithApiToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  bearer: string
): Promise<void> => {
  const record = await resolveApiToken(bearer);
  if (!record) {
    unauthorized(res, 'Invalid or expired API token');
    return;
  }
  let scopes: ApiTokenScope[];
  try {
    scopes = assertTokenAllowsPath(record, req.originalUrl.split('?')[0]);
    await consumeApiTokenRateLimit(record.id);
  } catch (error) {
    if (error instanceof ApiTokenScopeError) {
      res.status(403).json({
        success: false,
        code: 'TOKEN_SCOPE',
        message: error.message,
      });
      return;
    }
    if (error instanceof ApiTokenRateLimitError) {
      res.status(429).json({
        success: false,
        message: 'API token rate limit exceeded',
      });
      return;
    }
    throw error;
  }

  const resolved = await activeUserFor(record.user_id);
  if ('error' in resolved) {
    unauthorized(res, 'The account for this token is not active');
    return;
  }
  await touchApiTokenUse(record);
  req.user = {
    userId: resolved.user.id,
    username: resolved.user.username,
    role: resolved.user.role,
  };
  req.auth = { kind: 'api-token', tokenId: record.id, scopes };
  next();
};

/**
 * Authentication middleware. Accepts a session-bound JWT or a scoped
 * personal API token (prefix `lwk_`).
 */
export const authenticate = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      unauthorized(res, 'No authorization token provided');
      return;
    }

    const token = authHeader.substring(7);
    if (looksLikeApiToken(token)) {
      await authenticateWithApiToken(req, res, next, token);
      return;
    }

    const payload = authService.verifyToken(token);
    if (!payload) {
      unauthorized(res, 'Invalid or expired token');
      return;
    }

    const sessionResult = await resolveJwtContext(payload);
    if ('rejected' in sessionResult) {
      unauthorized(res, sessionResult.rejected);
      return;
    }

    const resolved = await activeUserFor(payload.userId);
    if ('error' in resolved) {
      if (resolved.error === 'pending') {
        res.status(403).json({
          success: false,
          code: 'ACCOUNT_PENDING',
          message: 'Your account is waiting for administrator approval',
        });
        return;
      }
      unauthorized(res, 'The account for this session no longer exists');
      return;
    }

    // Refresh identity and role from the database on every request. A deleted
    // account is rejected above, and role changes take effect without waiting
    // for the JWT to expire.
    req.user = {
      userId: resolved.user.id,
      username: resolved.user.username,
      role: resolved.user.role,
      ...(payload.sid !== undefined ? { sid: payload.sid } : {}),
      ...(payload.iat !== undefined ? { iat: payload.iat } : {}),
      ...(payload.exp !== undefined ? { exp: payload.exp } : {}),
    };
    req.auth =
      'context' in sessionResult
        ? sessionResult.context
        : { kind: 'legacy-token' };
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

  // An API token needs the admin scope in addition to the admin role.
  if (req.auth?.kind === 'api-token' && !req.auth.scopes.includes('admin')) {
    res.status(403).json({
      success: false,
      code: 'TOKEN_SCOPE',
      message: "This API token is missing the 'admin' scope",
    });
    return;
  }

  try {
    const currentUser = await userModel.getUserById(req.user.userId);
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
      if (looksLikeApiToken(token)) {
        // API tokens are for the API surface; optional-auth routes treat
        // them like an anonymous request unless they resolve cleanly.
        const record = await resolveApiToken(token);
        if (record) {
          const resolved = await activeUserFor(record.user_id);
          if (!('error' in resolved)) {
            req.user = {
              userId: resolved.user.id,
              username: resolved.user.username,
              role: resolved.user.role,
            };
            req.auth = {
              kind: 'api-token',
              tokenId: record.id,
              scopes: parseTokenScopes(record),
            };
          }
        }
        next();
        return;
      }
      const payload = authService.verifyToken(token);
      if (payload) {
        const sessionResult = await resolveJwtContext(payload);
        if ('context' in sessionResult) {
          const currentUser = await userModel.getUserById(payload.userId);
          if (currentUser?.status === 'active') {
            req.user = {
              userId: currentUser.id,
              username: currentUser.username,
              role: currentUser.role,
              ...(payload.sid !== undefined ? { sid: payload.sid } : {}),
              ...(payload.iat !== undefined ? { iat: payload.iat } : {}),
              ...(payload.exp !== undefined ? { exp: payload.exp } : {}),
            };
            req.auth = sessionResult.context;
          }
        }
      }
    }
  } catch (error) {
    logger.error('Optional auth error:', error);
  }

  next();
};
