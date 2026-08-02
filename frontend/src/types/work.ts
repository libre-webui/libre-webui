/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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

export type WorkRunEventType =
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

export type WorkRunConnectionState =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export type WorkLiveRunPhase =
  | 'queued'
  | 'preparing'
  | 'thinking'
  | 'using_tool'
  | 'responding'
  | 'completed'
  | 'needs_input'
  | 'failed'
  | 'cancelled';

export interface WorkRunEvent {
  id: number;
  type: WorkRunEventType;
  taskId: string;
  runId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface WorkLiveToolActivity {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  arguments?: unknown;
  output?: string;
  metadata?: Record<string, unknown>;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

export type WorkLiveSegment =
  | { kind: 'reasoning'; text: string }
  | { kind: 'response'; text: string }
  | { kind: 'tool'; toolId: string };

export interface WorkRunUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  tokensPerSecond?: number;
  durationMs?: number;
}

export interface WorkRunSkill {
  id: string;
  name: string;
  description?: string;
}

export interface WorkLiveRun {
  taskId: string;
  runId: string;
  connection: WorkRunConnectionState;
  connectionError?: string;
  phase: WorkLiveRunPhase;
  lastEventId: number;
  reasoning: string;
  response: string;
  timeline: WorkLiveSegment[];
  tools: WorkLiveToolActivity[];
  usage?: WorkRunUsage;
  skills: WorkRunSkill[];
  round?: number;
  roundLimit?: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  terminal: boolean;
}

export interface WorkModelSelection {
  model: string;
  providerType: WorkProviderType;
  providerId?: string;
}

export interface WorkModelOption extends WorkModelSelection {
  key: string;
  label: string;
  remote: boolean;
}

export interface WorkCapabilities {
  available: boolean;
  runtime: 'docker';
  image: string;
  dockerAvailable?: boolean;
  ollamaAvailable?: boolean;
  pluginAvailable?: boolean;
  reason?: string;
  limits?: {
    maxRounds?: number;
    commandTimeoutMs?: number;
    maxOutputChars?: number;
    maxActiveRuntimesGlobal?: number;
    maxActiveRuntimesPerUser?: number;
  };
  terminal?: {
    available: boolean;
    reason?: string;
    maxSessionsPerTask: number;
    idleTimeoutMs: number;
  };
  activeRuntimes?: {
    global: number;
    user: number;
  };
  hostWorkspaces?: {
    enabled: boolean;
    roots: string[];
  };
}

export interface WorkMessage {
  id: string;
  taskId: string;
  runId?: string | null;
  messageIndex: number;
  role: 'user' | 'assistant' | 'tool';
  kind: 'message' | 'reasoning' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  metadata?: Record<string, unknown> | null;
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
  providerId?: string | null;
  status: WorkRunStatus;
  error?: string | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export interface WorkTaskSummary {
  id: string;
  title: string;
  model: string;
  providerType: WorkProviderType;
  providerId?: string | null;
  status: WorkTaskStatus;
  networkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  activeRun?: WorkRun | null;
  previewUrl?: string | null;
  previewStatus: WorkPreviewStatus;
  workspacePath: '/workspace';
  /** Host folder mounted at /workspace, when this task is bound to one. */
  hostPath?: string | null;
}

export interface WorkTask extends WorkTaskSummary {
  messages: WorkMessage[];
  messageCursor?: number;
  hasMoreMessages: boolean;
}

export interface WorkFileEntry {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  updatedAt?: number;
}

export interface WorkFile {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  updatedAt?: number;
}

export interface WorkGitChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  staged: boolean;
}

export interface WorkGitCommit {
  hash: string;
  shortHash: string;
  author: string;
  authoredAt: string;
  subject: string;
}

export interface WorkGitStatus {
  initialized: boolean;
  branch?: string;
  detached: boolean;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: WorkGitChange[];
  branches: string[];
  commits: WorkGitCommit[];
}

export interface WorkGitDiff {
  path?: string;
  patch: string;
  truncated: boolean;
}

export interface CreateWorkTaskRequest {
  message: string;
  model: string;
  providerType: WorkProviderType;
  providerId?: string;
  networkEnabled: boolean;
  /** Absolute host folder to bind as the workspace, when enabled server-side. */
  hostPath?: string;
}

export interface StartWorkRunRequest {
  message: string;
  model: string;
  providerType: WorkProviderType;
  providerId?: string;
}

export interface UpdateWorkTaskRequest {
  title?: string;
  model?: string;
  providerType?: WorkProviderType;
  providerId?: string;
  networkEnabled?: boolean;
}

export const isWorkTaskActive = (task: Pick<WorkTask, 'status'>): boolean =>
  task.status === 'preparing' || task.status === 'running';

export const workModelSelectionKey = (
  selection: WorkModelSelection
): string => {
  const model = encodeURIComponent(selection.model);
  return selection.providerType === 'plugin'
    ? `plugin:${encodeURIComponent(selection.providerId || '')}:${model}`
    : `ollama:${model}`;
};
