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

    const filePath = path.join(this.pluginsDir, `${plugin.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(plugin, null, 2));

    return plugin;
  }

  // Delete a plugin
  deletePlugin(id: string): boolean {
    // Validate the ID parameter using a strict pattern
    const idPattern = /^[a-zA-Z0-9_-]+$/;
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
  getActivePluginForModel(model: string): Plugin | null {
    console.log(`[DEBUG] Looking for plugin for model: ${model}`);

    // Get all available plugins (not just active ones)
    const allPlugins = this.getAllPlugins();
    console.log(
      `[DEBUG] Available plugins:`,
      allPlugins.map(p => p.id)
    );

    // Find the plugin that supports this model
    for (const plugin of allPlugins) {
      console.log(
        `[DEBUG] Checking plugin ${plugin.id} with model_map:`,
        plugin.model_map
      );
      if (plugin.model_map.includes(model)) {
        console.log(`[DEBUG] Found plugin ${plugin.id} for model ${model}`);

        // Check if we have the required API key (from DB or env)
        const apiKey = this.getApiKey(plugin);
        if (!apiKey) {
          console.log(
            `[DEBUG] Plugin ${plugin.id} found but API key not set (checked DB and ${plugin.auth.key_env})`
          );
          continue;
        }

        return plugin;
      }
    }

    console.log(`[DEBUG] No plugin found for model: ${model}`);
    return null;
  }

  // Get all currently active plugins
  getActivePlugins(): Plugin[] {
    const allPlugins = this.getAllPlugins();
    console.log(
      'All plugins:',
      allPlugins.map(p => ({ id: p.id, active: p.active }))
    );
    console.log(
      'Active plugin IDs in memory:',
      Array.from(this.activePluginIds)
    );
    const activePlugins = allPlugins.filter(plugin =>
      this.activePluginIds.has(plugin.id)
    );
    console.log(
      'Filtered active plugins:',
      activePlugins.map(p => p.id)
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
    options: GenerationOptions = {}
  ): Promise<PluginResponse> {
    // Validate model parameter to prevent SSRF attacks
    if (!model || typeof model !== 'string') {
      throw new Error('Invalid model parameter: must be a non-empty string');
    }

    // Sanitize model parameter - only allow alphanumeric, hyphens, underscores, colons, and dots
    const modelPattern = /^[a-zA-Z0-9\-_:.]+$/;
    if (!modelPattern.test(model)) {
      throw new Error(
        `Invalid model parameter: ${model} contains invalid characters`
      );
    }

    // Prevent path traversal and other malicious patterns
    if (model.includes('..') || model.includes('//') || model.includes('\\')) {
      throw new Error(
        `Invalid model parameter: ${model} contains invalid patterns`
      );
    }

    const activePlugin = this.getActivePluginForModel(model);

    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    // Additional validation: ensure the model is in the plugin's allowed model_map
    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }

    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    // Get API key from database (per-user) or environment variable (fallback)
    const apiKey = this.getApiKey(activePlugin);
    if (!apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (set via Settings or ${activePlugin.auth.key_env} env var)`
      );
    }

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const authValue = activePlugin.auth.prefix
      ? `${activePlugin.auth.prefix}${apiKey}`
      : apiKey;

    headers[activePlugin.auth.header] = authValue;

    // Prepare request payload based on plugin type
    let payload: Record<string, unknown>;

    if (activePlugin.id === 'anthropic') {
      // Anthropic-specific payload format
      // Separate system messages from user/assistant messages
      const systemMessages = messages.filter(msg => msg.role === 'system');
      const nonSystemMessages = messages.filter(msg => msg.role !== 'system');

      // Convert messages to Anthropic format with image support
      const anthropicMessages = nonSystemMessages.map(msg => {
        // Check if message has images
        if (msg.images && msg.images.length > 0) {
          // Anthropic format: content is an array of content blocks
          const contentBlocks: Array<
            | { type: 'text'; text: string }
            | {
                type: 'image';
                source: { type: 'base64'; media_type: string; data: string };
              }
          > = [];

          // Add images first
          for (const image of msg.images) {
            // Extract base64 data and media type from data URL
            let base64Data = image;
            let mediaType = 'image/jpeg'; // Default

            if (image.startsWith('data:')) {
              const match = image.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                mediaType = match[1];
                base64Data = match[2];
              }
            }

            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            });
          }

          // Add text content
          if (msg.content) {
            contentBlocks.push({
              type: 'text',
              text: msg.content,
            });
          }

          return {
            role: msg.role,
            content: contentBlocks,
          };
        }

        // No images - simple text content
        return {
          role: msg.role,
          content: msg.content,
        };
      });

      payload = {
        model,
        messages: anthropicMessages,
        max_tokens:
          options.num_predict && options.num_predict !== -1
            ? options.num_predict
            : 1024,
        temperature: options.temperature || 0.7,
        top_p: options.top_p,
        stop_sequences: options.stop,
        stream: false,
      };

      // Add system message as top-level parameter if present
      if (systemMessages.length > 0) {
        payload.system = systemMessages.map(msg => msg.content).join('\n');
      }

      // Add required anthropic-version header
      headers['anthropic-version'] = '2023-06-01';
    } else if (activePlugin.id === 'gemini') {
      // Gemini-specific payload format with image support
      const lastMessage = messages[messages.length - 1];
      const parts: Array<{
        text?: string;
        inline_data?: { mime_type: string; data: string };
      }> = [];

      // Add images if present
      if (lastMessage?.images && lastMessage.images.length > 0) {
        for (const image of lastMessage.images) {
          let base64Data = image;
          let mimeType = 'image/jpeg';

          if (image.startsWith('data:')) {
            const match = image.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              mimeType = match[1];
              base64Data = match[2];
            }
          }

          parts.push({
            inline_data: {
              mime_type: mimeType,
              data: base64Data,
            },
          });
        }
      }

      // Add text content
      if (lastMessage?.content) {
        parts.push({ text: lastMessage.content });
      }

      payload = {
        contents: [{ parts }],
        generationConfig: {
          temperature: options.temperature || 0.7,
          maxOutputTokens:
            options.num_predict && options.num_predict !== -1
              ? options.num_predict
              : 1024,
          topP: options.top_p,
          stopSequences: options.stop,
        },
      };
    } else {
      // Default OpenAI-compatible format with image support
      const openaiMessages = messages.map(msg => {
        // Check if message has images (OpenAI vision format)
        if (msg.images && msg.images.length > 0) {
          const content: Array<
            | { type: 'text'; text: string }
            | { type: 'image_url'; image_url: { url: string } }
          > = [];

          // Add images
          for (const image of msg.images) {
            // OpenAI expects data URLs or regular URLs
            const imageUrl = image.startsWith('data:')
              ? image
              : `data:image/jpeg;base64,${image}`;
            content.push({
              type: 'image_url',
              image_url: { url: imageUrl },
            });
          }

          // Add text
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }

          return { role: msg.role, content };
        }

        return { role: msg.role, content: msg.content };
      });

      payload = {
        model,
        messages: openaiMessages,
        temperature: options.temperature || 0.7,
        max_tokens:
          options.num_predict === -1 ? undefined : options.num_predict,
        top_p: options.top_p,
        stop: options.stop,
        stream: false,
      };
    }

    // Process endpoint template - replace {model} with actual model name
    // Final validation before URL construction to prevent SSRF
    const sanitizedModel = encodeURIComponent(model);
    const processedEndpoint = activePlugin.endpoint.replace(
      '{model}',
      sanitizedModel
    );

    // Validate the final endpoint URL
    try {
      const url = new URL(processedEndpoint);

      // Allow HTTP for localhost and private network IPs (safe for local/LAN development)
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
        timeout: 60000, // 60 second timeout
      });

      // Handle different response formats
      if (activePlugin.id === 'anthropic') {
        return this.convertAnthropicResponse(response.data, model);
      } else if (activePlugin.id === 'gemini') {
        return this.convertGeminiResponse(response.data, model);
      }

      // Default to OpenAI format
      return response.data as PluginResponse;
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

  // Convert Anthropic response format to OpenAI format
  private convertAnthropicResponse(
    anthropicResponse: Record<string, unknown>,
    model: string
  ): PluginResponse {
    const id =
      typeof anthropicResponse.id === 'string'
        ? anthropicResponse.id
        : `chatcmpl-${Date.now()}`;

    // Map Anthropic stop reasons to OpenAI format
    const stopReasonMap: Record<string, string> = {
      end_turn: 'stop',
      max_tokens: 'length',
      stop_sequence: 'stop',
      tool_use: 'tool_calls',
    };

    const stopReason =
      typeof anthropicResponse.stop_reason === 'string'
        ? stopReasonMap[anthropicResponse.stop_reason] || 'stop'
        : 'stop';

    let content = '';
    // Anthropic returns content as an array of content blocks
    if (Array.isArray(anthropicResponse.content)) {
      for (const block of anthropicResponse.content) {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'text' &&
          'text' in block &&
          typeof block.text === 'string'
        ) {
          content += block.text;
        }
      }
    }

    let usage;
    if (
      anthropicResponse.usage &&
      typeof anthropicResponse.usage === 'object' &&
      anthropicResponse.usage !== null
    ) {
      const usageObj = anthropicResponse.usage as Record<string, unknown>;
      const inputTokens =
        typeof usageObj.input_tokens === 'number' ? usageObj.input_tokens : 0;
      const outputTokens =
        typeof usageObj.output_tokens === 'number' ? usageObj.output_tokens : 0;

      usage = {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      };
    }

    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: stopReason,
        },
      ],
      usage,
    };
  }

  // Convert Gemini response format to OpenAI format
  private convertGeminiResponse(
    geminiResponse: Record<string, unknown>,
    model: string
  ): PluginResponse {
    const id = `chatcmpl-${Date.now()}`;

    let content = '';
    let finishReason = 'stop';

    // Gemini returns candidates array
    if (Array.isArray(geminiResponse.candidates)) {
      const candidate = geminiResponse.candidates[0];
      if (candidate && typeof candidate === 'object') {
        const candidateObj = candidate as Record<string, unknown>;

        // Extract content from parts
        if (candidateObj.content && typeof candidateObj.content === 'object') {
          const contentObj = candidateObj.content as Record<string, unknown>;
          if (Array.isArray(contentObj.parts)) {
            for (const part of contentObj.parts) {
              if (
                part &&
                typeof part === 'object' &&
                'text' in part &&
                typeof part.text === 'string'
              ) {
                content += part.text;
              }
            }
          }
        }

        // Map Gemini finish reason to OpenAI format
        if (typeof candidateObj.finishReason === 'string') {
          const finishReasonMap: Record<string, string> = {
            STOP: 'stop',
            MAX_TOKENS: 'length',
            SAFETY: 'content_filter',
            RECITATION: 'content_filter',
            OTHER: 'stop',
          };
          finishReason = finishReasonMap[candidateObj.finishReason] || 'stop';
        }
      }
    }

    // Extract usage if available
    let usage;
    if (
      geminiResponse.usageMetadata &&
      typeof geminiResponse.usageMetadata === 'object'
    ) {
      const usageObj = geminiResponse.usageMetadata as Record<string, unknown>;
      const promptTokens =
        typeof usageObj.promptTokenCount === 'number'
          ? usageObj.promptTokenCount
          : 0;
      const completionTokens =
        typeof usageObj.candidatesTokenCount === 'number'
          ? usageObj.candidatesTokenCount
          : 0;

      usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }

    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: finishReason,
        },
      ],
      usage,
    };
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
    console.log(`[DEBUG] Looking for TTS plugin for model: ${model}`);

    const allPlugins = this.getAllPlugins();

    for (const plugin of allPlugins) {
      // Check if plugin has TTS capability
      if (plugin.capabilities?.tts) {
        const ttsCapability = plugin.capabilities.tts;
        if (ttsCapability.model_map.includes(model)) {
          console.log(
            `[DEBUG] Found TTS plugin ${plugin.id} for model ${model}`
          );

          // Check if we have the required API key (from DB or env)
          const apiKey = this.getApiKey(plugin);
          if (!apiKey) {
            console.log(
              `[DEBUG] Plugin ${plugin.id} found but API key not set (checked DB and ${plugin.auth.key_env})`
            );
            continue;
          }

          return plugin;
        }
      }

      // Also check primary type for backward compatibility with TTS-only plugins
      if (plugin.type === 'tts' && plugin.model_map.includes(model)) {
        console.log(
          `[DEBUG] Found TTS-type plugin ${plugin.id} for model ${model}`
        );

        const apiKey = this.getApiKey(plugin);
        if (!apiKey) {
          console.log(
            `[DEBUG] Plugin ${plugin.id} found but API key not set (checked DB and ${plugin.auth.key_env})`
          );
          continue;
        }

        return plugin;
      }
    }

    console.log(`[DEBUG] No TTS plugin found for model: ${model}`);
    return null;
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
        // Check if API key is available (from DB or env)
        const apiKey = this.getApiKey(plugin);
        if (apiKey) {
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
    // Validate model parameter
    if (!model || typeof model !== 'string') {
      throw new Error('Invalid model parameter: must be a non-empty string');
    }

    // Sanitize model parameter
    const modelPattern = /^[a-zA-Z0-9\-_:.]+$/;
    if (!modelPattern.test(model)) {
      throw new Error(
        `Invalid model parameter: ${model} contains invalid characters`
      );
    }

    // Prevent path traversal
    if (model.includes('..') || model.includes('//') || model.includes('\\')) {
      throw new Error(
        `Invalid model parameter: ${model} contains invalid patterns`
      );
    }

    const plugin = this.getPluginForTTS(model);
    if (!plugin) {
      throw new Error(`No TTS plugin found for model: ${model}`);
    }

    // Get API key from database (per-user) or environment variable (fallback)
    const apiKey = this.getApiKey(plugin);
    if (!apiKey) {
      throw new Error(
        `API key not found for plugin ${plugin.id} (set via Settings or ${plugin.auth.key_env} env var)`
      );
    }

    // Determine endpoint
    let endpoint: string;
    let ttsConfig: TTSConfig | undefined;

    if (plugin.capabilities?.tts) {
      endpoint = plugin.capabilities.tts.endpoint;
      ttsConfig = plugin.capabilities.tts.config;
    } else {
      endpoint = plugin.endpoint;
    }

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const authValue = plugin.auth.prefix
      ? `${plugin.auth.prefix}${apiKey}`
      : apiKey;

    headers[plugin.auth.header] = authValue;

    // Apply defaults from config
    const voice = options.voice || ttsConfig?.default_voice || 'alloy';
    const responseFormat =
      options.response_format || ttsConfig?.default_format || 'mp3';
    const speed = options.speed || 1.0;

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
          stability: 0.5,
          similarity_boost: 0.75,
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
            errorMessage = errorJson.error?.message || errorMessage;
          } catch {
            // Ignore parse errors
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

    console.log(`[DEBUG] No image generation plugin found for model: ${model}`);
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
    // Validate model parameter
    if (!model || typeof model !== 'string') {
      throw new Error('Invalid model parameter: must be a non-empty string');
    }

    // Sanitize model parameter
    const modelPattern = /^[a-zA-Z0-9\-_:.]+$/;
    if (!modelPattern.test(model)) {
      throw new Error(
        `Invalid model parameter: ${model} contains invalid characters`
      );
    }

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
      return this.executeComfyUIRequest(baseUrl, prompt, { ...options, model });
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
    const steps = config.steps[quality] || config.steps.standard;

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
          noise_seed: Math.floor(Math.random() * 1000000000000000),
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
          guidance: config.guidance,
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
