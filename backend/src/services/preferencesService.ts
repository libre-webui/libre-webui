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

import storageService from '../storage.js';
import {
  ChatProviderSelection,
  UserPreferences,
  GenerationOptions,
  EmbeddingSettings,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { normalizeChatProviderSelection } from '../utils/chatProviderSelection.js';

const logger = createLogger('services:preferences-service');

// Export data format interface
interface ExportData {
  format: string;
  version: string;
  preferences: Partial<UserPreferences>;
  sessions?: unknown[];
  documents?: unknown[];
  exportedAt: string;
}

class PreferencesService {
  private defaultPreferences: UserPreferences = {
    defaultModel: '',
    theme: {
      mode: 'light',
      adaptToAccent: false,
      accent: 'blue',
      customAccent: '#2563eb',
    },
    systemMessage: 'You are a helpful assistant.',
    generationOptions: {
      // Core parameters
      temperature: 0.8,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.0,
      typical_p: 0.7,

      // Generation control
      num_predict: -1,
      seed: undefined,
      repeat_last_n: 64,
      repeat_penalty: 1.1,
      presence_penalty: 0.0,
      frequency_penalty: 0.0,
      penalize_newline: true,

      // Context and processing
      num_ctx: 2048,
      num_batch: 512,
      num_keep: undefined,

      // Advanced options
      stop: undefined,
      numa: undefined,
      num_thread: undefined,
      num_gpu: undefined,
      main_gpu: undefined,
      use_mmap: true,

      // Model behavior
      format: undefined,
      raw: undefined,
      keep_alive: undefined,
    },
    // Embedding settings for semantic search
    embeddingSettings: {
      enabled: false, // Start with embeddings disabled
      model: 'nomic-embed-text', // Default embedding model
      chunkSize: 1000,
      chunkOverlap: 200,
      similarityThreshold: 0.3,
    },
    showUsername: false, // Default to showing "you" instead of username
    workRemoteProviderDisclosureDismissed: false,
  };

  constructor() {
    // Don't automatically create preferences - let them be created per user when needed
  }

  private ensurePreferencesExist(userId?: string) {
    try {
      const preferences = storageService.getPreferences(userId);
      if (!preferences) {
        // Create default preferences for this user if none exist
        storageService.savePreferences(this.defaultPreferences, userId);
        logger.debug(
          `Created default preferences for user: ${userId || 'default'}`
        );
      }
    } catch (error) {
      logger.error('Failed to ensure preferences exist:', error);
    }
  }

  getPreferences(userId?: string): UserPreferences {
    try {
      // Ensure preferences exist for this user
      this.ensurePreferencesExist(userId);

      const preferences = storageService.getPreferences(userId);
      if (preferences) {
        // Merge with defaults to ensure all fields exist
        return this.mergeWithDefaults(preferences);
      }
    } catch (error) {
      logger.error('Failed to get preferences:', error);
    }

    return this.defaultPreferences;
  }

  private mergeWithDefaults(preferences: UserPreferences): UserPreferences {
    return {
      ...this.defaultPreferences,
      ...preferences,
      theme: {
        ...this.defaultPreferences.theme,
        ...preferences.theme,
      },
      generationOptions: {
        ...this.defaultPreferences.generationOptions,
        ...preferences.generationOptions,
      },
      embeddingSettings: {
        ...this.defaultPreferences.embeddingSettings,
        ...preferences.embeddingSettings,
      },
      // Preserve backgroundSettings if they exist
      ...(preferences.backgroundSettings && {
        backgroundSettings: preferences.backgroundSettings,
      }),
      // Preserve ttsSettings if they exist
      ...(preferences.ttsSettings && {
        ttsSettings: preferences.ttsSettings,
      }),
    };
  }

  updatePreferences(
    updates: Partial<UserPreferences>,
    userId?: string
  ): UserPreferences {
    const currentPreferences = this.getPreferences(userId);
    const normalizedUpdates = { ...updates };
    const hasDefaultProviderUpdate =
      Object.prototype.hasOwnProperty.call(updates, 'defaultProviderType') ||
      Object.prototype.hasOwnProperty.call(updates, 'defaultProviderId');

    if (
      hasDefaultProviderUpdate ||
      Object.prototype.hasOwnProperty.call(updates, 'defaultModel')
    ) {
      const provider = hasDefaultProviderUpdate
        ? normalizeChatProviderSelection({
            providerType: updates.defaultProviderType,
            providerId: updates.defaultProviderId,
          })
        : undefined;
      normalizedUpdates.defaultProviderType = provider?.providerType;
      normalizedUpdates.defaultProviderId = provider?.providerId;
    }

    if (updates.titleSettings) {
      const currentTitleSettings = currentPreferences.titleSettings;
      const titleSettings = {
        ...currentTitleSettings,
        ...updates.titleSettings,
      };
      const hasTaskProviderUpdate =
        Object.prototype.hasOwnProperty.call(
          updates.titleSettings,
          'taskProviderType'
        ) ||
        Object.prototype.hasOwnProperty.call(
          updates.titleSettings,
          'taskProviderId'
        );

      if (
        hasTaskProviderUpdate ||
        Object.prototype.hasOwnProperty.call(updates.titleSettings, 'taskModel')
      ) {
        const provider = hasTaskProviderUpdate
          ? normalizeChatProviderSelection({
              providerType: updates.titleSettings.taskProviderType,
              providerId: updates.titleSettings.taskProviderId,
            })
          : undefined;
        titleSettings.taskProviderType = provider?.providerType;
        titleSettings.taskProviderId = provider?.providerId;
      }

      normalizedUpdates.titleSettings = titleSettings;
    }

    const updatedPreferences: UserPreferences = {
      ...currentPreferences,
      ...normalizedUpdates,
      theme: {
        ...currentPreferences.theme,
        ...normalizedUpdates.theme,
      },
      generationOptions: {
        ...currentPreferences.generationOptions,
        ...normalizedUpdates.generationOptions,
      },
      embeddingSettings: {
        ...currentPreferences.embeddingSettings,
        ...normalizedUpdates.embeddingSettings,
      },
      // Properly merge backgroundSettings
      backgroundSettings: normalizedUpdates.backgroundSettings
        ? {
            ...currentPreferences.backgroundSettings,
            ...normalizedUpdates.backgroundSettings,
          }
        : currentPreferences.backgroundSettings,
      // Properly merge ttsSettings
      ttsSettings: normalizedUpdates.ttsSettings
        ? {
            ...currentPreferences.ttsSettings,
            ...normalizedUpdates.ttsSettings,
          }
        : currentPreferences.ttsSettings,
    };

    try {
      storageService.savePreferences(updatedPreferences, userId);
      return updatedPreferences;
    } catch (error) {
      logger.error('Failed to update preferences:', error);
      throw error;
    }
  }

  setDefaultModel(
    model: string,
    userId?: string,
    providerSelection?: ChatProviderSelection
  ): UserPreferences {
    const provider = normalizeChatProviderSelection(providerSelection);
    return this.updatePreferences(
      {
        defaultModel: model,
        defaultProviderType: provider?.providerType,
        defaultProviderId: provider?.providerId,
      },
      userId
    );
  }

  setTheme(
    theme: 'light' | 'dark' | 'ophelia',
    userId?: string
  ): UserPreferences {
    return this.updatePreferences({ theme: { mode: theme } }, userId);
  }

  setSystemMessage(systemMessage: string, userId?: string): UserPreferences {
    return this.updatePreferences({ systemMessage }, userId);
  }

  getSystemMessage(userId?: string): string {
    return this.getPreferences(userId).systemMessage;
  }

  getDefaultModel(userId?: string): string {
    return this.getPreferences(userId).defaultModel;
  }

  getGenerationOptions(userId?: string): GenerationOptions {
    return this.getPreferences(userId).generationOptions;
  }

  getDefaultEmbeddingModel(userId?: string): string {
    return (
      this.getPreferences(userId).embeddingSettings?.model ||
      this.defaultPreferences.embeddingSettings.model
    );
  }

  updateGenerationOptions(
    options: Partial<GenerationOptions>,
    userId?: string
  ): UserPreferences {
    const currentPreferences = this.getPreferences(userId);
    return this.updatePreferences(
      {
        generationOptions: {
          ...currentPreferences.generationOptions,
          ...options,
        },
      },
      userId
    );
  }

  setGenerationOptions(
    options: GenerationOptions,
    userId?: string
  ): UserPreferences {
    return this.updatePreferences({ generationOptions: options }, userId);
  }

  resetGenerationOptions(userId?: string): UserPreferences {
    return this.updatePreferences(
      {
        generationOptions: this.defaultPreferences.generationOptions,
      },
      userId
    );
  }

  getEmbeddingSettings(userId?: string): EmbeddingSettings {
    return this.getPreferences(userId).embeddingSettings;
  }

  updateEmbeddingSettings(
    settings: Partial<EmbeddingSettings>,
    userId?: string
  ): UserPreferences {
    const currentPreferences = this.getPreferences(userId);
    return this.updatePreferences(
      {
        embeddingSettings: {
          ...currentPreferences.embeddingSettings,
          ...settings,
        },
      },
      userId
    );
  }

  setEmbeddingSettings(
    settings: EmbeddingSettings,
    userId?: string
  ): UserPreferences {
    return this.updatePreferences({ embeddingSettings: settings }, userId);
  }

  resetEmbeddingSettings(userId?: string): UserPreferences {
    return this.updatePreferences(
      {
        embeddingSettings: this.defaultPreferences.embeddingSettings,
      },
      userId
    );
  }

  resetToDefaults(userId?: string): UserPreferences {
    try {
      storageService.savePreferences(this.defaultPreferences, userId);
      return this.defaultPreferences;
    } catch (error) {
      logger.error('Failed to reset preferences to defaults:', error);
      throw error;
    }
  }

  importData(
    data: ExportData,
    mergeStrategy: 'merge' | 'replace' = 'merge',
    userId?: string
  ): UserPreferences {
    try {
      // Validate that the data has preferences
      if (!data || !data.preferences) {
        throw new Error('Invalid import data: missing preferences');
      }

      let updatedPreferences: UserPreferences;

      if (mergeStrategy === 'replace') {
        // Replace existing preferences entirely
        updatedPreferences = this.mergeWithDefaults(
          data.preferences as UserPreferences
        );
      } else {
        // Merge with existing preferences
        const currentPreferences = this.getPreferences(userId);
        updatedPreferences = {
          ...currentPreferences,
          ...data.preferences,
          generationOptions: {
            ...currentPreferences.generationOptions,
            ...data.preferences.generationOptions,
          },
          embeddingSettings: {
            ...currentPreferences.embeddingSettings,
            ...data.preferences.embeddingSettings,
          },
        };
      }

      // Save the updated preferences
      storageService.savePreferences(updatedPreferences, userId);
      return updatedPreferences;
    } catch (error) {
      logger.error('Failed to import preferences data:', error);
      throw error;
    }
  }
}

const preferencesService = new PreferencesService();
export default preferencesService;
