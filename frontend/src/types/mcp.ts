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

export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  type: 'stdio' | 'sse' | 'websocket';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  timeout: number;
  maxRetries: number;
  created_at?: string;
  updated_at?: string;
}

export type McpServerStatusType =
  | 'connected'
  | 'disconnected'
  | 'connecting'
  | 'error';

export interface McpServerStatus {
  id: string;
  status: McpServerStatusType;
  lastConnected?: string;
  error?: string;
  capabilities?: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    logging: boolean;
  };
}

export interface McpServerWithStatus extends McpServerConfig {
  status: McpServerStatus;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    openWorldHint?: boolean;
  };
  serverId: string;
}

export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  serverId: string;
}

export interface McpPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  serverId: string;
}

export interface McpToolCallRequest {
  serverId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface McpToolCallResponse {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
  }>;
  isError?: boolean;
}

export interface McpResourceReadRequest {
  serverId: string;
  uri: string;
}

export interface McpResourceContent {
  contents: Array<{
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  }>;
}

// Tool argument value types
export type ToolArgumentValue = string | number | boolean | string[];
export type ToolArguments = Record<string, ToolArgumentValue>;

// Tool call handler type
export type ToolCallHandler = (tool: McpTool, args: ToolArguments) => void;
