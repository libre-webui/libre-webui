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
  'idle' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';

export type WorkRunStatus =
  'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  kind: 'message' | 'tool_call' | 'tool_result' | 'error';
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
}

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
  };
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
