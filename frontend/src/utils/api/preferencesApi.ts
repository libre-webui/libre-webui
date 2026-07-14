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

import type { ApiResponse, UserPreferences } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';
import {
  DEFAULT_DEMO_PREFERENCES,
  getDemoPreferences,
  updateDemoPreferences,
} from './demoData';

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

  setDefaultModel: (model: string): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse(updateDemoPreferences({ defaultModel: model }));
    }

    return api
      .put('/preferences/default-model', { model })
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
  }, // Data import/export
  importData: (
    data: Record<string, unknown>,
    mergeStrategy: 'replace' | 'merge' = 'replace'
  ): Promise<ApiResponse<UserPreferences>> => {
    if (isDemoMode()) {
      return createDemoResponse<UserPreferences>({
        theme: {
          mode: 'dark',
          adaptToAccent: false,
          accent: 'blue',
          customAccent: '#2563eb',
        },
        defaultModel: 'llama3.2',
        systemMessage: 'You are a helpful assistant.',
        generationOptions: {},
        embeddingSettings: {
          enabled: false,
          model: 'nomic-embed-text',
          chunkSize: 1000,
          chunkOverlap: 200,
          similarityThreshold: 0.7,
        },
        showUsername: false, // Default to showing "You"
      });
    }

    return api
      .post('/preferences/import', { data, mergeStrategy })
      .then(res => res.data);
  },
};
