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
 * Common resource grants (IAM-03).
 *
 * One private-by-default grant model for every shareable resource family:
 * owner/user/group principals with read/write/admin permissions. Only the
 * resource owner (or a principal holding an `admin` grant on it) may manage
 * shares — the global administrator role deliberately confers no access to
 * private content. Every grant mutation commits in the same transaction as
 * its audit event.
 */

import { randomUUID } from 'node:crypto';
import { getPersistence } from '../persistence/index.js';
import type {
  GrantPermission,
  GrantPrincipalType,
  StoredResourceGrantRecord,
} from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { buildAuditEvent } from './securityAuditService.js';
import {
  authorize,
  isShareableResourceType,
  type AuthzActor,
  type ShareableResourceType,
} from './authorizationService.js';
import { userModel } from '../models/userModel.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('resource-grants');

/**
 * Post-commit propagation for a grant change. Knowledge shares re-publish
 * the vector ACL so retrieval reflects the new grant set immediately.
 * Failures are logged, never thrown: the SQL grant rows stay authoritative
 * and the next index publication converges the ACL.
 */
const propagateGrantChange = async (record: {
  resource_type: string;
  resource_id: string;
  owner_user_id: string;
}): Promise<void> => {
  if (
    record.resource_type !== 'document' &&
    record.resource_type !== 'knowledge-collection'
  ) {
    return;
  }
  try {
    const { default: documentService } = await import('./documentService.js');
    await documentService.syncShareGrants(
      record.resource_type,
      record.resource_id,
      record.owner_user_id
    );
  } catch (error) {
    logger.error('Failed to propagate a share change to the vector ACL', {
      resourceType: record.resource_type,
      error,
    });
  }
};

export class ResourceGrantError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = 'ResourceGrantError';
  }
}

const security = () => getPersistence(encryptionService).repositories.security;

const archive = () =>
  getPersistence(encryptionService).repositories.resources.archive;

const isPermission = (value: unknown): value is GrantPermission =>
  value === 'read' || value === 'write' || value === 'admin';

const isPrincipalType = (value: unknown): value is GrantPrincipalType =>
  value === 'user' || value === 'group';

/**
 * Whether the actor may manage sharing for a resource: the owner always
 * can; other users need an `admin` grant on that resource.
 */
export const canManageGrants = async (
  actor: AuthzActor,
  resourceType: ShareableResourceType,
  resourceId: string
): Promise<{ allowed: boolean; ownerUserId: string | null }> => {
  const ownerUserId = await archive().ownerOf(resourceType, resourceId);
  if (ownerUserId === null) return { allowed: false, ownerUserId: null };
  if (ownerUserId === actor.userId) return { allowed: true, ownerUserId };
  const decision = await authorize(actor, 'manage', {
    type: resourceType,
    id: resourceId,
    ownerUserId,
  });
  return { allowed: decision.allowed, ownerUserId };
};

export const listGrantsForResource = async (
  actor: AuthzActor,
  resourceType: string,
  resourceId: string
): Promise<StoredResourceGrantRecord[]> => {
  if (!isShareableResourceType(resourceType)) {
    throw new ResourceGrantError('Unknown resource type', 400);
  }
  const manage = await canManageGrants(actor, resourceType, resourceId);
  if (!manage.allowed) {
    // Non-enumerating: a denied caller learns nothing about existence.
    throw new ResourceGrantError('Resource not found', 404);
  }
  return security().grants.listForResource(resourceType, resourceId);
};

export const createGrant = async (
  actor: AuthzActor,
  input: {
    resourceType: string;
    resourceId: string;
    principalType: string;
    principalId: string;
    permission: string;
  }
): Promise<StoredResourceGrantRecord> => {
  if (!isShareableResourceType(input.resourceType)) {
    throw new ResourceGrantError('Unknown resource type', 400);
  }
  if (!isPrincipalType(input.principalType)) {
    throw new ResourceGrantError('Unknown principal type', 400);
  }
  if (!isPermission(input.permission)) {
    throw new ResourceGrantError('Unknown permission', 400);
  }
  const manage = await canManageGrants(
    actor,
    input.resourceType,
    input.resourceId
  );
  if (!manage.allowed || manage.ownerUserId === null) {
    throw new ResourceGrantError('Resource not found', 404);
  }
  if (
    input.principalType === 'user' &&
    input.principalId === manage.ownerUserId
  ) {
    throw new ResourceGrantError('The owner already has full access', 400);
  }
  if (input.principalType === 'user') {
    const principal = await userModel.getUserById(input.principalId);
    if (!principal) throw new ResourceGrantError('User not found', 404);
  } else {
    const group = await security().groups.findById(input.principalId);
    if (!group) throw new ResourceGrantError('Group not found', 404);
  }

  const record: StoredResourceGrantRecord = {
    id: randomUUID(),
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    owner_user_id: manage.ownerUserId,
    principal_type: input.principalType,
    principal_id: input.principalId,
    permission: input.permission,
    created_by: actor.userId,
    created_at: Date.now(),
  };
  const audit = buildAuditEvent({
    action: 'grant.create',
    result: 'success',
    actorUserId: actor.userId,
    targetType: input.resourceType,
    targetId: input.resourceId,
    details: {
      principalType: input.principalType,
      principalId: input.principalId,
      permission: input.permission,
    },
  });

  const persistence = getPersistence(encryptionService);
  if (persistence.dialect === 'sqlite') {
    await persistence.transaction(({ security: tx }) => {
      tx.grants.upsert(record);
      tx.audit.insert(audit);
      return undefined;
    });
  } else {
    await persistence.transaction(async ({ security: tx }) => {
      await tx.grants.upsert(record);
      await tx.audit.insert(audit);
    });
  }
  await propagateGrantChange(record);
  return record;
};

export const deleteGrant = async (
  actor: AuthzActor,
  grantId: string
): Promise<boolean> => {
  const record = await security().grants.findById(grantId);
  if (!record) return false;
  if (!isShareableResourceType(record.resource_type)) {
    throw new ResourceGrantError('Unknown resource type', 400);
  }
  const manage = await canManageGrants(
    actor,
    record.resource_type,
    record.resource_id
  );
  // A principal may always remove a grant that points at itself
  // (leave a share), even without manage rights.
  const selfRemoval =
    record.principal_type === 'user' && record.principal_id === actor.userId;
  if (!manage.allowed && !selfRemoval) {
    throw new ResourceGrantError('Resource not found', 404);
  }

  const audit = buildAuditEvent({
    action: 'grant.delete',
    result: 'success',
    actorUserId: actor.userId,
    targetType: record.resource_type,
    targetId: record.resource_id,
    details: {
      principalType: record.principal_type,
      principalId: record.principal_id,
    },
  });
  const persistence = getPersistence(encryptionService);
  const deleted =
    persistence.dialect === 'sqlite'
      ? await persistence.transaction(({ security: tx }) => {
          const removed = tx.grants.delete(grantId);
          if (removed) tx.audit.insert(audit);
          return removed;
        })
      : await persistence.transaction(async ({ security: tx }) => {
          const removed = await tx.grants.delete(grantId);
          if (removed) await tx.audit.insert(audit);
          return removed;
        });
  if (deleted) await propagateGrantChange(record);
  return deleted;
};

/** Resources shared with the actor (directly or via groups). */
export const listGrantsForActor = async (
  actor: AuthzActor
): Promise<StoredResourceGrantRecord[]> => {
  const grants = [
    ...(await security().grants.listForPrincipal('user', actor.userId)),
  ];
  const groups = await security().groups.listGroupIdsForUser(actor.userId);
  for (const groupId of groups) {
    grants.push(
      ...(await security().grants.listForPrincipal('group', groupId))
    );
  }
  return grants;
};

/** Deletion hygiene: called when a resource is removed. */
export const deleteGrantsForResource = (
  resourceType: string,
  resourceId: string
): Promise<number> =>
  security().grants.deleteForResource(resourceType, resourceId);
