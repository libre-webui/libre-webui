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

import { useState, useEffect, useCallback } from 'react';
import { mcpService } from '../services/mcpService';
import {
  McpServerConfig,
  McpServerWithStatus,
  McpServerStatusType,
  McpTool,
  McpResource,
  McpToolCallRequest,
  McpToolCallResponse,
  McpResourceReadRequest,
  McpResourceContent,
} from '../types/mcp';

interface UseMcpServersReturn {
  servers: McpServerWithStatus[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createServer: (
    server: Omit<McpServerConfig, 'id' | 'created_at' | 'updated_at'>
  ) => Promise<void>;
  updateServer: (
    id: string,
    updates: Partial<McpServerConfig>
  ) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  connectServer: (id: string) => Promise<void>;
  disconnectServer: (id: string) => Promise<void>;
  refreshServer: (id: string) => Promise<void>;
}

export function useMcpServers(): UseMcpServersReturn {
  const [servers, setServers] = useState<McpServerWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const fetchedServers = await mcpService.getServers();
      setServers(fetchedServers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch servers');
    } finally {
      setLoading(false);
    }
  }, []);

  const createServer = useCallback(
    async (
      server: Omit<McpServerConfig, 'id' | 'created_at' | 'updated_at'>
    ) => {
      try {
        setError(null);
        const newServer = await mcpService.createServer(server);
        setServers(prev => [...prev, newServer]);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to create server'
        );
        throw err;
      }
    },
    []
  );

  const updateServer = useCallback(
    async (id: string, updates: Partial<McpServerConfig>) => {
      try {
        setError(null);
        const updatedServer = await mcpService.updateServer(id, updates);
        setServers(prev => prev.map(s => (s.id === id ? updatedServer : s)));
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to update server'
        );
        throw err;
      }
    },
    []
  );

  const deleteServer = useCallback(async (id: string) => {
    try {
      setError(null);
      await mcpService.deleteServer(id);
      setServers(prev => prev.filter(s => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete server');
      throw err;
    }
  }, []);

  const connectServer = useCallback(
    async (id: string) => {
      try {
        setError(null);
        await mcpService.connectServer(id);
        // Update server status
        setServers(prev =>
          prev.map(s =>
            s.id === id
              ? {
                  ...s,
                  status: {
                    ...s.status,
                    status: 'connecting' as McpServerStatusType,
                  },
                }
              : s
          )
        );
        // Refresh after a short delay to get updated status
        setTimeout(refresh, 1000);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to connect server'
        );
        throw err;
      }
    },
    [refresh]
  );

  const disconnectServer = useCallback(async (id: string) => {
    try {
      setError(null);
      await mcpService.disconnectServer(id);
      // Update server status
      setServers(prev =>
        prev.map(s =>
          s.id === id
            ? {
                ...s,
                status: {
                  ...s.status,
                  status: 'disconnected' as McpServerStatusType,
                },
              }
            : s
        )
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to disconnect server'
      );
      throw err;
    }
  }, []);

  const refreshServer = useCallback(
    async (id: string) => {
      try {
        setError(null);
        await mcpService.refreshServer(id);
        // Refresh the server list to get updated capabilities
        setTimeout(refresh, 500);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to refresh server'
        );
        throw err;
      }
    },
    [refresh]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    servers,
    loading,
    error,
    refresh,
    createServer,
    updateServer,
    deleteServer,
    connectServer,
    disconnectServer,
    refreshServer,
  };
}

interface UseMcpToolsReturn {
  tools: McpTool[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  callTool: (request: McpToolCallRequest) => Promise<McpToolCallResponse>;
  getServerTools: (serverId: string) => Promise<McpTool[]>;
}

export function useMcpTools(): UseMcpToolsReturn {
  const [tools, setTools] = useState<McpTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const fetchedTools = await mcpService.getTools();
      setTools(fetchedTools);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tools');
    } finally {
      setLoading(false);
    }
  }, []);

  const callTool = useCallback(
    async (request: McpToolCallRequest): Promise<McpToolCallResponse> => {
      try {
        setError(null);
        return await mcpService.callTool(request);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to call tool');
        throw err;
      }
    },
    []
  );

  const getServerTools = useCallback(
    async (serverId: string): Promise<McpTool[]> => {
      try {
        setError(null);
        return await mcpService.getServerTools(serverId);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to fetch server tools'
        );
        throw err;
      }
    },
    []
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    tools,
    loading,
    error,
    refresh,
    callTool,
    getServerTools,
  };
}

interface UseMcpResourcesReturn {
  resources: McpResource[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  readResource: (
    request: McpResourceReadRequest
  ) => Promise<McpResourceContent>;
  getServerResources: (serverId: string) => Promise<McpResource[]>;
}

export function useMcpResources(): UseMcpResourcesReturn {
  const [resources, setResources] = useState<McpResource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const fetchedResources = await mcpService.getResources();
      setResources(fetchedResources);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to fetch resources'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  const readResource = useCallback(
    async (request: McpResourceReadRequest): Promise<McpResourceContent> => {
      try {
        setError(null);
        return await mcpService.readResource(request);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to read resource'
        );
        throw err;
      }
    },
    []
  );

  const getServerResources = useCallback(
    async (serverId: string): Promise<McpResource[]> => {
      try {
        setError(null);
        return await mcpService.getServerResources(serverId);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to fetch server resources'
        );
        throw err;
      }
    },
    []
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return {
    resources,
    loading,
    error,
    refresh,
    readResource,
    getServerResources,
  };
}
