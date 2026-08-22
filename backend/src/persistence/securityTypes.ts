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

/**
 * Trust-foundation persistence contracts: groups, resource grants, auth
 * sessions, API tokens, OAuth identities, and the security audit log.
 *
 * Repositories exchange snake_case row shapes with epoch-millisecond
 * timestamps, mirroring the resource repositories. Values arrive already
 * validated; secrets (API tokens) arrive already hashed. The audit log is
 * append-only: there is no update or delete surface beyond retention pruning.
 */

export type GrantPrincipalType = 'user' | 'group';
export type GrantPermission = 'read' | 'write' | 'admin';
export type AuditResult = 'success' | 'denied' | 'failure';

export interface StoredGroupRecord {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredGroupMemberRecord {
  group_id: string;
  user_id: string;
  added_by: string | null;
  added_at: number;
}

export interface StoredResourceGrantRecord {
  id: string;
  resource_type: string;
  resource_id: string;
  owner_user_id: string;
  principal_type: GrantPrincipalType;
  principal_id: string;
  permission: GrantPermission;
  created_by: string;
  created_at: number;
}

export interface StoredAuthSessionRecord {
  id: string;
  user_id: string;
  kind: string;
  ip_hash: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface StoredApiTokenRecord {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  token_prefix: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface StoredOAuthIdentityRecord {
  provider: string;
  subject: string;
  user_id: string;
  email: string | null;
  created_at: number;
  updated_at: number;
}

export interface StoredSecurityAuditEventRecord {
  id: string;
  occurred_at: number;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: AuditResult;
  request_id: string | null;
  ip_hash: string | null;
  details: string | null;
}

export interface StoredUserMfaRecord {
  user_id: string;
  /** Encrypted TOTP secret (base32 plaintext before encryption). */
  totp_secret: string;
  activated_at: number | null;
  /** Last accepted TOTP timestep, to refuse code replay. */
  last_used_step: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredMfaRecoveryCodeRecord {
  id: string;
  user_id: string;
  /** Keyed one-way lookup token of the recovery code; never the code itself. */
  code_lookup: string;
  created_at: number;
  used_at: number | null;
}

export interface StoredWebAuthnCredentialRecord {
  id: string;
  user_id: string;
  /** Keyed one-way lookup token of the raw credential id. */
  credential_lookup: string;
  /** Encrypted JSON: credential id, COSE public key, algorithm, transports. */
  credential_data: string;
  name: string | null;
  sign_count: number;
  created_at: number;
  last_used_at: number | null;
}

export interface SecurityAuditQuery {
  action?: string;
  actorUserId?: string;
  result?: AuditResult;
  targetType?: string;
  before?: number;
  after?: number;
  limit: number;
}

export interface GroupRepository {
  list(): Promise<StoredGroupRecord[]>;
  findById(groupId: string): Promise<StoredGroupRecord | null>;
  findByName(name: string): Promise<StoredGroupRecord | null>;
  insert(group: StoredGroupRecord): Promise<void>;
  update(
    groupId: string,
    patch: { name?: string; description?: string | null; updated_at: number }
  ): Promise<boolean>;
  delete(groupId: string): Promise<boolean>;
  listMembers(groupId: string): Promise<StoredGroupMemberRecord[]>;
  listGroupIdsForUser(userId: string): Promise<string[]>;
  listGroupsForUser(userId: string): Promise<StoredGroupRecord[]>;
  addMember(member: StoredGroupMemberRecord): Promise<boolean>;
  removeMember(groupId: string, userId: string): Promise<boolean>;
  removeUserFromAllGroups(userId: string): Promise<number>;
}

export interface ResourceGrantRepository {
  listForResource(
    resourceType: string,
    resourceId: string
  ): Promise<StoredResourceGrantRecord[]>;
  listForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): Promise<StoredResourceGrantRecord[]>;
  findById(grantId: string): Promise<StoredResourceGrantRecord | null>;
  /**
   * Effective grants for a user against one resource: direct user grants
   * plus grants held by any of the supplied group ids.
   */
  listEffective(
    resourceType: string,
    resourceId: string,
    userId: string,
    groupIds: readonly string[]
  ): Promise<StoredResourceGrantRecord[]>;
  upsert(grant: StoredResourceGrantRecord): Promise<void>;
  delete(grantId: string): Promise<boolean>;
  deleteForResource(resourceType: string, resourceId: string): Promise<number>;
  deleteForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): Promise<number>;
  deleteForOwner(ownerUserId: string): Promise<number>;
}

export interface AuthSessionRepository {
  insert(session: StoredAuthSessionRecord): Promise<void>;
  findById(sessionId: string): Promise<StoredAuthSessionRecord | null>;
  listByUser(userId: string): Promise<StoredAuthSessionRecord[]>;
  touch(sessionId: string, lastSeenAt: number): Promise<boolean>;
  revoke(
    sessionId: string,
    revokedAt: number,
    revokedBy: string
  ): Promise<boolean>;
  revokeAllForUser(
    userId: string,
    revokedAt: number,
    revokedBy: string,
    exceptSessionId?: string
  ): Promise<string[]>;
  deleteExpired(before: number): Promise<number>;
  deleteForUser(userId: string): Promise<number>;
}

export interface ApiTokenRepository {
  insert(token: StoredApiTokenRecord): Promise<void>;
  findByHash(tokenHash: string): Promise<StoredApiTokenRecord | null>;
  findById(tokenId: string): Promise<StoredApiTokenRecord | null>;
  listByUser(userId: string): Promise<StoredApiTokenRecord[]>;
  listAll(): Promise<StoredApiTokenRecord[]>;
  touchLastUsed(tokenId: string, lastUsedAt: number): Promise<boolean>;
  revoke(tokenId: string, revokedAt: number): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
}

export interface OAuthIdentityRepository {
  find(
    provider: string,
    subject: string
  ): Promise<StoredOAuthIdentityRecord | null>;
  listByUser(userId: string): Promise<StoredOAuthIdentityRecord[]>;
  upsert(identity: StoredOAuthIdentityRecord): Promise<void>;
  deleteForUser(userId: string): Promise<number>;
}

export interface SecurityAuditRepository {
  insert(event: StoredSecurityAuditEventRecord): Promise<void>;
  query(query: SecurityAuditQuery): Promise<StoredSecurityAuditEventRecord[]>;
  deleteBefore(before: number): Promise<number>;
}

export interface MfaRepository {
  find(userId: string): Promise<StoredUserMfaRecord | null>;
  /** Insert or replace the (single) pending/active MFA row for a user. */
  upsert(record: StoredUserMfaRecord): Promise<void>;
  activate(
    userId: string,
    activatedAt: number,
    updatedAt: number
  ): Promise<boolean>;
  /**
   * Record the accepted TOTP timestep. Only advances forward, so a replayed
   * or older code can never be marked used twice.
   */
  markStepUsed(
    userId: string,
    step: number,
    updatedAt: number
  ): Promise<boolean>;
  delete(userId: string): Promise<boolean>;
  replaceRecoveryCodes(
    userId: string,
    records: StoredMfaRecoveryCodeRecord[]
  ): Promise<void>;
  findRecoveryCode(
    codeLookup: string
  ): Promise<StoredMfaRecoveryCodeRecord | null>;
  /** Consume exactly once; false if already used. */
  consumeRecoveryCode(id: string, usedAt: number): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  deleteRecoveryCodes(userId: string): Promise<number>;
}

export interface WebAuthnCredentialRepository {
  insert(record: StoredWebAuthnCredentialRecord): Promise<void>;
  findByLookup(
    credentialLookup: string
  ): Promise<StoredWebAuthnCredentialRecord | null>;
  listByUser(userId: string): Promise<StoredWebAuthnCredentialRecord[]>;
  updateSignCount(
    id: string,
    signCount: number,
    lastUsedAt: number
  ): Promise<boolean>;
  delete(id: string, userId: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
  countForUser(userId: string): Promise<number>;
  countAll(): Promise<number>;
}

export interface SecurityRepositories {
  groups: GroupRepository;
  grants: ResourceGrantRepository;
  authSessions: AuthSessionRepository;
  apiTokens: ApiTokenRepository;
  oauthIdentities: OAuthIdentityRepository;
  audit: SecurityAuditRepository;
  mfa: MfaRepository;
  webauthnCredentials: WebAuthnCredentialRepository;
}

/**
 * Synchronous variants used inside owned SQLite transactions, so a
 * security-critical mutation and its audit event commit atomically.
 */
export interface GroupSyncRepository {
  findById(groupId: string): StoredGroupRecord | null;
  findByName(name: string): StoredGroupRecord | null;
  insert(group: StoredGroupRecord): void;
  update(
    groupId: string,
    patch: { name?: string; description?: string | null; updated_at: number }
  ): boolean;
  delete(groupId: string): boolean;
  addMember(member: StoredGroupMemberRecord): boolean;
  removeMember(groupId: string, userId: string): boolean;
}

export interface ResourceGrantSyncRepository {
  findById(grantId: string): StoredResourceGrantRecord | null;
  upsert(grant: StoredResourceGrantRecord): void;
  delete(grantId: string): boolean;
  deleteForResource(resourceType: string, resourceId: string): number;
  deleteForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): number;
}

export interface SecurityAuditSyncRepository {
  insert(event: StoredSecurityAuditEventRecord): void;
}

export interface SecuritySyncRepositories {
  groups: GroupSyncRepository;
  grants: ResourceGrantSyncRepository;
  audit: SecurityAuditSyncRepository;
}
