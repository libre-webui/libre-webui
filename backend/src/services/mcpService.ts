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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  McpServerConfig,
  McpServerStatus,
  McpTool,
  McpResource,
  McpPrompt,
  McpToolCallRequest,
  McpToolCallResponse,
  McpResourceReadRequest,
  McpResourceContent,
  McpToolDefinition,
  McpResourceDefinition,
  McpPromptDefinition,
  McpListToolsResult,
  McpListResourcesResult,
  McpListPromptsResult,
  McpToolCallResult,
} from '../types/mcpTypes.js';
import { getErrorMessage } from '../types/index.js';

export interface McpClientConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  config: McpServerConfig;
  status: McpServerStatus;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
}

export class McpService {
  private connections = new Map<string, McpClientConnection>();
  private logger: Console;

  constructor() {
    this.logger = console;
  }

  /**
   * Connect to an MCP server
   */
  async connectToServer(config: McpServerConfig): Promise<McpServerStatus> {
    try {
      // Disconnect existing connection if any
      await this.disconnectFromServer(config.id);

      this.logger.log(
        `Connecting to MCP server: ${config.name} (${config.id})`
      );

      // Create client
      const client = new Client(
        {
          name: 'libre-webui',
          version: '1.0.0',
        },
        {
          capabilities: {
            roots: { listChanged: true },
            sampling: {},
          },
        }
      );

      // Create transport based on type
      let transport: StdioClientTransport | SSEClientTransport;

      if (config.type === 'stdio') {
        if (!config.command) {
          throw new Error('Command is required for stdio transport');
        }
        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env as Record<string, string> | undefined,
        });
      } else if (config.type === 'sse') {
        if (!config.url) {
          throw new Error('URL is required for SSE transport');
        }
        transport = new SSEClientTransport(new URL(config.url));
      } else {
        throw new Error(`Unsupported transport type: ${config.type}`);
      }

      // Set connection timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error('Connection timeout')),
          config.timeout
        );
      });

      // Connect with timeout
      await Promise.race([client.connect(transport), timeoutPromise]);

      // Get server capabilities
      const tools: McpTool[] = [];
      const resources: McpResource[] = [];
      const prompts: McpPrompt[] = [];

      try {
        // List tools
        const toolsResult = (await client.request(
          {
            method: 'tools/list',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any
        )) as McpListToolsResult;

        if (toolsResult.tools) {
          tools.push(
            ...toolsResult.tools.map((tool: McpToolDefinition) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
              annotations: tool.annotations as
                | {
                    title?: string;
                    readOnlyHint?: boolean;
                    openWorldHint?: boolean;
                  }
                | undefined,
              serverId: config.id,
            }))
          );
        }
      } catch (error) {
        this.logger.warn(`Failed to list tools for ${config.name}:`, error);
      }

      try {
        // List resources
        const resourcesResult = (await client.request(
          {
            method: 'resources/list',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any
        )) as McpListResourcesResult;

        if (resourcesResult.resources) {
          resources.push(
            ...resourcesResult.resources.map(
              (resource: McpResourceDefinition) => ({
                uri: resource.uri,
                name: resource.name,
                title: resource.title,
                description: resource.description,
                mimeType: resource.mimeType,
                serverId: config.id,
              })
            )
          );
        }
      } catch (error) {
        this.logger.warn(`Failed to list resources for ${config.name}:`, error);
      }

      try {
        // List prompts
        const promptsResult = (await client.request(
          {
            method: 'prompts/list',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          {} as any
        )) as McpListPromptsResult;

        if (promptsResult.prompts) {
          prompts.push(
            ...promptsResult.prompts.map((prompt: McpPromptDefinition) => ({
              name: prompt.name,
              title: prompt.title,
              description: prompt.description,
              arguments: prompt.arguments,
              serverId: config.id,
            }))
          );
        }
      } catch (error) {
        this.logger.warn(`Failed to list prompts for ${config.name}:`, error);
      }

      const status: McpServerStatus = {
        id: config.id,
        status: 'connected',
        lastConnected: new Date().toISOString(),
        capabilities: {
          tools: tools.length > 0,
          resources: resources.length > 0,
          prompts: prompts.length > 0,
          logging: true,
        },
      };

      const connection: McpClientConnection = {
        client,
        transport,
        config,
        status,
        tools,
        resources,
        prompts,
      };

      this.connections.set(config.id, connection);

      this.logger.log(`Successfully connected to MCP server: ${config.name}`);
      this.logger.log(
        `  Tools: ${tools.length}, Resources: ${resources.length}, Prompts: ${prompts.length}`
      );

      return status;
    } catch (error) {
      const errorStatus: McpServerStatus = {
        id: config.id,
        status: 'error',
        error: getErrorMessage(error, 'Unknown connection error'),
      };

      this.logger.error(
        `Failed to connect to MCP server ${config.name}:`,
        error
      );
      return errorStatus;
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectFromServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }

    try {
      await connection.client.close();
      await connection.transport.close();
    } catch (error) {
      this.logger.warn(
        `Error disconnecting from MCP server ${serverId}:`,
        error
      );
    }

    this.connections.delete(serverId);
    this.logger.log(`Disconnected from MCP server: ${serverId}`);
  }

  /**
   * Get server status
   */
  getServerStatus(serverId: string): McpServerStatus | null {
    const connection = this.connections.get(serverId);
    return connection ? connection.status : null;
  }

  /**
   * Get all server statuses
   */
  getAllServerStatuses(): Map<string, McpServerStatus> {
    const statuses = new Map<string, McpServerStatus>();
    for (const [id, connection] of this.connections) {
      statuses.set(id, connection.status);
    }
    return statuses;
  }

  /**
   * Get available tools from all connected servers
   */
  getAllTools(): McpTool[] {
    const allTools: McpTool[] = [];
    for (const connection of this.connections.values()) {
      if (connection.status.status === 'connected') {
        allTools.push(...connection.tools);
      }
    }
    return allTools;
  }

  /**
   * Get tools from a specific server
   */
  getServerTools(serverId: string): McpTool[] {
    const connection = this.connections.get(serverId);
    return connection && connection.status.status === 'connected'
      ? connection.tools
      : [];
  }

  /**
   * Get available resources from all connected servers
   */
  getAllResources(): McpResource[] {
    const allResources: McpResource[] = [];
    for (const connection of this.connections.values()) {
      if (connection.status.status === 'connected') {
        allResources.push(...connection.resources);
      }
    }
    return allResources;
  }

  /**
   * Get resources from a specific server
   */
  getServerResources(serverId: string): McpResource[] {
    const connection = this.connections.get(serverId);
    return connection && connection.status.status === 'connected'
      ? connection.resources
      : [];
  }

  /**
   * Get available prompts from all connected servers
   */
  getAllPrompts(): McpPrompt[] {
    const allPrompts: McpPrompt[] = [];
    for (const connection of this.connections.values()) {
      if (connection.status.status === 'connected') {
        allPrompts.push(...connection.prompts);
      }
    }
    return allPrompts;
  }

  /**
   * Get prompts from a specific server
   */
  getServerPrompts(serverId: string): McpPrompt[] {
    const connection = this.connections.get(serverId);
    return connection && connection.status.status === 'connected'
      ? connection.prompts
      : [];
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(request: McpToolCallRequest): Promise<McpToolCallResponse> {
    const connection = this.connections.get(request.serverId);
    if (!connection) {
      throw new Error(`MCP server ${request.serverId} not connected`);
    }

    if (connection.status.status !== 'connected') {
      throw new Error(`MCP server ${request.serverId} is not connected`);
    }

    try {
      const result = (await connection.client.request(
        {
          method: 'tools/call',
          params: {
            name: request.toolName,
            arguments: request.arguments,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any
      )) as McpToolCallResult;

      return {
        content: result.content || [],
        isError: result.isError || false,
      };
    } catch (error) {
      throw new Error(
        `Failed to call tool ${request.toolName}: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Read a resource from an MCP server
   */
  async readResource(
    request: McpResourceReadRequest
  ): Promise<McpResourceContent> {
    const connection = this.connections.get(request.serverId);
    if (!connection) {
      throw new Error(`MCP server ${request.serverId} not connected`);
    }

    if (connection.status.status !== 'connected') {
      throw new Error(`MCP server ${request.serverId} is not connected`);
    }

    try {
      const result = (await connection.client.request(
        {
          method: 'resources/read',
          params: {
            uri: request.uri,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any
      )) as McpResourceContent;

      return {
        contents: result.contents || [],
      };
    } catch (error) {
      throw new Error(
        `Failed to read resource ${request.uri}: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Refresh capabilities for a connected server
   */
  async refreshServerCapabilities(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection || connection.status.status !== 'connected') {
      return;
    }

    try {
      // Clear existing capabilities
      connection.tools = [];
      connection.resources = [];
      connection.prompts = [];

      // Re-fetch capabilities
      await this.connectToServer(connection.config);
    } catch (error) {
      this.logger.error(
        `Failed to refresh capabilities for ${serverId}:`,
        error
      );
    }
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.connections.keys()).map(
      serverId => this.disconnectFromServer(serverId)
    );

    await Promise.allSettled(disconnectPromises);
  }
}

// Create singleton instance
export const mcpService = new McpService();
