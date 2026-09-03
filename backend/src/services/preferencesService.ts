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
import { getDefaultTheme } from './appearanceSettingsService.js';

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
    visionModel: '',
    theme: {
      mode: 'dark',
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

      // Thinking: unset means the provider decides. Present here so a reset
      // clears a saved level instead of leaving it behind forever.
      think: undefined,
    },
    // Set per model, from the model's own recommendations or by the user.
    modelGenerationOptions: {},
    // Embedding settings for semantic search
    embeddingSettings: {
      enabled: false, // Start with embeddings disabled
      model: 'nomic-embed-text', // Default embedding model
      chunkSize: 1000,
      chunkOverlap: 200,
      similarityThreshold: 0.3,
    },
    imageGenSettings: {
      enabled: false,
      model: '',
      size: '1024x1024',
      quality: 'standard',
      style: 'vivid',
      pluginId: '',
    },
    showUsername: false, // Default to showing "you" instead of username
    showFollowUpSuggestions: true, // Suggest follow-up messages after responses
    autoOpenArtifactPanel: true, // Open the artifact panel when a response generates one
    hapticFeedbackEnabled: false,
    workRemoteProviderDisclosureDismissed: false,
  };

  constructor() {
    // Don't automatically create preferences - let them be created per user when needed
  }

  private async mutatePreferences(
    operation: (current: UserPreferences) => UserPreferences,
    userId?: string
  ): Promise<UserPreferences> {
    const updated = await storageService.mutatePreferences(
      current =>
        operation(this.mergeWithDefaults(current ?? this.defaultPreferences)),
      userId
    );
    if (!updated) throw new Error('No users found in database');
    return this.mergeWithDefaults(updated);
  }

  async getPreferences(userId?: string): Promise<UserPreferences> {
    try {
      const preferences = await storageService.getPreferences(userId);
      if (preferences) {
        // Merge with defaults to ensure all fields exist
        return this.mergeWithDefaults(preferences);
      }

      // A first read and a concurrent patch must not race to replace one
      // another. Initialize only if the serialized re-read is still empty.
      const instanceDefaults = await this.instanceDefaults();
      const initialized = await storageService.mutatePreferences(
        current => (current ? undefined : instanceDefaults),
        userId
      );
      if (initialized) {
        logger.debug(
          `Created default preferences for user: ${userId || 'default'}`
        );
        return this.mergeWithDefaults(initialized);
      }
    } catch (error) {
      logger.error('Failed to get preferences:', error);
    }

    return this.mergeWithDefaults(this.defaultPreferences);
  }

  /**
   * The built-in defaults with the administrator's instance-wide theme in
   * place of the static one. New accounts and resets start from here.
   */
  private async instanceDefaults(): Promise<UserPreferences> {
    return this.mergeWithDefaults({
      ...this.defaultPreferences,
      theme: await getDefaultTheme(),
    });
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
      imageGenSettings: {
        ...this.defaultPreferences.imageGenSettings!,
        ...preferences.imageGenSettings,
      },
    };
  }

  private applyPreferenceUpdates(
    currentPreferences: UserPreferences,
    updates: Partial<UserPreferences>
  ): UserPreferences {
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

    const hasVisionProviderUpdate =
      Object.prototype.hasOwnProperty.call(updates, 'visionProviderType') ||
      Object.prototype.hasOwnProperty.call(updates, 'visionProviderId');

    if (
      hasVisionProviderUpdate ||
      Object.prototype.hasOwnProperty.call(updates, 'visionModel')
    ) {
      const provider = hasVisionProviderUpdate
        ? normalizeChatProviderSelection({
            providerType: updates.visionProviderType,
            providerId: updates.visionProviderId,
          })
        : undefined;
      normalizedUpdates.visionProviderType = provider?.providerType;
      normalizedUpdates.visionProviderId = provider?.providerId;
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

    return {
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
      imageGenSettings: normalizedUpdates.imageGenSettings
        ? {
            ...currentPreferences.imageGenSettings,
            ...normalizedUpdates.imageGenSettings,
          }
        : currentPreferences.imageGenSettings,
    };
  }

  async updatePreferences(
    updates: Partial<UserPreferences>,
    userId?: string
  ): Promise<UserPreferences> {
    try {
      return await this.mutatePreferences(
        current => this.applyPreferenceUpdates(current, updates),
        userId
      );
    } catch (error) {
      logger.error('Failed to update preferences:', error);
      throw error;
    }
  }

  async setDefaultModel(
    model: string,
    userId?: string,
    providerSelection?: ChatProviderSelection
  ): Promise<UserPreferences> {
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

  async setTheme(
    theme: 'light' | 'dark' | 'amoled' | 'ophelia',
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

  /** Whatever the user has pinned for one model, if anything. */
  async getModelGenerationOptions(
    model: string,
    userId?: string
  ): Promise<Partial<GenerationOptions>> {
    const overrides = (await this.getPreferences(userId))
      .modelGenerationOptions;
    return overrides?.[model] ? { ...overrides[model] } : {};
  }

  /**
   * Pins options for one model. Passing an empty object clears them, which is
   * what returning a model to its own recommended settings amounts to.
   */
  async setModelGenerationOptions(
    model: string,
    options: Partial<GenerationOptions>,
    userId?: string
  ): Promise<UserPreferences> {
    return this.mutatePreferences(current => {
      const overrides = { ...(current.modelGenerationOptions ?? {}) };
      if (Object.keys(options).length === 0) delete overrides[model];
      else overrides[model] = options;
      return this.applyPreferenceUpdates(current, {
        modelGenerationOptions: overrides,
      });
    }, userId);
  }

  async getDefaultEmbeddingModel(userId?: string): Promise<string> {
    return (
      (await this.getPreferences(userId)).embeddingSettings?.model ||
      this.defaultPreferences.embeddingSettings.model
    );
  }

  async updateGenerationOptions(
    options: Partial<GenerationOptions>,
    userId?: string
  ): Promise<UserPreferences> {
    return this.updatePreferences({ generationOptions: options }, userId);
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
    return this.mutatePreferences(
      current =>
        this.applyPreferenceUpdates(current, {
          embeddingSettings: {
            ...current.embeddingSettings,
            ...settings,
          },
        }),
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
      const instanceDefaults = await this.instanceDefaults();
      return await this.mutatePreferences(() => instanceDefaults, userId);
    } catch (error) {
      logger.error('Failed to reset preferences to defaults:', error);
      throw error;
    }
  }

  async importData(
    data: ExportData,
    mergeStrategy: 'merge' | 'replace' = 'merge',
    userId?: string
  ): Promise<UserPreferences> {
    try {
      this.assertImportData(data);
      return await this.mutatePreferences(
        current =>
          this.prepareImportDataFromCurrent(data, mergeStrategy, current),
        userId
      );
    } catch (error) {
      logger.error('Failed to import preferences data:', error);
      throw error;
    }
  }

  private assertImportData(data: ExportData): void {
    if (!data || !data.preferences) {
      throw new Error('Invalid import data: missing preferences');
    }
  }

  private prepareImportDataFromCurrent(
    data: ExportData,
    mergeStrategy: 'merge' | 'replace',
    currentPreferences: UserPreferences
  ): UserPreferences {
    return this.prepareImportedPreferences(
      data.preferences,
      mergeStrategy,
      currentPreferences
    );
  }

  prepareImportedPreferences(
    imported: Partial<UserPreferences>,
    mergeStrategy: 'merge' | 'replace',
    current: UserPreferences | null
  ): UserPreferences {
    if (mergeStrategy === 'replace') {
      return this.mergeWithDefaults(imported as UserPreferences);
    }
    const currentPreferences = this.mergeWithDefaults(
      current ?? this.defaultPreferences
    );
    return {
      ...currentPreferences,
      ...imported,
      generationOptions: {
        ...currentPreferences.generationOptions,
        ...imported.generationOptions,
      },
      embeddingSettings: {
        ...currentPreferences.embeddingSettings,
        ...imported.embeddingSettings,
      },
      imageGenSettings: imported.imageGenSettings
        ? {
            ...currentPreferences.imageGenSettings,
            ...imported.imageGenSettings,
          }
        : currentPreferences.imageGenSettings,
    };
  }

  /**
   * Calculate an archive preference import without writing it. Portable
   * archive imports use this to include preferences in the same database
   * transaction as every other archive section.
   */
  async prepareImportData(
    data: ExportData,
    mergeStrategy: 'merge' | 'replace' = 'merge',
    userId?: string
  ): Promise<UserPreferences> {
    this.assertImportData(data);
    const currentPreferences = await this.getPreferences(userId);
    return this.prepareImportDataFromCurrent(
      data,
      mergeStrategy,
      currentPreferences
    );
  }
}

const preferencesService = new PreferencesService();
export default preferencesService;
