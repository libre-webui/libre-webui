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
import { useMcpTools } from '../../hooks/useMcp';
import {
  McpTool,
  McpToolCallRequest,
  McpToolCallResponse,
  ToolArguments,
  ToolArgumentValue,
  ToolCallHandler,
} from '../../types/mcp';

interface McpToolsBrowserProps {
  onToolCall?: ToolCallHandler;
}

const McpToolsBrowser: React.FC<McpToolsBrowserProps> = ({ onToolCall }) => {
  const { tools, loading, error, callTool } = useMcpTools();
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [toolArgs, setToolArgs] = useState<ToolArguments>({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] =
    useState<McpToolCallResponse | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const filteredTools = tools.filter(
    tool =>
      tool.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      tool.description?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleToolSelection = (tool: McpTool) => {
    setSelectedTool(tool);
    setToolArgs({});
    setExecutionResult(null);

    // Initialize arguments with default values
    const initialArgs: ToolArguments = {};
    if (tool.inputSchema?.properties) {
      Object.entries(tool.inputSchema.properties).forEach(([key, schema]) => {
        const schemaObj = schema as Record<string, unknown>;
        if (schemaObj.default !== undefined && schemaObj.default !== null) {
          initialArgs[key] = schemaObj.default as ToolArgumentValue;
        } else if (schemaObj.type === 'boolean') {
          initialArgs[key] = false;
        } else if (schemaObj.type === 'number') {
          initialArgs[key] = 0;
        } else {
          initialArgs[key] = '';
        }
      });
    }
    setToolArgs(initialArgs);
  };

  const handleArgumentChange = (argName: string, value: ToolArgumentValue) => {
    setToolArgs(prev => ({
      ...prev,
      [argName]: value,
    }));
  };

  const handleExecuteTool = async () => {
    if (!selectedTool) return;

    setIsExecuting(true);
    setExecutionResult(null);

    try {
      const request: McpToolCallRequest = {
        serverId: selectedTool.serverId,
        toolName: selectedTool.name,
        arguments: toolArgs,
      };

      const result = await callTool(request);
      setExecutionResult(result);

      // Call the callback if provided
      if (onToolCall) {
        onToolCall(selectedTool, toolArgs);
      }
    } catch (err) {
      setExecutionResult({
        isError: true,
        content: [
          {
            type: 'text',
            text: err instanceof Error ? err.message : 'Unknown error occurred',
          },
        ],
      });
    } finally {
      setIsExecuting(false);
    }
  };

  const renderArgumentInput = (
    argName: string,
    schema: Record<string, unknown>
  ) => {
    const value = toolArgs[argName];
    const isRequired = selectedTool?.inputSchema?.required?.includes(argName);

    switch (schema.type) {
      case 'boolean':
        return (
          <div className='flex items-center'>
            <input
              type='checkbox'
              id={argName}
              checked={Boolean(value)}
              onChange={e => handleArgumentChange(argName, e.target.checked)}
              className='h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded'
            />
            <label
              htmlFor={argName}
              className='ml-2 text-sm text-gray-700 dark:text-gray-300'
            >
              {String(schema.description || '')}
            </label>
          </div>
        );

      case 'number':
      case 'integer':
        return (
          <input
            type='number'
            value={typeof value === 'number' ? value : ''}
            onChange={e =>
              handleArgumentChange(argName, parseFloat(e.target.value))
            }
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            placeholder={String(schema.description || '')}
            step={schema.type === 'integer' ? 1 : 'any'}
            min={
              typeof schema.minimum === 'number' ? schema.minimum : undefined
            }
            max={
              typeof schema.maximum === 'number' ? schema.maximum : undefined
            }
            required={isRequired}
          />
        );

      case 'array':
        return (
          <textarea
            value={
              Array.isArray(value)
                ? value.join('\n')
                : typeof value === 'string'
                  ? value
                  : ''
            }
            onChange={e =>
              handleArgumentChange(
                argName,
                e.target.value.split('\n').filter(Boolean)
              )
            }
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            placeholder={`${String(schema.description || '')} (one per line)`}
            rows={3}
            required={isRequired}
          />
        );

      default: // string
        if (schema.enum) {
          return (
            <select
              value={typeof value === 'string' ? value : ''}
              onChange={e => handleArgumentChange(argName, e.target.value)}
              className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
              required={isRequired}
            >
              <option value=''>Select {argName}</option>
              {Array.isArray(schema.enum)
                ? schema.enum.map((option: unknown) => (
                    <option key={String(option)} value={String(option)}>
                      {String(option)}
                    </option>
                  ))
                : null}
            </select>
          );
        }

        return (
          <textarea
            value={typeof value === 'string' ? value : ''}
            onChange={e => handleArgumentChange(argName, e.target.value)}
            className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            placeholder={String(schema.description || '')}
            rows={
              schema.description && String(schema.description).length > 50
                ? 3
                : 1
            }
            required={isRequired}
          />
        );
    }
  };

  const renderExecutionResult = (
    result: McpToolCallResponse | null
  ): React.ReactNode => {
    if (!result) return null;

    if (result.isError) {
      return (
        <div className='p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg'>
          <h4 className='font-medium text-red-800 dark:text-red-200 mb-2'>
            Error
          </h4>
          <div className='text-red-700 dark:text-red-300'>
            {result.content?.map(
              (item: { type?: string; text?: string }, index: number) => (
                <div key={index}>
                  {item.type === 'text' && (
                    <pre className='whitespace-pre-wrap'>{item.text}</pre>
                  )}
                </div>
              )
            )}
          </div>
        </div>
      );
    }

    return (
      <div className='p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg'>
        <h4 className='font-medium text-green-800 dark:text-green-200 mb-2'>
          Result
        </h4>
        <div className='text-green-700 dark:text-green-300'>
          {result.content?.map(
            (
              item: {
                type?: string;
                text?: string;
                data?: string;
              },
              index: number
            ) => (
              <div key={index} className='mb-2'>
                {item.type === 'text' && (
                  <pre className='whitespace-pre-wrap'>{item.text}</pre>
                )}
                {item.type === 'image' && (
                  <img
                    src={item.data}
                    alt='Tool result'
                    className='max-w-full h-auto rounded'
                  />
                )}
                {item.type === 'resource' && (
                  <div className='p-2 bg-blue-50 dark:bg-blue-900/20 rounded'>
                    <strong>Resource:</strong> {item.data}
                  </div>
                )}
              </div>
            )
          )}
        </div>
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
          MCP Tools
        </h2>
        <p className='text-gray-600 dark:text-gray-400'>
          Browse and execute tools provided by connected MCP servers
        </p>
      </div>

      {error && (
        <div className='mb-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg'>
          <p className='text-red-800 dark:text-red-200'>{error}</p>
        </div>
      )}

      <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
        {/* Tools List */}
        <div className='lg:col-span-1'>
          <div className='mb-4'>
            <input
              type='text'
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder='Search tools...'
              className='w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100'
            />
          </div>

          <div className='space-y-2 max-h-96 overflow-y-auto'>
            {filteredTools.length === 0 ? (
              <div className='text-center py-8'>
                <div className='text-gray-400 text-4xl mb-2'>🔧</div>
                <p className='text-gray-600 dark:text-gray-400'>
                  {searchTerm
                    ? 'No tools match your search'
                    : 'No tools available'}
                </p>
              </div>
            ) : (
              filteredTools.map(tool => (
                <div
                  key={`${tool.serverId}-${tool.name}`}
                  onClick={() => handleToolSelection(tool)}
                  className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                    selectedTool?.name === tool.name &&
                    selectedTool?.serverId === tool.serverId
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                >
                  <h3 className='font-medium text-gray-900 dark:text-gray-100'>
                    {tool.name}
                  </h3>
                  {tool.description && (
                    <p className='text-sm text-gray-600 dark:text-gray-400 mt-1'>
                      {tool.description}
                    </p>
                  )}
                  <p className='text-xs text-gray-500 dark:text-gray-500 mt-1'>
                    Server: {tool.serverId}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Tool Details & Execution */}
        <div className='lg:col-span-2'>
          {selectedTool ? (
            <div className='space-y-6'>
              <div className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6'>
                <h3 className='text-xl font-bold text-gray-900 dark:text-gray-100 mb-2'>
                  {selectedTool.name}
                </h3>
                {selectedTool.description && (
                  <p className='text-gray-600 dark:text-gray-400 mb-4'>
                    {selectedTool.description}
                  </p>
                )}

                {/* Arguments Form */}
                {selectedTool.inputSchema?.properties && (
                  <div className='space-y-4'>
                    <h4 className='font-medium text-gray-900 dark:text-gray-100'>
                      Arguments
                    </h4>
                    {Object.entries(selectedTool.inputSchema.properties).map(
                      ([argName, schemaUnknown]: [string, unknown]) => {
                        const schema = schemaUnknown as Record<string, unknown>;
                        return (
                          <div key={argName}>
                            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                              {argName}
                              {selectedTool.inputSchema?.required?.includes(
                                argName
                              ) && <span className='text-red-500 ml-1'>*</span>}
                              {(() => {
                                const desc = schema.description;
                                return desc &&
                                  typeof desc === 'string' &&
                                  desc !== argName ? (
                                  <span className='text-gray-500 font-normal ml-2'>
                                    - {desc}
                                  </span>
                                ) : null;
                              })()}
                            </label>
                            {renderArgumentInput(argName, schema)}
                          </div>
                        );
                      }
                    )}
                  </div>
                )}

                <div className='mt-6'>
                  <button
                    onClick={handleExecuteTool}
                    disabled={isExecuting}
                    className='px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors'
                  >
                    {isExecuting ? 'Executing...' : 'Execute Tool'}
                  </button>
                </div>
              </div>

              {/* Execution Result */}
              {executionResult && (
                <div>{renderExecutionResult(executionResult)}</div>
              )}
            </div>
          ) : (
            <div className='bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-12 text-center'>
              <div className='text-gray-400 text-6xl mb-4'>🔧</div>
              <h3 className='text-lg font-medium text-gray-900 dark:text-gray-100 mb-2'>
                Select a tool to execute
              </h3>
              <p className='text-gray-600 dark:text-gray-400'>
                Choose a tool from the list to view its details and execute it
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default McpToolsBrowser;
