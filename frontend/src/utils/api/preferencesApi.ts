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
  ChatProviderType,
  ChatSession,
  DocumentChunk,
  KnowledgeCollection,
  SessionFolder,
  UserPreferences,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';
import {
  DEFAULT_DEMO_PREFERENCES,
  getDemoPreferences,
  updateDemoPreferences,
} from './demoData';

export type DataArchiveMergeStrategy = 'skip' | 'overwrite';

export interface DataArchiveExclusion {
  key: string;
  reason: string;
}

export interface ArchivedDocument {
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
  chunks: Array<Omit<DocumentChunk, 'embedding' | 'filename'>>;
}

export interface UserDataArchive {
  format: 'libre-webui-user-data';
  version: 2;
  exportedAt: string;
  preferences: Partial<UserPreferences>;
  sessionFolders: SessionFolder[];
  sessions: ChatSession[];
  knowledgeCollections: KnowledgeCollection[];
  documents: ArchivedDocument[];
  exclusions: DataArchiveExclusion[];
}

export interface ArchiveSectionResult {
  imported: number;
  overwritten: number;
  skipped: number;
}

export interface DataArchiveImportResult {
  format: 'libre-webui-user-data';
  version: 2;
  migratedFromVersion?: string;
  strategy: DataArchiveMergeStrategy;
  preferences: { imported: boolean; mode: 'merge' | 'replace' };
  sessionFolders: ArchiveSectionResult;
  sessions: ArchiveSectionResult;
  knowledgeCollections: ArchiveSectionResult;
  documents: ArchiveSectionResult;
  remappedIds: number;
  warnings: string[];
  exclusions: DataArchiveExclusion[];
}

export interface DataArchivePreflight {
  valid: true;
  format: 'libre-webui-user-data';
  version: 2;
  migratedFromVersion?: string;
  strategy: DataArchiveMergeStrategy;
  incoming: {
    sessionFolders: number;
    sessions: number;
    messages: number;
    knowledgeCollections: number;
    documents: number;
    documentChunks: number;
  };
  warnings: string[];
  exclusions: DataArchiveExclusion[];
}

function archiveImportPayload(
  data: Record<string, unknown> | File,
  strategy: DataArchiveMergeStrategy
): Record<string, unknown> | FormData {
  if (typeof File !== 'undefined' && data instanceof File) {
    const formData = new FormData();
    formData.append('archive', data);
    formData.append('strategy', strategy);
    return formData;
  }
  return { data, strategy };
}

export const preferencesApi = {
  getPreferences: (): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(getDemoPreferences());
    }

    return api.get('/preferences').then(res => res.data);
  },

  updatePreferences: (
    updates: Partial<UserPreferences>
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(updateDemoPreferences(updates));
    }

    return api.put('/preferences', updates).then(res => res.data);
  },

  setDefaultModel: (
    model: string,
    providerType?: ChatProviderType | null,
    providerId?: string | null
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        updateDemoPreferences({
          defaultModel: model,
          defaultProviderType: providerType,
          defaultProviderId:
            providerType === 'plugin' || providerType === 'agent'
              ? providerId
              : null,
        })
      );
    }

    return api
      .put('/preferences/default-model', { model, providerType, providerId })
      .then(res => res.data);
  },

  setSystemMessage: (
    message: string
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        updateDemoPreferences({ systemMessage: message })
      );
    }

    return api
      .put('/preferences/system-message', { message })
      .then(res => res.data);
  },

  setGenerationOptions: (
    options: Partial<UserPreferences['generationOptions']>
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        updateDemoPreferences({ generationOptions: options })
      );
    }

    return api
      .put('/preferences/generation-options', options)
      .then(res => res.data);
  },

  /**
   * Pins generation options for one model. An empty object clears them, which
   * returns the model to what its own modelfile recommends.
   */
  setModelGenerationOptions: (
    model: string,
    options: Partial<UserPreferences['generationOptions']>
  ): Promise<ApiResponse<UserPreferences>> =>
    api
      .put('/preferences/model-generation-options', { model, options })
      .then(response => response.data),

  resetGenerationOptions: (): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        updateDemoPreferences({
          generationOptions: DEFAULT_DEMO_PREFERENCES.generationOptions,
        })
      );
    }

    return api
      .post('/preferences/generation-options/reset')
      .then(res => res.data);
  },

  // Embedding settings
  setEmbeddingSettings: (
    settings: UserPreferences['embeddingSettings']
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        updateDemoPreferences({ embeddingSettings: settings })
      );
    }

    return api
      .put('/preferences/embedding-settings', settings)
      .then(res => res.data);
  },

  resetEmbeddingSettings: (): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(
        updateDemoPreferences({
          embeddingSettings: DEFAULT_DEMO_PREFERENCES.embeddingSettings,
        })
      );
    }

    return api
      .post('/preferences/embedding-settings/reset')
      .then(res => res.data);
  },

  // Portable, per-user data archive. Secrets, reusable cloned voices, media,
  // personas/notes, and Work volumes are explicitly excluded by the backend.
  exportData: (): Promise<ApiResponse<UserDataArchive>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserDataArchive>({
        format: 'libre-webui-user-data',
        version: 2,
        exportedAt: new Date().toISOString(),
        preferences: getDemoPreferences(),
        sessionFolders: [],
        sessions: [],
        knowledgeCollections: [],
        documents: [],
        exclusions: [],
      });
    }
    return api.get('/preferences/export').then(res => res.data);
  },

  preflightImport: (
    data: Record<string, unknown> | File,
    strategy: DataArchiveMergeStrategy
  ): Promise<ApiResponse<DataArchivePreflight>> => {
    if (isDemoMode()) {
      return createDemoResponse<DataArchivePreflight>({
        valid: true,
        format: 'libre-webui-user-data',
        version: 2,
        strategy,
        incoming: {
          sessionFolders: 0,
          sessions: 0,
          messages: 0,
          knowledgeCollections: 0,
          documents: 0,
          documentChunks: 0,
        },
        warnings: [],
        exclusions: [],
      });
    }
    return api
      .post(
        '/preferences/import/preflight',
        archiveImportPayload(data, strategy)
      )
      .then(res => res.data);
  },

  importData: (
    data: Record<string, unknown> | File,
    strategy: DataArchiveMergeStrategy = 'skip'
  ): Promise<ApiResponse<DataArchiveImportResult>> => {
    if (isDemoMode()) {
      return createDemoResponse<DataArchiveImportResult>({
        format: 'libre-webui-user-data',
        version: 2,
        strategy,
        preferences: {
          imported: true,
          mode: strategy === 'overwrite' ? 'replace' : 'merge',
        },
        sessionFolders: { imported: 0, overwritten: 0, skipped: 0 },
        sessions: { imported: 0, overwritten: 0, skipped: 0 },
        knowledgeCollections: { imported: 0, overwritten: 0, skipped: 0 },
        documents: { imported: 0, overwritten: 0, skipped: 0 },
        remappedIds: 0,
        warnings: [],
        exclusions: [],
      });
    }

    return api
      .post('/preferences/import', archiveImportPayload(data, strategy))
      .then(res => res.data);
  },
};
