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

import {
  McpServerConfig,
  McpServerWithStatus,
  McpTool,
  McpResource,
  McpPrompt,
  McpToolCallRequest,
  McpToolCallResponse,
  McpResourceReadRequest,
  McpResourceContent,
} from '../types/mcp';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

class McpService {
  private async fetchWithAuth(url: string, options: RequestInit = {}) {
    const token = localStorage.getItem('token');
    const headers = {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...options.headers,
    };

    const response = await fetch(`${API_BASE}${url}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // Server management
  async getServers(): Promise<McpServerWithStatus[]> {
    const data = await this.fetchWithAuth('/api/mcp/servers');
    return data.servers;
  }

  async getServer(id: string): Promise<McpServerWithStatus> {
    const data = await this.fetchWithAuth(`/api/mcp/servers/${id}`);
    return data.server;
  }

  async createServer(
    server: Omit<McpServerConfig, 'id' | 'created_at' | 'updated_at'>
  ): Promise<McpServerWithStatus> {
    const data = await this.fetchWithAuth('/api/mcp/servers', {
      method: 'POST',
      body: JSON.stringify(server),
    });
    return data.server;
  }

  async updateServer(
    id: string,
    updates: Partial<McpServerConfig>
  ): Promise<McpServerWithStatus> {
    const data = await this.fetchWithAuth(`/api/mcp/servers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    return data.server;
  }

  async deleteServer(id: string): Promise<void> {
    await this.fetchWithAuth(`/api/mcp/servers/${id}`, {
      method: 'DELETE',
    });
  }

  // Connection management
  async connectServer(id: string): Promise<void> {
    await this.fetchWithAuth(`/api/mcp/servers/${id}/connect`, {
      method: 'POST',
    });
  }

  async disconnectServer(id: string): Promise<void> {
    await this.fetchWithAuth(`/api/mcp/servers/${id}/disconnect`, {
      method: 'POST',
    });
  }

  async refreshServer(id: string): Promise<void> {
    await this.fetchWithAuth(`/api/mcp/servers/${id}/refresh`, {
      method: 'POST',
    });
  }

  // Tools
  async getTools(): Promise<McpTool[]> {
    const data = await this.fetchWithAuth('/api/mcp/tools');
    return data.tools;
  }

  async getServerTools(serverId: string): Promise<McpTool[]> {
    const data = await this.fetchWithAuth(`/api/mcp/servers/${serverId}/tools`);
    return data.tools;
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResponse> {
    return await this.fetchWithAuth('/api/mcp/tools/call', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  // Resources
  async getResources(): Promise<McpResource[]> {
    const data = await this.fetchWithAuth('/api/mcp/resources');
    return data.resources;
  }

  async getServerResources(serverId: string): Promise<McpResource[]> {
    const data = await this.fetchWithAuth(
      `/api/mcp/servers/${serverId}/resources`
    );
    return data.resources;
  }

  async readResource(
    request: McpResourceReadRequest
  ): Promise<McpResourceContent> {
    return await this.fetchWithAuth('/api/mcp/resources/read', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  // Prompts
  async getPrompts(): Promise<McpPrompt[]> {
    const data = await this.fetchWithAuth('/api/mcp/prompts');
    return data.prompts;
  }

  async getServerPrompts(serverId: string): Promise<McpPrompt[]> {
    const data = await this.fetchWithAuth(
      `/api/mcp/servers/${serverId}/prompts`
    );
    return data.prompts;
  }
}

export const mcpService = new McpService();
