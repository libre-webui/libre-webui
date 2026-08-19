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

/**
 * Minimal MCP client over Streamable HTTP: JSON-RPC 2.0 requests POSTed to
 * the server's single endpoint, accepting either an application/json body or
 * a text/event-stream response that carries the matching JSON-RPC response.
 * Sessions use the Mcp-Session-Id header issued at initialize. Every request
 * goes through the pinned egress guard; stdio transports are deliberately
 * unsupported — external processes never run inside the web process.
 */

import { secureToolRequest } from '../utils/toolEgress.js';

const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpClientError';
  }
}

export interface McpEndpoint {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnlyHint?: boolean;
}

export interface McpSession {
  sessionId?: string;
  serverName?: string;
  serverVersion?: string;
  tools?: boolean;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Extract the JSON-RPC response for `id` from a JSON or SSE response body. */
const parseRpcBody = (
  bodyText: string,
  contentType: string,
  id: number
): JsonRpcResponse => {
  if (contentType.includes('text/event-stream')) {
    for (const block of bodyText.split(/\n\n/)) {
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .join('\n');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse;
        if (parsed && parsed.id === id) return parsed;
      } catch {
        continue;
      }
    }
    throw new McpClientError(
      'MCP server stream ended without a matching response'
    );
  }
  try {
    const parsed = JSON.parse(bodyText) as JsonRpcResponse | JsonRpcResponse[];
    if (Array.isArray(parsed)) {
      const match = parsed.find(entry => entry.id === id);
      if (match) return match;
      throw new McpClientError('MCP server batch had no matching response');
    }
    return parsed;
  } catch (error) {
    if (error instanceof McpClientError) throw error;
    throw new McpClientError('MCP server returned invalid JSON');
  }
};

let nextRequestId = 1;

async function mcpRequest(
  endpoint: McpEndpoint,
  session: McpSession,
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<unknown> {
  const id = nextRequestId++;
  const response = await secureToolRequest({
    url: endpoint.url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...(session.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {}),
      ...endpoint.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    timeoutMs: endpoint.timeoutMs,
    maxResponseBytes: endpoint.maxResponseBytes,
    ...(signal ? { signal } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    throw new McpClientError('MCP server rejected the configured credentials');
  }
  if (response.status >= 400) {
    throw new McpClientError(
      `MCP server responded with status ${response.status}`
    );
  }

  const issuedSession = response.headers['mcp-session-id'];
  if (issuedSession && !session.sessionId) session.sessionId = issuedSession;

  const rpc = parseRpcBody(
    response.bodyText,
    response.headers['content-type'] ?? '',
    id
  );
  if (rpc.error) {
    throw new McpClientError(
      `MCP error ${rpc.error.code ?? ''}: ${rpc.error.message ?? 'unknown'}`.trim()
    );
  }
  return rpc.result;
}

/** Fire-and-forget JSON-RPC notification (no id, response ignored). */
async function mcpNotify(
  endpoint: McpEndpoint,
  session: McpSession,
  method: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await secureToolRequest({
      url: endpoint.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        ...(session.sessionId ? { 'Mcp-Session-Id': session.sessionId } : {}),
        ...endpoint.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method }),
      timeoutMs: endpoint.timeoutMs,
      maxResponseBytes: endpoint.maxResponseBytes,
      ...(signal ? { signal } : {}),
    });
  } catch {
    // Notifications are best-effort; the session works without them.
  }
}

export async function mcpInitialize(
  endpoint: McpEndpoint,
  signal?: AbortSignal
): Promise<McpSession> {
  const session: McpSession = {};
  const result = (await mcpRequest(
    endpoint,
    session,
    'initialize',
    {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'libre-webui', version: '1.0' },
    },
    signal
  )) as {
    serverInfo?: { name?: string; version?: string };
    capabilities?: { tools?: unknown };
  } | null;
  session.serverName = result?.serverInfo?.name;
  session.serverVersion = result?.serverInfo?.version;
  session.tools = Boolean(
    result?.capabilities && 'tools' in result.capabilities
  );
  await mcpNotify(endpoint, session, 'notifications/initialized', signal);
  return session;
}

export async function mcpListTools(
  endpoint: McpEndpoint,
  session: McpSession,
  signal?: AbortSignal
): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 16; page++) {
    const result = (await mcpRequest(
      endpoint,
      session,
      'tools/list',
      cursor ? { cursor } : {},
      signal
    )) as {
      tools?: Array<{
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
        annotations?: { readOnlyHint?: unknown };
      }>;
      nextCursor?: unknown;
    } | null;
    for (const tool of result?.tools ?? []) {
      if (typeof tool.name !== 'string' || !tool.name) continue;
      tools.push({
        name: tool.name,
        ...(typeof tool.description === 'string'
          ? { description: tool.description }
          : {}),
        ...(tool.inputSchema && typeof tool.inputSchema === 'object'
          ? { inputSchema: tool.inputSchema as Record<string, unknown> }
          : {}),
        ...(typeof tool.annotations?.readOnlyHint === 'boolean'
          ? { readOnlyHint: tool.annotations.readOnlyHint }
          : {}),
      });
    }
    if (typeof result?.nextCursor === 'string' && result.nextCursor) {
      cursor = result.nextCursor;
    } else {
      return tools;
    }
  }
  return tools;
}

export interface McpToolCallResult {
  text: string;
  isError: boolean;
}

export async function mcpCallTool(
  endpoint: McpEndpoint,
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<McpToolCallResult> {
  const result = (await mcpRequest(
    endpoint,
    session,
    'tools/call',
    { name, arguments: args },
    signal
  )) as {
    content?: Array<{ type?: unknown; text?: unknown; data?: unknown }>;
    structuredContent?: unknown;
    isError?: unknown;
  } | null;

  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type && typeof block.type === 'string') {
      parts.push(`[unsupported ${block.type} content omitted]`);
    }
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return {
    text: parts.join('\n'),
    isError: result?.isError === true,
  };
}
