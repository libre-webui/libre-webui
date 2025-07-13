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

import { Router, Request, Response } from 'express';
import { mcpStorageService } from '../services/mcpStorageService.js';
import { mcpService } from '../services/mcpService.js';
import {
  McpServerConfigSchema,
  McpToolCallRequestSchema,
  McpResourceReadRequestSchema,
} from '../types/mcpTypes.js';
import { getErrorMessage } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export function createMcpRoutes(): Router {
  const router = Router();

  /**
   * Get all MCP servers
   */
  router.get('/servers', async (req: Request, res: Response) => {
    try {
      const servers = await mcpStorageService.getAllServers();
      const statuses = mcpService.getAllServerStatuses();

      const serversWithStatus = servers.map(server => ({
        ...server,
        status: statuses.get(server.id) || {
          id: server.id,
          status: 'disconnected' as const,
        },
      }));

      res.json({ servers: serversWithStatus });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get MCP servers'),
      });
    }
  });

  /**
   * Get a specific MCP server
   */
  router.get('/servers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const server = await mcpStorageService.getServer(id);

      if (!server) {
        return res.status(404).json({ error: 'MCP server not found' });
      }

      const status = mcpService.getServerStatus(id);
      const serverWithStatus = {
        ...server,
        status: status || {
          id: server.id,
          status: 'disconnected' as const,
        },
      };

      res.json({ server: serverWithStatus });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get MCP server'),
      });
    }
  });

  /**
   * Create a new MCP server
   */
  router.post('/servers', async (req: Request, res: Response) => {
    try {
      const serverData = {
        id: uuidv4(),
        ...req.body,
      };

      const validatedData = McpServerConfigSchema.parse(serverData);
      const server = await mcpStorageService.createServer(validatedData);

      // Auto-connect if enabled
      if (server.enabled) {
        try {
          await mcpService.connectToServer(server);
        } catch (error) {
          console.warn(
            `Failed to auto-connect to server ${server.name}:`,
            error
          );
        }
      }

      const status = mcpService.getServerStatus(server.id);
      const serverWithStatus = {
        ...server,
        status: status || {
          id: server.id,
          status: 'disconnected' as const,
        },
      };

      res.status(201).json({ server: serverWithStatus });
    } catch (error) {
      res.status(400).json({
        error: getErrorMessage(error, 'Failed to create MCP server'),
      });
    }
  });

  /**
   * Update an MCP server
   */
  router.put('/servers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const updates = req.body;

      const server = await mcpStorageService.updateServer(id, updates);
      if (!server) {
        return res.status(404).json({ error: 'MCP server not found' });
      }

      // Reconnect if server is enabled and connection-related settings changed
      if (server.enabled) {
        try {
          await mcpService.disconnectFromServer(id);
          await mcpService.connectToServer(server);
        } catch (error) {
          console.warn(`Failed to reconnect to server ${server.name}:`, error);
        }
      } else {
        await mcpService.disconnectFromServer(id);
      }

      const status = mcpService.getServerStatus(server.id);
      const serverWithStatus = {
        ...server,
        status: status || {
          id: server.id,
          status: 'disconnected' as const,
        },
      };

      res.json({ server: serverWithStatus });
    } catch (error) {
      res.status(400).json({
        error: getErrorMessage(error, 'Failed to update MCP server'),
      });
    }
  });

  /**
   * Delete an MCP server
   */
  router.delete('/servers/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;

      // Disconnect first
      await mcpService.disconnectFromServer(id);

      const deleted = await mcpStorageService.deleteServer(id);
      if (!deleted) {
        return res.status(404).json({ error: 'MCP server not found' });
      }

      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to delete MCP server'),
      });
    }
  });

  /**
   * Connect to an MCP server
   */
  router.post('/servers/:id/connect', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const server = await mcpStorageService.getServer(id);

      if (!server) {
        return res.status(404).json({ error: 'MCP server not found' });
      }

      const status = await mcpService.connectToServer(server);
      res.json({ status });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to connect to MCP server'),
      });
    }
  });

  /**
   * Disconnect from an MCP server
   */
  router.post(
    '/servers/:id/disconnect',
    async (req: Request, res: Response) => {
      try {
        const { id } = req.params;
        await mcpService.disconnectFromServer(id);
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({
          error: getErrorMessage(error, 'Failed to disconnect from MCP server'),
        });
      }
    }
  );

  /**
   * Get server status
   */
  router.get('/servers/:id/status', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const status = mcpService.getServerStatus(id);

      if (!status) {
        return res
          .status(404)
          .json({ error: 'MCP server not found or not connected' });
      }

      res.json({ status });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get server status'),
      });
    }
  });

  /**
   * Get all available tools
   */
  router.get('/tools', async (req: Request, res: Response) => {
    try {
      const tools = mcpService.getAllTools();
      res.json({ tools });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get MCP tools'),
      });
    }
  });

  /**
   * Get tools from a specific server
   */
  router.get('/servers/:id/tools', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const tools = mcpService.getServerTools(id);
      res.json({ tools });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get server tools'),
      });
    }
  });

  /**
   * Call a tool
   */
  router.post('/tools/call', async (req: Request, res: Response) => {
    try {
      const request = McpToolCallRequestSchema.parse(req.body);
      const result = await mcpService.callTool(request);
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: getErrorMessage(error, 'Failed to call MCP tool'),
      });
    }
  });

  /**
   * Get all available resources
   */
  router.get('/resources', async (req: Request, res: Response) => {
    try {
      const resources = mcpService.getAllResources();
      res.json({ resources });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get MCP resources'),
      });
    }
  });

  /**
   * Get resources from a specific server
   */
  router.get('/servers/:id/resources', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const resources = mcpService.getServerResources(id);
      res.json({ resources });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get server resources'),
      });
    }
  });

  /**
   * Read a resource
   */
  router.post('/resources/read', async (req: Request, res: Response) => {
    try {
      const request = McpResourceReadRequestSchema.parse(req.body);
      const result = await mcpService.readResource(request);
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: getErrorMessage(error, 'Failed to read MCP resource'),
      });
    }
  });

  /**
   * Get all available prompts
   */
  router.get('/prompts', async (req: Request, res: Response) => {
    try {
      const prompts = mcpService.getAllPrompts();
      res.json({ prompts });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get MCP prompts'),
      });
    }
  });

  /**
   * Get prompts from a specific server
   */
  router.get('/servers/:id/prompts', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const prompts = mcpService.getServerPrompts(id);
      res.json({ prompts });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to get server prompts'),
      });
    }
  });

  /**
   * Refresh server capabilities
   */
  router.post('/servers/:id/refresh', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      await mcpService.refreshServerCapabilities(id);

      const status = mcpService.getServerStatus(id);
      res.json({ status });
    } catch (error) {
      res.status(500).json({
        error: getErrorMessage(error, 'Failed to refresh server capabilities'),
      });
    }
  });

  return router;
}
