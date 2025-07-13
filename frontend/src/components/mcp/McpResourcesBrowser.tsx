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
import { useMcpResources } from '../../hooks/useMcp';
import { McpResource } from '../../types/mcp';

const McpResourcesBrowser: React.FC = () => {
  const { resources, loading, error, readResource } = useMcpResources();
  const [selectedResource, setSelectedResource] = useState<McpResource | null>(
    null
  );
  const [resourceContent, setResourceContent] = useState<{
    contents?: {
      type?: string;
      text?: string;
      uri?: string;
      mimeType?: string;
      blob?: string;
    }[];
  } | null>(null);
  const [isReading, setIsReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredResources = resources.filter(
    resource =>
      resource.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      resource.description?.toLowerCase().includes(searchTerm.toLowerCase()) ||
      resource.uri.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleResourceSelection = async (resource: McpResource) => {
    setSelectedResource(resource);
    setResourceContent(null);
    setReadError(null);
    setIsReading(true);

    try {
      const content = await readResource({
        serverId: resource.serverId,
        uri: resource.uri,
      });
      setResourceContent(content);
    } catch (err) {
      setReadError(
        err instanceof Error ? err.message : 'Failed to read resource'
      );
    } finally {
      setIsReading(false);
    }
  };

  const getResourceTypeIcon = (mimeType?: string) => {
    if (!mimeType) return '📄';

    if (mimeType.startsWith('text/')) return '📝';
    if (mimeType.startsWith('image/')) return '🖼️';
    if (mimeType.startsWith('application/json')) return '📋';
    if (mimeType.startsWith('application/xml')) return '📋';
    if (mimeType.startsWith('application/pdf')) return '📕';
    return '📄';
  };

  const renderResourceContent = (
    content: {
      contents?: {
        type?: string;
        text?: string;
        uri?: string;
        mimeType?: string;
        blob?: string;
      }[];
    } | null
  ) => {
    if (!content || !content.contents) return null;

    return (
      <div className='space-y-4'>
        {content.contents.map(
          (
            item: {
              type?: string;
              text?: string;
              uri?: string;
              mimeType?: string;
              blob?: string;
            },
            index: number
          ) => (
            <div
              key={index}
              className='border border-gray-200 dark:border-gray-700 rounded-lg p-4'
            >
              <div className='flex items-center justify-between mb-2'>
                <h4 className='font-medium text-gray-900 dark:text-gray-100'>
                  {item.uri}
                </h4>
                {item.mimeType && (
                  <span className='text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-1 rounded'>
                    {item.mimeType}
                  </span>
                )}
              </div>

              {item.text && (
                <div className='bg-gray-50 dark:bg-gray-800 rounded p-3'>
                  <pre className='whitespace-pre-wrap text-sm text-gray-800 dark:text-gray-200 max-h-96 overflow-y-auto'>
                    {item.text}
                  </pre>
                </div>
              )}

              {item.blob && (
                <div className='bg-gray-50 dark:bg-gray-800 rounded p-3'>
                  {item.mimeType?.startsWith('image/') ? (
                    <img
                      src={`data:${item.mimeType};base64,${item.blob}`}
                      alt='Resource content'
                      className='max-w-full h-auto rounded'
                    />
                  ) : (
                    <div className='text-center py-4'>
                      <div className='text-4xl mb-2'>📎</div>
                      <p className='text-gray-600 dark:text-gray-400'>
                        Binary content ({item.mimeType})
                      </p>
                      <button
                        onClick={() => {
                          const link = document.createElement('a');
                          link.href = `data:${item.mimeType};base64,${item.blob}`;
                          link.download =
                            item.uri?.split('/').pop() || 'resource';
                          link.click();
                        }}
                        className='mt-2 px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors'
                      >
                        Download
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        )}
      </div>
    );
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
      <div className='mb-6'>
        <h2 className='text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2'>
          MCP Resources
        </h2>
        <p className='text-gray-600 dark:text-gray-400'>
          Browse and access resources provided by connected MCP servers
        </p>
      </div>

      {error && (
        <div className='mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg'>
          <p className='text-red-800 dark:text-red-200'>{error}</p>
        </div>
      )}

      <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
        {/* Resources List */}
        <div className='lg:col-span-1'>
          <div className='mb-4'>
            <input
              type='text'
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder='Search resources...'
              className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            />
          </div>

          <div className='space-y-2 max-h-96 overflow-y-auto'>
            {filteredResources.length === 0 ? (
              <div className='text-center py-8'>
                <div className='text-gray-400 text-4xl mb-2'>📁</div>
                <p className='text-gray-600 dark:text-gray-400'>
                  {searchTerm
                    ? 'No resources match your search'
                    : 'No resources available'}
                </p>
              </div>
            ) : (
              filteredResources.map(resource => (
                <div
                  key={`${resource.serverId}-${resource.uri}`}
                  onClick={() => handleResourceSelection(resource)}
                  className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                    selectedResource?.uri === resource.uri &&
                    selectedResource?.serverId === resource.serverId
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  <div className='flex items-start space-x-2'>
                    <span className='text-lg flex-shrink-0 mt-1'>
                      {getResourceTypeIcon(resource.mimeType)}
                    </span>
                    <div className='flex-1 min-w-0'>
                      <h3 className='font-medium text-gray-900 dark:text-gray-100 truncate'>
                        {resource.name}
                      </h3>
                      {resource.description && (
                        <p className='text-sm text-gray-600 dark:text-gray-400 mt-1'>
                          {resource.description}
                        </p>
                      )}
                      <p className='text-xs text-gray-500 dark:text-gray-500 mt-1 truncate'>
                        {resource.uri}
                      </p>
                      {resource.mimeType && (
                        <span className='inline-block text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-2 py-1 rounded mt-1'>
                          {resource.mimeType}
                        </span>
                      )}
                      <p className='text-xs text-gray-500 dark:text-gray-500 mt-1'>
                        Server: {resource.serverId}
                      </p>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Resource Content */}
        <div className='lg:col-span-2'>
          {selectedResource ? (
            <div className='space-y-6'>
              <div className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6'>
                <div className='flex items-start space-x-3 mb-4'>
                  <span className='text-2xl'>
                    {getResourceTypeIcon(selectedResource.mimeType)}
                  </span>
                  <div className='flex-1'>
                    <h3 className='text-xl font-bold text-gray-900 dark:text-gray-100'>
                      {selectedResource.name}
                    </h3>
                    {selectedResource.description && (
                      <p className='text-gray-600 dark:text-gray-400 mt-1'>
                        {selectedResource.description}
                      </p>
                    )}
                    <div className='flex items-center space-x-4 mt-2 text-sm text-gray-500 dark:text-gray-500'>
                      <span>URI: {selectedResource.uri}</span>
                      {selectedResource.mimeType && (
                        <span>Type: {selectedResource.mimeType}</span>
                      )}
                    </div>
                  </div>
                </div>

                {isReading && (
                  <div className='flex items-center justify-center py-8'>
                    <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600 mr-3'></div>
                    <span className='text-gray-600 dark:text-gray-400'>
                      Loading resource content...
                    </span>
                  </div>
                )}

                {readError && (
                  <div className='p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg'>
                    <h4 className='font-medium text-red-800 dark:text-red-200 mb-2'>
                      Error
                    </h4>
                    <p className='text-red-700 dark:text-red-300'>
                      {readError}
                    </p>
                  </div>
                )}

                {resourceContent && !isReading && (
                  <div>
                    <h4 className='font-medium text-gray-900 dark:text-gray-100 mb-3'>
                      Content
                    </h4>
                    {renderResourceContent(resourceContent)}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center'>
              <div className='text-gray-400 text-6xl mb-4'>📁</div>
              <h3 className='text-lg font-medium text-gray-900 dark:text-gray-100 mb-2'>
                Select a resource to view
              </h3>
              <p className='text-gray-600 dark:text-gray-400'>
                Choose a resource from the list to view its content
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default McpResourcesBrowser;
