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
  ApiResponse,
  DocumentChunk,
  DocumentDetail,
  DocumentSummary,
  EmbeddingModel,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export const documentsApi = {
  uploadDocument: (
    file: File,
    sessionId?: string
  ): Promise<ApiResponse<DocumentSummary>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: 'demo-doc-' + Date.now(),
        filename: file.name,
        fileType: file.name.endsWith('.pdf')
          ? ('pdf' as const)
          : ('txt' as const),
        size: file.size,
        sessionId,
        uploadedAt: Date.now(),
      });
    }

    const formData = new FormData();
    formData.append('document', file);
    if (sessionId) {
      formData.append('sessionId', sessionId);
    }

    return api.post('/documents/upload', formData).then(res => res.data);
  },

  getDocuments: (
    sessionId?: string
  ): Promise<ApiResponse<DocumentSummary[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }

    const url = sessionId ? `/documents/session/${sessionId}` : '/documents';
    return api.get(url).then(res => res.data);
  },

  getDocument: (documentId: string): Promise<ApiResponse<DocumentDetail>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: documentId,
        filename: 'demo-document.pdf',
        fileType: 'pdf' as const,
        size: 1024,
        content: 'Demo document content...',
        uploadedAt: Date.now(),
      });
    }

    return api.get(`/documents/${documentId}`).then(res => res.data);
  },

  searchDocuments: (
    query: string,
    sessionId?: string,
    limit?: number
  ): Promise<ApiResponse<DocumentChunk[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([]);
    }

    return api
      .post('/documents/search', { query, sessionId, limit })
      .then(res => res.data);
  },

  deleteDocument: (documentId: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/documents/${documentId}`).then(res => res.data);
  },

  // Embedding management
  getEmbeddingStatus: (): Promise<
    ApiResponse<{
      available: boolean;
      model: string;
      chunksWithEmbeddings: number;
      totalChunks: number;
    }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({
        available: false,
        model: 'nomic-embed-text',
        chunksWithEmbeddings: 0,
        totalChunks: 0,
      });
    }

    return api.get('/documents/embeddings/status').then(res => res.data);
  },

  regenerateEmbeddings: (): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.post('/documents/embeddings/regenerate').then(res => res.data);
  },
};

export const embeddingApi = {
  getModels: (): Promise<ApiResponse<EmbeddingModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse([
        {
          id: 'nomic-embed-text',
          name: 'nomic-embed-text',
          description: 'Ollama - Default embedding model',
          provider: 'ollama',
          dimensions: 0,
          isDetectedEmbedding: true,
        },
      ]);
    }

    return api.get('/embeddings/models').then(res => res.data);
  },
};
