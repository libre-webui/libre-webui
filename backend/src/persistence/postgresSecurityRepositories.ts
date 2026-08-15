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

import type { PoolClient, QueryResultRow } from 'pg';
import type {
  ApiTokenRepository,
  AuthSessionRepository,
  GrantPrincipalType,
  GroupRepository,
  OAuthIdentityRepository,
  ResourceGrantRepository,
  SecurityAuditRepository,
  SecurityRepositories,
  SecurityAuditQuery,
  StoredApiTokenRecord,
  StoredAuthSessionRecord,
  StoredGroupMemberRecord,
  StoredGroupRecord,
  StoredOAuthIdentityRecord,
  StoredResourceGrantRecord,
  StoredSecurityAuditEventRecord,
} from './securityTypes.js';
import type { PostgresDatabase } from './postgresDatabase.js';

type NumericRow = QueryResultRow & Record<string, unknown>;

const number = (value: unknown, field: string): number => {
  const converted = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return converted;
};

const nullableNumber = (value: unknown, field: string): number | null =>
  value === null || value === undefined ? null : number(value, field);

const changes = (rowCount: number | null): number => rowCount ?? 0;

const group = (row: NumericRow): StoredGroupRecord => ({
  ...(row as unknown as StoredGroupRecord),
  created_at: number(row.created_at, 'group created_at'),
  updated_at: number(row.updated_at, 'group updated_at'),
});

const groupMember = (row: NumericRow): StoredGroupMemberRecord => ({
  ...(row as unknown as StoredGroupMemberRecord),
  added_at: number(row.added_at, 'group member added_at'),
});

const grant = (row: NumericRow): StoredResourceGrantRecord => ({
  ...(row as unknown as StoredResourceGrantRecord),
  created_at: number(row.created_at, 'grant created_at'),
});

const authSession = (row: NumericRow): StoredAuthSessionRecord => ({
  ...(row as unknown as StoredAuthSessionRecord),
  created_at: number(row.created_at, 'session created_at'),
  last_seen_at: number(row.last_seen_at, 'session last_seen_at'),
  expires_at: number(row.expires_at, 'session expires_at'),
  revoked_at: nullableNumber(row.revoked_at, 'session revoked_at'),
});

const apiToken = (row: NumericRow): StoredApiTokenRecord => ({
  ...(row as unknown as StoredApiTokenRecord),
  created_at: number(row.created_at, 'token created_at'),
  expires_at: nullableNumber(row.expires_at, 'token expires_at'),
  last_used_at: nullableNumber(row.last_used_at, 'token last_used_at'),
  revoked_at: nullableNumber(row.revoked_at, 'token revoked_at'),
});

const oauthIdentity = (row: NumericRow): StoredOAuthIdentityRecord => ({
  ...(row as unknown as StoredOAuthIdentityRecord),
  created_at: number(row.created_at, 'identity created_at'),
  updated_at: number(row.updated_at, 'identity updated_at'),
});

const auditEvent = (row: NumericRow): StoredSecurityAuditEventRecord => ({
  ...(row as unknown as StoredSecurityAuditEventRecord),
  occurred_at: number(row.occurred_at, 'audit occurred_at'),
});

class PostgresGroupRepository implements GroupRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async list(): Promise<StoredGroupRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM user_groups ORDER BY name'
    );
    return result.rows.map(group);
  }

  async findById(groupId: string): Promise<StoredGroupRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM user_groups WHERE id = $1',
      [groupId]
    );
    return result.rows[0] ? group(result.rows[0]) : null;
  }

  async findByName(name: string): Promise<StoredGroupRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM user_groups WHERE name = $1',
      [name]
    );
    return result.rows[0] ? group(result.rows[0]) : null;
  }

  async insert(record: StoredGroupRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO user_groups
         (id, name, description, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.id,
        record.name,
        record.description,
        record.created_by,
        record.created_at,
        record.updated_at,
      ]
    );
  }

  async update(
    groupId: string,
    patch: { name?: string; description?: string | null; updated_at: number }
  ): Promise<boolean> {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    if (patch.name !== undefined) {
      values.push(patch.name);
      assignments.push(`name = $${values.length}`);
    }
    if (patch.description !== undefined) {
      values.push(patch.description);
      assignments.push(`description = $${values.length}`);
    }
    values.push(patch.updated_at);
    assignments.push(`updated_at = $${values.length}`);
    values.push(groupId);
    const result = await this.database.query(
      `UPDATE user_groups SET ${assignments.join(', ')} WHERE id = $${values.length}`,
      values
    );
    return changes(result.rowCount) > 0;
  }

  async delete(groupId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM user_groups WHERE id = $1',
      [groupId]
    );
    return changes(result.rowCount) > 0;
  }

  async listMembers(groupId: string): Promise<StoredGroupMemberRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM user_group_members WHERE group_id = $1 ORDER BY added_at',
      [groupId]
    );
    return result.rows.map(groupMember);
  }

  async listGroupIdsForUser(userId: string): Promise<string[]> {
    const result = await this.database.query(
      'SELECT group_id FROM user_group_members WHERE user_id = $1',
      [userId]
    );
    return result.rows.map(row => String(row.group_id));
  }

  async listGroupsForUser(userId: string): Promise<StoredGroupRecord[]> {
    const result = await this.database.query(
      `SELECT g.* FROM user_groups g
         JOIN user_group_members m ON m.group_id = g.id
        WHERE m.user_id = $1
        ORDER BY g.name`,
      [userId]
    );
    return result.rows.map(group);
  }

  async addMember(member: StoredGroupMemberRecord): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO user_group_members (group_id, user_id, added_by, added_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [member.group_id, member.user_id, member.added_by, member.added_at]
    );
    return changes(result.rowCount) > 0;
  }

  async removeMember(groupId: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM user_group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, userId]
    );
    return changes(result.rowCount) > 0;
  }

  async removeUserFromAllGroups(userId: string): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM user_group_members WHERE user_id = $1',
      [userId]
    );
    return changes(result.rowCount);
  }
}

class PostgresResourceGrantRepository implements ResourceGrantRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listForResource(
    resourceType: string,
    resourceId: string
  ): Promise<StoredResourceGrantRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM resource_grants
        WHERE resource_type = $1 AND resource_id = $2
        ORDER BY created_at`,
      [resourceType, resourceId]
    );
    return result.rows.map(grant);
  }

  async listForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): Promise<StoredResourceGrantRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM resource_grants
        WHERE principal_type = $1 AND principal_id = $2
        ORDER BY created_at`,
      [principalType, principalId]
    );
    return result.rows.map(grant);
  }

  async findById(grantId: string): Promise<StoredResourceGrantRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM resource_grants WHERE id = $1',
      [grantId]
    );
    return result.rows[0] ? grant(result.rows[0]) : null;
  }

  async listEffective(
    resourceType: string,
    resourceId: string,
    userId: string,
    groupIds: readonly string[]
  ): Promise<StoredResourceGrantRecord[]> {
    const values: Array<string> = [resourceType, resourceId, userId];
    let groupPredicate = '';
    if (groupIds.length) {
      const placeholders = groupIds.map(groupId => {
        values.push(groupId);
        return `$${values.length}`;
      });
      groupPredicate = ` OR (principal_type = 'group' AND principal_id IN (${placeholders.join(', ')}))`;
    }
    const result = await this.database.query(
      `SELECT * FROM resource_grants
        WHERE resource_type = $1 AND resource_id = $2
          AND ((principal_type = 'user' AND principal_id = $3)${groupPredicate})`,
      values
    );
    return result.rows.map(grant);
  }

  async upsert(record: StoredResourceGrantRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO resource_grants
         (id, resource_type, resource_id, owner_user_id,
          principal_type, principal_id, permission, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (resource_type, resource_id, principal_type, principal_id)
       DO UPDATE SET permission = EXCLUDED.permission,
                     created_by = EXCLUDED.created_by,
                     created_at = EXCLUDED.created_at`,
      [
        record.id,
        record.resource_type,
        record.resource_id,
        record.owner_user_id,
        record.principal_type,
        record.principal_id,
        record.permission,
        record.created_by,
        record.created_at,
      ]
    );
  }

  async delete(grantId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM resource_grants WHERE id = $1',
      [grantId]
    );
    return changes(result.rowCount) > 0;
  }

  async deleteForResource(
    resourceType: string,
    resourceId: string
  ): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM resource_grants WHERE resource_type = $1 AND resource_id = $2',
      [resourceType, resourceId]
    );
    return changes(result.rowCount);
  }

  async deleteForPrincipal(
    principalType: GrantPrincipalType,
    principalId: string
  ): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM resource_grants WHERE principal_type = $1 AND principal_id = $2',
      [principalType, principalId]
    );
    return changes(result.rowCount);
  }

  async deleteForOwner(ownerUserId: string): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM resource_grants WHERE owner_user_id = $1',
      [ownerUserId]
    );
    return changes(result.rowCount);
  }
}

class PostgresAuthSessionRepository implements AuthSessionRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insert(session: StoredAuthSessionRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO auth_sessions
         (id, user_id, kind, ip_hash, user_agent,
          created_at, last_seen_at, expires_at, revoked_at, revoked_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        session.id,
        session.user_id,
        session.kind,
        session.ip_hash,
        session.user_agent,
        session.created_at,
        session.last_seen_at,
        session.expires_at,
        session.revoked_at,
        session.revoked_by,
      ]
    );
  }

  async findById(sessionId: string): Promise<StoredAuthSessionRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM auth_sessions WHERE id = $1',
      [sessionId]
    );
    return result.rows[0] ? authSession(result.rows[0]) : null;
  }

  async listByUser(userId: string): Promise<StoredAuthSessionRecord[]> {
    const result = await this.database.query(
      `SELECT * FROM auth_sessions
        WHERE user_id = $1
        ORDER BY last_seen_at DESC`,
      [userId]
    );
    return result.rows.map(authSession);
  }

  async touch(sessionId: string, lastSeenAt: number): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE auth_sessions SET last_seen_at = $1
        WHERE id = $2 AND revoked_at IS NULL`,
      [lastSeenAt, sessionId]
    );
    return changes(result.rowCount) > 0;
  }

  async revoke(
    sessionId: string,
    revokedAt: number,
    revokedBy: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE auth_sessions SET revoked_at = $1, revoked_by = $2
        WHERE id = $3 AND revoked_at IS NULL`,
      [revokedAt, revokedBy, sessionId]
    );
    return changes(result.rowCount) > 0;
  }

  async revokeAllForUser(
    userId: string,
    revokedAt: number,
    revokedBy: string,
    exceptSessionId?: string
  ): Promise<string[]> {
    const values: Array<string | number> = [revokedAt, revokedBy, userId];
    let exceptPredicate = '';
    if (exceptSessionId) {
      values.push(exceptSessionId);
      exceptPredicate = ` AND id != $${values.length}`;
    }
    const result = await this.database.query(
      `UPDATE auth_sessions SET revoked_at = $1, revoked_by = $2
        WHERE user_id = $3 AND revoked_at IS NULL${exceptPredicate}
        RETURNING id`,
      values
    );
    return result.rows.map(row => String(row.id));
  }

  async deleteExpired(before: number): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM auth_sessions WHERE expires_at < $1',
      [before]
    );
    return changes(result.rowCount);
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM auth_sessions WHERE user_id = $1',
      [userId]
    );
    return changes(result.rowCount);
  }
}

class PostgresApiTokenRepository implements ApiTokenRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insert(token: StoredApiTokenRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO api_tokens
         (id, user_id, name, token_hash, token_prefix, scopes,
          created_at, expires_at, last_used_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        token.id,
        token.user_id,
        token.name,
        token.token_hash,
        token.token_prefix,
        token.scopes,
        token.created_at,
        token.expires_at,
        token.last_used_at,
        token.revoked_at,
      ]
    );
  }

  async findByHash(tokenHash: string): Promise<StoredApiTokenRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM api_tokens WHERE token_hash = $1',
      [tokenHash]
    );
    return result.rows[0] ? apiToken(result.rows[0]) : null;
  }

  async findById(tokenId: string): Promise<StoredApiTokenRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM api_tokens WHERE id = $1',
      [tokenId]
    );
    return result.rows[0] ? apiToken(result.rows[0]) : null;
  }

  async listByUser(userId: string): Promise<StoredApiTokenRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM api_tokens WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    return result.rows.map(apiToken);
  }

  async listAll(): Promise<StoredApiTokenRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM api_tokens ORDER BY created_at DESC'
    );
    return result.rows.map(apiToken);
  }

  async touchLastUsed(tokenId: string, lastUsedAt: number): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE api_tokens SET last_used_at = $1 WHERE id = $2',
      [lastUsedAt, tokenId]
    );
    return changes(result.rowCount) > 0;
  }

  async revoke(tokenId: string, revokedAt: number): Promise<boolean> {
    const result = await this.database.query(
      'UPDATE api_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL',
      [revokedAt, tokenId]
    );
    return changes(result.rowCount) > 0;
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM api_tokens WHERE user_id = $1',
      [userId]
    );
    return changes(result.rowCount);
  }
}

class PostgresOAuthIdentityRepository implements OAuthIdentityRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async find(
    provider: string,
    subject: string
  ): Promise<StoredOAuthIdentityRecord | null> {
    const result = await this.database.query(
      'SELECT * FROM oauth_identities WHERE provider = $1 AND subject = $2',
      [provider, subject]
    );
    return result.rows[0] ? oauthIdentity(result.rows[0]) : null;
  }

  async listByUser(userId: string): Promise<StoredOAuthIdentityRecord[]> {
    const result = await this.database.query(
      'SELECT * FROM oauth_identities WHERE user_id = $1 ORDER BY created_at',
      [userId]
    );
    return result.rows.map(oauthIdentity);
  }

  async upsert(identity: StoredOAuthIdentityRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO oauth_identities
         (provider, subject, user_id, email, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, subject) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         email = EXCLUDED.email,
         updated_at = EXCLUDED.updated_at`,
      [
        identity.provider,
        identity.subject,
        identity.user_id,
        identity.email,
        identity.created_at,
        identity.updated_at,
      ]
    );
  }

  async deleteForUser(userId: string): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM oauth_identities WHERE user_id = $1',
      [userId]
    );
    return changes(result.rowCount);
  }
}

class PostgresSecurityAuditRepository implements SecurityAuditRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insert(event: StoredSecurityAuditEventRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO security_audit_events
         (id, occurred_at, actor_user_id, actor_kind, action,
          target_type, target_id, result, request_id, ip_hash, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
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
      ]
    );
  }

  async query(
    query: SecurityAuditQuery
  ): Promise<StoredSecurityAuditEventRecord[]> {
    const conditions: string[] = [];
    const values: Array<string | number> = [];
    if (query.action) {
      values.push(query.action);
      conditions.push(`action = $${values.length}`);
    }
    if (query.actorUserId) {
      values.push(query.actorUserId);
      conditions.push(`actor_user_id = $${values.length}`);
    }
    if (query.result) {
      values.push(query.result);
      conditions.push(`result = $${values.length}`);
    }
    if (query.targetType) {
      values.push(query.targetType);
      conditions.push(`target_type = $${values.length}`);
    }
    if (query.before !== undefined) {
      values.push(query.before);
      conditions.push(`occurred_at < $${values.length}`);
    }
    if (query.after !== undefined) {
      values.push(query.after);
      conditions.push(`occurred_at > $${values.length}`);
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    values.push(query.limit);
    const result = await this.database.query(
      `SELECT * FROM security_audit_events${where}
        ORDER BY occurred_at DESC, id DESC
        LIMIT $${values.length}`,
      values
    );
    return result.rows.map(auditEvent);
  }

  async deleteBefore(before: number): Promise<number> {
    const result = await this.database.query(
      'DELETE FROM security_audit_events WHERE occurred_at < $1',
      [before]
    );
    return changes(result.rowCount);
  }
}

export const createPostgresSecurityRepositories = (
  database: PostgresDatabase
): SecurityRepositories => ({
  groups: new PostgresGroupRepository(database),
  grants: new PostgresResourceGrantRepository(database),
  authSessions: new PostgresAuthSessionRepository(database),
  apiTokens: new PostgresApiTokenRepository(database),
  oauthIdentities: new PostgresOAuthIdentityRepository(database),
  audit: new PostgresSecurityAuditRepository(database),
});

/** Create transaction-scoped repositories over one pinned pooled client. */
export const createPostgresTransactionalSecurityRepositories = (
  database: PostgresDatabase,
  client: PoolClient
): SecurityRepositories => {
  const transactionDatabase = {
    query: client.query.bind(client),
    transaction: async <T>(operation: (nested: PoolClient) => Promise<T>) =>
      operation(client),
  } as unknown as PostgresDatabase;
  return createPostgresSecurityRepositories(transactionDatabase);
};
