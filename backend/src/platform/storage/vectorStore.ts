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
  /** Trusted group IDs resolved by the authorization layer. */
  groupIds?: readonly string[];
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
 * Every query and mutation carries an actor. Implementations must apply ACL
 * and resource predicates before embeddings are decrypted or scored.
 */
export interface VectorStore {
  upsert(request: VectorUpsertRequest): Promise<void>;
  query(request: VectorQuery): Promise<VectorHit[]>;
  delete(request: VectorDeleteRequest): Promise<number>;
  deleteAllForOwner(actor: VectorActor): Promise<number>;
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
