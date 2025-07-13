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
import McpServerManager from '../components/mcp/McpServerManager';
import McpToolsBrowser from '../components/mcp/McpToolsBrowser';
import McpResourcesBrowser from '../components/mcp/McpResourcesBrowser';

type Tab = 'servers' | 'tools' | 'resources';

const McpManagementPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('servers');

  const tabs = [
    {
      id: 'servers',
      label: 'Servers',
      icon: '🔌',
      description: 'Manage MCP server connections',
    },
    {
      id: 'tools',
      label: 'Tools',
      icon: '🔧',
      description: 'Browse and execute MCP tools',
    },
    {
      id: 'resources',
      label: 'Resources',
      icon: '📁',
      description: 'Access MCP resources',
    },
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case 'servers':
        return <McpServerManager />;
      case 'tools':
        return <McpToolsBrowser />;
      case 'resources':
        return <McpResourcesBrowser />;
      default:
        return null;
    }
  };

  return (
    <div className='min-h-screen bg-gray-50 dark:bg-gray-900'>
      <div className='max-w-7xl mx-auto'>
        {/* Header */}
        <div className='bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700'>
          <div className='px-6 py-4'>
            <div className='flex items-center justify-between'>
              <div>
                <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100'>
                  Model Context Protocol
                </h1>
                <p className='text-gray-600 dark:text-gray-400 mt-1'>
                  Enhance your AI conversations with external tools and
                  resources
                </p>
              </div>
              <div className='flex items-center space-x-2'>
                <div className='px-3 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded-full text-sm font-medium'>
                  MCP v1.0
                </div>
              </div>
            </div>

            {/* Tab Navigation */}
            <div className='mt-6'>
              <div className='border-b border-gray-200 dark:border-gray-700'>
                <nav className='-mb-px flex space-x-8'>
                  {tabs.map(tab => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as Tab)}
                      className={`py-2 px-1 border-b-2 font-medium text-sm flex items-center space-x-2 transition-colors ${
                        activeTab === tab.id
                          ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                          : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 dark:text-gray-400 dark:hover:text-gray-300'
                      }`}
                    >
                      <span className='text-lg'>{tab.icon}</span>
                      <span>{tab.label}</span>
                    </button>
                  ))}
                </nav>
              </div>
            </div>
          </div>
        </div>

        {/* Tab Description */}
        <div className='bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800'>
          <div className='px-6 py-3'>
            <p className='text-blue-800 dark:text-blue-200 text-sm'>
              {tabs.find(tab => tab.id === activeTab)?.description}
            </p>
          </div>
        </div>

        {/* Tab Content */}
        <div className='bg-gray-50 dark:bg-gray-900'>{renderTabContent()}</div>
      </div>
    </div>
  );
};

export default McpManagementPage;
