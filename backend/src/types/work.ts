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
  /** Named runtime policy this task runs under; absent = global defaults. */
  policyId?: string;
  /** True when this task's policy enables the Work Computer GUI session. */
  computerAvailable: boolean;
  /** Persona whose identity and instructions this task runs under. */
  personaId?: string;
  /** One-line status persisted at run completion for the agent sidebar. */
  statusBlurb?: string;
  /** True for a task the user hired as a persistent named agent. */
  isAgent: boolean;
  /** When the owner last opened this task; absent = never recorded. */
  lastSeenAt?: number;
  /** Per-task opt-in to action approvals; absent = off (policy may force). */
  approvalsEnabled?: boolean;
}

export type WorkLiveEventType =
  | 'snapshot'
  | 'run_state'
  | 'reasoning_delta'
  | 'assistant_delta'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'usage'
  | 'skill_loaded'
  | 'error'
  | 'done';

export type WorkApprovalDecisionStatus =
  'pending' | 'approved' | 'denied' | 'expired';

/** A pending (or just-resolved) approval as seen by the live run stream. */
export interface WorkLiveApproval {
  approvalId: string;
  toolCallId: string;
  name: string;
  summary?: Record<string, unknown>;
  status: WorkApprovalDecisionStatus;
  expiresAt?: number;
}

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

/** Loop telemetry: how a run spent its budget, for the run view. */
export interface WorkLoopStats {
  rounds: number;
  toolCalls: number;
  screenshots: number;
  fences: number;
  expectationsPassed: number;
  expectationsPending: number;
  stallNudges: number;
  ambiguityNudges: number;
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
  /** Loop telemetry captured from the run's terminal event. */
  loopStats?: WorkLoopStats;
  /** Approval the run is currently blocked on, when one is pending. */
  pendingApproval?: WorkLiveApproval;
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
    outcomeUnknown?: boolean;
    message?: WorkMessage;
  };
  approval: WorkLiveApproval;
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
    /** Loop telemetry: how the run spent its budget, for the run view. */
    loopStats?: WorkLoopStats;
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

export interface WorkCapabilities {
  available: boolean;
  runtime: 'docker' | 'kubernetes';
  image: string;
  runtimeAvailable: boolean;
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

/** Agent identity chosen at task creation ("hire an agent"). */
export interface WorkAgentIdentityInput {
  /** Persona to run the task under; must belong to the creating user. */
  personaId?: string;
  /** Pin the task above ad-hoc tasks as a persistent named agent. */
  isAgent?: boolean;
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
  /** Named runtime policy this task runs under; absent = global defaults. */
  policyId?: string;
  previewUrl?: string;
  previewStatus: WorkPreviewStatus;
  /** Private runtime endpoint; never serialize this record to a client. */
  previewUpstreamHost?: string;
  /** Private runtime endpoint; never serialize this record to a client. */
  previewUpstreamPort?: number;
  /** Persona whose identity and instructions this task runs under. */
  personaId?: string;
  /** One-line status persisted at run completion for the agent sidebar. */
  statusBlurb?: string;
  /** True for a task the user hired as a persistent named agent. */
  isAgent: boolean;
  /** When the owner last opened this task; absent = never recorded. */
  lastSeenAt?: number;
  /** Per-task opt-in to action approvals; absent = off (policy may force). */
  approvalsEnabled?: boolean;
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
