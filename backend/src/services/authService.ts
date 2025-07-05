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

const JWT_SECRET =
  process.env.JWT_SECRET ||
  'your-super-secret-jwt-key-change-this-in-production';

export interface AuthTokenPayload {
  userId: string;
  username: string;
  role: 'admin' | 'user';
}

export interface SystemInfo {
  requiresAuth: boolean;
  singleUserMode: boolean;
  hasUsers: boolean;
  version?: string;
}

export class AuthService {
  /**
   * Generate JWT token for user
   */
  generateToken(user: UserPublic): string {
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
      const payload = jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
      return payload;
    } catch (error) {
      console.error('Token verification failed:', error);
      return null;
    }
  }

  /**
   * Login user
   */
  async login(
    username: string,
    password: string
  ): Promise<{ user: UserPublic; token: string } | null> {
    const user = await userModel.verifyPassword(username, password);
    if (!user) return null;

    const userPublic: UserPublic = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: new Date(user.created_at).toISOString(),
      updatedAt: new Date(user.updated_at).toISOString(),
    };

    const token = this.generateToken(userPublic);
    return { user: userPublic, token };
  }

  /**
   * Get system information
   */
  getSystemInfo(): SystemInfo {
    const userCount = userModel.getUserCount();

    return {
      requiresAuth: true, // For now, always require auth
      singleUserMode: userCount === 1,
      hasUsers: userCount > 0,
      version: '1.0.0',
    };
  }

  /**
   * Get user from token
   */
  async getUserFromToken(token: string): Promise<UserPublic | null> {
    const payload = this.verifyToken(token);
    if (!payload) return null;

    return userModel.getUserById(payload.userId);
  }

  /**
   * Get user by username
   */
  async getUserByUsername(username: string): Promise<UserPublic | null> {
    const user = userModel.getUserByUsername(username);
    if (!user) return null;

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      createdAt: new Date(user.created_at).toISOString(),
      updatedAt: new Date(user.updated_at).toISOString(),
    };
  }

  /**
   * Signup user
   */
  async signup(
    username: string,
    password: string,
    email?: string
  ): Promise<{ user: UserPublic; token: string } | null> {
    try {
      const userCount = userModel.getUserCount();

      const userData = {
        username,
        password,
        email: email || '',
        // First user becomes admin, subsequent users are regular users
        role: userCount === 0 ? ('admin' as const) : ('user' as const),
      };

      const user = await userModel.createUser(userData);
      if (!user) return null;

      const token = this.generateToken(user);
      return { user, token };
    } catch (error) {
      console.error('Signup error:', error);
      return null;
    }
  }
}

export const authService = new AuthService();
