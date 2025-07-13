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

import { z } from 'zod';

// Empty schema for MCP requests that don't need validation
export const EmptyRequestSchema = z.object({}).passthrough();

/**
 * MCP Server Configuration Schema
 */
export const McpServerConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  type: z.enum(['stdio', 'sse', 'websocket']).default('stdio'),
  command: z.string().optional(), // For stdio servers
  args: z.array(z.string()).optional(), // For stdio servers
  url: z.string().optional(), // For HTTP/SSE servers
  env: z.record(z.string(), z.string()).optional(), // Environment variables
  timeout: z.number().default(30000), // Connection timeout in ms
  maxRetries: z.number().default(3),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * MCP Tool Schema
 */
export const McpToolSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.any().optional(),
  outputSchema: z.any().optional(),
  annotations: z
    .object({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  serverId: z.string(),
});

export type McpTool = z.infer<typeof McpToolSchema>;

/**
 * MCP Resource Schema
 */
export const McpResourceSchema = z.object({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serverId: z.string(),
});

export type McpResource = z.infer<typeof McpResourceSchema>;

/**
 * MCP Prompt Schema
 */
export const McpPromptSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        required: z.boolean().optional(),
      })
    )
    .optional(),
  serverId: z.string(),
});

export type McpPrompt = z.infer<typeof McpPromptSchema>;

/**
 * MCP Server Status
 */
export const McpServerStatusSchema = z.object({
  id: z.string(),
  status: z.enum(['connected', 'disconnected', 'connecting', 'error']),
  lastConnected: z.string().optional(),
  error: z.string().optional(),
  capabilities: z
    .object({
      tools: z.boolean().default(false),
      resources: z.boolean().default(false),
      prompts: z.boolean().default(false),
      logging: z.boolean().default(false),
    })
    .optional(),
});

export type McpServerStatus = z.infer<typeof McpServerStatusSchema>;

/**
 * MCP Tool Call Request
 */
export const McpToolCallRequestSchema = z.object({
  serverId: z.string(),
  toolName: z.string(),
  arguments: z.any().optional(),
});

export type McpToolCallRequest = z.infer<typeof McpToolCallRequestSchema>;

/**
 * MCP Tool Call Response
 */
export const McpToolCallResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
      data: z.any().optional(),
    })
  ),
  isError: z.boolean().optional(),
});

export type McpToolCallResponse = z.infer<typeof McpToolCallResponseSchema>;

/**
 * MCP Resource Read Request
 */
export const McpResourceReadRequestSchema = z.object({
  serverId: z.string(),
  uri: z.string(),
});

export type McpResourceReadRequest = z.infer<
  typeof McpResourceReadRequestSchema
>;

/**
 * MCP Resource Content
 */
export const McpResourceContentSchema = z.object({
  contents: z.array(
    z.object({
      uri: z.string(),
      mimeType: z.string().optional(),
      text: z.string().optional(),
      blob: z.string().optional(), // Base64 encoded binary data
    })
  ),
});

export type McpResourceContent = z.infer<typeof McpResourceContentSchema>;

// MCP Protocol Types
export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface McpResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpToolCallResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

export interface McpListToolsResult {
  tools: McpToolDefinition[];
}

export interface McpListResourcesResult {
  resources: McpResourceDefinition[];
}

export interface McpListPromptsResult {
  prompts: McpPromptDefinition[];
}
