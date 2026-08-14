/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type {
  WorkMessage,
  WorkPreviewStatus,
  WorkProviderType,
  WorkRunStatus,
  WorkTaskStatus,
} from '../../types/work.js';
import type { TransactionalWorkExecutionEnqueuer } from './workExecutionTypes.js';

export interface WorkTaskRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  provider_type: WorkProviderType;
  provider_id: string | null;
  status: WorkTaskStatus;
  network_enabled: number;
  volume_name: string;
  container_name: string;
  host_path: string | null;
  policy_id: string | null;
  preview_url: string | null;
  preview_status: WorkPreviewStatus;
  preview_upstream_host: string | null;
  preview_upstream_port: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkRunRow {
  id: string;
  task_id: string;
  model: string;
  provider_type: WorkProviderType;
  provider_id: string | null;
  status: WorkRunStatus;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface WorkMessageRow {
  id: string;
  task_id: string;
  run_id: string | null;
  message_index: number;
  role: WorkMessage['role'];
  kind: WorkMessage['kind'];
  content: string;
  metadata: string | null;
  created_at: number;
}

export interface WorkPolicyRow {
  id: string;
  name: string;
  image: string | null;
  memory_limit: string | null;
  cpu_limit: string | null;
  pids_limit: number | null;
  network_default: number | null;
  workspace_size: string | null;
  idle_timeout_ms: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkAdmissionLimits {
  maxActiveRuntimesGlobal: number;
  maxActiveRuntimesPerUser: number;
  maxTasksGlobal: number;
  maxTasksPerUser: number;
}

export interface CreateWorkTaskBundle {
  task: WorkTaskRow;
  run: WorkRunRow;
  message: WorkMessageRow;
  limits: WorkAdmissionLimits;
}

export interface CreateWorkRunBundle {
  taskId: string;
  userId: string;
  run: WorkRunRow;
  message: WorkMessageRow;
  limits: WorkAdmissionLimits;
}

export interface WorkTaskUpdate {
  taskId: string;
  userId: string;
  title: string;
  model: string;
  providerType: WorkProviderType;
  providerId: string | null;
  networkEnabled: boolean;
  updatedAt: number;
  requireNetworkChangeLease?: boolean;
}

export interface WorkPersistenceErrorOptions {
  code:
    | 'WORK_USER_FORBIDDEN'
    | 'WORK_USER_TASK_LIMIT'
    | 'WORK_GLOBAL_TASK_LIMIT'
    | 'WORK_USER_RUNTIME_LIMIT'
    | 'WORK_GLOBAL_RUNTIME_LIMIT'
    | 'WORK_ACTIVE_RUN'
    | 'WORK_PREVIEW_ACTIVE'
    | 'WORK_TASK_NOT_FOUND'
    | 'WORK_POLICY_NAME_CONFLICT'
    | 'WORK_POLICY_NOT_FOUND';
  detail?: string;
}

export class WorkPersistenceError extends Error {
  readonly code: WorkPersistenceErrorOptions['code'];

  constructor(options: WorkPersistenceErrorOptions) {
    super(options.detail || options.code);
    this.name = 'WorkPersistenceError';
    this.code = options.code;
  }
}

export interface WorkPersistenceRepository {
  createTaskWithRun(
    input: CreateWorkTaskBundle,
    enqueuer: TransactionalWorkExecutionEnqueuer
  ): Promise<void>;
  createRun(
    input: CreateWorkRunBundle,
    enqueuer: TransactionalWorkExecutionEnqueuer
  ): Promise<void>;
  listTasks(userId: string): Promise<WorkTaskRow[]>;
  listTaskRecords(userId?: string): Promise<WorkTaskRow[]>;
  listTasksWithOwners(): Promise<
    Array<WorkTaskRow & { owner_username: string }>
  >;
  findTask(taskId: string, userId: string): Promise<WorkTaskRow | undefined>;
  userCanUseWork(userId: string): Promise<boolean>;
  updateTask(input: WorkTaskUpdate): Promise<void>;
  deleteTask(taskId: string, userId: string): Promise<boolean>;
  beginPreview(input: {
    taskId: string;
    userId: string;
    allowActiveRun: boolean;
    limits: WorkAdmissionLimits;
    updatedAt: number;
  }): Promise<void>;
  insertMessage(row: Omit<WorkMessageRow, 'message_index'>): Promise<number>;
  listMessages(input: {
    taskId: string;
    mode: 'all' | 'conversation' | 'model-context' | 'page';
    limit?: number;
    before?: number;
  }): Promise<WorkMessageRow[]>;
  findRun(runId: string): Promise<WorkRunRow | undefined>;
  findActiveRun(taskId: string): Promise<WorkRunRow | undefined>;
  updateRun(input: {
    runId: string;
    status: WorkRunStatus;
    error: string | null;
    started: boolean;
    finished: boolean;
    now: number;
  }): Promise<void>;
  updateTaskStatus(
    taskId: string,
    status: WorkTaskStatus,
    now: number
  ): Promise<void>;
  updatePreview(
    taskId: string,
    status: WorkPreviewStatus,
    previewUrl: string | null,
    upstreamHost: string | null,
    upstreamPort: number | null,
    now: number
  ): Promise<void>;
  recoverOnStartup(now: number): Promise<{
    tasks: WorkTaskRow[];
    interruptedRuns: number;
    activePreviews: number;
    persistenceError?: unknown;
  }>;
  listPolicies(): Promise<WorkPolicyRow[]>;
  findPolicy(id: string): Promise<WorkPolicyRow | undefined>;
  insertPolicy(row: WorkPolicyRow): Promise<void>;
  updatePolicy(row: WorkPolicyRow): Promise<boolean>;
  deletePolicy(id: string): Promise<boolean>;
  anyIdleTimeoutConfigured(): Promise<boolean>;
  findPreview(
    taskId: string
  ): Promise<
    | Pick<
        WorkTaskRow,
        | 'preview_status'
        | 'preview_url'
        | 'preview_upstream_host'
        | 'preview_upstream_port'
      >
    | undefined
  >;
  findTaskOwnerAccess(
    taskId: string,
    userId: string
  ): Promise<{ role: string; status: string } | undefined>;
  taskStillOwnsResources(input: {
    taskId: string;
    userId: string;
    volumeName: string;
    containerName: string;
  }): Promise<boolean>;
}
