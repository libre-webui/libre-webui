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

import type { VectorPrincipalResolver } from '../platform/storage/vectorStore.js';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';

/**
 * Resolves a user's group principals from the trust-foundation membership
 * table, so vector-store ACL predicates can honor group grants. Memberships
 * are read fresh on every query: removing a member revokes their
 * group-granted retrieval immediately.
 */
export class GroupVectorPrincipalResolver implements VectorPrincipalResolver {
  async resolveGroupIds(userId: string): Promise<readonly string[]> {
    if (!userId) return [];
    return getPersistence(
      encryptionService
    ).repositories.security.groups.listGroupIdsForUser(userId);
  }
}

export const groupVectorPrincipalResolver = new GroupVectorPrincipalResolver();
