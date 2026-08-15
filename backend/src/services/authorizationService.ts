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
 * Central authorization (IAM-01).
 *
 * One decision point for feature gates and shareable-resource access:
 *
 *   role/feature permissions + ownership + direct grants + group grants
 *     = effective allow
 *
 * Feature gates keep their existing semantics (admin always allowed, others
 * by the admin-controlled mode); the per-feature services now delegate here.
 * Resource decisions are private by default: the owner has every permission,
 * other users only what an explicit user or group grant confers. The admin
 * role deliberately does NOT bypass resource privacy — administration is a
 * feature-level power, not a content read.
 *
 * `explainEffectiveAccess` answers "why can this user access this?" for the
 * administrator-facing effective-access view.
 */

import { getPersistence } from '../persistence/index.js';
import type {
  ArchiveOwnedResource,
  GrantPermission,
  StoredResourceGrantRecord,
} from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { getWorkAccessMode } from './workAccessService.js';
import { getModelDownloadMode } from './modelAccessService.js';
import { getAgentsEnabled } from './agentAccessService.js';
import { getWebSearchAccessMode } from './webSearchService.js';

export type AuthzAction = 'read' | 'write' | 'manage' | 'use';

export type FeatureId = 'work' | 'model-download' | 'web-search' | 'agents';

/** Grantable resource families reuse the portable-archive taxonomy. */
export type ShareableResourceType = ArchiveOwnedResource;

export const SHAREABLE_RESOURCE_TYPES: readonly ShareableResourceType[] = [
  'session',
  'session-folder',
  'note',
  'knowledge-collection',
  'document',
  'persona',
];

export const isShareableResourceType = (
  value: unknown
): value is ShareableResourceType =>
  typeof value === 'string' &&
  (SHAREABLE_RESOURCE_TYPES as readonly string[]).includes(value);

export interface AuthzActor {
  userId: string;
  role?: string | undefined;
  status?: string | undefined;
}

export type AuthzResource =
  | { type: 'feature'; id: FeatureId }
  | { type: ShareableResourceType; id: string; ownerUserId?: string };

export interface AuthzDecision {
  allowed: boolean;
  reason: string;
}

export class AuthorizationError extends Error {
  readonly statusCode = 403;
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

const security = () => getPersistence(encryptionService).repositories.security;

const archive = () =>
  getPersistence(encryptionService).repositories.resources.archive;

/** Group memberships resolved fresh so removals apply immediately. */
export const resolveGroupIdsForUser = (userId: string): Promise<string[]> =>
  security().groups.listGroupIdsForUser(userId);

const permissionSatisfies = (
  granted: GrantPermission,
  action: AuthzAction
): boolean => {
  if (action === 'read' || action === 'use') return true;
  if (action === 'write') return granted === 'write' || granted === 'admin';
  return granted === 'admin';
};

const featureDecision = async (
  actor: AuthzActor,
  featureId: FeatureId
): Promise<AuthzDecision> => {
  if (actor.role === 'admin') return { allowed: true, reason: 'admin-role' };
  switch (featureId) {
    case 'work':
      return (await getWorkAccessMode()) === 'all-users'
        ? { allowed: true, reason: 'feature-open-to-all-users' }
        : { allowed: false, reason: 'feature-restricted-to-admins' };
    case 'model-download':
      return (await getModelDownloadMode()) === 'all-users'
        ? { allowed: true, reason: 'feature-open-to-all-users' }
        : { allowed: false, reason: 'feature-restricted-to-admins' };
    case 'web-search':
      return (await getWebSearchAccessMode()) === 'all-users'
        ? { allowed: true, reason: 'feature-open-to-all-users' }
        : { allowed: false, reason: 'feature-restricted-to-admins' };
    case 'agents':
      return (await getAgentsEnabled())
        ? { allowed: true, reason: 'feature-enabled' }
        : { allowed: false, reason: 'feature-disabled' };
  }
};

/** Effective grants a user holds on a resource, via user and group rows. */
export const effectiveGrantsFor = async (
  userId: string,
  resourceType: ShareableResourceType,
  resourceId: string
): Promise<StoredResourceGrantRecord[]> => {
  const groupIds = await resolveGroupIdsForUser(userId);
  return security().grants.listEffective(
    resourceType,
    resourceId,
    userId,
    groupIds
  );
};

export const authorize = async (
  actor: AuthzActor,
  action: AuthzAction,
  resource: AuthzResource
): Promise<AuthzDecision> => {
  if (actor.status !== undefined && actor.status !== 'active') {
    return { allowed: false, reason: 'inactive-account' };
  }

  if (resource.type === 'feature') {
    return featureDecision(actor, resource.id);
  }

  const ownerUserId =
    resource.ownerUserId ??
    (await archive().ownerOf(resource.type, resource.id));
  if (ownerUserId === actor.userId) {
    return { allowed: true, reason: 'owner' };
  }
  if (ownerUserId === null) {
    return { allowed: false, reason: 'resource-not-found' };
  }

  const grants = await effectiveGrantsFor(
    actor.userId,
    resource.type,
    resource.id
  );
  const qualifying = grants.find(grant =>
    permissionSatisfies(grant.permission, action)
  );
  if (qualifying) {
    return {
      allowed: true,
      reason:
        qualifying.principal_type === 'user' ? 'direct-grant' : 'group-grant',
    };
  }
  return {
    allowed: false,
    reason: grants.length > 0 ? 'insufficient-permission' : 'no-grant',
  };
};

/** Throwing variant for route and service guards. */
export const requireAuthorized = async (
  actor: AuthzActor,
  action: AuthzAction,
  resource: AuthzResource
): Promise<AuthzDecision> => {
  const decision = await authorize(actor, action, resource);
  if (!decision.allowed) throw new AuthorizationError();
  return decision;
};

export interface EffectiveAccessView {
  userId: string;
  role: string | null;
  status: string | null;
  groups: Array<{ id: string; name: string }>;
  features: Record<FeatureId, boolean>;
  grants: Array<{
    id: string;
    resourceType: string;
    resourceId: string;
    permission: GrantPermission;
    via: 'user' | 'group';
    principalId: string;
  }>;
}

/**
 * "Why can this user access this?" — the complete effective-access picture
 * for one user: role, groups, feature gates, and every grant that reaches
 * them directly or through a group.
 */
export const explainEffectiveAccess = async (user: {
  id: string;
  role?: string;
  status?: string;
}): Promise<EffectiveAccessView> => {
  const actor: AuthzActor = {
    userId: user.id,
    role: user.role,
    status: user.status,
  };
  const groups = await security().groups.listGroupsForUser(user.id);
  const [work, modelDownload, webSearch, agents] = await Promise.all([
    authorize(actor, 'use', { type: 'feature', id: 'work' }),
    authorize(actor, 'use', { type: 'feature', id: 'model-download' }),
    authorize(actor, 'use', { type: 'feature', id: 'web-search' }),
    authorize(actor, 'use', { type: 'feature', id: 'agents' }),
  ]);

  const grantRows = [
    ...(await security().grants.listForPrincipal('user', user.id)),
  ];
  for (const group of groups) {
    grantRows.push(
      ...(await security().grants.listForPrincipal('group', group.id))
    );
  }

  return {
    userId: user.id,
    role: user.role ?? null,
    status: user.status ?? null,
    groups: groups.map(group => ({ id: group.id, name: group.name })),
    features: {
      work: work.allowed,
      'model-download': modelDownload.allowed,
      'web-search': webSearch.allowed,
      agents: agents.allowed,
    },
    grants: grantRows.map(grant => ({
      id: grant.id,
      resourceType: grant.resource_type,
      resourceId: grant.resource_id,
      permission: grant.permission,
      via: grant.principal_type,
      principalId: grant.principal_id,
    })),
  };
};
