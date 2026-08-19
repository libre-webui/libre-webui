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
 * Shared tool-runtime types: registered tool servers, their normalized tool
 * definitions, approval policy, and the versioned chat tool-event vocabulary
 * used identically on the WebSocket, SSE, and durable event transports.
 */

export type ToolServerKind = 'openapi' | 'mcp';
export type ToolServerAuthMode = 'none' | 'bearer' | 'header';
export type ToolServerAccessMode = 'admins-only' | 'all-users' | 'granted';

export interface ToolServer {
  id: string;
  name: string;
  description?: string;
  kind: ToolServerKind;
  baseUrl: string;
  specDigest?: string;
  specRevision: number;
  authMode: ToolServerAuthMode;
  authHeader?: string;
  accessMode: ToolServerAccessMode;
  enabled: boolean;
  timeoutMs: number;
  maxResponseBytes: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
}

/** OpenAPI execution mapping pinned at registration time. */
export interface OpenApiOperationDetail {
  method: string;
  path: string;
  parameters: Array<{
    name: string;
    in: 'query' | 'path' | 'header';
    required: boolean;
  }>;
  hasBody: boolean;
  bodyContentType?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON schema for the tool's arguments object. */
  paramsSchema?: Record<string, unknown>;
  sideEffect: boolean;
  enabled: boolean;
  detail?: OpenApiOperationDetail;
}

export type ToolSourceKind = 'builtin' | 'openapi' | 'mcp';

/**
 * One entry of a user's effective tool catalog for a turn. `name` is the
 * provider-visible identifier (namespaced for server tools); resolution back
 * to the executing source uses this entry, never string parsing.
 */
export interface EffectiveTool {
  name: string;
  description?: string;
  paramsSchema?: Record<string, unknown>;
  sideEffect: boolean;
  source: ToolSourceKind;
  serverId?: string;
  serverName?: string;
  /** Original tool name on the server, before namespacing. */
  toolName: string;
}

export type ToolApprovalScope = 'once' | 'session' | 'always';
export type ToolApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ToolApproval {
  id: string;
  sessionId?: string;
  serverId?: string;
  serverName?: string;
  toolName: string;
  callId?: string;
  scope: ToolApprovalScope;
  status: ToolApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  expiresAt?: number;
}

export type ChatToolCallStatus =
  | 'awaiting_approval'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled';

/** A tool call persisted on the assistant message that requested it. */
export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
  source: ToolSourceKind;
  serverId?: string;
  serverName?: string;
  sideEffect: boolean;
  status: ChatToolCallStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** Bounded result excerpt kept for display; never replayed to providers. */
  resultPreview?: string;
  isError?: boolean;
}

/** Persisted on a role:'tool' message alongside the result content. */
export interface ChatToolResultMetadata {
  toolCallId: string;
  toolName: string;
  source: ToolSourceKind;
  serverId?: string;
  isError: boolean;
  truncated: boolean;
}

/**
 * Versioned normalized chat tool events. The same payload shapes flow over
 * the private WebSocket path and the durable event gateway, so a client can
 * replay either transport into identical state.
 */
export const CHAT_TOOL_CALL_EVENT = 'chat.tool-call.v1';
export const CHAT_TOOL_RESULT_EVENT = 'chat.tool-result.v1';
export const CHAT_APPROVAL_EVENT = 'chat.approval.v1';

export interface ChatToolCallEventPayload {
  type: typeof CHAT_TOOL_CALL_EVENT;
  messageId: string;
  toolCall: ChatToolCall;
}

export interface ChatToolResultEventPayload {
  type: typeof CHAT_TOOL_RESULT_EVENT;
  messageId: string;
  toolCallId: string;
  status: ChatToolCallStatus;
  /** Bounded preview of the result; the full result is persisted. */
  preview?: string;
  isError: boolean;
}

export interface ChatApprovalEventPayload {
  type: typeof CHAT_APPROVAL_EVENT;
  messageId: string;
  approvalId: string;
  toolCall: ChatToolCall;
  expiresAt: number;
}

export type ChatToolEventPayload =
  | ChatToolCallEventPayload
  | ChatToolResultEventPayload
  | ChatApprovalEventPayload;
