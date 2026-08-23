/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import { createSQLiteSyncExecutor } from '../../persistence/sqliteSyncExecutor.js';
import type { WorkPreviewStatus, WorkTaskStatus } from '../../types/work.js';
import {
  WorkPersistenceError,
  type CreateWorkRunBundle,
  type CreateWorkTaskBundle,
  type WorkAdmissionLimits,
  type WorkMessageRow,
  type WorkPersistenceRepository,
  type WorkPolicyRow,
  type WorkRunRow,
  type WorkTaskRow,
  type WorkTaskUpdate,
} from './types.js';
import type { TransactionalWorkExecutionEnqueuer } from './workExecutionTypes.js';

const ACTIVE_PREVIEWS = ['starting', 'running'] as const;

const uniqueConflict = (error: unknown): boolean =>
  error instanceof Error && /(?:UNIQUE|SQLITE_CONSTRAINT)/i.test(error.message);

export class SQLiteWorkPersistence implements WorkPersistenceRepository {
  constructor(private readonly database: Database.Database) {}

  private assertUserCanUseWork(userId: string): void {
    const row = this.database
      .prepare(
        `SELECT users.role, users.account_status,
                COALESCE((SELECT value FROM system_settings
                           WHERE key = 'work_access_mode'), 'admins') AS access_mode
           FROM users WHERE users.id = ?`
      )
      .get(userId) as
      { role: string; account_status: string; access_mode: string } | undefined;
    if (
      row?.account_status !== 'active' ||
      (row.role !== 'admin' && row.access_mode !== 'all-users') ||
      row.access_mode === 'disabled'
    ) {
      throw new WorkPersistenceError({ code: 'WORK_USER_FORBIDDEN' });
    }
  }

  private assertTaskAdmission(
    userId: string,
    limits: WorkAdmissionLimits
  ): void {
    const counts = this.database
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END), 0) AS per_user
           FROM work_tasks`
      )
      .get(userId) as { total: number; per_user: number };
    if (counts.per_user >= limits.maxTasksPerUser) {
      throw new WorkPersistenceError({ code: 'WORK_USER_TASK_LIMIT' });
    }
    if (counts.total >= limits.maxTasksGlobal) {
      throw new WorkPersistenceError({ code: 'WORK_GLOBAL_TASK_LIMIT' });
    }
  }

  private assertRuntimeAdmission(
    userId: string,
    limits: WorkAdmissionLimits,
    excludedTaskId?: string
  ): void {
    const counts = this.database
      .prepare(
        `WITH active_tasks AS (
           SELECT DISTINCT work_tasks.id AS task_id, work_tasks.user_id
             FROM work_tasks
             JOIN work_runs ON work_runs.task_id = work_tasks.id
            WHERE work_runs.status IN ('queued', 'preparing', 'running')
           UNION
           SELECT id AS task_id, user_id
             FROM work_tasks
            WHERE preview_status IN ('starting', 'running')
         )
         SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END), 0) AS per_user
           FROM active_tasks
          WHERE ? IS NULL OR task_id != ?`
      )
      .get(userId, excludedTaskId || null, excludedTaskId || null) as {
      total: number;
      per_user: number;
    };
    if (counts.per_user >= limits.maxActiveRuntimesPerUser) {
      throw new WorkPersistenceError({ code: 'WORK_USER_RUNTIME_LIMIT' });
    }
    if (counts.total >= limits.maxActiveRuntimesGlobal) {
      throw new WorkPersistenceError({ code: 'WORK_GLOBAL_RUNTIME_LIMIT' });
    }
  }

  async createTaskWithRun(
    input: CreateWorkTaskBundle,
    enqueuer: TransactionalWorkExecutionEnqueuer
  ): Promise<void> {
    this.database
      .transaction(() => {
        this.assertUserCanUseWork(input.task.user_id);
        this.assertTaskAdmission(input.task.user_id, input.limits);
        this.assertRuntimeAdmission(input.task.user_id, input.limits);
        this.database
          .prepare(
            `INSERT INTO work_tasks (
             id, user_id, title, model, provider_type, provider_id, status,
             network_enabled, volume_name, container_name, host_path, policy_id,
             preview_url, preview_status, preview_upstream_host,
             preview_upstream_port, persona_id, status_blurb, is_agent,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            input.task.id,
            input.task.user_id,
            input.task.title,
            input.task.model,
            input.task.provider_type,
            input.task.provider_id,
            input.task.status,
            input.task.network_enabled,
            input.task.volume_name,
            input.task.container_name,
            input.task.host_path,
            input.task.policy_id,
            input.task.preview_url,
            input.task.preview_status,
            input.task.preview_upstream_host,
            input.task.preview_upstream_port,
            input.task.persona_id,
            input.task.status_blurb,
            input.task.is_agent,
            input.task.created_at,
            input.task.updated_at
          );
        this.insertRunSync(input.run);
        this.insertMessageSync(input.message);
        enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), {
          actorUserId: input.task.user_id,
          taskId: input.task.id,
          runId: input.run.id,
        });
      })
      .immediate();
  }

  async createRun(
    input: CreateWorkRunBundle,
    enqueuer: TransactionalWorkExecutionEnqueuer
  ): Promise<void> {
    this.database
      .transaction(() => {
        this.assertUserCanUseWork(input.userId);
        const task = this.database
          .prepare('SELECT * FROM work_tasks WHERE id = ? AND user_id = ?')
          .get(input.taskId, input.userId) as WorkTaskRow | undefined;
        if (!task)
          throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
        if (this.findActiveRunSync(input.taskId)) {
          throw new WorkPersistenceError({ code: 'WORK_ACTIVE_RUN' });
        }
        if (
          ACTIVE_PREVIEWS.includes(
            task.preview_status as (typeof ACTIVE_PREVIEWS)[number]
          )
        ) {
          throw new WorkPersistenceError({ code: 'WORK_PREVIEW_ACTIVE' });
        }
        this.assertRuntimeAdmission(input.userId, input.limits, input.taskId);
        const next = this.nextMessageIndexSync(input.taskId);
        this.insertRunSync(input.run);
        this.insertMessageSync({ ...input.message, message_index: next });
        this.database
          .prepare(
            `UPDATE work_tasks
              SET model = ?, provider_type = ?, provider_id = ?,
                  status = 'preparing', updated_at = ?
            WHERE id = ? AND user_id = ?`
          )
          .run(
            input.run.model,
            input.run.provider_type,
            input.run.provider_id,
            input.run.created_at,
            input.taskId,
            input.userId
          );
        enqueuer.enqueueSQLite(createSQLiteSyncExecutor(this.database), {
          actorUserId: input.userId,
          taskId: input.taskId,
          runId: input.run.id,
        });
      })
      .immediate();
  }

  async listTasks(userId: string): Promise<WorkTaskRow[]> {
    return this.database
      .prepare(
        'SELECT * FROM work_tasks WHERE user_id = ? ORDER BY updated_at DESC'
      )
      .all(userId) as WorkTaskRow[];
  }

  async listTaskRecords(userId?: string): Promise<WorkTaskRow[]> {
    return (
      userId
        ? this.database
            .prepare(
              'SELECT * FROM work_tasks WHERE user_id = ? ORDER BY created_at ASC'
            )
            .all(userId)
        : this.database
            .prepare('SELECT * FROM work_tasks ORDER BY created_at ASC')
            .all()
    ) as WorkTaskRow[];
  }

  async listTasksWithOwners(): Promise<
    Array<WorkTaskRow & { owner_username: string }>
  > {
    return this.database
      .prepare(
        `SELECT work_tasks.*, users.username AS owner_username
           FROM work_tasks JOIN users ON users.id = work_tasks.user_id
          ORDER BY work_tasks.updated_at DESC`
      )
      .all() as Array<WorkTaskRow & { owner_username: string }>;
  }

  async findTask(
    taskId: string,
    userId: string
  ): Promise<WorkTaskRow | undefined> {
    return this.database
      .prepare('SELECT * FROM work_tasks WHERE id = ? AND user_id = ?')
      .get(taskId, userId) as WorkTaskRow | undefined;
  }

  async userCanUseWork(userId: string): Promise<boolean> {
    try {
      this.assertUserCanUseWork(userId);
      return true;
    } catch (error) {
      if (
        error instanceof WorkPersistenceError &&
        error.code === 'WORK_USER_FORBIDDEN'
      ) {
        return false;
      }
      throw error;
    }
  }

  async updateTask(input: WorkTaskUpdate): Promise<void> {
    this.database
      .transaction(() => {
        const current = this.database
          .prepare('SELECT * FROM work_tasks WHERE id = ? AND user_id = ?')
          .get(input.taskId, input.userId) as WorkTaskRow | undefined;
        if (!current)
          throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
        const networkChanged =
          Boolean(current.network_enabled) !== input.networkEnabled;
        if (networkChanged && this.findActiveRunSync(input.taskId)) {
          throw new WorkPersistenceError({ code: 'WORK_ACTIVE_RUN' });
        }
        this.database
          .prepare(
            `UPDATE work_tasks
              SET title = ?, model = ?, provider_type = ?, provider_id = ?,
                  network_enabled = ?,
                  preview_status = CASE WHEN ? = 1 THEN 'stopped' ELSE preview_status END,
                  preview_url = CASE WHEN ? = 1 THEN NULL ELSE preview_url END,
                  preview_upstream_host = CASE WHEN ? = 1 THEN NULL ELSE preview_upstream_host END,
                  preview_upstream_port = CASE WHEN ? = 1 THEN NULL ELSE preview_upstream_port END,
                  updated_at = ?
            WHERE id = ? AND user_id = ?`
          )
          .run(
            input.title,
            input.model,
            input.providerType,
            input.providerId,
            input.networkEnabled ? 1 : 0,
            input.requireNetworkChangeLease && networkChanged ? 1 : 0,
            input.requireNetworkChangeLease && networkChanged ? 1 : 0,
            input.requireNetworkChangeLease && networkChanged ? 1 : 0,
            input.requireNetworkChangeLease && networkChanged ? 1 : 0,
            input.updatedAt,
            input.taskId,
            input.userId
          );
      })
      .immediate();
  }

  async deleteTask(taskId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM work_tasks WHERE id = ? AND user_id = ?')
        .run(taskId, userId).changes === 1
    );
  }

  async beginPreview(input: {
    taskId: string;
    userId: string;
    allowActiveRun: boolean;
    limits: WorkAdmissionLimits;
    updatedAt: number;
  }): Promise<void> {
    this.database
      .transaction(() => {
        this.assertUserCanUseWork(input.userId);
        const task = this.database
          .prepare('SELECT * FROM work_tasks WHERE id = ? AND user_id = ?')
          .get(input.taskId, input.userId) as WorkTaskRow | undefined;
        if (!task)
          throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
        if (!input.allowActiveRun && this.findActiveRunSync(input.taskId)) {
          throw new WorkPersistenceError({ code: 'WORK_ACTIVE_RUN' });
        }
        this.assertRuntimeAdmission(input.userId, input.limits, input.taskId);
        if (
          !ACTIVE_PREVIEWS.includes(
            task.preview_status as (typeof ACTIVE_PREVIEWS)[number]
          )
        ) {
          this.database
            .prepare(
              `UPDATE work_tasks
                SET preview_status = 'starting', preview_url = NULL,
                    preview_upstream_host = NULL, preview_upstream_port = NULL,
                    updated_at = ?
              WHERE id = ? AND user_id = ?`
            )
            .run(input.updatedAt, input.taskId, input.userId);
        }
      })
      .immediate();
  }

  async insertMessage(
    row: Omit<WorkMessageRow, 'message_index'>
  ): Promise<number> {
    return this.database
      .transaction(() => {
        const index = this.nextMessageIndexSync(row.task_id);
        this.insertMessageSync({ ...row, message_index: index });
        this.database
          .prepare('UPDATE work_tasks SET updated_at = ? WHERE id = ?')
          .run(row.created_at, row.task_id);
        return index;
      })
      .immediate();
  }

  async listMessages(input: {
    taskId: string;
    mode: 'all' | 'conversation' | 'model-context' | 'page';
    limit?: number;
    before?: number;
  }): Promise<WorkMessageRow[]> {
    const columns =
      'id, task_id, run_id, message_index, role, kind, content, metadata, created_at';
    if (input.mode === 'all') {
      return this.database
        .prepare(
          `SELECT ${columns} FROM work_messages
            WHERE task_id = ? AND kind <> 'provider_state'
            ORDER BY message_index ASC`
        )
        .all(input.taskId) as WorkMessageRow[];
    }
    if (input.mode === 'conversation') {
      return this.database
        .prepare(
          `SELECT ${columns} FROM work_messages
            WHERE task_id = ? AND kind = 'message'
              AND role IN ('user', 'assistant')
            ORDER BY message_index DESC LIMIT ?`
        )
        .all(input.taskId, input.limit) as WorkMessageRow[];
    }
    if (input.mode === 'model-context') {
      return this.database
        .prepare(
          `SELECT ${columns} FROM work_messages
            WHERE task_id = ? AND (
              (kind = 'message' AND role IN ('user', 'assistant'))
              OR (kind = 'provider_state' AND role = 'assistant')
              OR (kind = 'tool_result' AND role = 'tool')
            ) ORDER BY message_index DESC LIMIT ?`
        )
        .all(input.taskId, input.limit) as WorkMessageRow[];
    }
    return (
      input.before === undefined
        ? this.database
            .prepare(
              `SELECT ${columns} FROM work_messages
              WHERE task_id = ? AND kind <> 'provider_state'
              ORDER BY message_index DESC LIMIT ?`
            )
            .all(input.taskId, input.limit)
        : this.database
            .prepare(
              `SELECT ${columns} FROM work_messages
              WHERE task_id = ? AND message_index < ? AND kind <> 'provider_state'
              ORDER BY message_index DESC LIMIT ?`
            )
            .all(input.taskId, input.before, input.limit)
    ) as WorkMessageRow[];
  }

  async findRun(runId: string): Promise<WorkRunRow | undefined> {
    return this.database
      .prepare('SELECT * FROM work_runs WHERE id = ?')
      .get(runId) as WorkRunRow | undefined;
  }

  async findActiveRun(taskId: string): Promise<WorkRunRow | undefined> {
    return this.findActiveRunSync(taskId);
  }

  async updateRun(input: {
    runId: string;
    status: WorkRunRow['status'];
    error: string | null;
    started: boolean;
    finished: boolean;
    now: number;
  }): Promise<void> {
    this.database
      .prepare(
        `UPDATE work_runs SET status = ?, error = ?,
          started_at = CASE WHEN ? = 1 THEN COALESCE(started_at, ?) ELSE started_at END,
          finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
          WHERE id = ?`
      )
      .run(
        input.status,
        input.error,
        input.started ? 1 : 0,
        input.now,
        input.finished ? 1 : 0,
        input.now,
        input.runId
      );
  }

  async updateTaskStatus(
    taskId: string,
    status: WorkTaskStatus,
    now: number,
    statusBlurb?: string | null
  ): Promise<void> {
    if (statusBlurb === undefined) {
      this.database
        .prepare(
          'UPDATE work_tasks SET status = ?, updated_at = ? WHERE id = ?'
        )
        .run(status, now, taskId);
      return;
    }
    this.database
      .prepare(
        'UPDATE work_tasks SET status = ?, status_blurb = ?, updated_at = ? WHERE id = ?'
      )
      .run(status, statusBlurb, now, taskId);
  }

  async updatePreview(
    taskId: string,
    status: WorkPreviewStatus,
    previewUrl: string | null,
    upstreamHost: string | null,
    upstreamPort: number | null,
    now: number
  ): Promise<void> {
    this.database
      .prepare(
        `UPDATE work_tasks
            SET preview_status = ?, preview_url = ?,
                preview_upstream_host = ?, preview_upstream_port = ?,
                updated_at = ?
          WHERE id = ?`
      )
      .run(status, previewUrl, upstreamHost, upstreamPort, now, taskId);
  }

  async recoverOnStartup(now: number): Promise<{
    tasks: WorkTaskRow[];
    interruptedRuns: number;
    activePreviews: number;
    persistenceError?: unknown;
  }> {
    const tasks = this.database
      .prepare('SELECT * FROM work_tasks')
      .all() as WorkTaskRow[];
    const interruptedRuns = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM work_runs
            WHERE status IN ('queued', 'preparing', 'running')`
        )
        .get() as { count: number }
    ).count;
    const activePreviews = (
      this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM work_tasks
            WHERE preview_status IN ('starting', 'running')`
        )
        .get() as { count: number }
    ).count;
    try {
      this.database
        .transaction(() => {
          this.database
            .prepare(
              `UPDATE work_tasks SET status = 'failed', updated_at = ?
              WHERE status IN ('preparing', 'running') OR id IN (
                SELECT task_id FROM work_runs
                 WHERE status IN ('queued', 'preparing', 'running')
              )`
            )
            .run(now);
          this.database
            .prepare(
              `UPDATE work_tasks
                SET preview_status = 'stopped', preview_url = NULL,
                    preview_upstream_host = NULL, preview_upstream_port = NULL,
                    updated_at = ?
              WHERE preview_status != 'stopped' OR preview_url IS NOT NULL
                 OR preview_upstream_host IS NOT NULL
                 OR preview_upstream_port IS NOT NULL`
            )
            .run(now);
          this.database
            .prepare(
              `UPDATE work_runs SET status = 'failed',
                error = 'Backend restarted while this run was active.', finished_at = ?
              WHERE status IN ('queued', 'preparing', 'running')`
            )
            .run(now);
        })
        .immediate();
      return { tasks, interruptedRuns, activePreviews };
    } catch (persistenceError) {
      return { tasks, interruptedRuns, activePreviews, persistenceError };
    }
  }

  async listPolicies(): Promise<WorkPolicyRow[]> {
    return this.database
      .prepare('SELECT * FROM work_policies ORDER BY name ASC')
      .all() as WorkPolicyRow[];
  }

  async findPolicy(id: string): Promise<WorkPolicyRow | undefined> {
    return this.database
      .prepare('SELECT * FROM work_policies WHERE id = ?')
      .get(id) as WorkPolicyRow | undefined;
  }

  async insertPolicy(row: WorkPolicyRow): Promise<void> {
    try {
      this.database
        .prepare(
          `INSERT INTO work_policies (
             id, name, image, memory_limit, cpu_limit, pids_limit,
             network_default, workspace_size, idle_timeout_ms, gui_enabled,
             takeover_enabled, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(...this.policyValues(row));
    } catch (error) {
      if (uniqueConflict(error)) {
        throw new WorkPersistenceError({ code: 'WORK_POLICY_NAME_CONFLICT' });
      }
      throw error;
    }
  }

  async updatePolicy(row: WorkPolicyRow): Promise<boolean> {
    try {
      return (
        this.database
          .prepare(
            `UPDATE work_policies SET name = ?, image = ?, memory_limit = ?,
               cpu_limit = ?, pids_limit = ?, network_default = ?,
               workspace_size = ?, idle_timeout_ms = ?, gui_enabled = ?,
               takeover_enabled = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            row.name,
            row.image,
            row.memory_limit,
            row.cpu_limit,
            row.pids_limit,
            row.network_default,
            row.workspace_size,
            row.idle_timeout_ms,
            row.gui_enabled,
            row.takeover_enabled,
            row.updated_at,
            row.id
          ).changes === 1
      );
    } catch (error) {
      if (uniqueConflict(error)) {
        throw new WorkPersistenceError({ code: 'WORK_POLICY_NAME_CONFLICT' });
      }
      throw error;
    }
  }

  async deletePolicy(id: string): Promise<boolean> {
    return this.database
      .transaction(() => {
        this.database
          .prepare('UPDATE work_tasks SET policy_id = NULL WHERE policy_id = ?')
          .run(id);
        return (
          this.database
            .prepare('DELETE FROM work_policies WHERE id = ?')
            .run(id).changes === 1
        );
      })
      .immediate();
  }

  async anyIdleTimeoutConfigured(): Promise<boolean> {
    return (
      this.database
        .prepare(
          'SELECT 1 FROM work_policies WHERE idle_timeout_ms > 0 LIMIT 1'
        )
        .get() !== undefined
    );
  }

  async findPreview(
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
  > {
    return this.database
      .prepare(
        `SELECT preview_status, preview_url, preview_upstream_host,
                preview_upstream_port
           FROM work_tasks WHERE id = ?`
      )
      .get(taskId) as
      | Pick<
          WorkTaskRow,
          | 'preview_status'
          | 'preview_url'
          | 'preview_upstream_host'
          | 'preview_upstream_port'
        >
      | undefined;
  }

  async findTaskOwnerAccess(
    taskId: string,
    userId: string
  ): Promise<{ role: string; status: string } | undefined> {
    return this.database
      .prepare(
        `SELECT users.role AS role, users.account_status AS status
           FROM work_tasks JOIN users ON users.id = work_tasks.user_id
          WHERE work_tasks.id = ? AND work_tasks.user_id = ?`
      )
      .get(taskId, userId) as { role: string; status: string } | undefined;
  }

  async taskStillOwnsResources(input: {
    taskId: string;
    userId: string;
    volumeName: string;
    containerName: string;
  }): Promise<boolean> {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM work_tasks
            WHERE id = ? AND user_id = ? AND volume_name = ? AND container_name = ?`
        )
        .get(
          input.taskId,
          input.userId,
          input.volumeName,
          input.containerName
        ) !== undefined
    );
  }

  private findActiveRunSync(taskId: string): WorkRunRow | undefined {
    return this.database
      .prepare(
        `SELECT * FROM work_runs WHERE task_id = ?
          AND status IN ('queued', 'preparing', 'running')
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(taskId) as WorkRunRow | undefined;
  }

  private nextMessageIndexSync(taskId: string): number {
    return (
      this.database
        .prepare(
          'SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index FROM work_messages WHERE task_id = ?'
        )
        .get(taskId) as { next_index: number }
    ).next_index;
  }

  private insertRunSync(row: WorkRunRow): void {
    this.database
      .prepare(
        `INSERT INTO work_runs (
           id, task_id, model, provider_type, provider_id, status, error,
           created_at, started_at, finished_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.task_id,
        row.model,
        row.provider_type,
        row.provider_id,
        row.status,
        row.error,
        row.created_at,
        row.started_at,
        row.finished_at
      );
  }

  private insertMessageSync(row: WorkMessageRow): void {
    this.database
      .prepare(
        `INSERT INTO work_messages (
           id, task_id, run_id, role, kind, content, metadata, message_index, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.task_id,
        row.run_id,
        row.role,
        row.kind,
        row.content,
        row.metadata,
        row.message_index,
        row.created_at
      );
  }

  private policyValues(row: WorkPolicyRow): unknown[] {
    return [
      row.id,
      row.name,
      row.image,
      row.memory_limit,
      row.cpu_limit,
      row.pids_limit,
      row.network_default,
      row.workspace_size,
      row.idle_timeout_ms,
      row.gui_enabled,
      row.takeover_enabled,
      row.created_at,
      row.updated_at,
    ];
  }
}
