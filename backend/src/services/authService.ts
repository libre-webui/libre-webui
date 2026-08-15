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

import jwt, { type SignOptions } from 'jsonwebtoken';
import { userModel, UserPublic } from '../models/userModel.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { turnstileService, TurnstilePublicConfig } from './turnstileService.js';
import { getAgentsEnabled } from './agentAccessService.js';
import {
  canCreateLocalAccount,
  isPublicRegistrationEnabled,
} from './registrationPolicy.js';
import { createLogger } from '../utils/logger.js';
import { validatePasswordStrength } from '../utils/hash.js';

const logger = createLogger('services:auth-service');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
let packageVersion = '0.1.0';
try {
  const packageJsonPath = join(__dirname, '..', '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  packageVersion = packageJson.version;
} catch (_error) {
  logger.warn('Could not read version from package.json, using default');
}

// Generate or use JWT secret - never use hardcoded secrets in production
export const JWT_SECRET =
  process.env.JWT_SECRET ||
  (() => {
    const generatedSecret = randomBytes(64).toString('hex');
    logger.warn(
      '⚠️  JWT_SECRET not provided - generated random secret for this session'
    );
    logger.warn(
      '🔒 For production, set JWT_SECRET environment variable to persist sessions across restarts'
    );
    return generatedSecret;
  })();

export const parseJwtLifetime = (
  value = process.env.JWT_EXPIRES_IN
): SignOptions['expiresIn'] => {
  const normalized = value?.trim();
  if (!normalized) return '7d';
  if (/^\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  if (/^\d+(?:ms|s|m|h|d|w|y)$/i.test(normalized)) {
    return normalized as SignOptions['expiresIn'];
  }
  logger.warn(
    `Ignoring invalid JWT_EXPIRES_IN value "${normalized}"; using 7d.`
  );
  return '7d';
};

export const JWT_EXPIRES_IN = parseJwtLifetime();

export interface AuthTokenPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  iat?: number;
  exp?: number;
}

export type AuthResult =
  | { status: 'authenticated'; user: UserPublic; token: string }
  | { status: 'pending'; user: UserPublic };

export interface SystemInfo {
  requiresAuth: boolean;
  hasUsers: boolean;
  userCount: number;
  signupEnabled: boolean;
  agentsEnabled: boolean;
  version?: string;
  turnstile: TurnstilePublicConfig;
}

export class AuthService {
  /**
   * Generate JWT token for user
   */
  generateToken(user: UserPublic): string {
    if (user.status !== 'active') {
      throw new Error('Cannot create a session for an inactive account');
    }

    const payload = {
      userId: user.id,
      username: user.username,
      role: user.role,
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Verify JWT token
   */
  verifyToken(token: string): AuthTokenPayload | null {
    try {
      return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
    } catch (error) {
      // Expired/invalid tokens are an expected, routine condition (e.g. a stale
      // token left in the browser), so return null quietly. Only surface
      // genuinely unexpected failures, and without dumping a full stack trace.
      if (!(error instanceof jwt.JsonWebTokenError)) {
        logger.error(
          'Unexpected token verification error:',
          error instanceof Error ? error.message : error
        );
      }
      return null;
    }
  }

  /**
   * Login user
   */
  async login(username: string, password: string): Promise<AuthResult | null> {
    const user = await userModel.verifyPassword(username, password);
    if (!user) return null;

    const userPublic = await userModel.getUserById(user.id);
    if (!userPublic) return null;
    if (userPublic.status !== 'active') {
      return { status: 'pending', user: userPublic };
    }

    const token = this.generateToken(userPublic);
    return { status: 'authenticated', user: userPublic, token };
  }

  /**
   * Get system information
   */
  async getSystemInfo(): Promise<SystemInfo> {
    const userCount = await userModel.getUserCount();

    return {
      requiresAuth: true, // For now, always require auth
      hasUsers: userCount > 0,
      userCount,
      signupEnabled: canCreateLocalAccount(userCount),
      agentsEnabled: await getAgentsEnabled(),
      version: packageVersion,
      turnstile: turnstileService.getPublicConfig(),
    };
  }

  /** Whether public registration is enabled by configuration. */
  isPublicRegistrationEnabled(): boolean {
    return isPublicRegistrationEnabled();
  }

  /** Whether the local signup endpoint may create an account right now. */
  async canCreateLocalAccount(): Promise<boolean> {
    return canCreateLocalAccount(await userModel.getUserCount());
  }

  /**
   * Get user from token
   */
  async getUserFromToken(token: string): Promise<UserPublic | null> {
    const payload = this.verifyToken(token);
    if (!payload) return null;

    const user = await userModel.getUserById(payload.userId);
    return user?.status === 'active' ? user : null;
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<UserPublic | null> {
    const user = await userModel.getUserByUsername(username);
    if (!user) return null;

    return userModel.getUserById(user.id);
  }

  /**
   * Signup user
   */
  async signup(
    username: string,
    password: string,
    email?: string
  ): Promise<AuthResult | null> {
    try {
      if (!(await this.canCreateLocalAccount())) {
        logger.warn(
          'Blocked account creation because registration is disabled'
        );
        return null;
      }

      if (!validatePasswordStrength(password).isValid) {
        logger.warn('Blocked account creation because the password is weak');
        return null;
      }

      const userData = {
        username,
        password,
        email: email || null, // Use null instead of empty string
      };

      // Bootstrap must remain possible. The model atomically makes the first
      // real user active/admin and holds every later registration for review.
      const user = await userModel.createPublicUser(
        userData,
        this.isPublicRegistrationEnabled()
      );
      if (!user) return null;

      if (user.status === 'pending') {
        return { status: 'pending', user };
      }

      const token = this.generateToken(user);
      return { status: 'authenticated', user, token };
    } catch (error) {
      logger.error('Signup error:', error);
      return null;
    }
  }
}

export const authService = new AuthService();
