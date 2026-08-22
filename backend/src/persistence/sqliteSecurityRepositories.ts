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

import type Database from 'better-sqlite3';
import type { PersistenceSyncExecutor } from './types.js';
import type {
  ApiTokenRepository,
  AuthSessionRepository,
  GrantPrincipalType,
  GroupRepository,
  GroupSyncRepository,
  MfaRepository,
  OAuthIdentityRepository,
  ResourceGrantRepository,
  ResourceGrantSyncRepository,
  SecurityAuditRepository,
  SecurityAuditSyncRepository,
  SecurityRepositories,
  SecuritySyncRepositories,
  SecurityAuditQuery,
  StoredApiTokenRecord,
  StoredAuthSessionRecord,
  StoredGroupMemberRecord,
  StoredGroupRecord,
  StoredMfaRecoveryCodeRecord,
  StoredOAuthIdentityRecord,
  StoredResourceGrantRecord,
  StoredSecurityAuditEventRecord,
  StoredUserMfaRecord,
  StoredWebAuthnCredentialRecord,
  WebAuthnCredentialRepository,
} from './securityTypes.js';

const insertGroupSql = `INSERT INTO user_groups
   (id, name, description, created_by, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?)`;

const insertMemberSql = `INSERT OR IGNORE INTO user_group_members
   (group_id, user_id, added_by, added_at)
 VALUES (?, ?, ?, ?)`;

const upsertGrantSql = `INSERT INTO resource_grants
   (id, resource_type, resource_id, owner_user_id,
    principal_type, principal_id, permission, created_by, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(resource_type, resource_id, principal_type, principal_id)
 DO UPDATE SET permission = excluded.permission,
               created_by = excluded.created_by,
               created_at = excluded.created_at`;

const insertAuditSql = `INSERT INTO security_audit_events
   (id, occurred_at, actor_user_id, actor_kind, action,
    target_type, target_id, result, request_id, ip_hash, details)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const applyGroupUpdate = (
  database: Database.Database,
  groupId: string,
  patch: { name?: string; description?: string | null; updated_at: number }
): boolean => {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    assignments.push('name = ?');
    values.push(patch.name);
  }
  if (patch.description !== undefined) {
    assignments.push('description = ?');
    values.push(patch.description);
  }
  assignments.push('updated_at = ?');
  values.push(patch.updated_at);
  return (
    database
      .prepare(`UPDATE user_groups SET ${assignments.join(', ')} WHERE id = ?`)
      .run(...values, groupId).changes > 0
  );
};

class SQLiteGroupRepository implements GroupRepository {
  constructor(private readonly database: Database.Database) {}

  async list(): Promise<StoredGroupRecord[]> {
    return this.database
      .prepare('SELECT * FROM user_groups ORDER BY name')
      .all() as StoredGroupRecord[];
  }

  async findById(groupId: string): Promise<StoredGroupRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM user_groups WHERE id = ?')
        .get(groupId) as StoredGroupRecord | undefined) ?? null
    );
  }

  async findByName(name: string): Promise<StoredGroupRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM user_groups WHERE name = ?')
        .get(name) as StoredGroupRecord | undefined) ?? null
    );
  }

  async insert(group: StoredGroupRecord): Promise<void> {
    this.database
      .prepare(insertGroupSql)
      .run(
        group.id,
        group.name,
        group.description,
        group.created_by,
        group.created_at,
        group.updated_at
      );
  }

  async update(
    groupId: string,
    patch: { name?: string; description?: string | null; updated_at: number }
  ): Promise<boolean> {
    return applyGroupUpdate(this.database, groupId, patch);
  }

  async delete(groupId: string): Promise<boolean> {
    return (
      this.database.prepare('DELETE FROM user_groups WHERE id = ?').run(groupId)
        .changes > 0
    );
  }

  async listMembers(groupId: string): Promise<StoredGroupMemberRecord[]> {
    return this.database
      .prepare(
        'SELECT * FROM user_group_members WHERE group_id = ? ORDER BY added_at'
      )
      .all(groupId) as StoredGroupMemberRecord[];
  }

  async listGroupIdsForUser(userId: string): Promise<string[]> {
    const rows = this.database
      .prepare('SELECT group_id FROM user_group_members WHERE user_id = ?')
      .all(userId) as Array<{ group_id: string }>;
    return rows.map(row => row.group_id);
  }

  async listGroupsForUser(userId: string): Promise<StoredGroupRecord[]> {
    return this.database
      .prepare(
        `SELECT g.* FROM user_groups g
           JOIN user_group_members m ON m.group_id = g.id
          WHERE m.user_id = ?
          ORDER BY g.name`
      )
      .all(userId) as StoredGroupRecord[];
  }

  async addMember(member: StoredGroupMemberRecord): Promise<boolean> {
    return (
      this.database
        .prepare(insertMemberSql)
        .run(member.group_id, member.user_id, member.added_by, member.added_at)
        .changes > 0
    );
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          'DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?'
        )
        .run(groupId, userId).changes > 0
    );
  }

  async removeUserFromAllGroups(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM user_group_members WHERE user_id = ?')
      .run(userId).changes;
  }
}

class SQLiteResourceGrantRepository implements ResourceGrantRepository {
  constructor(private readonly database: Database.Database) {}

  async listForResource(
    resourceType: string,
    resourceId: string
  ): Promise<StoredResourceGrantRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM resource_grants
          WHERE resource_type = ? AND resource_id = ?
          ORDER BY created_at`
      )
      .all(resourceType, resourceId) as StoredResourceGrantRecord[];
  }

  async listForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): Promise<StoredResourceGrantRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM resource_grants
          WHERE principal_type = ? AND principal_id = ?
          ORDER BY created_at`
      )
      .all(principalType, principalId) as StoredResourceGrantRecord[];
  }

  async findById(grantId: string): Promise<StoredResourceGrantRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM resource_grants WHERE id = ?')
        .get(grantId) as StoredResourceGrantRecord | undefined) ?? null
    );
  }

  async listEffective(
    resourceType: string,
    resourceId: string,
    userId: string,
    groupIds: readonly string[]
  ): Promise<StoredResourceGrantRecord[]> {
    const groupPredicate = groupIds.length
      ? ` OR (principal_type = 'group' AND principal_id IN (${groupIds
          .map(() => '?')
          .join(', ')}))`
      : '';
    return this.database
      .prepare(
        `SELECT * FROM resource_grants
          WHERE resource_type = ? AND resource_id = ?
            AND ((principal_type = 'user' AND principal_id = ?)${groupPredicate})`
      )
      .all(
        resourceType,
        resourceId,
        userId,
        ...groupIds
      ) as StoredResourceGrantRecord[];
  }

  async upsert(grant: StoredResourceGrantRecord): Promise<void> {
    this.database
      .prepare(upsertGrantSql)
      .run(
        grant.id,
        grant.resource_type,
        grant.resource_id,
        grant.owner_user_id,
        grant.principal_type,
        grant.principal_id,
        grant.permission,
        grant.created_by,
        grant.created_at
      );
  }

  async delete(grantId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM resource_grants WHERE id = ?')
        .run(grantId).changes > 0
    );
  }

  async deleteForResource(
    resourceType: string,
    resourceId: string
  ): Promise<number> {
    return this.database
      .prepare(
        'DELETE FROM resource_grants WHERE resource_type = ? AND resource_id = ?'
      )
      .run(resourceType, resourceId).changes;
  }

  async deleteForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): Promise<number> {
    return this.database
      .prepare(
        'DELETE FROM resource_grants WHERE principal_type = ? AND principal_id = ?'
      )
      .run(principalType, principalId).changes;
  }

  async deleteForOwner(ownerUserId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM resource_grants WHERE owner_user_id = ?')
      .run(ownerUserId).changes;
  }
}

class SQLiteAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly database: Database.Database) {}

  async insert(session: StoredAuthSessionRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO auth_sessions
           (id, user_id, kind, ip_hash, user_agent,
            created_at, last_seen_at, expires_at, revoked_at, revoked_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        session.id,
        session.user_id,
        session.kind,
        session.ip_hash,
        session.user_agent,
        session.created_at,
        session.last_seen_at,
        session.expires_at,
        session.revoked_at,
        session.revoked_by
      );
  }

  async findById(sessionId: string): Promise<StoredAuthSessionRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM auth_sessions WHERE id = ?')
        .get(sessionId) as StoredAuthSessionRecord | undefined) ?? null
    );
  }

  async listByUser(userId: string): Promise<StoredAuthSessionRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM auth_sessions
          WHERE user_id = ?
          ORDER BY last_seen_at DESC`
      )
      .all(userId) as StoredAuthSessionRecord[];
  }

  async touch(sessionId: string, lastSeenAt: number): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE auth_sessions SET last_seen_at = ?
            WHERE id = ? AND revoked_at IS NULL`
        )
        .run(lastSeenAt, sessionId).changes > 0
    );
  }

  async revoke(
    sessionId: string,
    revokedAt: number,
    revokedBy: string
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ?, revoked_by = ?
            WHERE id = ? AND revoked_at IS NULL`
        )
        .run(revokedAt, revokedBy, sessionId).changes > 0
    );
  }

  async revokeAllForUser(
    userId: string,
    revokedAt: number,
    revokedBy: string,
    exceptSessionId?: string
  ): Promise<string[]> {
    const revokeAll = this.database.transaction(() => {
      const exceptPredicate = exceptSessionId ? ' AND id != ?' : '';
      const parameters: Array<string | number> = [userId];
      if (exceptSessionId) parameters.push(exceptSessionId);
      const rows = this.database
        .prepare(
          `SELECT id FROM auth_sessions
            WHERE user_id = ? AND revoked_at IS NULL${exceptPredicate}`
        )
        .all(...parameters) as Array<{ id: string }>;
      this.database
        .prepare(
          `UPDATE auth_sessions SET revoked_at = ?, revoked_by = ?
            WHERE user_id = ? AND revoked_at IS NULL${exceptPredicate}`
        )
        .run(revokedAt, revokedBy, ...parameters);
      return rows.map(row => row.id);
    });
    return revokeAll.immediate();
  }

  async deleteExpired(before: number): Promise<number> {
    return this.database
      .prepare('DELETE FROM auth_sessions WHERE expires_at < ?')
      .run(before).changes;
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM auth_sessions WHERE user_id = ?')
      .run(userId).changes;
  }
}

class SQLiteApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly database: Database.Database) {}

  async insert(token: StoredApiTokenRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO api_tokens
           (id, user_id, name, token_hash, token_prefix, scopes,
            created_at, expires_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token.id,
        token.user_id,
        token.name,
        token.token_hash,
        token.token_prefix,
        token.scopes,
        token.created_at,
        token.expires_at,
        token.last_used_at,
        token.revoked_at
      );
  }

  async findByHash(tokenHash: string): Promise<StoredApiTokenRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM api_tokens WHERE token_hash = ?')
        .get(tokenHash) as StoredApiTokenRecord | undefined) ?? null
    );
  }

  async findById(tokenId: string): Promise<StoredApiTokenRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM api_tokens WHERE id = ?')
        .get(tokenId) as StoredApiTokenRecord | undefined) ?? null
    );
  }

  async listByUser(userId: string): Promise<StoredApiTokenRecord[]> {
    return this.database
      .prepare(
        'SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC'
      )
      .all(userId) as StoredApiTokenRecord[];
  }

  async listAll(): Promise<StoredApiTokenRecord[]> {
    return this.database
      .prepare('SELECT * FROM api_tokens ORDER BY created_at DESC')
      .all() as StoredApiTokenRecord[];
  }

  async touchLastUsed(tokenId: string, lastUsedAt: number): Promise<boolean> {
    return (
      this.database
        .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
        .run(lastUsedAt, tokenId).changes > 0
    );
  }

  async revoke(tokenId: string, revokedAt: number): Promise<boolean> {
    return (
      this.database
        .prepare(
          'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'
        )
        .run(revokedAt, tokenId).changes > 0
    );
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM api_tokens WHERE user_id = ?')
      .run(userId).changes;
  }
}

class SQLiteOAuthIdentityRepository implements OAuthIdentityRepository {
  constructor(private readonly database: Database.Database) {}

  async find(
    provider: string,
    subject: string
  ): Promise<StoredOAuthIdentityRecord | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM oauth_identities WHERE provider = ? AND subject = ?'
        )
        .get(provider, subject) as StoredOAuthIdentityRecord | undefined) ??
      null
    );
  }

  async listByUser(userId: string): Promise<StoredOAuthIdentityRecord[]> {
    return this.database
      .prepare(
        'SELECT * FROM oauth_identities WHERE user_id = ? ORDER BY created_at'
      )
      .all(userId) as StoredOAuthIdentityRecord[];
  }

  async upsert(identity: StoredOAuthIdentityRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO oauth_identities
           (provider, subject, user_id, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, subject) DO UPDATE SET
           user_id = excluded.user_id,
           email = excluded.email,
           updated_at = excluded.updated_at`
      )
      .run(
        identity.provider,
        identity.subject,
        identity.user_id,
        identity.email,
        identity.created_at,
        identity.updated_at
      );
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM oauth_identities WHERE user_id = ?')
      .run(userId).changes;
  }
}

const buildAuditQuery = (
  query: SecurityAuditQuery
): { sql: string; parameters: Array<string | number> } => {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (query.action) {
    conditions.push('action = ?');
    parameters.push(query.action);
  }
  if (query.actorUserId) {
    conditions.push('actor_user_id = ?');
    parameters.push(query.actorUserId);
  }
  if (query.result) {
    conditions.push('result = ?');
    parameters.push(query.result);
  }
  if (query.targetType) {
    conditions.push('target_type = ?');
    parameters.push(query.targetType);
  }
  if (query.before !== undefined) {
    conditions.push('occurred_at < ?');
    parameters.push(query.before);
  }
  if (query.after !== undefined) {
    conditions.push('occurred_at > ?');
    parameters.push(query.after);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  parameters.push(query.limit);
  return {
    sql: `SELECT * FROM security_audit_events${where}
           ORDER BY occurred_at DESC, id DESC
           LIMIT ?`,
    parameters,
  };
};

class SQLiteSecurityAuditRepository implements SecurityAuditRepository {
  constructor(private readonly database: Database.Database) {}

  async insert(event: StoredSecurityAuditEventRecord): Promise<void> {
    this.database
      .prepare(insertAuditSql)
      .run(
        event.id,
        event.occurred_at,
        event.actor_user_id,
        event.actor_kind,
        event.action,
        event.target_type,
        event.target_id,
        event.result,
        event.request_id,
        event.ip_hash,
        event.details
      );
  }

  async query(
    query: SecurityAuditQuery
  ): Promise<StoredSecurityAuditEventRecord[]> {
    const built = buildAuditQuery(query);
    return this.database
      .prepare(built.sql)
      .all(...built.parameters) as StoredSecurityAuditEventRecord[];
  }

  async deleteBefore(before: number): Promise<number> {
    return this.database
      .prepare('DELETE FROM security_audit_events WHERE occurred_at < ?')
      .run(before).changes;
  }
}

class SQLiteGroupSyncRepository implements GroupSyncRepository {
  constructor(private readonly executor: PersistenceSyncExecutor) {}

  findById(groupId: string): StoredGroupRecord | null {
    return (
      this.executor.get<StoredGroupRecord>(
        'SELECT * FROM user_groups WHERE id = ?',
        [groupId]
      ) ?? null
    );
  }

  findByName(name: string): StoredGroupRecord | null {
    return (
      this.executor.get<StoredGroupRecord>(
        'SELECT * FROM user_groups WHERE name = ?',
        [name]
      ) ?? null
    );
  }

  insert(group: StoredGroupRecord): void {
    this.executor.run(insertGroupSql, [
      group.id,
      group.name,
      group.description,
      group.created_by,
      group.created_at,
      group.updated_at,
    ]);
  }

  update(
    groupId: string,
    patch: { name?: string; description?: string | null; updated_at: number }
  ): boolean {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      assignments.push('name = ?');
      values.push(patch.name);
    }
    if (patch.description !== undefined) {
      assignments.push('description = ?');
      values.push(patch.description);
    }
    assignments.push('updated_at = ?');
    values.push(patch.updated_at);
    return (
      this.executor.run(
        `UPDATE user_groups SET ${assignments.join(', ')} WHERE id = ?`,
        [...values, groupId]
      ).changes > 0
    );
  }

  delete(groupId: string): boolean {
    return (
      this.executor.run('DELETE FROM user_groups WHERE id = ?', [groupId])
        .changes > 0
    );
  }

  addMember(member: StoredGroupMemberRecord): boolean {
    return (
      this.executor.run(insertMemberSql, [
        member.group_id,
        member.user_id,
        member.added_by,
        member.added_at,
      ]).changes > 0
    );
  }

  removeMember(groupId: string, userId: string): boolean {
    return (
      this.executor.run(
        'DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?',
        [groupId, userId]
      ).changes > 0
    );
  }
}

class SQLiteResourceGrantSyncRepository implements ResourceGrantSyncRepository {
  constructor(private readonly executor: PersistenceSyncExecutor) {}

  findById(grantId: string): StoredResourceGrantRecord | null {
    return (
      this.executor.get<StoredResourceGrantRecord>(
        'SELECT * FROM resource_grants WHERE id = ?',
        [grantId]
      ) ?? null
    );
  }

  upsert(grant: StoredResourceGrantRecord): void {
    this.executor.run(upsertGrantSql, [
      grant.id,
      grant.resource_type,
      grant.resource_id,
      grant.owner_user_id,
      grant.principal_type,
      grant.principal_id,
      grant.permission,
      grant.created_by,
      grant.created_at,
    ]);
  }

  delete(grantId: string): boolean {
    return (
      this.executor.run('DELETE FROM resource_grants WHERE id = ?', [grantId])
        .changes > 0
    );
  }

  deleteForResource(resourceType: string, resourceId: string): number {
    return this.executor.run(
      'DELETE FROM resource_grants WHERE resource_type = ? AND resource_id = ?',
      [resourceType, resourceId]
    ).changes;
  }

  deleteForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): number {
    return this.executor.run(
      'DELETE FROM resource_grants WHERE principal_type = ? AND principal_id = ?',
      [principalType, principalId]
    ).changes;
  }
}

class SQLiteSecurityAuditSyncRepository implements SecurityAuditSyncRepository {
  constructor(private readonly executor: PersistenceSyncExecutor) {}

  insert(event: StoredSecurityAuditEventRecord): void {
    this.executor.run(insertAuditSql, [
      event.id,
      event.occurred_at,
      event.actor_user_id,
      event.actor_kind,
      event.action,
      event.target_type,
      event.target_id,
      event.result,
      event.request_id,
      event.ip_hash,
      event.details,
    ]);
  }
}

class SQLiteMfaRepository implements MfaRepository {
  constructor(private readonly database: Database.Database) {}

  async find(userId: string): Promise<StoredUserMfaRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM user_mfa WHERE user_id = ?')
        .get(userId) as StoredUserMfaRecord | undefined) ?? null
    );
  }

  async upsert(record: StoredUserMfaRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO user_mfa
           (user_id, totp_secret, activated_at, last_used_step,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           totp_secret = excluded.totp_secret,
           activated_at = excluded.activated_at,
           last_used_step = excluded.last_used_step,
           updated_at = excluded.updated_at`
      )
      .run(
        record.user_id,
        record.totp_secret,
        record.activated_at,
        record.last_used_step,
        record.created_at,
        record.updated_at
      );
  }

  async activate(
    userId: string,
    activatedAt: number,
    updatedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE user_mfa SET activated_at = ?, updated_at = ?
            WHERE user_id = ? AND activated_at IS NULL`
        )
        .run(activatedAt, updatedAt, userId).changes > 0
    );
  }

  async markStepUsed(
    userId: string,
    step: number,
    updatedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE user_mfa SET last_used_step = ?, updated_at = ?
            WHERE user_id = ?
              AND (last_used_step IS NULL OR last_used_step < ?)`
        )
        .run(step, updatedAt, userId, step).changes > 0
    );
  }

  async delete(userId: string): Promise<boolean> {
    const remove = this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?')
        .run(userId);
      return (
        this.database
          .prepare('DELETE FROM user_mfa WHERE user_id = ?')
          .run(userId).changes > 0
      );
    });
    return remove.immediate();
  }

  async replaceRecoveryCodes(
    userId: string,
    records: StoredMfaRecoveryCodeRecord[]
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?')
        .run(userId);
      const insert = this.database.prepare(
        `INSERT INTO mfa_recovery_codes
           (id, user_id, code_lookup, created_at, used_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      for (const record of records) {
        insert.run(
          record.id,
          record.user_id,
          record.code_lookup,
          record.created_at,
          record.used_at
        );
      }
    });
    replace.immediate();
  }

  async findRecoveryCode(
    codeLookup: string
  ): Promise<StoredMfaRecoveryCodeRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM mfa_recovery_codes WHERE code_lookup = ?')
        .get(codeLookup) as StoredMfaRecoveryCodeRecord | undefined) ?? null
    );
  }

  async consumeRecoveryCode(id: string, usedAt: number): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE mfa_recovery_codes SET used_at = ?
            WHERE id = ? AND used_at IS NULL`
        )
        .run(usedAt, id).changes > 0
    );
  }

  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM mfa_recovery_codes
          WHERE user_id = ? AND used_at IS NULL`
      )
      .get(userId) as { count: number };
    return row.count;
  }

  async deleteRecoveryCodes(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?')
      .run(userId).changes;
  }
}

class SQLiteWebAuthnCredentialRepository implements WebAuthnCredentialRepository {
  constructor(private readonly database: Database.Database) {}

  async insert(record: StoredWebAuthnCredentialRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO webauthn_credentials
           (id, user_id, credential_lookup, credential_data, name,
            sign_count, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.user_id,
        record.credential_lookup,
        record.credential_data,
        record.name,
        record.sign_count,
        record.created_at,
        record.last_used_at
      );
  }

  async findByLookup(
    credentialLookup: string
  ): Promise<StoredWebAuthnCredentialRecord | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM webauthn_credentials WHERE credential_lookup = ?'
        )
        .get(credentialLookup) as StoredWebAuthnCredentialRecord | undefined) ??
      null
    );
  }

  async listByUser(userId: string): Promise<StoredWebAuthnCredentialRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM webauthn_credentials
          WHERE user_id = ?
          ORDER BY created_at ASC`
      )
      .all(userId) as StoredWebAuthnCredentialRecord[];
  }

  async updateSignCount(
    id: string,
    signCount: number,
    lastUsedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ?
            WHERE id = ?`
        )
        .run(signCount, lastUsedAt, id).changes > 0
    );
  }

  async delete(id: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          'DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?'
        )
        .run(id, userId).changes > 0
    );
  }

  async deleteForUser(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM webauthn_credentials WHERE user_id = ?')
      .run(userId).changes;
  }

  async countForUser(userId: string): Promise<number> {
    const row = this.database
      .prepare(
        'SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id = ?'
      )
      .get(userId) as { count: number };
    return row.count;
  }

  async countAll(): Promise<number> {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM webauthn_credentials')
      .get() as { count: number };
    return row.count;
  }
}

export const createSQLiteSecurityRepositories = (
  database: Database.Database
): SecurityRepositories => ({
  groups: new SQLiteGroupRepository(database),
  grants: new SQLiteResourceGrantRepository(database),
  authSessions: new SQLiteAuthSessionRepository(database),
  apiTokens: new SQLiteApiTokenRepository(database),
  oauthIdentities: new SQLiteOAuthIdentityRepository(database),
  audit: new SQLiteSecurityAuditRepository(database),
  mfa: new SQLiteMfaRepository(database),
  webauthnCredentials: new SQLiteWebAuthnCredentialRepository(database),
});

export const createSQLiteSecuritySyncRepositories = (
  executor: PersistenceSyncExecutor
): SecuritySyncRepositories => ({
  groups: new SQLiteGroupSyncRepository(executor),
  grants: new SQLiteResourceGrantSyncRepository(executor),
  audit: new SQLiteSecurityAuditSyncRepository(executor),
});
