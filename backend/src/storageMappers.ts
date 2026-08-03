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

import type {
  ChatProviderType,
  ChatSession,
  DocumentChunk,
} from './types/index.js';
import { encryptionService } from './services/encryptionService.js';

export interface Document {
  id: string;
  filename: string;
  title?: string;
  content?: string;
  fileType?: 'pdf' | 'txt';
  size?: number;
  sessionId?: string;
  collectionId?: string;
  uploadedAt: number;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  persona_id?: string;
  provider_type?: string | null;
  provider_id?: string | null;
  created_at: number;
  updated_at: number;
  archived?: number | null;
  settings?: string | null;
  folder_id?: string | null;
}

export interface SessionFolderRow {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  timestamp: number;
  message_index: number;
  model?: string;
  provider_metadata?: string;
  images?: string;
  statistics?: string;
  artifacts?: string;
  parent_id?: string;
  branch_index?: number;
  is_active?: number;
  rating?: number | null;
}

export interface DocumentRow {
  id: string;
  user_id: string;
  filename: string;
  title?: string;
  content?: string;
  file_type?: string;
  size?: number;
  session_id?: string;
  collection_id?: string | null;
  uploaded_at: number;
  created_at?: number;
  metadata?: string;
}

export interface DocumentChunkRow {
  id: string;
  document_id: string;
  user_id: string;
  content: string;
  embedding?: string;
  chunk_index: number;
  start_char: number;
  end_char: number;
  metadata?: string;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  password_hash: string;
  role: string;
  avatar?: string | null;
  created_at: number;
  updated_at: number;
}

interface SiblingCountRow {
  parent_id: string;
  count: number;
}

function decryptJson<T>(value?: string): T | undefined {
  return value
    ? (JSON.parse(encryptionService.decrypt(value)) as T)
    : undefined;
}

export function buildSiblingCountMap(siblingCounts: SiblingCountRow[]) {
  const siblingCountMap = new Map<string, number>();
  for (const siblingCount of siblingCounts) {
    siblingCountMap.set(siblingCount.parent_id, siblingCount.count + 1);
  }
  return siblingCountMap;
}

export function mapMessageRow(
  row: MessageRow,
  siblingCountMap: Map<string, number>
): ChatSession['messages'][number] {
  const parentId = row.parent_id || row.id;
  const siblingCount = siblingCountMap.get(parentId) || 1;

  return {
    id: row.id,
    role: row.role as 'user' | 'assistant' | 'system',
    content: encryptionService.decrypt(row.content),
    timestamp: row.timestamp,
    model: row.model,
    providerMetadata: decryptJson(row.provider_metadata),
    images: decryptJson(row.images),
    statistics: decryptJson(row.statistics),
    artifacts: decryptJson(row.artifacts),
    parentId: row.parent_id,
    branchIndex: row.branch_index ?? 0,
    isActive: row.is_active !== 0,
    rating: row.rating ?? undefined,
    siblingCount: siblingCount > 1 ? siblingCount : undefined,
  };
}

export function mapSessionRow(
  row: SessionRow,
  messages: MessageRow[],
  siblingCounts: SiblingCountRow[]
): ChatSession {
  const siblingCountMap = buildSiblingCountMap(siblingCounts);

  return {
    id: row.id,
    title: encryptionService.decrypt(row.title),
    model: row.model,
    personaId: row.persona_id || undefined,
    providerType: (row.provider_type as ChatProviderType | null) || undefined,
    providerId: row.provider_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    settings: decryptJson(row.settings || undefined),
    folderId: row.folder_id || undefined,
    messages: messages.map(message => mapMessageRow(message, siblingCountMap)),
  };
}

export function mapDocumentRow(row: DocumentRow): Document {
  return {
    id: row.id,
    filename: row.filename,
    title: row.title ? encryptionService.decrypt(row.title) : undefined,
    content: row.content ? encryptionService.decrypt(row.content) : undefined,
    fileType: row.file_type as 'pdf' | 'txt' | undefined,
    size: row.size,
    sessionId: row.session_id,
    collectionId: row.collection_id || undefined,
    uploadedAt: row.uploaded_at,
    createdAt: row.created_at,
    metadata: decryptJson<Record<string, unknown>>(row.metadata),
  };
}

export function mapDocumentChunkRow(row: DocumentChunkRow): DocumentChunk {
  return {
    id: row.id,
    documentId: row.document_id,
    content: encryptionService.decrypt(row.content),
    embedding: decryptJson(row.embedding),
    chunkIndex: row.chunk_index,
    startChar: row.start_char,
    endChar: row.end_char,
  };
}
