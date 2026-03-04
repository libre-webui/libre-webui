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
import type { DatabaseAdapter } from '../database/types.js';
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
  private getDb(): DatabaseAdapter | null {
    return getDatabaseSafe();
  }

  private ensureDatabase(): DatabaseAdapter {
    const db = this.getDb();
    if (!db) throw new Error('Database not available');
    return db;
  }

  async getAllUsers(): Promise<UserPublic[]> {
    const db = this.ensureDatabase();
    const users = await db.all<Omit<User, 'password_hash'>>(
      `SELECT id, username, email, role, avatar, created_at, updated_at
       FROM users WHERE id != 'default' ORDER BY created_at DESC`
    );
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

  async getUserById(id: string): Promise<UserPublic | null> {
    const db = this.ensureDatabase();
    const user = await db.get<Omit<User, 'password_hash'>>(
      `SELECT id, username, email, role, avatar, created_at, updated_at
       FROM users WHERE id = ?`,
      id
    );
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

  async getUserByUsername(username: string): Promise<User | null> {
    const db = this.ensureDatabase();
    return (
      (await db.get<User>(
        'SELECT * FROM users WHERE username = ?',
        username
      )) ?? null
    );
  }

  async createUser(userData: UserCreateData): Promise<UserPublic> {
    const id = uuidv4();
    const now = Date.now();
    const passwordHash = await bcrypt.hash(userData.password, 12);
    const db = this.ensureDatabase();

    await db.run(
      `INSERT INTO users (id, username, email, password_hash, role, avatar, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userData.username,
      userData.email || null,
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

  async updateUser(
    id: string,
    userData: UserUpdateData
  ): Promise<UserPublic | null> {
    const existingUser = await this.getUserById(id);
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
      updates.push('password_hash = ?');
      values.push(await bcrypt.hash(userData.password, 12));
    }
    if (userData.role !== undefined) {
      updates.push('role = ?');
      values.push(userData.role);
    }
    if (userData.avatar !== undefined) {
      updates.push('avatar = ?');
      values.push(userData.avatar);
    }
    if (updates.length === 0) return existingUser;

    updates.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const db = this.ensureDatabase();
    await db.run(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
      ...values
    );
    return this.getUserById(id);
  }

  async deleteUser(id: string): Promise<boolean> {
    const db = this.ensureDatabase();
    const result = await db.run('DELETE FROM users WHERE id = ?', id);
    return result.changes > 0;
  }

  async verifyPassword(
    username: string,
    password: string
  ): Promise<User | null> {
    const user = await this.getUserByUsername(username);
    if (!user) return null;
    return (await bcrypt.compare(password, user.password_hash)) ? user : null;
  }

  async usernameExists(username: string): Promise<boolean> {
    const db = this.ensureDatabase();
    return !!(await db.get('SELECT 1 FROM users WHERE username = ?', username));
  }

  async emailExists(email: string): Promise<boolean> {
    const db = this.ensureDatabase();
    return !!(await db.get('SELECT 1 FROM users WHERE email = ?', email));
  }

  async getUserCount(): Promise<number> {
    const db = this.ensureDatabase();
    const r = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM users WHERE id != ?',
      'default'
    );
    return r?.count ?? 0;
  }

  async getRealUserCount(): Promise<number> {
    return this.getUserCount();
  }
}

export const userModel = new UserModel();
