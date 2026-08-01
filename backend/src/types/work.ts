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

export type WorkTaskStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'completed'
  | 'needs_input'
  | 'failed'
  | 'cancelled';

export type WorkRunStatus =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'completed'
  | 'needs_input'
  | 'failed'
  | 'cancelled';

export type WorkPreviewStatus = 'stopped' | 'starting' | 'running' | 'failed';

export type WorkProviderType = 'ollama' | 'plugin';

export interface WorkProviderSelection {
  providerType: WorkProviderType;
  providerId?: string;
}

export interface WorkMessage {
  id: string;
  taskId: string;
  runId?: string;
  messageIndex: number;
  role: 'user' | 'assistant' | 'tool';
  kind:
    | 'message'
    | 'reasoning'
    | 'tool_call'
    | 'tool_result'
    | 'provider_state'
    | 'error';
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

export interface WorkMessagePage {
  messages: WorkMessage[];
  cursor?: number;
  hasMore: boolean;
}

export interface WorkRun {
  id: string;
  taskId: string;
  model: string;
  providerType: WorkProviderType;
  providerId?: string;
  status: WorkRunStatus;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkTaskDetail {
  id: string;
  title: string;
  model: string;
  providerType: WorkProviderType;
  providerId?: string;
  status: WorkTaskStatus;
  networkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  messages: WorkMessage[];
  messageCursor?: number;
  hasMoreMessages: boolean;
  activeRun?: WorkRun;
  previewUrl?: string;
  previewStatus: WorkPreviewStatus;
  workspacePath: '/workspace';
  /** Host folder mounted at /workspace, when this task is bound to one. */
  hostPath?: string;
}

export type WorkLiveEventType =
  | 'snapshot'
  | 'run_state'
  | 'reasoning_delta'
  | 'assistant_delta'
  | 'tool_call'
  | 'tool_result'
  | 'usage'
  | 'skill_loaded'
  | 'error'
  | 'done';

export interface WorkLiveRunSnapshotTool {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  isError?: boolean;
  arguments?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  output?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface WorkLiveRunSnapshot {
  status?: WorkRunStatus;
  phase?: string;
  round?: number;
  roundLimit?: number;
  reasoning: string;
  response: string;
  tools: WorkLiveRunSnapshotTool[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
  };
  skills: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  terminal: boolean;
  error?: string;
  budgetReason?: string;
}

export interface WorkLiveEventDataMap {
  snapshot: {
    task: WorkTaskDetail;
    liveRun?: WorkLiveRunSnapshot;
    replayTruncated?: boolean;
  };
  run_state: {
    status: WorkRunStatus;
    round?: number;
    roundLimit?: number;
    phase?: string;
  };
  reasoning_delta: {
    delta: string;
    messageId?: string;
    total?: string;
  };
  assistant_delta: {
    delta: string;
    messageId?: string;
    total?: string;
  };
  tool_call: {
    toolCallId: string;
    name: string;
    arguments?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    phase?: 'queued' | 'running';
    message?: WorkMessage;
  };
  tool_result: {
    toolCallId: string;
    name: string;
    phase?: 'completed' | 'failed';
    content?: string;
    error?: boolean;
    message?: WorkMessage;
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    durationMs?: number;
  };
  skill_loaded: {
    id: string;
    name: string;
    description?: string;
  };
  error: {
    message: string;
    code?: string;
  };
  done: {
    status: Extract<
      WorkRunStatus,
      'completed' | 'needs_input' | 'failed' | 'cancelled'
    >;
    error?: string;
    budgetReason?: string;
  };
}

interface WorkLiveEventBase {
  id: number;
  taskId: string;
  runId: string;
  timestamp: number;
}

export type WorkLiveEvent<T extends WorkLiveEventType = WorkLiveEventType> =
  T extends WorkLiveEventType
    ? WorkLiveEventBase & {
        type: T;
        data: WorkLiveEventDataMap[T];
      }
    : never;

export type WorkTaskSummary = Omit<
  WorkTaskDetail,
  'messages' | 'messageCursor' | 'hasMoreMessages'
>;

export interface WorkFileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  updatedAt: number;
  modifiedAt: number;
}

export interface WorkCapabilities {
  available: boolean;
  runtime: 'docker';
  image: string;
  dockerAvailable: boolean;
  ollamaAvailable: boolean;
  pluginAvailable: boolean;
  runtimeImage: string;
  reason?: string;
  limits: {
    maxRounds: number;
    commandTimeoutMs: number;
    maxOutputChars: number;
    maxActiveRuntimesGlobal: number;
    maxActiveRuntimesPerUser: number;
  };
  activeRuntimes: {
    global: number;
    user: number;
  };
  terminal?: WorkTerminalCapability;
  hostWorkspaces?: WorkHostWorkspaceCapability;
}

export interface WorkHostWorkspaceCapability {
  enabled: boolean;
  roots: string[];
}

export interface WorkTerminalCapability {
  available: boolean;
  reason?: string;
  maxSessionsPerTask: number;
  idleTimeoutMs: number;
}

export interface WorkTaskRecord {
  id: string;
  userId: string;
  title: string;
  model: string;
  providerType: WorkProviderType;
  providerId?: string;
  status: WorkTaskStatus;
  networkEnabled: boolean;
  volumeName: string;
  containerName: string;
  /** Host folder bound to /workspace, when this task uses one. */
  hostPath?: string;
  previewUrl?: string;
  previewStatus: WorkPreviewStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkToolCall {
  id: string;
  thoughtSignature?: string;
  providerMetadata?: Record<string, unknown>;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}
