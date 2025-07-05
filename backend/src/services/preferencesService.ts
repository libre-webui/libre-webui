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
      num_predict: 128,
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
    this.ensurePreferencesExist();
  }

  private ensurePreferencesExist() {
    try {
      const preferences = storageService.getPreferences();
      if (!preferences) {
        // Create default preferences if none exist
        storageService.savePreferences(this.defaultPreferences);
        console.log('Created default preferences');
      }
    } catch (error) {
      console.error('Failed to ensure preferences exist:', error);
    }
  }

  getPreferences(): UserPreferences {
    try {
      const preferences = storageService.getPreferences();
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
    };
  }

  updatePreferences(updates: Partial<UserPreferences>): UserPreferences {
    const currentPreferences = this.getPreferences();
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
    };

    try {
      storageService.savePreferences(updatedPreferences);
      return updatedPreferences;
    } catch (error) {
      console.error('Failed to update preferences:', error);
      throw error;
    }
  }

  setDefaultModel(model: string): UserPreferences {
    return this.updatePreferences({ defaultModel: model });
  }

  setTheme(theme: 'light' | 'dark'): UserPreferences {
    return this.updatePreferences({ theme: { mode: theme } });
  }

  setSystemMessage(systemMessage: string): UserPreferences {
    return this.updatePreferences({ systemMessage });
  }

  getSystemMessage(): string {
    return this.getPreferences().systemMessage;
  }

  getDefaultModel(): string {
    return this.getPreferences().defaultModel;
  }

  getGenerationOptions(): GenerationOptions {
    return this.getPreferences().generationOptions;
  }

  updateGenerationOptions(
    options: Partial<GenerationOptions>
  ): UserPreferences {
    const currentPreferences = this.getPreferences();
    return this.updatePreferences({
      generationOptions: {
        ...currentPreferences.generationOptions,
        ...options,
      },
    });
  }

  setGenerationOptions(options: GenerationOptions): UserPreferences {
    return this.updatePreferences({ generationOptions: options });
  }

  resetGenerationOptions(): UserPreferences {
    return this.updatePreferences({
      generationOptions: this.defaultPreferences.generationOptions,
    });
  }

  getEmbeddingSettings(): EmbeddingSettings {
    return this.getPreferences().embeddingSettings;
  }

  updateEmbeddingSettings(
    settings: Partial<EmbeddingSettings>
  ): UserPreferences {
    const currentPreferences = this.getPreferences();
    return this.updatePreferences({
      embeddingSettings: {
        ...currentPreferences.embeddingSettings,
        ...settings,
      },
    });
  }

  setEmbeddingSettings(settings: EmbeddingSettings): UserPreferences {
    return this.updatePreferences({ embeddingSettings: settings });
  }

  resetEmbeddingSettings(): UserPreferences {
    return this.updatePreferences({
      embeddingSettings: this.defaultPreferences.embeddingSettings,
    });
  }

  resetToDefaults(): UserPreferences {
    try {
      storageService.savePreferences(this.defaultPreferences);
      return this.defaultPreferences;
    } catch (error) {
      console.error('Failed to reset preferences to defaults:', error);
      throw error;
    }
  }
}

const preferencesService = new PreferencesService();
export default preferencesService;
