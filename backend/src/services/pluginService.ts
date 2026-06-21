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

class PluginService {
  private pluginsDir: string;
  private activePluginIds: Set<string> = new Set();

  constructor() {
    this.pluginsDir = path.join(process.cwd(), 'plugins');
    this.ensurePluginsDirectory();
    this.loadActivePlugins();
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
        console.error('Failed to load plugin status:', error);
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

  private getEmbeddingCapability(plugin: Plugin):
    | {
        endpoint: string;
        model_map: string[];
        config?: Record<string, unknown>;
      }
    | undefined {
    return plugin.capabilities?.embedding;
  }

  /**
   * Validate an endpoint URL for safety (SSRF protection).
   * Returns the URL string if valid, or null if invalid.
   */
  private validateEndpointUrl(endpoint: string): string | null {
    return validatePluginEndpointOverride(endpoint);
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
          console.log(
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
      console.log(
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
            console.error(`Failed to load plugin ${file}:`, error);
          }
        }
      }
    } catch (error) {
      console.error('Failed to read plugins directory:', error);
    }

    return plugins;
  }

  // Get a specific plugin by ID
  getPlugin(id: string): Plugin | null {
    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      console.error('Invalid plugin ID provided:', id);
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
      console.error('Failed to load plugin %s:', sanitizedId, error);
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
      console.error('Invalid plugin ID format:', id);
      return false;
    }

    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      console.error('Plugin ID failed sanitization:', id);
      return false;
    }

    const filePath = path.resolve(this.pluginsDir, `${sanitizedId}.json`);

    // Ensure the file path is within the plugins directory
    if (
      !filePath.startsWith(path.resolve(this.pluginsDir)) ||
      !fs.existsSync(filePath)
    ) {
      console.error('File path is invalid or does not exist:', filePath);
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
      console.error('Failed to delete plugin %s:', sanitizedId, error);
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
      console.error(`Plugin request failed for ${activePlugin.id}:`, error);

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
  // TTS (Text-to-Speech) Methods
  // ============================================

  // Get plugin that supports TTS for a specific model
  getPluginForTTS(model: string): Plugin | null {
    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      // Check if plugin has TTS capability
      if (plugin.capabilities?.tts) {
        const ttsCapability = plugin.capabilities.tts;
        if (ttsCapability.model_map.includes(model)) {
          // Check if no auth is required (e.g., local TTS servers)
          const noAuthRequired =
            (ttsCapability.config as Record<string, unknown> | undefined)
              ?.no_auth_required === true;

          // Check if we have the required API key (from DB or env)
          const apiKey = this.getApiKey(plugin);
          if (!apiKey && !noAuthRequired) {
            continue;
          }

          return plugin;
        }
      }

      // Also check primary type for backward compatibility with TTS-only plugins
      if (plugin.type === 'tts' && plugin.model_map.includes(model)) {
        // Check if no auth is required
        const noAuthRequired =
          (
            plugin.capabilities?.tts?.config as
              | Record<string, unknown>
              | undefined
          )?.no_auth_required === true;

        const apiKey = this.getApiKey(plugin);
        if (!apiKey && !noAuthRequired) {
          continue;
        }

        return plugin;
      }
    }

    return null;
  }

  getPluginForEmbedding(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      if (pluginId && plugin.id !== pluginId) {
        continue;
      }

      const embeddingCapability = this.getEmbeddingCapability(plugin);
      const supportsEmbedding =
        embeddingCapability?.model_map.includes(model) ||
        ((plugin.type === 'embedding' ||
          plugin.type === 'completion' ||
          plugin.type === 'chat') &&
          plugin.model_map.includes(model));

      if (!supportsEmbedding) {
        continue;
      }

      const noAuthRequired =
        (embeddingCapability?.config as Record<string, unknown> | undefined)
          ?.no_auth_required === true;
      const apiKey = this.getApiKey(plugin, userId);
      if (apiKey || noAuthRequired) {
        return plugin;
      }
    }

    return null;
  }

  getAvailableEmbeddingModels(userId?: string): Array<{
    model: string;
    plugin: string;
    pluginName: string;
    provider: EmbeddingModel['provider'];
    description?: string;
    fromEmbeddingCapability?: boolean;
  }> {
    const models: Array<{
      model: string;
      plugin: string;
      pluginName: string;
      provider: EmbeddingModel['provider'];
      description?: string;
      fromEmbeddingCapability?: boolean;
    }> = [];
    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      const embeddingCapability = this.getEmbeddingCapability(plugin);
      const noAuthRequired =
        (embeddingCapability?.config as Record<string, unknown> | undefined)
          ?.no_auth_required === true;
      const apiKey = this.getApiKey(plugin, userId);
      if (!apiKey && !noAuthRequired) {
        continue;
      }

      const provider: EmbeddingModel['provider'] =
        plugin.id === 'huggingface' ? 'huggingface' : 'openai';
      const modelMap =
        embeddingCapability?.model_map ||
        ((plugin.type === 'embedding' ||
          plugin.type === 'completion' ||
          plugin.type === 'chat') &&
        Array.isArray(plugin.model_map)
          ? plugin.model_map
          : []);

      for (const model of modelMap) {
        models.push({
          model,
          plugin: plugin.id,
          pluginName: plugin.name,
          provider,
          description: embeddingCapability
            ? 'Embedding provider'
            : 'OpenAI-compatible provider',
          fromEmbeddingCapability: Boolean(embeddingCapability),
        });
      }
    }

    return models;
  }

  async executeEmbeddingRequest(
    model: string,
    input: string | string[],
    pluginId?: string,
    userId?: string
  ): Promise<OllamaEmbeddingsResponse> {
    validatePluginModel(model);

    const plugin = this.getPluginForEmbedding(model, pluginId, userId);
    if (!plugin) {
      throw new Error(`No embedding plugin found for model: ${model}`);
    }

    const embeddingCapability = this.getEmbeddingCapability(plugin);
    const noAuthRequired =
      (embeddingCapability?.config as Record<string, unknown> | undefined)
        ?.no_auth_required === true;
    const apiKey = this.getApiKey(plugin, userId);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (set via Settings or ${plugin.auth.key_env} env var)`
      );
    }

    const pluginVars = this.getPluginVariables(plugin, userId);
    const endpointOverride = pluginVars.endpoint as string | undefined;
    const effectiveEndpoint =
      (endpointOverride && this.validateEndpointUrl(endpointOverride)) ||
      embeddingCapability?.endpoint ||
      plugin.endpoint;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey && plugin.auth.header) {
      const authValue = plugin.auth.prefix
        ? `${plugin.auth.prefix}${apiKey}`
        : apiKey;
      headers[plugin.auth.header] = authValue;
    }

    const response = await axios.post(
      this.getEmbeddingEndpoint(effectiveEndpoint),
      {
        model,
        input,
      },
      {
        headers,
        timeout: 60000,
      }
    );

    if (Array.isArray(response.data?.embeddings)) {
      return {
        embeddings: response.data.embeddings,
      };
    }

    if (Array.isArray(response.data?.data)) {
      return {
        embeddings: response.data.data
          .map((entry: { embedding?: number[] }) => entry.embedding)
          .filter((embedding: unknown): embedding is number[] =>
            Array.isArray(embedding)
          ),
      };
    }

    throw new Error('Embedding provider returned an unexpected response');
  }

  private getEmbeddingEndpoint(endpoint: string): string {
    const url = new URL(endpoint);
    url.search = '';

    if (url.pathname.endsWith('/embeddings')) {
      return url.toString();
    }

    if (url.pathname.endsWith('/chat/completions')) {
      url.pathname = `${url.pathname.slice(0, -'/chat/completions'.length)}/embeddings`;
      return url.toString();
    }

    if (url.pathname.endsWith('/completions')) {
      url.pathname = `${url.pathname.slice(0, -'/completions'.length)}/embeddings`;
      return url.toString();
    }

    if (url.pathname.endsWith('/models')) {
      url.pathname = `${url.pathname.slice(0, -'/models'.length)}/embeddings`;
      return url.toString();
    }

    const basePath =
      url.pathname === '/'
        ? ''
        : url.pathname.endsWith('/')
          ? url.pathname.slice(0, -1)
          : url.pathname;
    url.pathname = `${basePath}/embeddings`;
    return url.toString();
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

  // Get all available TTS models from all plugins
  getAvailableTTSModels(): {
    model: string;
    plugin: string;
    config?: TTSConfig;
  }[] {
    const models: { model: string; plugin: string; config?: TTSConfig }[] = [];
    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      // Check capabilities-based TTS
      if (plugin.capabilities?.tts) {
        const ttsCapability = plugin.capabilities.tts;
        // Check if no auth is required (e.g., local TTS servers)
        const noAuthRequired =
          (ttsCapability.config as Record<string, unknown> | undefined)
            ?.no_auth_required === true;
        // Check if API key is available (from DB or env)
        const apiKey = this.getApiKey(plugin);
        if (apiKey || noAuthRequired) {
          for (const model of ttsCapability.model_map) {
            models.push({
              model,
              plugin: plugin.id,
              config: ttsCapability.config,
            });
          }
        }
      }

      // Check primary type for TTS-only plugins
      if (plugin.type === 'tts') {
        // Check if no auth is required
        const noAuthRequired =
          (
            plugin.capabilities?.tts?.config as
              | Record<string, unknown>
              | undefined
          )?.no_auth_required === true;
        const apiKey = this.getApiKey(plugin);
        if (apiKey || noAuthRequired) {
          for (const model of plugin.model_map) {
            models.push({
              model,
              plugin: plugin.id,
            });
          }
        }
      }
    }

    return models;
  }

  // Execute a TTS request through the appropriate plugin
  async executeTTSRequest(
    model: string,
    input: string,
    options: {
      voice?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      speed?: number;
    } = {}
  ): Promise<Buffer> {
    validatePluginModel(model);

    const plugin = this.getPluginForTTS(model);
    if (!plugin) {
      throw new Error(`No TTS plugin found for model: ${model}`);
    }

    // Determine endpoint and config
    let endpoint: string;
    let ttsConfig: TTSConfig | undefined;

    if (plugin.capabilities?.tts) {
      endpoint = plugin.capabilities.tts.endpoint;
      ttsConfig = plugin.capabilities.tts.config;
    } else {
      endpoint = plugin.endpoint;
    }

    // Check if no auth is required (e.g., local TTS servers like Qwen3-TTS)
    const noAuthRequired =
      (ttsConfig as Record<string, unknown> | undefined)?.no_auth_required ===
      true;

    // Get API key from database (per-user) or environment variable (fallback)
    const apiKey = this.getApiKey(plugin);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (set via Settings or ${plugin.auth.key_env} env var)`
      );
    }

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Only add auth header if API key exists and auth header is configured
    if (apiKey && plugin.auth.header) {
      const authValue = plugin.auth.prefix
        ? `${plugin.auth.prefix}${apiKey}`
        : apiKey;
      headers[plugin.auth.header] = authValue;
    }

    // Load plugin variables for TTS defaults
    const ttsVars = this.getPluginVariables(plugin);

    // Allow endpoint override via plugin variables
    if (ttsVars.endpoint && typeof ttsVars.endpoint === 'string') {
      const validated = this.validateEndpointUrl(ttsVars.endpoint);
      if (validated) endpoint = validated;
    }

    // Apply defaults from config, then plugin variables, then request options
    const voice = options.voice || ttsConfig?.default_voice || 'alloy';
    const responseFormat =
      options.response_format || ttsConfig?.default_format || 'mp3';
    const speed = options.speed || (ttsVars.speed as number | undefined) || 1.0;

    // Check if input needs chunking (for long texts)
    const maxChars = ttsConfig?.max_characters || 4096;
    if (input.length > maxChars) {
      // Split text into chunks and process each, then concatenate audio
      const chunks = this.splitTextForTTS(input, maxChars);
      console.log(
        `[TTS] Input too long (${input.length} chars), splitting into ${chunks.length} chunks`
      );

      const audioBuffers: Buffer[] = [];
      for (let i = 0; i < chunks.length; i++) {
        console.log(
          `[TTS] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`
        );
        // Recursive call with chunk (will not re-chunk since it's under limit)
        const chunkAudio = await this.executeTTSRequest(
          model,
          chunks[i],
          options
        );
        audioBuffers.push(chunkAudio);
      }

      // Concatenate all audio buffers
      return Buffer.concat(audioBuffers);
    }

    // Prepare request payload and endpoint based on plugin type
    let payload: Record<string, unknown>;
    let processedEndpoint: string;

    if (plugin.id === 'elevenlabs') {
      // ElevenLabs API format
      // ElevenLabs uses voice IDs - map voice names to IDs
      const elevenLabsVoiceIds: Record<string, string> = {
        rachel: '21m00Tcm4TlvDq8ikWAM',
        domi: 'AZnzlk1XvdvUeBnXmlld',
        bella: 'EXAVITQu4vr4xnSDxMaL',
        antoni: 'ErXwobaYiN019PkySvjV',
        elli: 'MF3mGyEYCl7XYWbV9V6O',
        josh: 'TxGEqnHWrfWFTfGW9XjX',
        arnold: 'VR6AewLTigWG4xSOukaG',
        adam: 'pNInz6obpgDQGcFmaJgB',
        sam: 'yoZ06aMxZJJ28mfd3POQ',
        nicole: 'piTKgcLEGmPE4e6mEKli',
        glinda: 'z9fAnlkpzviPz146aGWa',
        clyde: '2EiwWnXFnvU5JabPnv8n',
        james: 'ZQe5CZNOzWyzPSCn5a3c',
        charlotte: 'XB0fDUnXU5powFXDhCwa',
        lily: 'pFZP5JQG7iQjIQuC4Bku',
        serena: 'pMsXgVXv3BLzUgSXRplE',
      };

      const voiceId =
        elevenLabsVoiceIds[voice.toLowerCase()] ||
        elevenLabsVoiceIds['rachel'] ||
        '21m00Tcm4TlvDq8ikWAM';

      processedEndpoint = `${endpoint}/${voiceId}`;

      // Add output_format query parameter
      const formatMap: Record<string, string> = {
        mp3: 'mp3_44100_128',
        pcm: 'pcm_16000',
        ulaw: 'ulaw_8000',
      };
      const outputFormat = formatMap[responseFormat] || 'mp3_44100_128';
      processedEndpoint += `?output_format=${outputFormat}`;

      payload = {
        text: input,
        model_id: model,
        voice_settings: {
          stability: (ttsVars.stability as number | undefined) ?? 0.5,
          similarity_boost:
            (ttsVars.similarity_boost as number | undefined) ?? 0.75,
        },
      };
    } else {
      // Default OpenAI TTS format
      payload = {
        model,
        input,
        voice,
        response_format: responseFormat,
        speed,
      };

      // Process endpoint template
      const sanitizedModel = encodeURIComponent(model);
      processedEndpoint = endpoint.replace('{model}', sanitizedModel);
    }

    // Validate the final endpoint URL
    try {
      const url = new URL(processedEndpoint);
      const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(
        url.hostname
      );
      const isPrivateNetwork =
        /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(url.hostname);

      if (url.protocol !== 'https:' && !isLocalhost && !isPrivateNetwork) {
        throw new Error(
          `Insecure endpoint protocol: ${url.protocol}. Only HTTPS is allowed for remote endpoints. ` +
            `(HTTP is permitted for localhost and private network IPs)`
        );
      }
    } catch (_error) {
      throw new Error(`Invalid endpoint URL constructed: ${processedEndpoint}`);
    }

    try {
      const response = await axios.post(processedEndpoint, payload, {
        headers,
        timeout: 120000, // 2 minute timeout for TTS
        responseType: 'arraybuffer', // TTS returns binary audio data
      });

      return Buffer.from(response.data);
    } catch (error: unknown) {
      console.error(`TTS plugin request failed for ${plugin.id}:`, error);

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response: {
            status: number;
            data?: ArrayBuffer;
            statusText: string;
          };
        };

        // Try to parse error message from response
        let errorMessage = axiosError.response.statusText;
        if (axiosError.response.data) {
          try {
            const errorText = Buffer.from(axiosError.response.data).toString(
              'utf8'
            );
            const errorJson = JSON.parse(errorText);
            errorMessage =
              errorJson.error?.message ||
              errorJson.detail ||
              errorJson.message ||
              errorMessage;
          } catch {
            // If not JSON, show raw text
            const rawText = Buffer.from(axiosError.response.data).toString(
              'utf8'
            );
            if (rawText) {
              errorMessage = rawText.substring(0, 200);
            }
          }
        }

        throw new Error(
          `TTS API error: ${axiosError.response.status} - ${errorMessage}`
        );
      } else if (error && typeof error === 'object' && 'request' in error) {
        throw new Error(
          `TTS connection error: Unable to reach ${processedEndpoint}`
        );
      } else {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`TTS error: ${errorMessage}`);
      }
    }
  }

  // Split text into chunks for TTS, trying to break at sentence boundaries
  private splitTextForTTS(text: string, maxChars: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining);
        break;
      }

      // Try to find a good break point (sentence end) within the limit
      let breakPoint = maxChars;
      const searchStart = Math.max(0, maxChars - 500); // Look in last 500 chars for sentence end

      // Look for sentence endings (. ! ?) followed by space or end
      const sentenceEnders = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];
      let bestBreak = -1;

      for (const ender of sentenceEnders) {
        const lastIndex = remaining.lastIndexOf(ender, maxChars);
        if (lastIndex > searchStart && lastIndex > bestBreak) {
          bestBreak = lastIndex + ender.length;
        }
      }

      if (bestBreak > searchStart) {
        breakPoint = bestBreak;
      } else {
        // Fall back to breaking at whitespace
        const lastSpace = remaining.lastIndexOf(' ', maxChars);
        if (lastSpace > searchStart) {
          breakPoint = lastSpace + 1;
        }
        // If no good break found, just break at maxChars (may split mid-word)
      }

      chunks.push(remaining.slice(0, breakPoint).trim());
      remaining = remaining.slice(breakPoint).trim();
    }

    return chunks.filter(chunk => chunk.length > 0);
  }

  // Get TTS configuration for a specific plugin
  getTTSConfig(pluginId: string): TTSConfig | null {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return null;

    if (plugin.capabilities?.tts?.config) {
      return plugin.capabilities.tts.config;
    }

    return null;
  }

  // ==================== Image Generation Methods ====================

  // Get plugin that supports a specific image generation model
  getPluginForImageGen(model: string): Plugin | null {
    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      // Check capabilities-based image generation
      if (plugin.capabilities?.image) {
        const imageCapability = plugin.capabilities.image;
        if (imageCapability.model_map.includes(model)) {
          return plugin;
        }
      }

      // Check primary type for image-only plugins
      if (plugin.type === 'image' && plugin.model_map.includes(model)) {
        return plugin;
      }
    }

    return null;
  }

  // Get all available image generation models from all plugins
  getAvailableImageGenModels(): {
    model: string;
    plugin: string;
    config?: ImageGenConfig;
  }[] {
    const models: { model: string; plugin: string; config?: ImageGenConfig }[] =
      [];
    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      // Check capabilities-based image generation
      if (plugin.capabilities?.image) {
        const imageCapability = plugin.capabilities.image;
        // Check if API key is available (from DB or env) or if no auth is required
        const noAuthRequired =
          (imageCapability.config as Record<string, unknown> | undefined)
            ?.no_auth_required === true;
        const apiKey = this.getApiKey(plugin);
        if (apiKey || noAuthRequired) {
          for (const model of imageCapability.model_map) {
            models.push({
              model,
              plugin: plugin.id,
              config: imageCapability.config,
            });
          }
        }
      }

      // Check primary type for image-only plugins
      if (plugin.type === 'image') {
        const apiKey = this.getApiKey(plugin);
        if (apiKey) {
          for (const model of plugin.model_map) {
            models.push({
              model,
              plugin: plugin.id,
            });
          }
        }
      }
    }

    return models;
  }

  // Execute an image generation request through the appropriate plugin
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
    validatePluginModel(model);

    // Validate prompt
    if (!prompt || typeof prompt !== 'string') {
      throw new Error('Invalid prompt: must be a non-empty string');
    }

    const plugin = this.getPluginForImageGen(model);
    if (!plugin) {
      throw new Error(`No image generation plugin found for model: ${model}`);
    }

    // Determine endpoint and config first (needed for auth check)
    let endpoint: string;
    let imageConfig: ImageGenConfig | undefined;

    if (plugin.capabilities?.image) {
      endpoint = plugin.capabilities.image.endpoint;
      imageConfig = plugin.capabilities.image.config;
    } else {
      endpoint = plugin.endpoint;
    }

    // Allow endpoint override via plugin variables
    const imageVars = this.getPluginVariables(plugin);
    if (imageVars.endpoint && typeof imageVars.endpoint === 'string') {
      const validated = this.validateEndpointUrl(imageVars.endpoint);
      if (validated) endpoint = validated;
    }

    // Get API key from database (per-user) or environment variable (fallback)
    // Some plugins (like local ComfyUI) don't require auth
    const noAuthRequired =
      (imageConfig as Record<string, unknown> | undefined)?.no_auth_required ===
      true;
    const apiKey = this.getApiKey(plugin);
    if (!apiKey && !noAuthRequired) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (set via Settings or ${plugin.auth.key_env} env var)`
      );
    }

    // Validate prompt length
    if (
      imageConfig?.max_prompt_length &&
      prompt.length > imageConfig.max_prompt_length
    ) {
      throw new Error(
        `Prompt exceeds maximum length of ${imageConfig.max_prompt_length} characters`
      );
    }

    // Build headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Only add auth header if API key is available
    if (apiKey) {
      if (plugin.auth.prefix) {
        headers[plugin.auth.header] = `${plugin.auth.prefix}${apiKey}`;
      } else {
        headers[plugin.auth.header] = apiKey;
      }
    }

    // Build payload (OpenAI-compatible format)
    const payload: Record<string, unknown> = {
      model,
      prompt,
      size: options.size || imageConfig?.default_size || '1024x1024',
      quality: options.quality || imageConfig?.default_quality || 'standard',
      n: options.n || 1,
      response_format: options.response_format || 'url',
    };

    // Add style if supported
    if (options.style || imageConfig?.default_style) {
      payload.style = options.style || imageConfig?.default_style;
    }

    // Validate the final endpoint URL
    let baseUrl: URL;
    try {
      baseUrl = new URL(endpoint);
      const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(
        baseUrl.hostname
      );
      const isPrivateNetwork =
        /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(
          baseUrl.hostname
        );

      if (baseUrl.protocol !== 'https:' && !isLocalhost && !isPrivateNetwork) {
        throw new Error(
          `Insecure endpoint protocol: ${baseUrl.protocol}. Only HTTPS is allowed for remote endpoints.`
        );
      }
    } catch (_error) {
      throw new Error(`Invalid endpoint URL: ${endpoint}`);
    }

    // Check if this is ComfyUI (special handling required)
    if (plugin.id === 'comfyui' || endpoint.includes('/prompt')) {
      return this.executeComfyUIRequest(baseUrl, prompt, {
        ...options,
        model,
        pluginVars: this.getPluginVariables(plugin),
      });
    }

    try {
      const response = await axios.post(endpoint, payload, {
        headers,
        timeout: 120000, // 2 minute timeout for image generation
      });

      // Handle OpenAI-style response
      if (response.data?.data) {
        return {
          images: response.data.data.map(
            (img: {
              url?: string;
              b64_json?: string;
              revised_prompt?: string;
            }) => ({
              url: img.url,
              b64_json: img.b64_json,
              revised_prompt: img.revised_prompt,
            })
          ),
          model,
        };
      }

      // Handle direct response format
      return {
        images: Array.isArray(response.data) ? response.data : [response.data],
        model,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message =
          error.response?.data?.error?.message ||
          error.response?.data?.message ||
          error.message;
        throw new Error(`Image generation failed: ${message}`);
      }
      throw error;
    }
  }

  // Execute ComfyUI image generation request (Flux.1 workflow)
  private async executeComfyUIRequest(
    baseUrl: URL,
    prompt: string,
    options: {
      size?: string;
      quality?: string;
      model?: string;
      pluginVars?: Record<string, string | number | boolean>;
    } = {}
  ): Promise<ImageGenResponse> {
    const comfyBaseUrl = `${baseUrl.protocol}//${baseUrl.host}`;

    // Parse size
    const size = options.size || '1024x1024';
    const [width, height] = size.split('x').map(Number);

    // Determine model-specific settings
    const model = options.model || 'flux1-dev';

    // Model configurations for Flux variants
    interface FluxModelConfig {
      unetFile: string;
      t5File: string;
      steps: { draft: number; standard: number; high: number; ultra: number };
      guidance: number;
      useCheckpointLoader: boolean;
    }

    const modelConfigs: Record<string, FluxModelConfig> = {
      'flux1-dev': {
        unetFile: 'flux1-dev.safetensors',
        t5File: 't5xxl_fp16.safetensors',
        steps: { draft: 12, standard: 20, high: 28, ultra: 40 },
        guidance: 3.5,
        useCheckpointLoader: false,
      },
      'flux1-dev-fp8': {
        unetFile: 'flux1-dev-fp8.safetensors',
        t5File: 't5xxl_fp8_e4m3fn_scaled.safetensors',
        steps: { draft: 12, standard: 20, high: 28, ultra: 40 },
        guidance: 3.5,
        useCheckpointLoader: false,
      },
      'flux1-schnell': {
        unetFile: 'flux1-schnell.safetensors',
        t5File: 't5xxl_fp16.safetensors',
        steps: { draft: 2, standard: 4, high: 6, ultra: 8 },
        guidance: 0, // Schnell doesn't use guidance
        useCheckpointLoader: false,
      },
    };

    const config = modelConfigs[model] || modelConfigs['flux1-dev'];
    const quality = (options.quality ||
      'standard') as keyof typeof config.steps;
    const pVars = options.pluginVars || {};
    // Plugin variable overrides quality-based steps if set and non-default
    const steps =
      pVars.steps && (pVars.steps as number) > 0
        ? (pVars.steps as number)
        : config.steps[quality] || config.steps.standard;

    // Create a Flux.1 workflow for ComfyUI
    // Flux uses UNET loader + dual CLIP + VAE separately
    const workflow: Record<string, unknown> = {
      '6': {
        inputs: {
          text: prompt,
          clip: ['11', 0],
        },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'CLIP Text Encode (Prompt)' },
      },
      '8': {
        inputs: {
          samples: ['13', 0],
          vae: ['10', 0],
        },
        class_type: 'VAEDecode',
        _meta: { title: 'VAE Decode' },
      },
      '9': {
        inputs: {
          filename_prefix: `LibreWebUI_${model}`,
          images: ['8', 0],
        },
        class_type: 'SaveImage',
        _meta: { title: 'Save Image' },
      },
      '10': {
        inputs: {
          vae_name: 'ae.safetensors',
        },
        class_type: 'VAELoader',
        _meta: { title: 'Load VAE' },
      },
      '11': {
        inputs: {
          clip_name1: 'clip_l.safetensors',
          clip_name2: config.t5File,
          type: 'flux',
        },
        class_type: 'DualCLIPLoader',
        _meta: { title: 'DualCLIPLoader' },
      },
      '12': {
        inputs: {
          unet_name: config.unetFile,
          weight_dtype: 'default',
        },
        class_type: 'UNETLoader',
        _meta: { title: 'Load Diffusion Model' },
      },
      '13': {
        inputs: {
          noise: ['25', 0],
          guider: ['22', 0],
          sampler: ['16', 0],
          sigmas: ['17', 0],
          latent_image: ['27', 0],
        },
        class_type: 'SamplerCustomAdvanced',
        _meta: { title: 'SamplerCustomAdvanced' },
      },
      '16': {
        inputs: {
          sampler_name: 'euler',
        },
        class_type: 'KSamplerSelect',
        _meta: { title: 'KSamplerSelect' },
      },
      '17': {
        inputs: {
          scheduler: 'simple',
          steps: steps,
          denoise: 1,
          model: ['12', 0],
        },
        class_type: 'BasicScheduler',
        _meta: { title: 'BasicScheduler' },
      },
      '22': {
        inputs: {
          model: ['12', 0],
          conditioning: config.guidance > 0 ? ['26', 0] : ['6', 0],
        },
        class_type: 'BasicGuider',
        _meta: { title: 'BasicGuider' },
      },
      '25': {
        inputs: {
          noise_seed:
            pVars.seed && (pVars.seed as number) >= 0
              ? (pVars.seed as number)
              : Math.floor(Math.random() * 1000000000000000),
        },
        class_type: 'RandomNoise',
        _meta: { title: 'RandomNoise' },
      },
      '27': {
        inputs: {
          width: width,
          height: height,
          batch_size: 1,
        },
        class_type: 'EmptySD3LatentImage',
        _meta: { title: 'EmptySD3LatentImage' },
      },
    };

    // Only add FluxGuidance node if guidance > 0 (not needed for schnell)
    if (config.guidance > 0) {
      workflow['26'] = {
        inputs: {
          guidance:
            pVars.cfg_scale && (pVars.cfg_scale as number) > 0
              ? (pVars.cfg_scale as number)
              : config.guidance,
          conditioning: ['6', 0],
        },
        class_type: 'FluxGuidance',
        _meta: { title: 'FluxGuidance' },
      };
    }

    try {
      // Generate a unique client ID
      const clientId = `libre-webui-${Date.now()}`;

      // Submit the workflow
      const promptResponse = await axios.post(
        `${comfyBaseUrl}/prompt`,
        {
          prompt: workflow,
          client_id: clientId,
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000,
        }
      );

      const promptId = promptResponse.data.prompt_id;
      if (!promptId) {
        throw new Error('Failed to get prompt ID from ComfyUI');
      }

      // Poll for completion
      let completed = false;
      let attempts = 0;
      const maxAttempts = 120; // 2 minutes with 1 second intervals

      while (!completed && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;

        const historyResponse = await axios.get(
          `${comfyBaseUrl}/history/${promptId}`,
          { timeout: 5000 }
        );

        if (historyResponse.data[promptId]) {
          const outputs = historyResponse.data[promptId].outputs;
          if (outputs && Object.keys(outputs).length > 0) {
            completed = true;

            // Find the SaveImage output
            for (const nodeId in outputs) {
              const nodeOutput = outputs[nodeId];
              if (nodeOutput.images && nodeOutput.images.length > 0) {
                const imageInfo = nodeOutput.images[0];

                // Get the image data
                const imageUrl = `${comfyBaseUrl}/view?filename=${encodeURIComponent(
                  imageInfo.filename
                )}&subfolder=${encodeURIComponent(
                  imageInfo.subfolder || ''
                )}&type=${encodeURIComponent(imageInfo.type || 'output')}`;

                // Fetch image and convert to base64
                const imageResponse = await axios.get(imageUrl, {
                  responseType: 'arraybuffer',
                  timeout: 30000,
                });

                const base64Image = Buffer.from(imageResponse.data).toString(
                  'base64'
                );

                return {
                  images: [
                    {
                      b64_json: base64Image,
                      revised_prompt: prompt,
                    },
                  ],
                  model,
                };
              }
            }
          }
        }
      }

      if (!completed) {
        throw new Error('ComfyUI generation timed out');
      }

      throw new Error('No image output found from ComfyUI');
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message =
          error.response?.data?.error ||
          error.response?.data?.message ||
          error.message;
        throw new Error(`ComfyUI generation failed: ${message}`);
      }
      throw error;
    }
  }

  // Get image generation configuration for a specific plugin
  getImageGenConfig(pluginId: string): ImageGenConfig | null {
    const plugin = this.getPlugin(pluginId);
    if (!plugin) return null;

    if (plugin.capabilities?.image?.config) {
      return plugin.capabilities.image.config;
    }

    return null;
  }

  // Get all plugins that support a specific capability type
  getPluginsByCapability(capabilityType: PluginType): Plugin[] {
    const allPlugins = this.getAllPlugins();
    const result: Plugin[] = [];

    for (const plugin of allPlugins) {
      // Check if primary type matches
      if (plugin.type === capabilityType) {
        // Check if no auth is required for image plugins
        const noAuthRequired =
          capabilityType === 'image' &&
          (
            plugin.capabilities?.image?.config as
              | Record<string, unknown>
              | undefined
          )?.no_auth_required === true;
        const apiKey = this.getApiKey(plugin);
        if (apiKey || noAuthRequired) {
          result.push(plugin);
        }
        continue;
      }

      // Check capabilities object based on capability type
      if (plugin.capabilities) {
        let hasCapability = false;
        let noAuthRequired = false;

        switch (capabilityType) {
          case 'tts':
            hasCapability = !!plugin.capabilities.tts;
            // Check if no auth is required for TTS capability (e.g., local servers)
            noAuthRequired =
              (
                plugin.capabilities.tts?.config as
                  | Record<string, unknown>
                  | undefined
              )?.no_auth_required === true;
            break;
          case 'stt':
            hasCapability = !!plugin.capabilities.stt;
            break;
          case 'embedding':
            hasCapability = !!plugin.capabilities.embedding;
            break;
          case 'image':
            hasCapability = !!plugin.capabilities.image;
            // Check if no auth is required for image capability
            noAuthRequired =
              (
                plugin.capabilities.image?.config as
                  | Record<string, unknown>
                  | undefined
              )?.no_auth_required === true;
            break;
          case 'completion':
          case 'chat':
            hasCapability = !!plugin.capabilities.completion;
            break;
        }

        if (hasCapability) {
          const apiKey = this.getApiKey(plugin);
          if (apiKey || noAuthRequired) {
            result.push(plugin);
          }
        }
      }
    }

    return result;
  }
}

export default new PluginService();
