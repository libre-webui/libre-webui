/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import bcrypt from 'bcryptjs';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from '../services/encryptionService.js';
import { transactionalIdentityDeletionEnqueuer } from '../platform/jobs/identityDeletionEnqueuer.js';
import type {
  IdentityAccountStatus,
  IdentityRepository,
  IdentitySyncRepository,
  IdentityUserRecord,
  Persistence,
} from '../persistence/index.js';
import { randomUUID } from 'node:crypto';

export type AccountStatus = IdentityAccountStatus;
export type User = IdentityUserRecord;

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
  constructor(
    private readonly persistenceProvider: () => Persistence = () =>
      getPersistence(encryptionService)
  ) {}

  private toPublic(user: Omit<User, 'password_hash'>): UserPublic {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.account_status,
      approvedAt:
        user.approved_at === null
          ? null
          : new Date(user.approved_at).toISOString(),
      approvedBy: user.approved_by,
      avatar: user.avatar,
      createdAt: new Date(user.created_at).toISOString(),
      updatedAt: new Date(user.updated_at).toISOString(),
    };
  }

  /** Get all users, excluding the default single-user identity. */
  async getAllUsers(): Promise<UserPublic[]> {
    const users = await this.persistenceProvider().repositories.identity.list();
    return users.map(user => this.toPublic(user));
  }

  async getUserById(id: string): Promise<UserPublic | null> {
    const user =
      await this.persistenceProvider().repositories.identity.findPublicById(id);
    return user ? this.toPublic(user) : null;
  }

  getUserByUsername(username: string): Promise<User | null> {
    return this.persistenceProvider().repositories.identity.findByUsername(
      username
    );
  }

  async createUser(userData: UserCreateData): Promise<UserPublic> {
    const passwordHash = await bcrypt.hash(userData.password, 12);
    const accountStatus = userData.accountStatus ?? 'active';
    return this.insertUser(
      this.persistenceProvider().repositories.identity,
      userData,
      passwordHash,
      accountStatus
    );
  }

  /**
   * Atomically decide whether a public registration is the bootstrap
   * administrator or a pending user. Password hashing happens before the unit
   * of work so the database transaction remains short.
   */
  async createPublicUser(
    userData: Omit<UserCreateData, 'role' | 'accountStatus'>,
    allowNonBootstrapRegistration = true
  ): Promise<UserPublic | null> {
    const passwordHash = await bcrypt.hash(userData.password, 12);
    const persistence = this.persistenceProvider();
    if (persistence.dialect === 'sqlite') {
      return persistence.transaction(({ identity }) => {
        const isFirstRealUser = identity.countRealUsers() === 0;
        if (!isFirstRealUser && !allowNonBootstrapRegistration) return null;

        return this.insertUserSynchronously(
          identity,
          {
            ...userData,
            role: isFirstRealUser ? 'admin' : 'user',
          },
          passwordHash,
          isFirstRealUser ? 'active' : 'pending'
        );
      });
    }
    return persistence.transaction(async ({ identity }) => {
      const isFirstRealUser = (await identity.countRealUsers()) === 0;
      if (!isFirstRealUser && !allowNonBootstrapRegistration) return null;
      return this.insertUser(
        identity,
        {
          ...userData,
          role: isFirstRealUser ? 'admin' : 'user',
        },
        passwordHash,
        isFirstRealUser ? 'active' : 'pending'
      );
    });
  }

  private async insertUser(
    identity: IdentityRepository,
    userData: UserCreateData,
    passwordHash: string,
    accountStatus: AccountStatus
  ): Promise<UserPublic> {
    const user = this.createUserRecord(userData, passwordHash, accountStatus);
    await identity.insert(user);
    return this.toPublic(user);
  }

  private insertUserSynchronously(
    identity: IdentitySyncRepository,
    userData: UserCreateData,
    passwordHash: string,
    accountStatus: AccountStatus
  ): UserPublic {
    const user = this.createUserRecord(userData, passwordHash, accountStatus);
    identity.insert(user);
    return this.toPublic(user);
  }

  private createUserRecord(
    userData: UserCreateData,
    passwordHash: string,
    accountStatus: AccountStatus
  ): User {
    const id = randomUUID();
    const now = Date.now();
    const approvedAt = accountStatus === 'active' ? now : null;
    const user: User = {
      id,
      username: userData.username,
      email: userData.email || null,
      password_hash: passwordHash,
      role: userData.role,
      account_status: accountStatus,
      approved_at: approvedAt,
      approved_by: null,
      avatar: userData.avatar || null,
      created_at: now,
      updated_at: now,
    };

    return user;
  }

  /** Activate a pending account and record the administrator who reviewed it. */
  async approveUser(
    id: string,
    approvedBy: string
  ): Promise<UserPublic | null> {
    const persistence = this.persistenceProvider();
    if (persistence.dialect === 'sqlite') {
      return persistence.transaction(({ identity }) => {
        const now = Date.now();
        if (!identity.approve(id, approvedBy, now)) return null;
        const user = identity.findPublicById(id);
        return user ? this.toPublic(user) : null;
      });
    }
    return persistence.transaction(async ({ identity }) => {
      const now = Date.now();
      if (!(await identity.approve(id, approvedBy, now))) return null;
      const user = await identity.findPublicById(id);
      return user ? this.toPublic(user) : null;
    });
  }

  /** Return the durable state used by the administrator notification badge. */
  async getPendingApprovalSummary(): Promise<{
    count: number;
    latestCreatedAt: string | null;
  }> {
    const result =
      await this.persistenceProvider().repositories.identity.getPendingApprovalSummary();
    return {
      count: result.count,
      latestCreatedAt:
        result.latest_created_at === null
          ? null
          : new Date(result.latest_created_at).toISOString(),
    };
  }

  async updateUser(
    id: string,
    userData: UserUpdateData
  ): Promise<UserPublic | null> {
    const existingUser = await this.getUserById(id);
    if (!existingUser) return null;

    if (Object.values(userData).every(value => value === undefined)) {
      return existingUser;
    }

    const passwordHash =
      userData.password === undefined
        ? undefined
        : await bcrypt.hash(userData.password, 12);
    const identity = this.persistenceProvider().repositories.identity;
    const normalizedEmail =
      userData.email === undefined
        ? undefined
        : userData.email === null || userData.email.trim() === ''
          ? null
          : userData.email.trim();
    await identity.update(id, {
      username: userData.username,
      email: normalizedEmail,
      passwordHash,
      role: userData.role,
      avatar: userData.avatar,
      updatedAt: Date.now(),
    });
    const updatedUser = await identity.findPublicById(id);
    return updatedUser ? this.toPublic(updatedUser) : null;
  }

  deleteUser(id: string): Promise<boolean> {
    return this.persistenceProvider().repositories.identity.delete(id);
  }

  beginUserRetirement(id: string): Promise<boolean> {
    return this.persistenceProvider().repositories.identity.beginRetirement(
      id,
      Date.now()
    );
  }

  deleteUserAndEnqueueCleanup(
    id: string,
    actorUserId: string
  ): Promise<boolean> {
    return this.persistenceProvider().repositories.identity.deleteAndEnqueue(
      id,
      actorUserId,
      transactionalIdentityDeletionEnqueuer
    );
  }

  async verifyPassword(
    username: string,
    password: string
  ): Promise<User | null> {
    const user = await this.getUserByUsername(username);
    if (!user) return null;
    return (await bcrypt.compare(password, user.password_hash)) ? user : null;
  }

  usernameExists(username: string): Promise<boolean> {
    return this.persistenceProvider().repositories.identity.usernameExists(
      username
    );
  }

  emailExists(email: string): Promise<boolean> {
    return this.persistenceProvider().repositories.identity.emailExists(email);
  }

  getUserCount(): Promise<number> {
    return this.persistenceProvider().repositories.identity.countRealUsers();
  }

  getRealUserCount(): Promise<number> {
    return this.getUserCount();
  }
}

export const userModel = new UserModel();
