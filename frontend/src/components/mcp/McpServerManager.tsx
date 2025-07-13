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

import React, { useState } from 'react';
import { useMcpServers } from '../../hooks/useMcp';
import { McpServerConfig, McpServerWithStatus } from '../../types/mcp';

const McpServerManager: React.FC = () => {
  const {
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
  } = useMcpServers();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<string | null>(null);
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  const handleAddServer = async (
    serverData: Omit<McpServerConfig, 'id' | 'created_at' | 'updated_at'>
  ) => {
    try {
      await createServer(serverData);
      setIsAddModalOpen(false);
    } catch (error) {
      console.error('Failed to create server:', error);
    }
  };

  const handleUpdateServer = async (
    id: string,
    updates: Partial<McpServerConfig>
  ) => {
    try {
      await updateServer(id, updates);
      setEditingServer(null);
    } catch (error) {
      console.error('Failed to update server:', error);
    }
  };

  const handleDeleteServer = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this MCP server?')) {
      try {
        await deleteServer(id);
      } catch (error) {
        console.error('Failed to delete server:', error);
      }
    }
  };

  const handleConnectToggle = async (server: McpServerWithStatus) => {
    try {
      if (server.status?.status === 'connected') {
        await disconnectServer(server.id);
      } else {
        await connectServer(server.id);
      }
    } catch (error) {
      console.error('Failed to toggle connection:', error);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return 'text-green-600 bg-green-100';
      case 'connecting':
        return 'text-yellow-600 bg-yellow-100';
      case 'error':
        return 'text-red-600 bg-red-100';
      default:
        return 'text-gray-600 bg-gray-100';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'connected':
        return '●';
      case 'connecting':
        return '○';
      case 'error':
        return '✕';
      default:
        return '○';
    }
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center h-64'>
        <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
      </div>
    );
  }

  return (
    <div className='p-6'>
      <div className='flex items-center justify-between mb-6'>
        <div>
          <h2 className='text-2xl font-bold text-gray-900 dark:text-gray-100'>
            MCP Servers
          </h2>
          <p className='text-gray-600 dark:text-gray-400 mt-1'>
            Manage Model Context Protocol servers for enhanced AI capabilities
          </p>
        </div>
        <div className='flex gap-2'>
          <button
            onClick={refresh}
            className='px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors'
          >
            🔄 Refresh
          </button>
          <button
            onClick={() => setIsAddModalOpen(true)}
            className='px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors'
          >
            + Add Server
          </button>
        </div>
      </div>

      {error && (
        <div className='mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg'>
          <p className='text-red-800 dark:text-red-200'>{error}</p>
        </div>
      )}

      <div className='space-y-4'>
        {servers.length === 0 ? (
          <div className='text-center py-12'>
            <div className='text-gray-400 text-6xl mb-4'>🔌</div>
            <h3 className='text-lg font-medium text-gray-900 dark:text-gray-100 mb-2'>
              No MCP servers configured
            </h3>
            <p className='text-gray-600 dark:text-gray-400 mb-4'>
              Add your first MCP server to unlock additional AI capabilities
            </p>
            <button
              onClick={() => setIsAddModalOpen(true)}
              className='px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors'
            >
              Add Your First Server
            </button>
          </div>
        ) : (
          servers.map(server => (
            <div
              key={server.id}
              className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden'
            >
              <div className='p-4'>
                <div className='flex items-center justify-between'>
                  <div className='flex items-center space-x-3'>
                    <div
                      className={`px-2 py-1 rounded-full text-xs font-medium flex items-center gap-1 ${getStatusColor(server.status?.status || 'disconnected')}`}
                    >
                      <span>
                        {getStatusIcon(server.status?.status || 'disconnected')}
                      </span>
                      {server.status?.status || 'disconnected'}
                    </div>
                    <div>
                      <h3 className='text-lg font-medium text-gray-900 dark:text-gray-100'>
                        {server.name}
                      </h3>
                      {server.description && (
                        <p className='text-gray-600 dark:text-gray-400 text-sm'>
                          {server.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className='flex items-center space-x-2'>
                    <button
                      onClick={() =>
                        setExpandedServer(
                          expandedServer === server.id ? null : server.id
                        )
                      }
                      className='text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                    >
                      {expandedServer === server.id ? '▼' : '▶'}
                    </button>
                    <button
                      onClick={() => handleConnectToggle(server)}
                      className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                        server.status?.status === 'connected'
                          ? 'bg-red-100 text-red-700 hover:bg-red-200'
                          : 'bg-green-100 text-green-700 hover:bg-green-200'
                      }`}
                      disabled={server.status?.status === 'connecting'}
                    >
                      {server.status?.status === 'connected'
                        ? 'Disconnect'
                        : 'Connect'}
                    </button>
                    <button
                      onClick={() => setEditingServer(server.id)}
                      className='text-gray-400 hover:text-blue-600 dark:hover:text-blue-400'
                    >
                      ✏️
                    </button>
                    <button
                      onClick={() => handleDeleteServer(server.id)}
                      className='text-gray-400 hover:text-red-600 dark:hover:text-red-400'
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {expandedServer === server.id && (
                  <div className='mt-4 pt-4 border-t border-gray-200 dark:border-gray-700'>
                    <div className='grid grid-cols-2 gap-4 text-sm'>
                      <div>
                        <span className='font-medium text-gray-700 dark:text-gray-300'>
                          Type:
                        </span>
                        <span className='ml-2 text-gray-600 dark:text-gray-400'>
                          {server.type}
                        </span>
                      </div>
                      {server.command && (
                        <div>
                          <span className='font-medium text-gray-700 dark:text-gray-300'>
                            Command:
                          </span>
                          <span className='ml-2 text-gray-600 dark:text-gray-400 font-mono text-xs'>
                            {server.command}
                          </span>
                        </div>
                      )}
                      {server.url && (
                        <div>
                          <span className='font-medium text-gray-700 dark:text-gray-300'>
                            URL:
                          </span>
                          <span className='ml-2 text-gray-600 dark:text-gray-400'>
                            {server.url}
                          </span>
                        </div>
                      )}
                      {server.status?.lastConnected && (
                        <div>
                          <span className='font-medium text-gray-700 dark:text-gray-300'>
                            Last Connected:
                          </span>
                          <span className='ml-2 text-gray-600 dark:text-gray-400'>
                            {new Date(
                              server.status.lastConnected
                            ).toLocaleString()}
                          </span>
                        </div>
                      )}
                    </div>

                    {server.status?.capabilities && (
                      <div className='mt-3'>
                        <span className='font-medium text-gray-700 dark:text-gray-300'>
                          Capabilities:
                        </span>
                        <div className='flex gap-2 mt-1'>
                          {server.status.capabilities.tools && (
                            <span className='px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs'>
                              Tools
                            </span>
                          )}
                          {server.status.capabilities.resources && (
                            <span className='px-2 py-1 bg-green-100 text-green-700 rounded text-xs'>
                              Resources
                            </span>
                          )}
                          {server.status.capabilities.prompts && (
                            <span className='px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs'>
                              Prompts
                            </span>
                          )}
                          {server.status.capabilities.logging && (
                            <span className='px-2 py-1 bg-orange-100 text-orange-700 rounded text-xs'>
                              Logging
                            </span>
                          )}
                        </div>
                      </div>
                    )}

                    {server.status?.error && (
                      <div className='mt-3 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded'>
                        <span className='font-medium text-red-700 dark:text-red-300'>
                          Error:
                        </span>
                        <span className='ml-2 text-red-600 dark:text-red-400 text-sm'>
                          {server.status.error}
                        </span>
                      </div>
                    )}

                    <div className='mt-3 flex gap-2'>
                      <button
                        onClick={() => refreshServer(server.id)}
                        className='px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors'
                      >
                        Refresh Capabilities
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add/Edit Modal would go here */}
      {isAddModalOpen && (
        <McpServerForm
          onSubmit={handleAddServer}
          onCancel={() => setIsAddModalOpen(false)}
        />
      )}

      {editingServer && (
        <McpServerForm
          server={servers.find(s => s.id === editingServer)}
          onSubmit={data => handleUpdateServer(editingServer, data)}
          onCancel={() => setEditingServer(null)}
        />
      )}
    </div>
  );
};

// Form component for adding/editing servers
interface McpServerFormProps {
  server?: McpServerConfig;
  onSubmit: (data: Omit<McpServerConfig, 'id'> & { id?: string }) => void;
  onCancel: () => void;
}

const McpServerForm: React.FC<McpServerFormProps> = ({
  server,
  onSubmit,
  onCancel,
}) => {
  const [formData, setFormData] = useState({
    name: server?.name || '',
    description: server?.description || '',
    enabled: server?.enabled ?? true,
    type: server?.type || 'stdio',
    command: server?.command || '',
    args: server?.args?.join(' ') || '',
    url: server?.url || '',
    env: server?.env
      ? Object.entries(server.env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n')
      : '',
    timeout: server?.timeout || 30000,
    maxRetries: server?.maxRetries || 3,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const submitData = {
      ...formData,
      args: formData.args ? formData.args.split(' ').filter(Boolean) : [],
      env: formData.env
        ? Object.fromEntries(
            formData.env
              .split('\n')
              .filter(line => line.includes('='))
              .map(line => {
                const [key, ...valueParts] = line.split('=');
                return [key.trim(), valueParts.join('=').trim()];
              })
          )
        : {},
    };
    onSubmit(submitData);
  };

  return (
    <div className='fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'>
      <div className='bg-white dark:bg-gray-800 rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto'>
        <h3 className='text-lg font-bold text-gray-900 dark:text-gray-100 mb-4'>
          {server ? 'Edit MCP Server' : 'Add MCP Server'}
        </h3>

        <form onSubmit={handleSubmit} className='space-y-4'>
          <div className='grid grid-cols-2 gap-4'>
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                Name
              </label>
              <input
                type='text'
                value={formData.name}
                onChange={e =>
                  setFormData({ ...formData, name: e.target.value })
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                required
              />
            </div>

            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                Type
              </label>
              <select
                value={formData.type}
                onChange={e =>
                  setFormData({
                    ...formData,
                    type: e.target.value as 'stdio' | 'sse' | 'websocket',
                  })
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              >
                <option value='stdio'>stdio</option>
                <option value='sse'>Server-Sent Events</option>
                <option value='websocket'>WebSocket</option>
              </select>
            </div>
          </div>

          <div>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
              Description
            </label>
            <input
              type='text'
              value={formData.description}
              onChange={e =>
                setFormData({ ...formData, description: e.target.value })
              }
              className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            />
          </div>

          {formData.type === 'stdio' && (
            <>
              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                  Command
                </label>
                <input
                  type='text'
                  value={formData.command}
                  onChange={e =>
                    setFormData({ ...formData, command: e.target.value })
                  }
                  className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                  placeholder='node server.js'
                  required
                />
              </div>

              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                  Arguments
                </label>
                <input
                  type='text'
                  value={formData.args}
                  onChange={e =>
                    setFormData({ ...formData, args: e.target.value })
                  }
                  className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                  placeholder='--port 3000 --config config.json'
                />
              </div>

              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                  Environment Variables
                </label>
                <textarea
                  value={formData.env}
                  onChange={e =>
                    setFormData({ ...formData, env: e.target.value })
                  }
                  className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                  placeholder='NODE_ENV=production&#10;API_KEY=your-key'
                  rows={3}
                />
              </div>
            </>
          )}

          {(formData.type === 'sse' || formData.type === 'websocket') && (
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                URL
              </label>
              <input
                type='url'
                value={formData.url}
                onChange={e =>
                  setFormData({ ...formData, url: e.target.value })
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                placeholder='http://localhost:3001/mcp'
                required
              />
            </div>
          )}

          <div className='grid grid-cols-2 gap-4'>
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                Timeout (ms)
              </label>
              <input
                type='number'
                value={formData.timeout}
                onChange={e =>
                  setFormData({
                    ...formData,
                    timeout: parseInt(e.target.value),
                  })
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                min='1000'
                max='300000'
              />
            </div>

            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                Max Retries
              </label>
              <input
                type='number'
                value={formData.maxRetries}
                onChange={e =>
                  setFormData({
                    ...formData,
                    maxRetries: parseInt(e.target.value),
                  })
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
                min='0'
                max='10'
              />
            </div>
          </div>

          <div className='flex items-center'>
            <input
              type='checkbox'
              id='enabled'
              checked={formData.enabled}
              onChange={e =>
                setFormData({ ...formData, enabled: e.target.checked })
              }
              className='h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded'
            />
            <label
              htmlFor='enabled'
              className='ml-2 block text-sm text-gray-700 dark:text-gray-300'
            >
              Enable server
            </label>
          </div>

          <div className='flex justify-end space-x-3 pt-4'>
            <button
              type='button'
              onClick={onCancel}
              className='px-4 py-2 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors'
            >
              Cancel
            </button>
            <button
              type='submit'
              className='px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors'
            >
              {server ? 'Update' : 'Create'} Server
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default McpServerManager;
