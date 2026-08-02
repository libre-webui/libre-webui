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

export type AccountStatus = 'pending' | 'active';

export interface User {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: 'admin' | 'user';
  account_status: AccountStatus;
  approved_at: number | null;
  approved_by: string | null;
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

export interface UserCreateData {
  username: string;
  email: string | null;
  password: string;
  role: 'admin' | 'user';
  accountStatus?: AccountStatus;
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
  status: AccountStatus;
  approvedAt: string | null;
  approvedBy: string | null;
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

  private toPublic(user: Omit<User, 'password_hash'>): UserPublic {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.account_status,
      approvedAt: user.approved_at
        ? new Date(user.approved_at).toISOString()
        : null,
      approvedBy: user.approved_by,
      avatar: user.avatar,
      createdAt: new Date(user.created_at).toISOString(),
      updatedAt: new Date(user.updated_at).toISOString(),
    };
  }

  /**
   * Get all users (excluding the default system user)
   */
  getAllUsers(): UserPublic[] {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT id, username, email, role, account_status, approved_at, approved_by,
             avatar, created_at, updated_at
      FROM users
      WHERE id != 'default'
      ORDER BY created_at DESC
    `);

    const users = stmt.all() as Omit<User, 'password_hash'>[];
    return users.map(user => this.toPublic(user));
  }

  /**
   * Get user by ID
   */
  getUserById(id: string): UserPublic | null {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT id, username, email, role, account_status, approved_at, approved_by,
             avatar, created_at, updated_at
      FROM users
      WHERE id = ?
    `);

    const user = stmt.get(id) as Omit<User, 'password_hash'> | undefined;
    if (!user) return null;

    return this.toPublic(user);
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
    const passwordHash = await bcrypt.hash(userData.password, 12);
    const accountStatus = userData.accountStatus ?? 'active';
    return this.insertUser(userData, passwordHash, accountStatus);
  }

  /**
   * Atomically decide whether a public registration is the bootstrap
   * administrator or a pending user. Hashing happens before the transaction,
   * while the count and insert stay serialized to prevent two first admins.
   */
  async createPublicUser(
    userData: Omit<UserCreateData, 'role' | 'accountStatus'>
  ): Promise<UserPublic> {
    const passwordHash = await bcrypt.hash(userData.password, 12);
    const db = this.ensureDatabase();
    const create = db.transaction(() => {
      const count = db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE id != 'default'")
        .get() as { count: number };
      const isFirstRealUser = count.count === 0;
      return this.insertUser(
        {
          ...userData,
          role: isFirstRealUser ? 'admin' : 'user',
        },
        passwordHash,
        isFirstRealUser ? 'active' : 'pending'
      );
    });

    return create();
  }

  private insertUser(
    userData: UserCreateData,
    passwordHash: string,
    accountStatus: AccountStatus
  ): UserPublic {
    const id = uuidv4();
    const now = Date.now();
    const approvedAt = accountStatus === 'active' ? now : null;

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT INTO users (
        id, username, email, password_hash, role, account_status,
        approved_at, approved_by, avatar, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      userData.username,
      userData.email || null, // Store NULL instead of empty string
      passwordHash,
      userData.role,
      accountStatus,
      approvedAt,
      null,
      userData.avatar || null,
      now,
      now
    );

    return {
      id,
      username: userData.username,
      email: userData.email,
      role: userData.role,
      status: accountStatus,
      approvedAt: approvedAt ? new Date(approvedAt).toISOString() : null,
      approvedBy: null,
      avatar: userData.avatar || null,
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
  }

  /** Activate a pending account and record the administrator who reviewed it. */
  approveUser(id: string, approvedBy: string): UserPublic | null {
    const db = this.ensureDatabase();
    const now = Date.now();
    const result = db
      .prepare(
        `
          UPDATE users
          SET account_status = 'active', approved_at = ?, approved_by = ?, updated_at = ?
          WHERE id = ? AND id != 'default' AND account_status = 'pending'
        `
      )
      .run(now, approvedBy, now, id);

    if (result.changes === 0) return null;
    return this.getUserById(id);
  }

  /** Return the durable state used by the administrator notification badge. */
  getPendingApprovalSummary(): {
    count: number;
    latestCreatedAt: string | null;
  } {
    const db = this.ensureDatabase();
    const result = db
      .prepare(
        `
          SELECT COUNT(*) AS count, MAX(created_at) AS latest_created_at
          FROM users
          WHERE id != 'default' AND account_status = 'pending'
        `
      )
      .get() as { count: number; latest_created_at: number | null };

    return {
      count: result.count,
      latestCreatedAt: result.latest_created_at
        ? new Date(result.latest_created_at).toISOString()
        : null,
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
