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
  PluginRequest,
  PluginResponse,
  ChatMessage,
  GenerationOptions,
} from '../types';

class PluginService {
  private pluginsDir: string;
  private activePluginId: string | null = null;

  constructor() {
    this.pluginsDir = path.join(process.cwd(), 'plugins');
    this.ensurePluginsDirectory();
    this.loadActivePlugin();
  }

  private ensurePluginsDirectory(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  private loadActivePlugin(): void {
    const statusFile = path.join(this.pluginsDir, '.status.json');
    if (fs.existsSync(statusFile)) {
      try {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        this.activePluginId = status.activePlugin || null;
      } catch (error) {
        console.error('Failed to load plugin status:', error);
      }
    }
  }

  private saveActivePlugin(): void {
    const statusFile = path.join(this.pluginsDir, '.status.json');
    const status = {
      activePlugin: this.activePluginId,
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
              plugin.active = plugin.id === this.activePluginId;
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
        plugin.active = plugin.id === this.activePluginId;
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

      // If this was the active plugin, deactivate it
      if (this.activePluginId === id) {
        this.activePluginId = null;
        this.saveActivePlugin();
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

    this.activePluginId = id;
    this.saveActivePlugin();
    return true;
  }

  // Deactivate the current plugin
  deactivatePlugin(): boolean {
    this.activePluginId = null;
    this.saveActivePlugin();
    return true;
  }

  // Get the currently active plugin
  getActivePlugin(): Plugin | null {
    if (!this.activePluginId) {
      return null;
    }
    return this.getPlugin(this.activePluginId);
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
    const activePlugin = this.getActivePlugin();

    if (!activePlugin) {
      throw new Error('No active plugin found');
    }

    // Check if the model is supported by this plugin
    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
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

    // Convert internal format to OpenAI-compatible format
    const openaiMessages = messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    // Prepare request payload
    const payload = {
      model,
      messages: openaiMessages,
      temperature: options.temperature || 0.7,
      max_tokens: options.num_predict === -1 ? undefined : options.num_predict,
      top_p: options.top_p,
      stop: options.stop,
      stream: false, // For now, we'll handle non-streaming responses
    };

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
    } catch (error: any) {
      console.error(`Plugin request failed for ${activePlugin.id}:`, error);

      if (error.response) {
        throw new Error(
          `Plugin API error: ${error.response.status} - ${error.response.data?.error?.message || error.response.statusText}`
        );
      } else if (error.request) {
        throw new Error(
          `Plugin connection error: Unable to reach ${activePlugin.endpoint}`
        );
      } else {
        throw new Error(`Plugin error: ${error.message}`);
      }
    }
  }

  // Convert Anthropic response format to OpenAI format
  private convertAnthropicResponse(
    anthropicResponse: any,
    model: string
  ): PluginResponse {
    return {
      id: anthropicResponse.id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              anthropicResponse.content?.[0]?.text ||
              anthropicResponse.completion ||
              '',
          },
          finish_reason: anthropicResponse.stop_reason || 'stop',
        },
      ],
      usage: anthropicResponse.usage
        ? {
            prompt_tokens: anthropicResponse.usage.input_tokens || 0,
            completion_tokens: anthropicResponse.usage.output_tokens || 0,
            total_tokens:
              (anthropicResponse.usage.input_tokens || 0) +
              (anthropicResponse.usage.output_tokens || 0),
          }
        : undefined,
    };
  }

  // Validate plugin structure
  private validatePlugin(plugin: any): plugin is Plugin {
    return (
      typeof plugin === 'object' &&
      typeof plugin.id === 'string' &&
      typeof plugin.name === 'string' &&
      typeof plugin.type === 'string' &&
      typeof plugin.endpoint === 'string' &&
      typeof plugin.auth === 'object' &&
      typeof plugin.auth.header === 'string' &&
      typeof plugin.auth.key_env === 'string' &&
      (plugin.auth.prefix === undefined ||
        typeof plugin.auth.prefix === 'string') &&
      Array.isArray(plugin.model_map) &&
      plugin.model_map.length > 0
    );
  }

  // Export plugin to JSON
  exportPlugin(id: string): Plugin | null {
    return this.getPlugin(id);
  }

  // Import plugin from JSON data
  importPlugin(pluginData: any): Plugin {
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
