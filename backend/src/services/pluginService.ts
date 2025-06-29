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
} from '../types/index.js';

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

        // Check if we have the required API key
        const apiKey = process.env[plugin.auth.key_env];
        if (!apiKey) {
          console.log(
            `[DEBUG] Plugin ${plugin.id} found but API key ${plugin.auth.key_env} not set`
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
    const activePlugin = this.getActivePluginForModel(model);

    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    // Get API key from environment
    const apiKey = process.env[activePlugin.auth.key_env];
    if (!apiKey) {
      throw new Error(
        `API key not found in environment variable: ${activePlugin.auth.key_env}`
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

    // Convert internal format to plugin-compatible format
    const pluginMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    // Prepare request payload based on plugin type
    let payload: Record<string, unknown>;

    if (activePlugin.id === 'anthropic') {
      // Anthropic-specific payload format
      // Separate system messages from user/assistant messages
      const systemMessages = pluginMessages.filter(
        msg => msg.role === 'system'
      );
      const nonSystemMessages = pluginMessages.filter(
        msg => msg.role !== 'system'
      );

      payload = {
        model,
        messages: nonSystemMessages,
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
    } else {
      // Default OpenAI-compatible format
      payload = {
        model,
        messages: pluginMessages,
        temperature: options.temperature || 0.7,
        max_tokens:
          options.num_predict === -1 ? undefined : options.num_predict,
        top_p: options.top_p,
        stop: options.stop,
        stream: false,
      };
    }

    try {
      const response = await axios.post(activePlugin.endpoint, payload, {
        headers,
        timeout: 60000, // 60 second timeout
      });

      // Handle different response formats
      if (activePlugin.id === 'anthropic') {
        return this.convertAnthropicResponse(response.data, model);
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
          `Plugin connection error: Unable to reach ${activePlugin.endpoint}`
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
}

export default new PluginService();
