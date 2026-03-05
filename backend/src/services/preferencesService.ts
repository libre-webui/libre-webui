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
  UserPreferences,
  GenerationOptions,
  EmbeddingSettings,
} from '../types/index.js';

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
    theme: { mode: 'light' },
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
  };

  constructor() {
    // Don't automatically create preferences - let them be created per user when needed
  }

  private async ensurePreferencesExist(userId?: string) {
    try {
      const preferences = await storageService.getPreferences(userId);
      if (!preferences) {
        // Create default preferences for this user if none exist
        await storageService.savePreferences(this.defaultPreferences, userId);
        console.log(
          `Created default preferences for user: ${userId || 'default'}`
        );
      }
    } catch (error) {
      console.error('Failed to ensure preferences exist:', error);
    }
  }

  async getPreferences(userId?: string): Promise<UserPreferences> {
    try {
      // Ensure preferences exist for this user
      await this.ensurePreferencesExist(userId);

      const preferences = await storageService.getPreferences(userId);
      if (preferences) {
        // Merge with defaults to ensure all fields exist
        return this.mergeWithDefaults(preferences);
      }
    } catch (error) {
      console.error('Failed to get preferences:', error);
    }

    return this.defaultPreferences;
  }

  private mergeWithDefaults(preferences: UserPreferences): UserPreferences {
    return {
      ...this.defaultPreferences,
      ...preferences,
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

  async updatePreferences(
    updates: Partial<UserPreferences>,
    userId?: string
  ): Promise<UserPreferences> {
    const currentPreferences = await this.getPreferences(userId);
    const updatedPreferences: UserPreferences = {
      ...currentPreferences,
      ...updates,
      generationOptions: {
        ...currentPreferences.generationOptions,
        ...updates.generationOptions,
      },
      embeddingSettings: {
        ...currentPreferences.embeddingSettings,
        ...updates.embeddingSettings,
      },
      // Properly merge backgroundSettings
      backgroundSettings: updates.backgroundSettings
        ? {
            ...currentPreferences.backgroundSettings,
            ...updates.backgroundSettings,
          }
        : currentPreferences.backgroundSettings,
      // Properly merge ttsSettings
      ttsSettings: updates.ttsSettings
        ? { ...currentPreferences.ttsSettings, ...updates.ttsSettings }
        : currentPreferences.ttsSettings,
    };

    try {
      await storageService.savePreferences(updatedPreferences, userId);
      return updatedPreferences;
    } catch (error) {
      console.error('Failed to update preferences:', error);
      throw error;
    }
  }

  async setDefaultModel(
    model: string,
    userId?: string
  ): Promise<UserPreferences> {
    return this.updatePreferences({ defaultModel: model }, userId);
  }

  async setTheme(
    theme: 'light' | 'dark' | 'ophelia',
    userId?: string
  ): Promise<UserPreferences> {
    return this.updatePreferences({ theme: { mode: theme } }, userId);
  }

  async setSystemMessage(
    systemMessage: string,
    userId?: string
  ): Promise<UserPreferences> {
    return this.updatePreferences({ systemMessage }, userId);
  }

  async getSystemMessage(userId?: string): Promise<string> {
    return (await this.getPreferences(userId)).systemMessage;
  }

  async getDefaultModel(userId?: string): Promise<string> {
    return (await this.getPreferences(userId)).defaultModel;
  }

  async getGenerationOptions(userId?: string): Promise<GenerationOptions> {
    return (await this.getPreferences(userId)).generationOptions;
  }

  async updateGenerationOptions(
    options: Partial<GenerationOptions>,
    userId?: string
  ): Promise<UserPreferences> {
    const currentPreferences = await this.getPreferences(userId);
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

  async setGenerationOptions(
    options: GenerationOptions,
    userId?: string
  ): Promise<UserPreferences> {
    return this.updatePreferences({ generationOptions: options }, userId);
  }

  async resetGenerationOptions(userId?: string): Promise<UserPreferences> {
    return this.updatePreferences(
      {
        generationOptions: this.defaultPreferences.generationOptions,
      },
      userId
    );
  }

  async getEmbeddingSettings(userId?: string): Promise<EmbeddingSettings> {
    return (await this.getPreferences(userId)).embeddingSettings;
  }

  async updateEmbeddingSettings(
    settings: Partial<EmbeddingSettings>,
    userId?: string
  ): Promise<UserPreferences> {
    const currentPreferences = await this.getPreferences(userId);
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

  async setEmbeddingSettings(
    settings: EmbeddingSettings,
    userId?: string
  ): Promise<UserPreferences> {
    return this.updatePreferences({ embeddingSettings: settings }, userId);
  }

  async resetEmbeddingSettings(userId?: string): Promise<UserPreferences> {
    return this.updatePreferences(
      {
        embeddingSettings: this.defaultPreferences.embeddingSettings,
      },
      userId
    );
  }

  async resetToDefaults(userId?: string): Promise<UserPreferences> {
    try {
      await storageService.savePreferences(this.defaultPreferences, userId);
      return this.defaultPreferences;
    } catch (error) {
      console.error('Failed to reset preferences to defaults:', error);
      throw error;
    }
  }

  async importData(
    data: ExportData,
    mergeStrategy: 'merge' | 'replace' = 'merge',
    userId?: string
  ): Promise<UserPreferences> {
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
        const currentPreferences = await this.getPreferences(userId);
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
      await storageService.savePreferences(updatedPreferences, userId);
      return updatedPreferences;
    } catch (error) {
      console.error('Failed to import preferences data:', error);
      throw error;
    }
  }
}

const preferencesService = new PreferencesService();
export default preferencesService;
