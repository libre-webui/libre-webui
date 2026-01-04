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

import { getDatabaseSafe } from '../db.js';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';

export interface User {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: 'admin' | 'user';
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserCreateData {
  username: string;
  email: string | null;
  password: string;
  role: 'admin' | 'user';
  avatar?: string | null;
}

export interface UserUpdateData {
  username?: string;
  email?: string | null;
  password?: string;
  role?: 'admin' | 'user';
  avatar?: string | null;
}

export interface UserPublic {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'user';
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
}

export class UserModel {
  private db = getDatabaseSafe();

  /**
   * Ensure database is available
   */
  private ensureDatabase() {
    if (!this.db) {
      throw new Error('Database not available');
    }
    return this.db;
  }

  /**
   * Get all users (excluding the default system user)
   */
  getAllUsers(): UserPublic[] {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT id, username, email, role, avatar, created_at, updated_at
      FROM users
      WHERE id != 'default'
      ORDER BY created_at DESC
    `);

    const users = stmt.all() as Omit<User, 'password_hash'>[];
    return users.map(user => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar: user.avatar,
      createdAt: new Date(user.created_at).toISOString(),
      updatedAt: new Date(user.updated_at).toISOString(),
    }));
  }

  /**
   * Get user by ID
   */
  getUserById(id: string): UserPublic | null {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT id, username, email, role, avatar, created_at, updated_at
      FROM users
      WHERE id = ?
    `);

    const user = stmt.get(id) as Omit<User, 'password_hash'> | undefined;
    if (!user) return null;

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      avatar: user.avatar,
      createdAt: new Date(user.created_at).toISOString(),
      updatedAt: new Date(user.updated_at).toISOString(),
    };
  }

  /**
   * Get user by username
   */
  getUserByUsername(username: string): User | null {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT *
      FROM users
      WHERE username = ?
    `);

    return stmt.get(username) as User | null;
  }

  /**
   * Create a new user
   */
  async createUser(userData: UserCreateData): Promise<UserPublic> {
    const id = uuidv4();
    const now = Date.now();
    const passwordHash = await bcrypt.hash(userData.password, 12);

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT INTO users (id, username, email, password_hash, role, avatar, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      userData.username,
      userData.email || null, // Store NULL instead of empty string
      passwordHash,
      userData.role,
      userData.avatar || null,
      now,
      now
    );

    return {
      id,
      username: userData.username,
      email: userData.email,
      role: userData.role,
      avatar: userData.avatar || null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Update a user
   */
  async updateUser(
    id: string,
    userData: UserUpdateData
  ): Promise<UserPublic | null> {
    const existingUser = this.getUserById(id);
    if (!existingUser) return null;

    const now = Date.now();
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (userData.username !== undefined) {
      updates.push('username = ?');
      values.push(userData.username);
    }

    if (userData.email !== undefined) {
      updates.push('email = ?');
      values.push(userData.email);
    }

    if (userData.password !== undefined) {
      const passwordHash = await bcrypt.hash(userData.password, 12);
      updates.push('password_hash = ?');
      values.push(passwordHash);
    }

    if (userData.role !== undefined) {
      updates.push('role = ?');
      values.push(userData.role);
    }

    if (userData.avatar !== undefined) {
      updates.push('avatar = ?');
      values.push(userData.avatar);
    }

    if (updates.length === 0) {
      return existingUser;
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    stmt.run(...values);

    return this.getUserById(id);
  }

  /**
   * Delete a user
   */
  deleteUser(id: string): boolean {
    const db = this.ensureDatabase();
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * Verify user password
   */
  async verifyPassword(
    username: string,
    password: string
  ): Promise<User | null> {
    const user = this.getUserByUsername(username);
    if (!user) return null;

    const isValid = await bcrypt.compare(password, user.password_hash);
    return isValid ? user : null;
  }

  /**
   * Check if username exists
   */
  usernameExists(username: string): boolean {
    const db = this.ensureDatabase();
    const stmt = db.prepare('SELECT 1 FROM users WHERE username = ?');
    return !!stmt.get(username);
  }

  /**
   * Check if email exists
   */
  emailExists(email: string): boolean {
    const db = this.ensureDatabase();
    const stmt = db.prepare('SELECT 1 FROM users WHERE email = ?');
    return !!stmt.get(email);
  }

  /**
   * Get user count (excluding the default system user)
   */
  getUserCount(): number {
    const db = this.ensureDatabase();
    const stmt = db.prepare(
      'SELECT COUNT(*) as count FROM users WHERE id != ?'
    );
    const result = stmt.get('default') as { count: number };
    return result.count;
  }

  /**
   * Get real user count (excluding default system user) - alias for getUserCount
   */
  getRealUserCount(): number {
    return this.getUserCount();
  }
}

export const userModel = new UserModel();
