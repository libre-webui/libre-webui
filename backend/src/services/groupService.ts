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
 * Groups and memberships (IAM-02).
 *
 * Groups are administrator-managed principals for grants and external
 * identity mapping. Every mutation commits atomically with its security
 * audit event (AUDIT-02): the SQLite path runs both writes in one owned
 * synchronous transaction, the PostgreSQL path in one serializable
 * transaction, so a group change can never exist without its audit trail.
 *
 * Revocation is immediate by construction: membership is read from the
 * database at decision time, never cached.
 */

import { randomUUID } from 'node:crypto';
import { getPersistence } from '../persistence/index.js';
import type {
  StoredGroupMemberRecord,
  StoredGroupRecord,
} from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { buildAuditEvent } from './securityAuditService.js';
import { userModel } from '../models/userModel.js';

export class GroupError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'GroupError';
  }
}

const GROUP_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u;

const normalizeName = (name: string): string => {
  const trimmed = name.trim();
  if (!GROUP_NAME_PATTERN.test(trimmed)) {
    throw new GroupError(
      'Group names are 1-128 letters, numbers, spaces, dots, underscores, or dashes',
      400
    );
  }
  return trimmed;
};

const security = () => getPersistence(encryptionService).repositories.security;

export interface GroupWithMembers extends StoredGroupRecord {
  members: StoredGroupMemberRecord[];
}

export const listGroups = (): Promise<StoredGroupRecord[]> =>
  security().groups.list();

export const listGroupsWithMembers = async (): Promise<GroupWithMembers[]> => {
  const groups = await security().groups.list();
  return Promise.all(
    groups.map(async group => ({
      ...group,
      members: await security().groups.listMembers(group.id),
    }))
  );
};

export const getGroup = (groupId: string): Promise<StoredGroupRecord | null> =>
  security().groups.findById(groupId);

export const getGroupByName = (
  name: string
): Promise<StoredGroupRecord | null> => security().groups.findByName(name);

export const listGroupsForUser = (
  userId: string
): Promise<StoredGroupRecord[]> => security().groups.listGroupsForUser(userId);

export const createGroup = async (
  input: { name: string; description?: string | null },
  actorUserId: string
): Promise<StoredGroupRecord> => {
  const name = normalizeName(input.name);
  const now = Date.now();
  const record: StoredGroupRecord = {
    id: randomUUID(),
    name,
    description: input.description?.trim() || null,
    created_by: actorUserId,
    created_at: now,
    updated_at: now,
  };
  const audit = buildAuditEvent({
    action: 'group.create',
    result: 'success',
    actorUserId,
    targetType: 'group',
    targetId: record.id,
    details: { name },
  });

  const persistence = getPersistence(encryptionService);
  if (persistence.dialect === 'sqlite') {
    await persistence.transaction(({ security: tx }) => {
      if (tx.groups.findByName(name)) {
        throw new GroupError('A group with this name already exists', 409);
      }
      tx.groups.insert(record);
      tx.audit.insert(audit);
      return undefined;
    });
    return record;
  }
  await persistence.transaction(async ({ security: tx }) => {
    if (await tx.groups.findByName(name)) {
      throw new GroupError('A group with this name already exists', 409);
    }
    await tx.groups.insert(record);
    await tx.audit.insert(audit);
  });
  return record;
};

export const updateGroup = async (
  groupId: string,
  patch: { name?: string; description?: string | null },
  actorUserId: string
): Promise<StoredGroupRecord | null> => {
  const name = patch.name !== undefined ? normalizeName(patch.name) : undefined;
  const update = {
    ...(name !== undefined ? { name } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description?.trim() || null }
      : {}),
    updated_at: Date.now(),
  };
  const audit = buildAuditEvent({
    action: 'group.update',
    result: 'success',
    actorUserId,
    targetType: 'group',
    targetId: groupId,
    details: { ...(name !== undefined ? { name } : {}) },
  });

  const persistence = getPersistence(encryptionService);
  if (persistence.dialect === 'sqlite') {
    const updated = await persistence.transaction(({ security: tx }) => {
      if (name !== undefined) {
        const existing = tx.groups.findByName(name);
        if (existing && existing.id !== groupId) {
          throw new GroupError('A group with this name already exists', 409);
        }
      }
      const applied = tx.groups.update(groupId, update);
      if (applied) tx.audit.insert(audit);
      return applied;
    });
    return updated ? security().groups.findById(groupId) : null;
  }
  const updated = await persistence.transaction(async ({ security: tx }) => {
    if (name !== undefined) {
      const existing = await tx.groups.findByName(name);
      if (existing && existing.id !== groupId) {
        throw new GroupError('A group with this name already exists', 409);
      }
    }
    const applied = await tx.groups.update(groupId, update);
    if (applied) await tx.audit.insert(audit);
    return applied;
  });
  return updated ? security().groups.findById(groupId) : null;
};

export const deleteGroup = async (
  groupId: string,
  actorUserId: string
): Promise<boolean> => {
  const audit = buildAuditEvent({
    action: 'group.delete',
    result: 'success',
    actorUserId,
    targetType: 'group',
    targetId: groupId,
  });
  const persistence = getPersistence(encryptionService);
  if (persistence.dialect === 'sqlite') {
    return persistence.transaction(({ security: tx }) => {
      // Grants held by the group disappear with it; memberships cascade.
      tx.grants.deleteForPrincipal('group', groupId);
      const deleted = tx.groups.delete(groupId);
      if (deleted) tx.audit.insert(audit);
      return deleted;
    });
  }
  return persistence.transaction(async ({ security: tx }) => {
    await tx.grants.deleteForPrincipal('group', groupId);
    const deleted = await tx.groups.delete(groupId);
    if (deleted) await tx.audit.insert(audit);
    return deleted;
  });
};

export const addGroupMember = async (
  groupId: string,
  userId: string,
  actorUserId: string
): Promise<boolean> => {
  const user = await userModel.getUserById(userId);
  if (!user) throw new GroupError('User not found', 404);
  const member: StoredGroupMemberRecord = {
    group_id: groupId,
    user_id: userId,
    added_by: actorUserId,
    added_at: Date.now(),
  };
  const audit = buildAuditEvent({
    action: 'group.member-add',
    result: 'success',
    actorUserId,
    targetType: 'group',
    targetId: groupId,
    details: { userId },
  });
  const persistence = getPersistence(encryptionService);
  if (persistence.dialect === 'sqlite') {
    return persistence.transaction(({ security: tx }) => {
      if (!tx.groups.findById(groupId)) {
        throw new GroupError('Group not found', 404);
      }
      const added = tx.groups.addMember(member);
      if (added) tx.audit.insert(audit);
      return added;
    });
  }
  return persistence.transaction(async ({ security: tx }) => {
    if (!(await tx.groups.findById(groupId))) {
      throw new GroupError('Group not found', 404);
    }
    const added = await tx.groups.addMember(member);
    if (added) await tx.audit.insert(audit);
    return added;
  });
};

export const removeGroupMember = async (
  groupId: string,
  userId: string,
  actorUserId: string
): Promise<boolean> => {
  const audit = buildAuditEvent({
    action: 'group.member-remove',
    result: 'success',
    actorUserId,
    targetType: 'group',
    targetId: groupId,
    details: { userId },
  });
  const persistence = getPersistence(encryptionService);
  if (persistence.dialect === 'sqlite') {
    return persistence.transaction(({ security: tx }) => {
      const removed = tx.groups.removeMember(groupId, userId);
      if (removed) tx.audit.insert(audit);
      return removed;
    });
  }
  return persistence.transaction(async ({ security: tx }) => {
    const removed = await tx.groups.removeMember(groupId, userId);
    if (removed) await tx.audit.insert(audit);
    return removed;
  });
};

/** Deletion hygiene: strip a retiring user from groups and their grants. */
export const removeUserFromSecurityPrincipals = async (
  userId: string
): Promise<void> => {
  await security().groups.removeUserFromAllGroups(userId);
  await security().grants.deleteForPrincipal('user', userId);
};
