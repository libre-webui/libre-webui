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

import fs from 'fs';
import path from 'path';
import sanitize from 'sanitize-filename';
import axios from 'axios';
import {
  EmbeddingModel,
  OllamaEmbeddingsResponse,
  Plugin,
  PluginStatus,
  PluginResponse,
  ChatMessage,
  GenerationOptions,
  TTSConfig,
  ImageGenConfig,
  ImageGenResponse,
  PluginType,
} from '../types/index.js';
import pluginCredentialsService from './pluginCredentialsService.js';
import pluginVariablesService from './pluginVariablesService.js';
import { PluginCapabilityRegistryService } from './pluginCapabilityRegistryService.js';
import { PluginEmbeddingService } from './pluginEmbeddingService.js';
import { PluginImageGenerationService } from './pluginImageGenerationService.js';
import { PluginTTSService } from './pluginTTSService.js';
import {
  applyPluginDefinitionPolicy,
  buildPluginChatPayload,
  convertProviderResponse,
  getOpenAICompatibleSamplingParameters,
  resolvePluginChatParameters,
  toOpenAICompatibleMessages,
} from '../utils/pluginChatAdapter.js';
import {
  streamAnthropicResponse,
  streamOpenAICompatibleResponse,
  streamOpenAIResponsesResponse,
  type PluginStreamChunk,
} from '../utils/pluginStreamAdapter.js';
import {
  applyModelEndpointTemplate,
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  buildPluginModelDiscoveryHeaders,
  pluginRequiresApiKey,
  resolvePluginApiConfig,
  resolvePluginEndpoint,
  resolvePluginModelsEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import { createLogger } from '../utils/logger.js';
import { resolveBundledPluginsDir } from '../utils/packagePaths.js';
import { getDatabaseSafe } from '../db.js';

const logger = createLogger('plugins');

export class PluginService {
  private pluginsDir: string;
  private bundledPluginsDir: string;
  private legacyPluginsDir: string;
  private pluginReadDirs: string[];
  private activePluginIds: Set<string> = new Set();
  private discoveredModelsCache = new Map<string, string[] | null>();
  private embeddingService: PluginEmbeddingService;
  private ttsService: PluginTTSService;
  private imageGenerationService: PluginImageGenerationService;
  private capabilityRegistryService: PluginCapabilityRegistryService;

  constructor() {
    this.bundledPluginsDir = resolveBundledPluginsDir(import.meta.url);
    this.legacyPluginsDir = path.join(process.cwd(), 'plugins');
    this.pluginsDir =
      process.env.PLUGINS_DIR ||
      (process.env.DATA_DIR
        ? path.join(process.env.DATA_DIR, 'plugins')
        : this.legacyPluginsDir);
    this.pluginReadDirs = Array.from(
      new Set([this.bundledPluginsDir, this.legacyPluginsDir, this.pluginsDir])
    );
    this.ensurePluginsDirectory();
    this.loadActivePlugins();
    this.embeddingService = new PluginEmbeddingService({
      getAllPlugins: userId => this.getAllPlugins(userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
    });
    this.ttsService = new PluginTTSService({
      getAllPlugins: userId => this.getAllPlugins(userId),
      getPlugin: (id, userId) => this.getPlugin(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
    });
    this.imageGenerationService = new PluginImageGenerationService({
      getAllPlugins: userId => this.getAllPlugins(userId),
      getPlugin: (id, userId) => this.getPlugin(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
    });
    this.capabilityRegistryService = new PluginCapabilityRegistryService({
      getAllPlugins: userId => this.getAllPlugins(userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
    });
  }

  private discoveredModelsCacheKey(pluginId: string, userId: string): string {
    return `${userId}:${pluginId}`;
  }

  private getDiscoveredModels(
    pluginId: string,
    userId?: string
  ): string[] | undefined {
    const effectiveUserId = userId || 'default';
    const cacheKey = this.discoveredModelsCacheKey(pluginId, effectiveUserId);
    if (this.discoveredModelsCache.has(cacheKey)) {
      return this.discoveredModelsCache.get(cacheKey) || undefined;
    }

    const db = getDatabaseSafe();
    if (!db) {
      this.discoveredModelsCache.set(cacheKey, null);
      return undefined;
    }

    try {
      const row = db
        .prepare(
          'SELECT models_json FROM plugin_discovered_models WHERE user_id = ? AND plugin_id = ?'
        )
        .get(effectiveUserId, pluginId) as { models_json: string } | undefined;
      if (!row) {
        this.discoveredModelsCache.set(cacheKey, null);
        return undefined;
      }

      const parsed = JSON.parse(row.models_json) as unknown;
      const models = Array.isArray(parsed)
        ? Array.from(
            new Set(
              parsed.filter(
                (model): model is string =>
                  typeof model === 'string' && model.length > 0
              )
            )
          )
        : [];
      if (models.length === 0) {
        this.discoveredModelsCache.set(cacheKey, null);
        return undefined;
      }
      this.discoveredModelsCache.set(cacheKey, models);
      return models;
    } catch (error) {
      logger.warn(
        'Failed to read discovered models for plugin %s:',
        pluginId,
        error
      );
      this.discoveredModelsCache.set(cacheKey, null);
      return undefined;
    }
  }

  private storeDiscoveredModels(
    pluginId: string,
    models: string[],
    userId?: string
  ): void {
    const effectiveUserId = userId || 'default';
    const uniqueModels = Array.from(new Set(models));
    const cacheKey = this.discoveredModelsCacheKey(pluginId, effectiveUserId);
    this.discoveredModelsCache.set(cacheKey, uniqueModels);

    const db = getDatabaseSafe();
    if (!db) return;

    try {
      db.prepare(
        `INSERT INTO plugin_discovered_models
          (user_id, plugin_id, models_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET
          models_json = excluded.models_json,
          updated_at = excluded.updated_at`
      ).run(
        effectiveUserId,
        pluginId,
        JSON.stringify(uniqueModels),
        Date.now()
      );
    } catch (error) {
      logger.warn(
        'Failed to persist discovered models for plugin %s:',
        pluginId,
        error
      );
    }
  }

  clearDiscoveredModels(pluginId: string, userId?: string): void {
    const db = getDatabaseSafe();
    if (userId) {
      this.discoveredModelsCache.set(
        this.discoveredModelsCacheKey(pluginId, userId),
        null
      );
      if (!db) return;
      try {
        db.prepare(
          'DELETE FROM plugin_discovered_models WHERE user_id = ? AND plugin_id = ?'
        ).run(userId, pluginId);
      } catch (error) {
        logger.warn(
          'Failed to clear discovered models for plugin %s:',
          pluginId,
          error
        );
      }
      return;
    }

    for (const key of this.discoveredModelsCache.keys()) {
      if (key.endsWith(`:${pluginId}`)) {
        this.discoveredModelsCache.delete(key);
      }
    }
    if (!db) return;
    try {
      db.prepare(
        'DELETE FROM plugin_discovered_models WHERE plugin_id = ?'
      ).run(pluginId);
    } catch (error) {
      logger.warn(
        'Failed to clear discovered models for plugin %s:',
        pluginId,
        error
      );
    }
  }

  private applyDiscoveredModels(plugin: Plugin, userId?: string): Plugin {
    const models = this.getDiscoveredModels(plugin.id, userId);
    return models ? { ...plugin, model_map: [...models] } : plugin;
  }

  private ensurePluginsDirectory(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  private loadActivePlugins(): void {
    const statusDirs = Array.from(
      new Set([this.pluginsDir, this.legacyPluginsDir])
    );

    for (const statusDir of statusDirs) {
      const statusFile = path.join(statusDir, '.status.json');
      if (!fs.existsSync(statusFile)) {
        continue;
      }

      try {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        if (Array.isArray(status.activePlugins)) {
          this.activePluginIds = new Set(status.activePlugins);
        } else if (status.activePlugin) {
          // Legacy support for single active plugin
          this.activePluginIds = new Set([status.activePlugin]);
        }
        return;
      } catch (error) {
        logger.error('Failed to load plugin status:', error);
      }
    }
  }

  private saveActivePlugins(): void {
    const statusFile = path.join(this.pluginsDir, '.status.json');
    const status = {
      activePlugins: Array.from(this.activePluginIds),
      lastUpdated: new Date().toISOString(),
    };
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2));
  }

  /**
   * Get API key for a plugin from database (per-user) or environment variable (fallback)
   * @param plugin The plugin to get the API key for
   * @param userId Optional user ID for per-user credentials
   * @returns The API key or null if not found
   */
  getApiKey(plugin: Plugin, userId?: string): string | null {
    return pluginCredentialsService.getApiKey(
      plugin.id,
      plugin.auth.key_env,
      userId
    );
  }

  /**
   * Get resolved variable values for a plugin (decrypted, typed).
   */
  getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): Record<string, string | number | boolean> {
    if (!plugin.variables || plugin.variables.length === 0) {
      return {};
    }
    return pluginVariablesService.getResolvedVariables(
      plugin.id,
      plugin.variables,
      userId
    );
  }

  /**
   * Validate an endpoint URL for safety (SSRF protection).
   * Returns the URL string if valid and throws for an unsafe explicit value.
   */
  private validateEndpointUrl(endpoint: string): string {
    return resolvePluginEndpoint('', endpoint);
  }

  /**
   * Attempt to auto-discover available models from a plugin's full API endpoint.
   * Resolves the provider's model-list endpoint and updates the plugin's model_map.
   * Falls back silently to the existing model_map if the endpoint is unavailable.
   */
  async discoverModels(pluginId: string, userId?: string): Promise<string[]> {
    const plugin = this.getPlugin(pluginId, userId);
    if (!plugin) return [];

    const pluginVars = this.getPluginVariables(plugin, userId);
    const { endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      plugin,
      pluginVars
    );
    const modelsEndpoint = resolvePluginModelsEndpoint(effectiveEndpoint);
    assertSafePluginEndpoint(modelsEndpoint, 'model discovery endpoint');

    const apiKey = this.getApiKey(plugin, userId);
    const headers = buildPluginModelDiscoveryHeaders(plugin, apiKey);

    try {
      const response = await axios.get(modelsEndpoint, {
        headers,
        timeout: 5000,
      });

      if (response.data?.data && Array.isArray(response.data.data)) {
        const models = response.data.data
          .map((m: { id?: string }) => m.id)
          .filter((id: unknown): id is string => typeof id === 'string');

        if (models.length > 0) {
          logger.debug(
            '[Plugin] Auto-discovered %d models for %s:',
            models.length,
            pluginId,
            models
          );

          this.storeDiscoveredModels(pluginId, models, userId);
          return models;
        }
      }
    } catch (_error) {
      logger.debug(
        `[Plugin] Model discovery unavailable for ${pluginId}, using existing model_map`
      );
    }

    return plugin.model_map;
  }

  // List all installed plugins
  getAllPlugins(userId?: string): Plugin[] {
    const plugins = new Map<string, Plugin>();

    for (const pluginsDir of this.pluginReadDirs) {
      if (!fs.existsSync(pluginsDir)) {
        continue;
      }

      try {
        const files = fs.readdirSync(pluginsDir);
        for (const file of files) {
          if (file.endsWith('.json') && !file.startsWith('.')) {
            try {
              const filePath = path.join(pluginsDir, file);
              const content = fs.readFileSync(filePath, 'utf8');
              const parsedPlugin: Plugin = JSON.parse(content);

              // Validate plugin structure
              if (this.validatePlugin(parsedPlugin)) {
                const plugin = applyPluginDefinitionPolicy(parsedPlugin);
                plugin.active = this.activePluginIds.has(plugin.id);
                plugins.set(
                  plugin.id,
                  this.applyDiscoveredModels(plugin, userId)
                );
              }
            } catch (error) {
              logger.error(`Failed to load plugin ${file}:`, error);
            }
          }
        }
      } catch (error) {
        logger.error(`Failed to read plugins directory ${pluginsDir}:`, error);
      }
    }

    return Array.from(plugins.values());
  }

  // Get a specific plugin by ID
  getPlugin(id: string, userId?: string): Plugin | null {
    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      logger.error('Invalid plugin ID provided:', id);
      return null;
    }

    for (const pluginsDir of [...this.pluginReadDirs].reverse()) {
      const filePath = path.resolve(pluginsDir, `${sanitizedId}.json`);

      if (
        !filePath.startsWith(path.resolve(pluginsDir)) ||
        !fs.existsSync(filePath)
      ) {
        continue;
      }

      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const parsedPlugin: Plugin = JSON.parse(content);

        if (this.validatePlugin(parsedPlugin)) {
          const plugin = applyPluginDefinitionPolicy(parsedPlugin);
          plugin.active = this.activePluginIds.has(plugin.id);
          return this.applyDiscoveredModels(plugin, userId);
        }
      } catch (error) {
        logger.error('Failed to load plugin %s:', sanitizedId, error);
      }
    }

    return null;
  }

  // Install or update a plugin
  installPlugin(pluginData: Plugin): Plugin {
    if (!this.validatePlugin(pluginData)) {
      throw new Error('Invalid plugin structure');
    }

    const now = Date.now();
    const plugin: Plugin = {
      ...pluginData,
      created_at: pluginData.created_at || now,
      updated_at: now,
      active: false,
    };

    const safeId = plugin.id.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (safeId !== plugin.id) throw new Error('Invalid plugin ID');
    const filePath = path.resolve(this.pluginsDir, `${safeId}.json`);
    if (!filePath.startsWith(path.resolve(this.pluginsDir))) {
      throw new Error('Path traversal detected');
    }
    fs.writeFileSync(filePath, JSON.stringify(plugin, null, 2));
    this.clearDiscoveredModels(plugin.id);

    return plugin;
  }

  // Delete a plugin
  deletePlugin(id: string): boolean {
    // Validate the ID parameter using a strict pattern (allows dots for version numbers like 1.6b)
    const idPattern = /^[a-zA-Z0-9._-]+$/;
    if (!idPattern.test(id)) {
      logger.error('Invalid plugin ID format:', id);
      return false;
    }

    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      logger.error('Plugin ID failed sanitization:', id);
      return false;
    }

    const writablePluginDirs = Array.from(
      new Set([this.pluginsDir, this.legacyPluginsDir])
    );
    const filePath = writablePluginDirs
      .map(pluginsDir => path.resolve(pluginsDir, `${sanitizedId}.json`))
      .find(candidate => fs.existsSync(candidate));

    if (!filePath) {
      logger.error('File path is invalid or does not exist:', filePath);
      return false;
    }

    try {
      fs.unlinkSync(filePath);

      // If this was an active plugin, deactivate it
      if (this.activePluginIds.has(id)) {
        this.activePluginIds.delete(id);
        this.saveActivePlugins();
      }

      // Clean up stored variables
      pluginVariablesService.deletePluginVariables(id);
      this.clearDiscoveredModels(id);

      return true;
    } catch (error) {
      logger.error('Failed to delete plugin %s:', sanitizedId, error);
      return false;
    }
  }

  // Activate a plugin
  async activatePlugin(id: string, userId?: string): Promise<boolean> {
    const plugin = this.getPlugin(id, userId);

    if (!plugin) {
      throw new Error('Plugin not found');
    }

    this.activePluginIds.add(id);
    this.saveActivePlugins();

    // Wait for discovery so the activation response and the UI's first reload
    // observe the same user-scoped model catalog.
    await this.discoverModels(id, userId).catch(() => {});

    return true;
  }

  // Deactivate a specific plugin
  deactivatePlugin(id?: string): boolean {
    if (id) {
      this.activePluginIds.delete(id);
    } else {
      // Legacy: deactivate all plugins
      this.activePluginIds.clear();
    }
    this.saveActivePlugins();
    return true;
  }

  // Get the active plugin for a specific model
  getActivePluginForModel(
    model: string,
    userId?: string,
    pluginId?: string
  ): Plugin | null {
    if (pluginId) {
      const plugin = this.getPlugin(pluginId, userId);
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }
      if (!this.activePluginIds.has(pluginId)) {
        throw new Error(`Plugin is not active: ${pluginId}`);
      }
      if (!plugin.model_map.includes(model)) {
        throw new Error(
          `Model ${model} is not supported by plugin ${pluginId}`
        );
      }

      const apiKey = this.getApiKey(plugin, userId);
      if (pluginRequiresApiKey(plugin) && !apiKey) {
        throw new Error(
          `API key not found for plugin ${pluginId} (set via Settings or ${plugin.auth.key_env} env var)`
        );
      }

      return plugin;
    }

    // Only route through plugins the user explicitly activated.
    const activePlugins = this.getActivePlugins(userId);

    // Find the active plugin that supports this model
    for (const plugin of activePlugins) {
      if (plugin.model_map.includes(model)) {
        // Local OpenAI-compatible servers can explicitly opt out of auth by
        // leaving both auth fields empty.
        const apiKey = this.getApiKey(plugin, userId);
        if (pluginRequiresApiKey(plugin) && !apiKey) {
          continue;
        }

        return plugin;
      }
    }

    return null;
  }

  // Get all currently active plugins
  getActivePlugins(userId?: string): Plugin[] {
    const allPlugins = this.getAllPlugins(userId);
    const activePlugins = allPlugins.filter(plugin =>
      this.activePluginIds.has(plugin.id)
    );
    return activePlugins;
  }

  // Legacy method for backward compatibility - returns first active plugin
  getActivePlugin(userId?: string): Plugin | null {
    const activePlugins = this.getActivePlugins(userId);
    return activePlugins.length > 0 ? activePlugins[0] : null;
  }

  // Get plugin status
  getPluginStatus(): PluginStatus[] {
    const plugins = this.getAllPlugins();
    return plugins.map(plugin => ({
      id: plugin.id,
      active: plugin.active || false,
      available: true, // Could be enhanced to check endpoint availability
    }));
  }

  // Execute a chat request through the active plugin
  async executePluginRequest(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions = {},
    userId?: string,
    pluginId?: string
  ): Promise<PluginResponse> {
    validatePluginModel(model);

    const activePlugin = this.getActivePluginForModel(model, userId, pluginId);
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }

    const apiKey = this.getApiKey(activePlugin, userId);
    if (pluginRequiresApiKey(activePlugin) && !apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (set via Settings or ${activePlugin.auth.key_env} env var)`
      );
    }

    const pluginVars = this.getPluginVariables(activePlugin, userId);
    const { apiMode, endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      activePlugin,
      pluginVars
    );
    const headers = buildPluginAuthHeaders(activePlugin, apiKey);
    const { payload, headers: payloadHeaders } = buildPluginChatPayload(
      activePlugin,
      model,
      messages,
      options,
      pluginVars,
      false,
      apiMode
    );
    Object.assign(headers, payloadHeaders);
    const processedEndpoint = applyModelEndpointTemplate(
      effectiveEndpoint,
      model
    );
    assertSafePluginEndpoint(processedEndpoint, 'endpoint URL constructed');

    try {
      const response = await axios.post(processedEndpoint, payload, {
        headers,
        timeout: 60000, // 60 second timeout
      });

      return convertProviderResponse(
        activePlugin,
        response.data,
        model,
        apiMode
      );
    } catch (error: unknown) {
      logger.error(`Plugin request failed for ${activePlugin.id}:`, error);

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response: {
            status: number;
            data?: { error?: { message?: string } };
            statusText: string;
          };
        };
        throw new Error(
          `Plugin API error: ${axiosError.response.status} - ${axiosError.response.data?.error?.message || axiosError.response.statusText}`
        );
      } else if (error && typeof error === 'object' && 'request' in error) {
        throw new Error(
          `Plugin connection error: Unable to reach ${processedEndpoint}`
        );
      } else {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Plugin error: ${errorMessage}`);
      }
    }
  }

  /**
   * Execute a streaming chat request through the active plugin.
   * Returns an async generator that yields SSE delta content strings.
   * Also collects tool_calls from the stream.
   */
  async *executePluginStreamRequest(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions = {},
    userId?: string,
    pluginId?: string
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    validatePluginModel(model);

    const activePlugin = this.getActivePluginForModel(model, userId, pluginId);
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }
    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }

    const apiKey = this.getApiKey(activePlugin, userId);
    if (pluginRequiresApiKey(activePlugin) && !apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (set via Settings or ${activePlugin.auth.key_env} env var)`
      );
    }

    const pluginVars = this.getPluginVariables(activePlugin, userId);
    const { apiMode, endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      activePlugin,
      pluginVars
    );
    const headers = buildPluginAuthHeaders(activePlugin, apiKey);
    let payload: Record<string, unknown>;

    if (activePlugin.id === 'anthropic' || apiMode === 'responses') {
      const pluginRequest = buildPluginChatPayload(
        activePlugin,
        model,
        messages,
        options,
        pluginVars,
        true,
        apiMode
      );
      payload = pluginRequest.payload;
      Object.assign(headers, pluginRequest.headers);
    } else {
      const params = resolvePluginChatParameters(options, pluginVars);
      payload = {
        model,
        messages: toOpenAICompatibleMessages(messages),
        ...getOpenAICompatibleSamplingParameters(activePlugin, params),
        max_tokens: params.maxTokens,
        stop: options.stop,
        stream: true,
      };
    }

    const processedEndpoint = applyModelEndpointTemplate(
      effectiveEndpoint,
      model
    );
    assertSafePluginEndpoint(processedEndpoint);

    const response = await fetch(processedEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (activePlugin.id === 'anthropic') {
      yield* streamAnthropicResponse(response);
    } else if (apiMode === 'responses') {
      yield* streamOpenAIResponsesResponse(response);
    } else {
      yield* streamOpenAICompatibleResponse(response);
    }
  }

  // Validate plugin structure
  private validatePlugin(plugin: unknown): plugin is Plugin {
    return (
      typeof plugin === 'object' &&
      plugin !== null &&
      typeof (plugin as Record<string, unknown>).id === 'string' &&
      typeof (plugin as Record<string, unknown>).name === 'string' &&
      typeof (plugin as Record<string, unknown>).type === 'string' &&
      typeof (plugin as Record<string, unknown>).endpoint === 'string' &&
      ((plugin as Record<string, unknown>).api_mode === undefined ||
        (plugin as Record<string, unknown>).api_mode === 'chat_completions' ||
        (plugin as Record<string, unknown>).api_mode === 'responses') &&
      ((plugin as Record<string, unknown>).base_url === undefined ||
        typeof (plugin as Record<string, unknown>).base_url === 'string') &&
      ((plugin as Record<string, unknown>).api_path === undefined ||
        typeof (plugin as Record<string, unknown>).api_path === 'string') &&
      typeof (plugin as Record<string, unknown>).auth === 'object' &&
      (plugin as Record<string, unknown>).auth !== null &&
      typeof (
        (plugin as Record<string, unknown>).auth as Record<string, unknown>
      ).header === 'string' &&
      typeof (
        (plugin as Record<string, unknown>).auth as Record<string, unknown>
      ).key_env === 'string' &&
      (((plugin as Record<string, unknown>).auth as Record<string, unknown>)
        .prefix === undefined ||
        typeof (
          (plugin as Record<string, unknown>).auth as Record<string, unknown>
        ).prefix === 'string') &&
      Array.isArray((plugin as Record<string, unknown>).model_map) &&
      ((plugin as Record<string, unknown>).model_map as unknown[]).length > 0
    );
  }

  // Export plugin to JSON
  exportPlugin(id: string, userId?: string): Plugin | null {
    return this.getPlugin(id, userId);
  }

  // Import plugin from JSON data
  importPlugin(pluginData: unknown): Plugin {
    // Validate and clean the plugin data
    if (!this.validatePlugin(pluginData)) {
      throw new Error('Invalid plugin data');
    }

    // Check if plugin already exists
    const existingPlugin = this.getPlugin(pluginData.id);
    if (existingPlugin) {
      throw new Error(`Plugin with ID ${pluginData.id} already exists`);
    }

    return this.installPlugin(pluginData);
  }

  // ============================================
  // Capability Methods
  // ============================================

  getPluginForTTS(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    return this.ttsService.getPluginForTTS(model, pluginId, userId);
  }

  getPluginForEmbedding(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    return this.embeddingService.getPluginForEmbedding(model, pluginId, userId);
  }

  getAvailableEmbeddingModels(userId?: string): Array<{
    model: string;
    plugin: string;
    pluginName: string;
    provider: EmbeddingModel['provider'];
    description?: string;
    fromEmbeddingCapability?: boolean;
  }> {
    return this.embeddingService.getAvailableEmbeddingModels(userId);
  }

  async executeEmbeddingRequest(
    model: string,
    input: string | string[],
    pluginId?: string,
    userId?: string
  ): Promise<OllamaEmbeddingsResponse> {
    return this.embeddingService.executeEmbeddingRequest(
      model,
      input,
      pluginId,
      userId
    );
  }

  getAvailableTTSModels(userId?: string): {
    model: string;
    plugin: string;
    config?: TTSConfig;
  }[] {
    return this.ttsService.getAvailableTTSModels(userId);
  }

  async executeTTSRequest(
    model: string,
    input: string,
    options: {
      voice?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      speed?: number;
      pluginId?: string;
      userId?: string;
    } = {}
  ): Promise<Buffer> {
    return this.ttsService.executeTTSRequest(model, input, options);
  }

  getTTSConfig(pluginId: string): TTSConfig | null {
    return this.ttsService.getTTSConfig(pluginId);
  }

  getPluginForImageGen(model: string, userId?: string): Plugin | null {
    return this.imageGenerationService.getPluginForImageGen(model, userId);
  }

  getAvailableImageGenModels(userId?: string): {
    model: string;
    plugin: string;
    config?: ImageGenConfig;
  }[] {
    return this.imageGenerationService.getAvailableImageGenModels(userId);
  }

  async executeImageGenRequest(
    model: string,
    prompt: string,
    options: {
      size?: string;
      quality?: string;
      style?: string;
      n?: number;
      response_format?: 'url' | 'b64_json';
      userId?: string;
    } = {}
  ): Promise<ImageGenResponse> {
    return this.imageGenerationService.executeImageGenRequest(
      model,
      prompt,
      options
    );
  }

  getImageGenConfig(pluginId: string, userId?: string): ImageGenConfig | null {
    return this.imageGenerationService.getImageGenConfig(pluginId, userId);
  }

  getPluginsByCapability(
    capabilityType: PluginType,
    userId?: string
  ): Plugin[] {
    return this.capabilityRegistryService.getPluginsByCapability(
      capabilityType,
      userId
    );
  }
}

export default new PluginService();
