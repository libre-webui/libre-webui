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
  buildPluginChatPayload,
  convertProviderResponse,
  resolvePluginChatParameters,
  toOpenAICompatibleMessages,
} from '../utils/pluginChatAdapter.js';
import {
  streamOpenAICompatibleResponse,
  type PluginStreamChunk,
} from '../utils/pluginStreamAdapter.js';
import {
  addOpenClawSessionHeader,
  applyModelEndpointTemplate,
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  resolvePluginEndpoint,
  validatePluginEndpointOverride,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('plugins');

class PluginService {
  private pluginsDir: string;
  private activePluginIds: Set<string> = new Set();
  private embeddingService: PluginEmbeddingService;
  private ttsService: PluginTTSService;
  private imageGenerationService: PluginImageGenerationService;
  private capabilityRegistryService: PluginCapabilityRegistryService;

  constructor() {
    this.pluginsDir = path.join(process.cwd(), 'plugins');
    this.ensurePluginsDirectory();
    this.loadActivePlugins();
    this.embeddingService = new PluginEmbeddingService({
      getAllPlugins: () => this.getAllPlugins(),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
    });
    this.ttsService = new PluginTTSService({
      getAllPlugins: () => this.getAllPlugins(),
      getPlugin: id => this.getPlugin(id),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
    });
    this.imageGenerationService = new PluginImageGenerationService({
      getAllPlugins: () => this.getAllPlugins(),
      getPlugin: id => this.getPlugin(id),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
    });
    this.capabilityRegistryService = new PluginCapabilityRegistryService({
      getAllPlugins: () => this.getAllPlugins(),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
    });
  }

  private ensurePluginsDirectory(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  private loadActivePlugins(): void {
    const statusFile = path.join(this.pluginsDir, '.status.json');
    if (fs.existsSync(statusFile)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        if (Array.isArray(status.activePlugins)) {
          this.activePluginIds = new Set(status.activePlugins);
        } else if (status.activePlugin) {
          // Legacy support for single active plugin
          this.activePluginIds = new Set([status.activePlugin]);
        }
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
   * Returns the URL string if valid, or null if invalid.
   */
  private validateEndpointUrl(endpoint: string): string | null {
    return validatePluginEndpointOverride(endpoint);
  }

  private getModelsEndpoint(endpoint: string): string {
    const url = new URL(endpoint);
    url.search = '';

    if (url.pathname.endsWith('/models')) {
      return url.toString();
    }

    if (url.pathname.endsWith('/chat/completions')) {
      url.pathname = `${url.pathname.slice(0, -'/chat/completions'.length)}/models`;
      return url.toString();
    }

    if (url.pathname.endsWith('/completions')) {
      url.pathname = `${url.pathname.slice(0, -'/completions'.length)}/models`;
      return url.toString();
    }

    if (url.pathname.endsWith('/embeddings')) {
      url.pathname = `${url.pathname.slice(0, -'/embeddings'.length)}/models`;
      return url.toString();
    }

    const basePath =
      url.pathname === '/'
        ? ''
        : url.pathname.endsWith('/')
          ? url.pathname.slice(0, -1)
          : url.pathname;
    url.pathname = `${basePath}/models`;
    return url.toString();
  }

  /**
   * Attempt to auto-discover available models from a plugin's base endpoint.
   * Hits {baseUrl}/v1/models (OpenAI-compatible) and updates the plugin's model_map.
   * Falls back silently to the existing model_map if the endpoint is unavailable.
   */
  async discoverModels(pluginId: string, userId?: string): Promise<string[]> {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return [];

    const pluginVars = this.getPluginVariables(plugin, userId);
    const endpointOverride = pluginVars.endpoint as string | undefined;
    const effectiveEndpoint =
      (endpointOverride && this.validateEndpointUrl(endpointOverride)) ||
      plugin.endpoint;

    const apiKey = this.getApiKey(plugin, userId);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (apiKey) {
      const authValue = plugin.auth.prefix
        ? `${plugin.auth.prefix}${apiKey}`
        : apiKey;
      headers[plugin.auth.header] = authValue;
    }

    try {
      const response = await axios.get(
        this.getModelsEndpoint(effectiveEndpoint),
        {
          headers,
          timeout: 5000,
        }
      );

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

          // Update the plugin file with discovered models
          plugin.model_map = models;
          const safeId = pluginId.replace(/[^a-zA-Z0-9_.-]/g, '');
          if (safeId !== pluginId) throw new Error('Invalid plugin ID');
          const filePath = path.resolve(this.pluginsDir, `${safeId}.json`);
          if (!filePath.startsWith(path.resolve(this.pluginsDir))) {
            throw new Error('Path traversal detected');
          }
          if (fs.existsSync(filePath)) {
            const pluginData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            pluginData.model_map = models;
            pluginData.updated_at = Date.now();
            fs.writeFileSync(filePath, JSON.stringify(pluginData, null, 2));
          }

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
  getAllPlugins(): Plugin[] {
    const plugins: Plugin[] = [];

    try {
      const files = fs.readdirSync(this.pluginsDir);

      for (const file of files) {
        if (file.endsWith('.json') && !file.startsWith('.')) {
          try {
            const filePath = path.join(this.pluginsDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const plugin: Plugin = JSON.parse(content);

            // Validate plugin structure
            if (this.validatePlugin(plugin)) {
              plugin.active = this.activePluginIds.has(plugin.id);
              plugins.push(plugin);
            }
          } catch (error) {
            logger.error(`Failed to load plugin ${file}:`, error);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to read plugins directory:', error);
    }

    return plugins;
  }

  // Get a specific plugin by ID
  getPlugin(id: string): Plugin | null {
    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      logger.error('Invalid plugin ID provided:', id);
      return null;
    }

    const filePath = path.resolve(this.pluginsDir, `${sanitizedId}.json`);

    // Ensure the file path is within the plugins directory
    if (
      !filePath.startsWith(path.resolve(this.pluginsDir)) ||
      !fs.existsSync(filePath)
    ) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const plugin: Plugin = JSON.parse(content);

      if (this.validatePlugin(plugin)) {
        plugin.active = this.activePluginIds.has(plugin.id);
        return plugin;
      }
    } catch (error) {
      logger.error('Failed to load plugin %s:', sanitizedId, error);
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

    const filePath = path.resolve(this.pluginsDir, `${sanitizedId}.json`);

    // Ensure the file path is within the plugins directory
    if (
      !filePath.startsWith(path.resolve(this.pluginsDir)) ||
      !fs.existsSync(filePath)
    ) {
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

      return true;
    } catch (error) {
      logger.error('Failed to delete plugin %s:', sanitizedId, error);
      return false;
    }
  }

  // Activate a plugin
  activatePlugin(id: string): boolean {
    const plugin = this.getPlugin(id);

    if (!plugin) {
      throw new Error('Plugin not found');
    }

    this.activePluginIds.add(id);
    this.saveActivePlugins();

    // Trigger model discovery in background (non-blocking)
    this.discoverModels(id).catch(() => {});

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
  getActivePluginForModel(model: string, userId?: string): Plugin | null {
    // Only route through plugins the user explicitly activated.
    const activePlugins = this.getActivePlugins();

    // Find the active plugin that supports this model
    for (const plugin of activePlugins) {
      if (plugin.model_map.includes(model)) {
        // Check if we have the required API key (from DB or env)
        const apiKey = this.getApiKey(plugin, userId);
        if (!apiKey) {
          continue;
        }

        return plugin;
      }
    }

    return null;
  }

  // Get all currently active plugins
  getActivePlugins(): Plugin[] {
    const allPlugins = this.getAllPlugins();
    const activePlugins = allPlugins.filter(plugin =>
      this.activePluginIds.has(plugin.id)
    );
    return activePlugins;
  }

  // Legacy method for backward compatibility - returns first active plugin
  getActivePlugin(): Plugin | null {
    const activePlugins = this.getActivePlugins();
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
    userId?: string
  ): Promise<PluginResponse> {
    validatePluginModel(model);

    const activePlugin = this.getActivePluginForModel(model, userId);
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }

    const apiKey = this.getApiKey(activePlugin, userId);
    if (!apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (set via Settings or ${activePlugin.auth.key_env} env var)`
      );
    }

    const pluginVars = this.getPluginVariables(activePlugin, userId);
    const effectiveEndpoint = resolvePluginEndpoint(
      activePlugin.endpoint,
      pluginVars.endpoint as string | undefined
    );
    const headers = buildPluginAuthHeaders(activePlugin, apiKey);
    addOpenClawSessionHeader(activePlugin, pluginVars, headers);
    const { payload, headers: payloadHeaders } = buildPluginChatPayload(
      activePlugin,
      model,
      messages,
      options,
      pluginVars
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

      return convertProviderResponse(activePlugin, response.data, model);
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
    userId?: string
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    validatePluginModel(model);

    const activePlugin = this.getActivePluginForModel(model, userId);
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }
    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }

    const apiKey = this.getApiKey(activePlugin, userId);
    if (!apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (set via Settings or ${activePlugin.auth.key_env} env var)`
      );
    }

    const pluginVars = this.getPluginVariables(activePlugin, userId);
    const effectiveEndpoint = resolvePluginEndpoint(
      activePlugin.endpoint,
      pluginVars.endpoint as string | undefined
    );
    const params = resolvePluginChatParameters(options, pluginVars);
    const headers = buildPluginAuthHeaders(activePlugin, apiKey);
    addOpenClawSessionHeader(activePlugin, pluginVars, headers);

    const payload = {
      model,
      messages: toOpenAICompatibleMessages(messages),
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
      stop: options.stop,
      stream: true,
    };

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

    yield* streamOpenAICompatibleResponse(response);
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
  exportPlugin(id: string): Plugin | null {
    return this.getPlugin(id);
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

  getPluginForTTS(model: string): Plugin | null {
    return this.ttsService.getPluginForTTS(model);
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

  getAvailableTTSModels(): {
    model: string;
    plugin: string;
    config?: TTSConfig;
  }[] {
    return this.ttsService.getAvailableTTSModels();
  }

  async executeTTSRequest(
    model: string,
    input: string,
    options: {
      voice?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      speed?: number;
    } = {}
  ): Promise<Buffer> {
    return this.ttsService.executeTTSRequest(model, input, options);
  }

  getTTSConfig(pluginId: string): TTSConfig | null {
    return this.ttsService.getTTSConfig(pluginId);
  }

  getPluginForImageGen(model: string): Plugin | null {
    return this.imageGenerationService.getPluginForImageGen(model);
  }

  getAvailableImageGenModels(): {
    model: string;
    plugin: string;
    config?: ImageGenConfig;
  }[] {
    return this.imageGenerationService.getAvailableImageGenModels();
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
    } = {}
  ): Promise<ImageGenResponse> {
    return this.imageGenerationService.executeImageGenRequest(
      model,
      prompt,
      options
    );
  }

  getImageGenConfig(pluginId: string): ImageGenConfig | null {
    return this.imageGenerationService.getImageGenConfig(pluginId);
  }

  getPluginsByCapability(capabilityType: PluginType): Plugin[] {
    return this.capabilityRegistryService.getPluginsByCapability(
      capabilityType
    );
  }
}

export default new PluginService();
