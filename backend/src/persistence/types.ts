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

import type { ApplicationResourceRepositories } from './resourceTypes.js';
import type { ExtensionRepositories } from './extensionTypes.js';
import type { IdentityDeletionEnqueuer } from './identityDeletionTypes.js';
import type {
  SecurityRepositories,
  SecuritySyncRepositories,
} from './securityTypes.js';

export type PersistenceDialect = 'sqlite' | 'postgres';

export interface PersistenceRunResult {
  changes: number;
}

export interface PersistenceExecutor {
  run(
    sql: string,
    parameters?: readonly unknown[]
  ): Promise<PersistenceRunResult>;
  get<T>(sql: string, parameters?: readonly unknown[]): Promise<T | undefined>;
  all<T>(sql: string, parameters?: readonly unknown[]): Promise<T[]>;
}

export interface PersistenceSyncExecutor {
  run(sql: string, parameters?: readonly unknown[]): PersistenceRunResult;
  get<T>(sql: string, parameters?: readonly unknown[]): T | undefined;
  all<T>(sql: string, parameters?: readonly unknown[]): T[];
}

/**
 * Application-level protection for identity email addresses. The persistence
 * adapter owns the storage boundary, so callers always exchange plaintext
 * records while SQLite only receives authenticated ciphertext.
 */
export interface IdentityEmailCodec {
  encrypt(plaintext: string): string;
  decryptAuthenticated(ciphertext: string): string;
  decryptBuffer(ciphertext: Buffer, additionalData?: Buffer): Buffer;
  isEncrypted(value: string): boolean;
  lookupToken(plaintext: string): string;
}

export type IdentityAccountStatus = 'pending' | 'active' | 'retiring';
export type IdentityRole = 'admin' | 'user';

export interface IdentityUserRecord {
  id: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: IdentityRole;
  account_status: IdentityAccountStatus;
  approved_at: number | null;
  approved_by: string | null;
  avatar: string | null;
  created_at: number;
  updated_at: number;
}

export type IdentityPublicUserRecord = Omit<
  IdentityUserRecord,
  'password_hash'
>;

export interface IdentityUserUpdate {
  username?: string;
  email?: string | null;
  passwordHash?: string;
  role?: IdentityRole;
  avatar?: string | null;
  updatedAt: number;
}

export interface PendingApprovalRecord {
  count: number;
  latest_created_at: number | null;
}

export interface IdentityRepository {
  list(): Promise<IdentityPublicUserRecord[]>;
  findPublicById(id: string): Promise<IdentityPublicUserRecord | null>;
  findAccountStatusById(id: string): Promise<IdentityAccountStatus | null>;
  findByUsername(username: string): Promise<IdentityUserRecord | null>;
  insert(user: IdentityUserRecord): Promise<void>;
  approve(id: string, approvedBy: string, approvedAt: number): Promise<boolean>;
  /** Idempotently fences an active identity before cross-domain cleanup. */
  beginRetirement(id: string, updatedAt: number): Promise<boolean>;
  getPendingApprovalSummary(): Promise<PendingApprovalRecord>;
  update(id: string, update: IdentityUserUpdate): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  deleteAndEnqueue(
    id: string,
    actorUserId: string,
    enqueuer: IdentityDeletionEnqueuer
  ): Promise<boolean>;
  usernameExists(username: string): Promise<boolean>;
  emailExists(email: string): Promise<boolean>;
  countRealUsers(): Promise<number>;
}

export interface IdentitySyncRepository {
  list(): IdentityPublicUserRecord[];
  findPublicById(id: string): IdentityPublicUserRecord | null;
  findAccountStatusById(id: string): IdentityAccountStatus | null;
  findByUsername(username: string): IdentityUserRecord | null;
  insert(user: IdentityUserRecord): void;
  approve(id: string, approvedBy: string, approvedAt: number): boolean;
  beginRetirement(id: string, updatedAt: number): boolean;
  getPendingApprovalSummary(): PendingApprovalRecord;
  update(id: string, update: IdentityUserUpdate): boolean;
  delete(id: string): boolean;
  usernameExists(username: string): boolean;
  emailExists(email: string): boolean;
  countRealUsers(): number;
}

export interface PersistenceRepositories {
  identity: IdentityRepository;
  resources: ApplicationResourceRepositories;
  extensions: ExtensionRepositories;
  security: SecurityRepositories;
}

export interface PersistenceUnitOfWork {
  identity: IdentityRepository;
  resources: ApplicationResourceRepositories;
  extensions: ExtensionRepositories;
  security: SecurityRepositories;
}

export interface PersistenceSyncUnitOfWork {
  identity: IdentitySyncRepository;
  security: SecuritySyncRepositories;
}

export type SynchronousTransactionResult<T> =
  T extends PromiseLike<unknown> ? never : T;

interface PersistenceBase {
  readonly dialect: PersistenceDialect;
  readonly repositories: PersistenceRepositories;
  health(): Promise<PersistenceHealth>;
  close(): Promise<void>;
}

export interface SQLitePersistenceContract extends PersistenceBase {
  readonly dialect: 'sqlite';
  transaction<T>(
    operation: (
      unitOfWork: PersistenceSyncUnitOfWork
    ) => SynchronousTransactionResult<T>
  ): Promise<T>;
}

export interface PostgresPersistenceContract extends PersistenceBase {
  readonly dialect: 'postgres';
  transaction<T>(
    operation: (unitOfWork: PersistenceUnitOfWork) => Promise<T>
  ): Promise<T>;
}

export type Persistence =
  SQLitePersistenceContract | PostgresPersistenceContract;

export interface PersistenceHealth {
  ready: boolean;
  dialect: PersistenceDialect;
  latencyMs: number;
  message?: string;
  pool?: {
    total: number;
    idle: number;
    waiting: number;
  };
}
