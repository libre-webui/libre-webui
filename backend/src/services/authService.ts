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

import jwt from 'jsonwebtoken';
import { userModel, UserPublic } from '../models/userModel.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import { systemSettingsService } from './systemSettingsService.js';
import { turnstileService, TurnstilePublicConfig } from './turnstileService.js';
import {
  canCreateLocalAccount,
  isPublicRegistrationEnabled,
} from './registrationPolicy.js';
import { createLogger } from '../utils/logger.js';

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

export interface AuthTokenPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
}

export type AuthResult =
  | { status: 'authenticated'; user: UserPublic; token: string }
  | { status: 'pending'; user: UserPublic };

export interface SystemInfo {
  requiresAuth: boolean;
  hasUsers: boolean;
  userCount: number;
  signupEnabled: boolean;
  allowUserModelPull: boolean;
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

    return jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
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

    const userPublic = userModel.getUserById(user.id);
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
  getSystemInfo(): SystemInfo {
    const userCount = userModel.getUserCount();

    return {
      requiresAuth: true, // For now, always require auth
      hasUsers: userCount > 0,
      userCount,
      signupEnabled: canCreateLocalAccount(userCount),
      allowUserModelPull: systemSettingsService.getAllowUserModelPull(),
      version: packageVersion,
      turnstile: turnstileService.getPublicConfig(),
    };
  }

  /** Whether public registration is enabled by configuration. */
  isPublicRegistrationEnabled(): boolean {
    return isPublicRegistrationEnabled();
  }

  /** Whether the local signup endpoint may create an account right now. */
  canCreateLocalAccount(): boolean {
    return canCreateLocalAccount(userModel.getUserCount());
  }

  /**
   * Get user from token
   */
  async getUserFromToken(token: string): Promise<UserPublic | null> {
    const payload = this.verifyToken(token);
    if (!payload) return null;

    const user = userModel.getUserById(payload.userId);
    return user?.status === 'active' ? user : null;
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<UserPublic | null> {
    const user = userModel.getUserByUsername(username);
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
      if (!this.canCreateLocalAccount()) {
        logger.warn(
          'Blocked account creation because registration is disabled'
        );
        return null;
      }

      const userData = {
        username,
        password,
        email: email || null, // Use null instead of empty string
      };

      // Bootstrap must remain possible. The model atomically makes the first
      // real user active/admin and holds every later registration for review.
      const user = await userModel.createPublicUser(userData);
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
