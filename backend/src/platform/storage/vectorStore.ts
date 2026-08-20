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

export interface VectorActor {
  userId: string;
  /**
   * Untrusted compatibility claims. Stores must resolve current membership
   * through VectorPrincipalResolver and never authorize from this array.
   */
  groupIds?: readonly string[];
}

export interface VectorPrincipalResolver {
  /** Resolve current, trusted group membership on every authorization call. */
  resolveGroupIds(userId: string): Promise<readonly string[]>;
}

/** Owner/user grants only until a trusted group repository is configured. */
export class OwnerOnlyVectorPrincipalResolver implements VectorPrincipalResolver {
  async resolveGroupIds(): Promise<readonly string[]> {
    return [];
  }
}

export type VectorGrant =
  { type: 'user'; id: string } | { type: 'group'; id: string };

export interface VectorRecord {
  namespace: string;
  id: string;
  ownerUserId: string;
  resourceId: string;
  model: string;
  dimensions: number;
  version: string;
  sourceRevision: string;
  embedding: readonly number[];
  /** Non-secret equality filters normalized by the backend. */
  attributes?: Readonly<Record<string, string>>;
  grants?: readonly VectorGrant[];
  createdAt?: number;
}

export interface VectorUpsertRequest {
  actor: VectorActor;
  records: readonly VectorRecord[];
}

export interface VectorQuery {
  actor: VectorActor;
  namespace: string;
  model: string;
  dimensions: number;
  version: string;
  embedding: readonly number[];
  limit: number;
  minScore?: number;
  resourceIds?: readonly string[];
  attributes?: Readonly<Record<string, string>>;
}

export interface VectorHit {
  id: string;
  namespace: string;
  ownerUserId: string;
  resourceId: string;
  model: string;
  dimensions: number;
  version: string;
  sourceRevision: string;
  score: number;
  attributes: Readonly<Record<string, string>>;
}

export interface VectorDeleteRequest {
  actor: VectorActor;
  namespace: string;
  resourceId?: string;
  ids?: readonly string[];
}

/**
 * Owner-scoped ACL replacement: every current record of the listed
 * resources receives exactly this grant set. Embeddings and attributes are
 * untouched, so share/revoke operations never re-embed content and
 * revocation applies to the very next query.
 */
export interface VectorGrantReplacementRequest {
  actor: VectorActor;
  namespace: string;
  resourceIds: readonly string[];
  grants: readonly VectorGrant[];
}

export interface VectorResourceIndexEntry {
  id: string;
  sourceRevision: string;
}

/** Mutation batch size supported atomically by both vector backends. */
export const MAX_VECTOR_RECORDS_PER_UPSERT = 1_000;

/**
 * Maximum exact resource manifest accepted by the bounded paged probe. This
 * is deliberately larger than one mutation batch so callers can publish a
 * resource through multiple compensated batches and still prove it globally,
 * while remaining aligned with the portable archive document-chunk ceiling.
 */
export const MAX_VECTOR_RESOURCE_INDEX_ENTRIES = 100_000;

/**
 * Metadata-only owner probe used by repair paths before they mutate an index.
 * Implementations must require the resource to contain exactly these records;
 * extra, missing, stale-model, or stale-revision rows all return false.
 */
export interface VectorResourceIndexProbe {
  actor: VectorActor;
  namespace: string;
  resourceId: string;
  model: string;
  dimensions: number;
  version: string;
  entries: readonly VectorResourceIndexEntry[];
}

/**
 * Every query and mutation carries an actor. Implementations must apply ACL
 * and resource predicates before embeddings are decrypted or scored.
 */
export interface VectorStore {
  upsert(request: VectorUpsertRequest): Promise<void>;
  query(request: VectorQuery): Promise<VectorHit[]>;
  hasExactResourceIndex(request: VectorResourceIndexProbe): Promise<boolean>;
  delete(request: VectorDeleteRequest): Promise<number>;
  deleteAllForOwner(actor: VectorActor): Promise<number>;
  /** Returns the number of records whose grant set was replaced. */
  replaceResourceGrants(
    request: VectorGrantReplacementRequest
  ): Promise<number>;
}

export type VectorStoreErrorCode =
  | 'candidate-limit'
  | 'corrupt'
  | 'forbidden'
  | 'invalid-input'
  | 'unavailable'
  | 'verification-limit';

export class VectorStoreError extends Error {
  constructor(
    readonly code: VectorStoreErrorCode,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'VectorStoreError';
  }
}
