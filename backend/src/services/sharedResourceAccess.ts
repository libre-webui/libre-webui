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
 * Shared helpers for the "shared with me" access pattern (SHARE-01).
 *
 * Every shareable surface resolves access the same way: the owner always
 * passes, anyone else needs a live grant, and the surfaced metadata
 * collapses `admin` down to `write` because resource deletion stays an
 * owner-only power.
 */

import {
  authorize,
  type AuthzActor,
  type ShareableResourceType,
} from './authorizationService.js';
import { listGrantsForActor } from './resourceGrantService.js';

export interface SharedResourceMeta {
  /** Owner of a resource shared with the actor. */
  ownerUserId: string;
  permission: 'read' | 'write';
}

/**
 * Shared-access metadata when the actor may perform `action`, or null.
 * Never call for resources the actor owns; owners carry no `shared` meta.
 */
export const sharedMetaFor = async (
  actor: AuthzActor,
  type: ShareableResourceType,
  id: string,
  ownerUserId: string,
  action: 'read' | 'write' = 'read'
): Promise<SharedResourceMeta | null> => {
  const decision = await authorize(actor, action, { type, id, ownerUserId });
  if (!decision.allowed) return null;
  const writable = await authorize(actor, 'write', { type, id, ownerUserId });
  return {
    ownerUserId,
    permission: writable.allowed ? 'write' : 'read',
  };
};

/**
 * Distinct resource ids of one type granted to the actor directly or through
 * a group, excluding any ids the caller already holds.
 */
export const grantedResourceIdsFor = async (
  actor: AuthzActor,
  type: ShareableResourceType,
  excludeIds: ReadonlySet<string> = new Set()
): Promise<string[]> => {
  const grants = await listGrantsForActor(actor);
  const ids: string[] = [];
  const seen = new Set(excludeIds);
  for (const grant of grants) {
    if (grant.resource_type !== type) continue;
    if (seen.has(grant.resource_id)) continue;
    seen.add(grant.resource_id);
    ids.push(grant.resource_id);
  }
  return ids;
};
