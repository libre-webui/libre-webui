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

import React, { useEffect, useRef, useState } from 'react';
import { usePluginStore } from '@/store/pluginStore';
import { Plugin } from '@/types';
import { Button } from '@/components/ui/Button';
import {
  Settings,
  Upload,
  Download,
  Trash2,
  Check,
  X,
} from '@/components/icons';

interface PluginManagerProps {
  onClose?: () => void;
}

export const PluginManager: React.FC<PluginManagerProps> = ({ onClose }) => {
  const {
    plugins,
    activePlugin,
    isLoading,
    isUploading,
    error,
    loadPlugins,
    uploadPlugin,
    deletePlugin,
    activatePlugin,
    deactivatePlugin,
    exportPlugin,
    clearError,
  } = usePluginStore();

  const [showUploadForm, setShowUploadForm] = useState(false);
  const [showJsonForm, setShowJsonForm] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      await uploadPlugin(file);
      setShowUploadForm(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleJsonSubmit = async () => {
    try {
      const pluginData = JSON.parse(jsonInput) as Plugin;
      await usePluginStore.getState().installPlugin(pluginData);
      setShowJsonForm(false);
      setJsonInput('');
    } catch (error) {
      usePluginStore.getState().setError('Invalid JSON format');
    }
  };

  const handleActivatePlugin = async (id: string) => {
    if (activePlugin?.id === id) {
      await deactivatePlugin();
    } else {
      await activatePlugin(id);
    }
  };

  const handleDeletePlugin = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this plugin?')) {
      await deletePlugin(id);
    }
  };

  const handleExportPlugin = async (id: string) => {
    await exportPlugin(id);
  };

  return (
    <div className='fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50'>
      <div className='bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden'>
        {/* Header */}
        <div className='flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700'>
          <div className='flex items-center space-x-3'>
            <Settings className='w-6 h-6 text-blue-600' />
            <h2 className='text-xl font-semibold text-gray-900 dark:text-white'>
              Plugin Manager
            </h2>
          </div>
          <div className='flex items-center space-x-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setShowUploadForm(!showUploadForm)}
              disabled={isLoading || isUploading}
            >
              <Upload className='w-4 h-4 mr-2' />
              Upload
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setShowJsonForm(!showJsonForm)}
              disabled={isLoading}
            >
              Add JSON
            </Button>
            {onClose && (
              <Button variant='ghost' size='sm' onClick={onClose}>
                <X className='w-4 h-4' />
              </Button>
            )}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className='p-4 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800'>
            <div className='flex items-center justify-between'>
              <p className='text-red-800 dark:text-red-200'>{error}</p>
              <Button
                variant='ghost'
                size='sm'
                onClick={clearError}
                className='text-red-600 hover:text-red-800'
              >
                <X className='w-4 h-4' />
              </Button>
            </div>
          </div>
        )}

        {/* Upload Form */}
        {showUploadForm && (
          <div className='p-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700'>
            <div className='flex items-center space-x-4'>
              <input
                ref={fileInputRef}
                type='file'
                accept='.json,.zip'
                onChange={handleFileUpload}
                className='flex-1 p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white'
                disabled={isUploading}
              />
              <Button
                variant='outline'
                size='sm'
                onClick={() => setShowUploadForm(false)}
                disabled={isUploading}
              >
                Cancel
              </Button>
            </div>
            {isUploading && (
              <p className='text-sm text-gray-600 dark:text-gray-400 mt-2'>
                Uploading plugin...
              </p>
            )}
          </div>
        )}

        {/* JSON Form */}
        {showJsonForm && (
          <div className='p-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700'>
            <div className='space-y-3'>
              <textarea
                value={jsonInput}
                onChange={e => setJsonInput(e.target.value)}
                placeholder='Paste plugin JSON here...'
                className='w-full h-32 p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono text-sm'
                disabled={isLoading}
              />
              <div className='flex items-center justify-end space-x-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    setShowJsonForm(false);
                    setJsonInput('');
                  }}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
                <Button
                  variant='primary'
                  size='sm'
                  onClick={handleJsonSubmit}
                  disabled={isLoading || !jsonInput.trim()}
                >
                  Install Plugin
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Plugin List */}
        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='flex items-center justify-center p-8'>
              <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
              <span className='ml-2 text-gray-600 dark:text-gray-400'>
                Loading plugins...
              </span>
            </div>
          ) : plugins.length === 0 ? (
            <div className='text-center p-8'>
              <Settings className='w-12 h-12 mx-auto mb-4 text-gray-400' />
              <h3 className='text-lg font-medium text-gray-900 dark:text-white mb-2'>
                No Plugins Installed
              </h3>
              <p className='text-gray-600 dark:text-gray-400'>
                Upload a plugin file or add a plugin from JSON to get started.
              </p>
            </div>
          ) : (
            <div className='divide-y divide-gray-200 dark:divide-gray-700'>
              {plugins.map(plugin => (
                <div
                  key={plugin.id}
                  className='p-4 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors'
                >
                  <div className='flex items-center justify-between'>
                    <div className='flex-1'>
                      <div className='flex items-center space-x-3 mb-2'>
                        <h3 className='font-medium text-gray-900 dark:text-white'>
                          {plugin.name}
                        </h3>
                        {plugin.active && (
                          <span className='inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'>
                            <Check className='w-3 h-3 mr-1' />
                            Active
                          </span>
                        )}
                        <span className='inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'>
                          {plugin.type}
                        </span>
                      </div>
                      <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                        ID: {plugin.id}
                      </p>
                      <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                        Endpoint: {plugin.endpoint}
                      </p>
                      <div className='flex flex-wrap gap-1'>
                        {plugin.model_map.map(model => (
                          <span
                            key={model}
                            className='inline-block px-2 py-1 text-xs rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                          >
                            {model}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className='flex items-center space-x-2 ml-4'>
                      <Button
                        variant={plugin.active ? 'outline' : 'primary'}
                        size='sm'
                        onClick={() => handleActivatePlugin(plugin.id)}
                        disabled={isLoading}
                      >
                        {plugin.active ? 'Deactivate' : 'Activate'}
                      </Button>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => handleExportPlugin(plugin.id)}
                        disabled={isLoading}
                        title='Export plugin'
                      >
                        <Download className='w-4 h-4' />
                      </Button>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => handleDeletePlugin(plugin.id)}
                        disabled={isLoading}
                        className='text-red-600 hover:text-red-800 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20'
                        title='Delete plugin'
                      >
                        <Trash2 className='w-4 h-4' />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Plugin Status */}
        {activePlugin && (
          <div className='p-4 bg-green-50 dark:bg-green-900/20 border-t border-green-200 dark:border-green-800'>
            <div className='flex items-center space-x-3'>
              <Check className='w-5 h-5 text-green-600 dark:text-green-400' />
              <div>
                <p className='text-sm font-medium text-green-800 dark:text-green-200'>
                  Active Plugin: {activePlugin.name}
                </p>
                <p className='text-xs text-green-600 dark:text-green-400'>
                  All chat requests will be routed through this plugin
                </p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
