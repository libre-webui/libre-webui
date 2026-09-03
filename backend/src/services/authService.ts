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
  getDefaultTheme,
  type ThemePreference,
} from './appearanceSettingsService.js';
import { getOllamaRuntimeSettings } from './ollamaSettingsService.js';
import {
  canCreateLocalAccount,
  isPublicRegistrationEnabled,
} from './registrationPolicy.js';
import { createLogger } from '../utils/logger.js';
import { validatePasswordStrength } from '../utils/hash.js';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';

const logger = createLogger('services:auth-service');

/**
 * Whether any user has a registered passkey. Drives the passkey sign-in
 * affordance on the login screen: with zero credentials in the system the
 * button can never succeed, so it is not shown. Fails open to `false`.
 */
const anyPasskeysRegistered = async (): Promise<boolean> => {
  try {
    const count =
      await getPersistence(
        encryptionService
      ).repositories.security.webauthnCredentials.countAll();
    return count > 0;
  } catch (error) {
    logger.warn('Failed to count passkeys for system info', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

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

/** The configured JWT lifetime in milliseconds. */
export const jwtLifetimeMs = (
  lifetime: SignOptions['expiresIn'] = JWT_EXPIRES_IN
): number => {
  if (typeof lifetime === 'number') return lifetime * 1000;
  const match = /^(\d+)(ms|s|m|h|d|w|y)$/i.exec(String(lifetime ?? '7d'));
  if (!match) return 7 * 24 * 60 * 60 * 1000;
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const unitMs: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 7 * 86_400_000,
    y: 365 * 86_400_000,
  };
  return amount * (unitMs[unit] ?? 86_400_000);
};

export interface AuthTokenPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
  /** Server-side auth session id; absent only on legacy tokens. */
  sid?: string;
  iat?: number;
  exp?: number;
}

export interface SessionMetadata {
  kind: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type AuthResult =
  | { status: 'authenticated'; user: UserPublic; token: string }
  | { status: 'pending'; user: UserPublic }
  | {
      status: 'mfa';
      user: UserPublic;
      /** verify = complete an existing second factor; enroll = policy-forced setup. */
      requirement: 'verify' | 'enroll';
      challengeToken: string;
    };

export interface SystemInfo {
  requiresAuth: boolean;
  hasUsers: boolean;
  userCount: number;
  signupEnabled: boolean;
  agentsEnabled: boolean;
  /** True when at least one passkey is registered system-wide. */
  passkeysInUse: boolean;
  /** False when the admin disabled the Ollama provider entirely. */
  ollamaEnabled: boolean;
  version?: string;
  turnstile: TurnstilePublicConfig;
  /** Administrator-chosen theme for the sign-in page and new accounts. */
  defaultTheme: ThemePreference;
}

export class AuthService {
  /**
   * Generate JWT token for user. When a server-side session id is provided
   * the token carries it as `sid`, making the token revocable.
   */
  generateToken(user: UserPublic, sessionId?: string): string {
    if (user.status !== 'active') {
      throw new Error('Cannot create a session for an inactive account');
    }

    const payload = {
      userId: user.id,
      username: user.username,
      role: user.role,
      ...(sessionId ? { sid: sessionId } : {}),
    };

    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Create a server-side auth session and mint the JWT bound to it. All
   * login paths (password, signup bootstrap, OAuth, OIDC) issue through
   * here so every new token is revocable from the session inventory.
   */
  async issueSession(
    user: UserPublic,
    metadata: SessionMetadata
  ): Promise<string> {
    const { createAuthSession } = await import('./authSessionService.js');
    const session = await createAuthSession(
      user.id,
      metadata,
      Date.now() + jwtLifetimeMs()
    );
    return this.generateToken(user, session.id);
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
  async login(
    username: string,
    password: string,
    metadata?: SessionMetadata
  ): Promise<AuthResult | null> {
    const user = await userModel.verifyPassword(username, password);
    if (!user) return null;

    const userPublic = await userModel.getUserById(user.id);
    if (!userPublic) return null;
    if (userPublic.status !== 'active') {
      return { status: 'pending', user: userPublic };
    }

    // A password alone is not a session when the account has a second factor
    // (or the instance policy demands one). The caller receives a short-lived
    // challenge instead; /auth/mfa endpoints finish the sign-in.
    const { loginRequirement, issueMfaChallenge } =
      await import('./mfaService.js');
    const requirement = await loginRequirement(userPublic.id);
    if (requirement !== 'none') {
      const challengeToken = await issueMfaChallenge(
        userPublic.id,
        requirement === 'verify' ? 'mfa-verify' : 'mfa-enroll'
      );
      return { status: 'mfa', user: userPublic, requirement, challengeToken };
    }

    const token = await this.issueSession(userPublic, {
      kind: 'password',
      ...metadata,
    });
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
      passkeysInUse: await anyPasskeysRegistered(),
      ollamaEnabled: (await getOllamaRuntimeSettings()).enabled,
      version: packageVersion,
      turnstile: turnstileService.getPublicConfig(),
      defaultTheme: await getDefaultTheme(),
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
    email?: string,
    metadata?: SessionMetadata
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

      const token = await this.issueSession(user, {
        kind: 'signup',
        ...metadata,
      });
      return { status: 'authenticated', user, token };
    } catch (error) {
      logger.error('Signup error:', error);
      return null;
    }
  }
}

export const authService = new AuthService();
