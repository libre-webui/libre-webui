/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { QueryResultRow } from 'pg';
import type {
  PostgresDatabase,
  PostgresQueryExecutor,
} from '../../persistence/postgresDatabase.js';
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
import {
  decodePostgresWorkMessageContent,
  encodePostgresWorkMessageContent,
} from './workMessageContentCodec.js';
import { replaceWorkTextNul } from './workTextSafety.js';

type StoredTaskRow = QueryResultRow &
  Omit<
    WorkTaskRow,
    | 'network_enabled'
    | 'preview_upstream_port'
    | 'is_agent'
    | 'last_seen_at'
    | 'created_at'
    | 'updated_at'
  > & {
    network_enabled: number | string;
    preview_upstream_port: number | string | null;
    is_agent: number | string | null;
    last_seen_at: number | string | null;
    created_at: number | string;
    updated_at: number | string;
  };
type StoredRunRow = QueryResultRow &
  Omit<WorkRunRow, 'created_at' | 'started_at' | 'finished_at'> & {
    created_at: number | string;
    started_at: number | string | null;
    finished_at: number | string | null;
  };
type StoredMessageRow = QueryResultRow &
  Omit<WorkMessageRow, 'message_index' | 'created_at'> & {
    message_index: number | string;
    created_at: number | string;
  };
type StoredPolicyRow = QueryResultRow &
  Omit<
    WorkPolicyRow,
    | 'pids_limit'
    | 'network_default'
    | 'idle_timeout_ms'
    | 'created_at'
    | 'updated_at'
  > & {
    pids_limit: number | string | null;
    network_default: number | string | null;
    idle_timeout_ms: number | string | null;
    created_at: number | string;
    updated_at: number | string;
  };

const integer = (value: string | number, field: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`Invalid PostgreSQL Work ${field}`);
  return parsed;
};
const nullableInteger = (
  value: string | number | null,
  field: string
): number | null => (value === null ? null : integer(value, field));
const taskRow = (row: StoredTaskRow): WorkTaskRow => ({
  ...row,
  network_enabled: integer(row.network_enabled, 'network flag'),
  preview_upstream_port: nullableInteger(
    row.preview_upstream_port,
    'preview upstream port'
  ),
  is_agent: nullableInteger(row.is_agent, 'agent flag'),
  last_seen_at: nullableInteger(row.last_seen_at, 'seen time'),
  created_at: integer(row.created_at, 'created time'),
  updated_at: integer(row.updated_at, 'updated time'),
});
const runRow = (row: StoredRunRow): WorkRunRow => ({
  ...row,
  created_at: integer(row.created_at, 'run created time'),
  started_at: nullableInteger(row.started_at, 'run started time'),
  finished_at: nullableInteger(row.finished_at, 'run finished time'),
});
const messageRow = (row: StoredMessageRow): WorkMessageRow => {
  return {
    ...row,
    content: decodePostgresWorkMessageContent(row.content),
    message_index: integer(row.message_index, 'message index'),
    created_at: integer(row.created_at, 'message created time'),
  };
};
const policyRow = (row: StoredPolicyRow): WorkPolicyRow => ({
  ...row,
  pids_limit: nullableInteger(row.pids_limit, 'policy pids limit'),
  network_default: nullableInteger(
    row.network_default,
    'policy network default'
  ),
  idle_timeout_ms: nullableInteger(row.idle_timeout_ms, 'policy idle timeout'),
  created_at: integer(row.created_at, 'policy created time'),
  updated_at: integer(row.updated_at, 'policy updated time'),
});

const isUniqueViolation = (error: unknown): boolean =>
  Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: string }).code === '23505'
  );

export class PostgresWorkPersistence implements WorkPersistenceRepository {
  constructor(private readonly database: PostgresDatabase) {}

  private async lockAdmission(executor: PostgresQueryExecutor): Promise<void> {
    await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      'libre:webui:work-admission:v1',
    ]);
  }

  private async assertUserCanUseWork(
    executor: PostgresQueryExecutor,
    userId: string
  ): Promise<void> {
    const result = await executor.query<{ role: string } & QueryResultRow>(
      `SELECT users.role, users.account_status,
              COALESCE((SELECT value FROM system_settings
                         WHERE key = 'work_access_mode'), 'admins') AS access_mode
         FROM users WHERE users.id = $1`,
      [userId]
    );
    const row = result.rows[0] as
      { role: string; account_status: string; access_mode: string } | undefined;
    if (
      row?.account_status !== 'active' ||
      (row.role !== 'admin' && row.access_mode !== 'all-users') ||
      row.access_mode === 'disabled'
    ) {
      throw new WorkPersistenceError({ code: 'WORK_USER_FORBIDDEN' });
    }
  }

  private async assertTaskAdmission(
    executor: PostgresQueryExecutor,
    userId: string,
    limits: WorkAdmissionLimits
  ): Promise<void> {
    const result = await executor.query<
      { total: string; per_user: string } & QueryResultRow
    >(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE user_id = $1)::text AS per_user
         FROM work_tasks`,
      [userId]
    );
    const total = integer(result.rows[0]?.total || '0', 'task count');
    const perUser = integer(result.rows[0]?.per_user || '0', 'user task count');
    if (perUser >= limits.maxTasksPerUser) {
      throw new WorkPersistenceError({ code: 'WORK_USER_TASK_LIMIT' });
    }
    if (total >= limits.maxTasksGlobal) {
      throw new WorkPersistenceError({ code: 'WORK_GLOBAL_TASK_LIMIT' });
    }
  }

  private async assertRuntimeAdmission(
    executor: PostgresQueryExecutor,
    userId: string,
    limits: WorkAdmissionLimits,
    excludedTaskId?: string
  ): Promise<void> {
    const result = await executor.query<
      { total: string; per_user: string } & QueryResultRow
    >(
      `WITH active_tasks AS (
         SELECT DISTINCT work_tasks.id AS task_id, work_tasks.user_id
           FROM work_tasks JOIN work_runs ON work_runs.task_id = work_tasks.id
          WHERE work_runs.status IN ('queued', 'preparing', 'running')
         UNION
         SELECT id AS task_id, user_id FROM work_tasks
          WHERE preview_status IN ('starting', 'running')
       )
       SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE user_id = $1)::text AS per_user
         FROM active_tasks WHERE $2::text IS NULL OR task_id <> $2`,
      [userId, excludedTaskId || null]
    );
    const total = integer(result.rows[0]?.total || '0', 'active runtime count');
    const perUser = integer(
      result.rows[0]?.per_user || '0',
      'active user runtime count'
    );
    if (perUser >= limits.maxActiveRuntimesPerUser) {
      throw new WorkPersistenceError({ code: 'WORK_USER_RUNTIME_LIMIT' });
    }
    if (total >= limits.maxActiveRuntimesGlobal) {
      throw new WorkPersistenceError({ code: 'WORK_GLOBAL_RUNTIME_LIMIT' });
    }
  }

  async createTaskWithRun(
    input: CreateWorkTaskBundle,
    enqueuer: TransactionalWorkExecutionEnqueuer,
    beforeCommit?: () => void | Promise<void>
  ): Promise<void> {
    await this.database.transaction(
      async client => {
        await this.lockAdmission(client);
        await this.assertUserCanUseWork(client, input.task.user_id);
        await this.assertTaskAdmission(
          client,
          input.task.user_id,
          input.limits
        );
        await this.assertRuntimeAdmission(
          client,
          input.task.user_id,
          input.limits
        );
        await client.query(
          `INSERT INTO work_tasks (
             id, user_id, title, model, provider_type, provider_id, status,
             network_enabled, volume_name, container_name, host_path, policy_id,
             preview_url, preview_status, preview_upstream_host,
             preview_upstream_port, persona_id, status_blurb, is_agent,
             last_seen_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
          this.taskValues(input.task)
        );
        await this.insertRun(client, input.run);
        await this.insertMessageRow(client, input.message);
        await enqueuer.enqueuePostgres(client, {
          actorUserId: input.task.user_id,
          taskId: input.task.id,
          runId: input.run.id,
        });
      },
      { isolationLevel: 'serializable', beforeCommit }
    );
  }

  async createRun(
    input: CreateWorkRunBundle,
    enqueuer: TransactionalWorkExecutionEnqueuer,
    beforeCommit?: () => void | Promise<void>
  ): Promise<void> {
    await this.database.transaction(
      async client => {
        await this.lockAdmission(client);
        await this.assertUserCanUseWork(client, input.userId);
        const found = await client.query<StoredTaskRow>(
          'SELECT * FROM work_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [input.taskId, input.userId]
        );
        const task = found.rows[0];
        if (!task)
          throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
        if (await this.findActiveRunWith(client, input.taskId)) {
          throw new WorkPersistenceError({ code: 'WORK_ACTIVE_RUN' });
        }
        if (
          task.preview_status === 'starting' ||
          task.preview_status === 'running'
        ) {
          throw new WorkPersistenceError({ code: 'WORK_PREVIEW_ACTIVE' });
        }
        await this.assertRuntimeAdmission(
          client,
          input.userId,
          input.limits,
          input.taskId
        );
        const next = await this.nextMessageIndex(client, input.taskId);
        await this.insertRun(client, input.run);
        await this.insertMessageRow(client, {
          ...input.message,
          message_index: next,
        });
        await client.query(
          `UPDATE work_tasks SET model = $1, provider_type = $2, provider_id = $3,
             status = 'preparing', updated_at = $4 WHERE id = $5 AND user_id = $6`,
          [
            input.run.model,
            input.run.provider_type,
            input.run.provider_id,
            input.run.created_at,
            input.taskId,
            input.userId,
          ]
        );
        await enqueuer.enqueuePostgres(client, {
          actorUserId: input.userId,
          taskId: input.taskId,
          runId: input.run.id,
        });
      },
      { isolationLevel: 'serializable', beforeCommit }
    );
  }

  async listTasks(userId: string): Promise<WorkTaskRow[]> {
    const result = await this.database.query<StoredTaskRow>(
      'SELECT * FROM work_tasks WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId]
    );
    return result.rows.map(taskRow);
  }

  async listTaskRecords(userId?: string): Promise<WorkTaskRow[]> {
    const result = userId
      ? await this.database.query<StoredTaskRow>(
          'SELECT * FROM work_tasks WHERE user_id = $1 ORDER BY created_at ASC',
          [userId]
        )
      : await this.database.query<StoredTaskRow>(
          'SELECT * FROM work_tasks ORDER BY created_at ASC'
        );
    return result.rows.map(taskRow);
  }

  async listTasksWithOwners(): Promise<
    Array<WorkTaskRow & { owner_username: string }>
  > {
    const result = await this.database.query<
      StoredTaskRow & { owner_username: string }
    >(
      `SELECT work_tasks.*, users.username AS owner_username
         FROM work_tasks JOIN users ON users.id = work_tasks.user_id
        ORDER BY work_tasks.updated_at DESC`
    );
    return result.rows.map(row => ({
      ...taskRow(row),
      owner_username: row.owner_username,
    }));
  }

  async findTask(
    taskId: string,
    userId: string
  ): Promise<WorkTaskRow | undefined> {
    const result = await this.database.query<StoredTaskRow>(
      'SELECT * FROM work_tasks WHERE id = $1 AND user_id = $2',
      [taskId, userId]
    );
    return result.rows[0] ? taskRow(result.rows[0]) : undefined;
  }

  async userCanUseWork(userId: string): Promise<boolean> {
    try {
      await this.assertUserCanUseWork(this.database, userId);
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
    await this.database.transaction(async client => {
      const result = await client.query<StoredTaskRow>(
        'SELECT * FROM work_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [input.taskId, input.userId]
      );
      const current = result.rows[0];
      if (!current)
        throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
      const networkChanged =
        Boolean(integer(current.network_enabled, 'network flag')) !==
        input.networkEnabled;
      if (
        networkChanged &&
        (await this.findActiveRunWith(client, input.taskId))
      ) {
        throw new WorkPersistenceError({ code: 'WORK_ACTIVE_RUN' });
      }
      await client.query(
        `UPDATE work_tasks SET title = $1, model = $2, provider_type = $3,
           provider_id = $4, network_enabled = $5,
           preview_status = CASE WHEN $6 = 1 THEN 'stopped' ELSE preview_status END,
           preview_url = CASE WHEN $6 = 1 THEN NULL ELSE preview_url END,
           preview_upstream_host = CASE WHEN $6 = 1 THEN NULL ELSE preview_upstream_host END,
           preview_upstream_port = CASE WHEN $6 = 1 THEN NULL ELSE preview_upstream_port END,
           updated_at = $7 WHERE id = $8 AND user_id = $9`,
        [
          input.title,
          input.model,
          input.providerType,
          input.providerId,
          input.networkEnabled ? 1 : 0,
          input.requireNetworkChangeLease && networkChanged ? 1 : 0,
          input.updatedAt,
          input.taskId,
          input.userId,
        ]
      );
    });
  }

  async deleteTask(taskId: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM work_tasks WHERE id = $1 AND user_id = $2',
      [taskId, userId]
    );
    return result.rowCount === 1;
  }

  async beginPreview(input: {
    taskId: string;
    userId: string;
    allowActiveRun: boolean;
    limits: WorkAdmissionLimits;
    updatedAt: number;
  }): Promise<void> {
    await this.database.transaction(
      async client => {
        await this.lockAdmission(client);
        await this.assertUserCanUseWork(client, input.userId);
        const result = await client.query<StoredTaskRow>(
          'SELECT * FROM work_tasks WHERE id = $1 AND user_id = $2 FOR UPDATE',
          [input.taskId, input.userId]
        );
        const task = result.rows[0];
        if (!task)
          throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
        if (
          !input.allowActiveRun &&
          (await this.findActiveRunWith(client, input.taskId))
        ) {
          throw new WorkPersistenceError({ code: 'WORK_ACTIVE_RUN' });
        }
        await this.assertRuntimeAdmission(
          client,
          input.userId,
          input.limits,
          input.taskId
        );
        if (
          task.preview_status !== 'starting' &&
          task.preview_status !== 'running'
        ) {
          await client.query(
            `UPDATE work_tasks SET preview_status = 'starting', preview_url = NULL,
               preview_upstream_host = NULL, preview_upstream_port = NULL,
               updated_at = $1 WHERE id = $2 AND user_id = $3`,
            [input.updatedAt, input.taskId, input.userId]
          );
        }
      },
      { isolationLevel: 'serializable' }
    );
  }

  async insertMessage(
    row: Omit<WorkMessageRow, 'message_index'>
  ): Promise<number> {
    return this.database.transaction(async client => {
      const locked = await client.query(
        'SELECT id FROM work_tasks WHERE id = $1 FOR UPDATE',
        [row.task_id]
      );
      if (locked.rowCount !== 1) {
        throw new WorkPersistenceError({ code: 'WORK_TASK_NOT_FOUND' });
      }
      const index = await this.nextMessageIndex(client, row.task_id);
      await this.insertMessageRow(client, { ...row, message_index: index });
      await client.query(
        'UPDATE work_tasks SET updated_at = $1 WHERE id = $2',
        [row.created_at, row.task_id]
      );
      return index;
    });
  }

  async listMessages(input: {
    taskId: string;
    mode: 'all' | 'conversation' | 'model-context' | 'page';
    limit?: number;
    before?: number;
  }): Promise<WorkMessageRow[]> {
    const columns =
      'id, task_id, run_id, message_index, role, kind, content, metadata, created_at';
    let result;
    if (input.mode === 'all') {
      result = await this.database.query<StoredMessageRow>(
        `SELECT ${columns} FROM work_messages WHERE task_id = $1
          AND kind <> 'provider_state' ORDER BY message_index ASC`,
        [input.taskId]
      );
    } else if (input.mode === 'conversation') {
      result = await this.database.query<StoredMessageRow>(
        `SELECT ${columns} FROM work_messages WHERE task_id = $1
          AND kind = 'message' AND role IN ('user','assistant')
          ORDER BY message_index DESC LIMIT $2`,
        [input.taskId, input.limit]
      );
    } else if (input.mode === 'model-context') {
      result = await this.database.query<StoredMessageRow>(
        `SELECT ${columns} FROM work_messages WHERE task_id = $1 AND (
          (kind = 'message' AND role IN ('user','assistant'))
          OR (kind = 'provider_state' AND role = 'assistant')
          OR (kind = 'tool_result' AND role = 'tool'))
          ORDER BY message_index DESC LIMIT $2`,
        [input.taskId, input.limit]
      );
    } else if (input.before === undefined) {
      result = await this.database.query<StoredMessageRow>(
        `SELECT ${columns} FROM work_messages WHERE task_id = $1
          AND kind <> 'provider_state' ORDER BY message_index DESC LIMIT $2`,
        [input.taskId, input.limit]
      );
    } else {
      result = await this.database.query<StoredMessageRow>(
        `SELECT ${columns} FROM work_messages WHERE task_id = $1
          AND message_index < $2 AND kind <> 'provider_state'
          ORDER BY message_index DESC LIMIT $3`,
        [input.taskId, input.before, input.limit]
      );
    }
    return result.rows.map(messageRow);
  }

  async findRun(runId: string): Promise<WorkRunRow | undefined> {
    const result = await this.database.query<StoredRunRow>(
      'SELECT * FROM work_runs WHERE id = $1',
      [runId]
    );
    return result.rows[0] ? runRow(result.rows[0]) : undefined;
  }

  async findActiveRun(taskId: string): Promise<WorkRunRow | undefined> {
    return this.findActiveRunWith(this.database, taskId);
  }

  async updateRun(input: {
    runId: string;
    status: WorkRunRow['status'];
    error: string | null;
    started: boolean;
    finished: boolean;
    now: number;
  }): Promise<void> {
    await this.database.query(
      `UPDATE work_runs SET status = $1, error = $2,
       started_at = CASE WHEN $3 THEN COALESCE(started_at, $5) ELSE started_at END,
       finished_at = CASE WHEN $4 THEN $5 ELSE finished_at END WHERE id = $6`,
      [
        input.status,
        input.error === null ? null : replaceWorkTextNul(input.error),
        input.started,
        input.finished,
        input.now,
        input.runId,
      ]
    );
  }

  async updateTaskStatus(
    taskId: string,
    status: WorkTaskStatus,
    now: number,
    statusBlurb?: string | null
  ): Promise<void> {
    if (statusBlurb === undefined) {
      await this.database.query(
        'UPDATE work_tasks SET status = $1, updated_at = $2 WHERE id = $3',
        [status, now, taskId]
      );
      return;
    }
    await this.database.query(
      'UPDATE work_tasks SET status = $1, status_blurb = $2, updated_at = $3 WHERE id = $4',
      [
        status,
        statusBlurb === null ? null : replaceWorkTextNul(statusBlurb),
        now,
        taskId,
      ]
    );
  }

  async markTaskSeen(
    taskId: string,
    userId: string,
    seenAt: number
  ): Promise<void> {
    await this.database.query(
      `UPDATE work_tasks SET last_seen_at = $1
        WHERE id = $2 AND user_id = $3
          AND (last_seen_at IS NULL OR last_seen_at < $1)`,
      [seenAt, taskId, userId]
    );
  }

  async updatePreview(
    taskId: string,
    status: WorkPreviewStatus,
    previewUrl: string | null,
    upstreamHost: string | null,
    upstreamPort: number | null,
    now: number
  ): Promise<void> {
    await this.database.query(
      `UPDATE work_tasks
          SET preview_status = $1, preview_url = $2,
              preview_upstream_host = $3, preview_upstream_port = $4,
              updated_at = $5
        WHERE id = $6`,
      [status, previewUrl, upstreamHost, upstreamPort, now, taskId]
    );
  }

  async recoverOnStartup(now: number): Promise<{
    tasks: WorkTaskRow[];
    interruptedRuns: number;
    activePreviews: number;
    persistenceError?: unknown;
  }> {
    const snapshot = await this.database.transaction(
      async client => {
        const [tasks, runs, previews] = await Promise.all([
          client.query<StoredTaskRow>('SELECT * FROM work_tasks'),
          client.query<{ count: string } & QueryResultRow>(
            `SELECT COUNT(*)::text AS count FROM work_runs
              WHERE status IN ('queued','preparing','running')`
          ),
          client.query<{ count: string } & QueryResultRow>(
            `SELECT COUNT(*)::text AS count FROM work_tasks
              WHERE preview_status IN ('starting','running')`
          ),
        ]);
        return {
          tasks: tasks.rows.map(taskRow),
          interruptedRuns: integer(
            runs.rows[0]?.count || '0',
            'interrupted run count'
          ),
          activePreviews: integer(
            previews.rows[0]?.count || '0',
            'active preview count'
          ),
        };
      },
      { isolationLevel: 'repeatable read', readOnly: true }
    );
    try {
      await this.database.transaction(async client => {
        await client.query(
          `UPDATE work_tasks SET status = 'failed', updated_at = $1
            WHERE status IN ('preparing','running') OR id IN (
              SELECT task_id FROM work_runs WHERE status IN ('queued','preparing','running'))`,
          [now]
        );
        await client.query(
          `UPDATE work_tasks SET preview_status = 'stopped', preview_url = NULL,
             preview_upstream_host = NULL, preview_upstream_port = NULL,
             updated_at = $1 WHERE preview_status <> 'stopped'
                OR preview_url IS NOT NULL OR preview_upstream_host IS NOT NULL
                OR preview_upstream_port IS NOT NULL`,
          [now]
        );
        await client.query(
          `UPDATE work_runs SET status = 'failed',
             error = 'Backend restarted while this run was active.', finished_at = $1
            WHERE status IN ('queued','preparing','running')`,
          [now]
        );
      });
      return snapshot;
    } catch (persistenceError) {
      return { ...snapshot, persistenceError };
    }
  }

  async listPolicies(): Promise<WorkPolicyRow[]> {
    const result = await this.database.query<StoredPolicyRow>(
      'SELECT * FROM work_policies ORDER BY name ASC'
    );
    return result.rows.map(policyRow);
  }

  async findPolicy(id: string): Promise<WorkPolicyRow | undefined> {
    const result = await this.database.query<StoredPolicyRow>(
      'SELECT * FROM work_policies WHERE id = $1',
      [id]
    );
    return result.rows[0] ? policyRow(result.rows[0]) : undefined;
  }

  async insertPolicy(row: WorkPolicyRow): Promise<void> {
    try {
      await this.database.query(
        `INSERT INTO work_policies (
           id,name,image,memory_limit,cpu_limit,pids_limit,network_default,
           workspace_size,idle_timeout_ms,gui_enabled,takeover_enabled,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        this.policyValues(row)
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkPersistenceError({ code: 'WORK_POLICY_NAME_CONFLICT' });
      }
      throw error;
    }
  }

  async updatePolicy(row: WorkPolicyRow): Promise<boolean> {
    try {
      const result = await this.database.query(
        `UPDATE work_policies SET name=$1,image=$2,memory_limit=$3,cpu_limit=$4,
         pids_limit=$5,network_default=$6,workspace_size=$7,idle_timeout_ms=$8,
         gui_enabled=$9,takeover_enabled=$10,updated_at=$11 WHERE id=$12`,
        [
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
          row.id,
        ]
      );
      return result.rowCount === 1;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WorkPersistenceError({ code: 'WORK_POLICY_NAME_CONFLICT' });
      }
      throw error;
    }
  }

  async deletePolicy(id: string): Promise<boolean> {
    return this.database.transaction(async client => {
      await client.query(
        'UPDATE work_tasks SET policy_id = NULL WHERE policy_id = $1',
        [id]
      );
      const result = await client.query(
        'DELETE FROM work_policies WHERE id = $1',
        [id]
      );
      return result.rowCount === 1;
    });
  }

  async anyIdleTimeoutConfigured(): Promise<boolean> {
    const result = await this.database.query(
      'SELECT 1 FROM work_policies WHERE idle_timeout_ms > 0 LIMIT 1'
    );
    return result.rowCount === 1;
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
    const result = await this.database.query<
      Pick<
        StoredTaskRow,
        | 'preview_status'
        | 'preview_url'
        | 'preview_upstream_host'
        | 'preview_upstream_port'
      >
    >(
      `SELECT preview_status, preview_url, preview_upstream_host,
              preview_upstream_port
         FROM work_tasks WHERE id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row
      ? {
          ...row,
          preview_upstream_port: nullableInteger(
            row.preview_upstream_port,
            'preview upstream port'
          ),
        }
      : undefined;
  }

  async findTaskOwnerAccess(
    taskId: string,
    userId: string
  ): Promise<{ role: string; status: string } | undefined> {
    const result = await this.database.query<
      { role: string; status: string } & QueryResultRow
    >(
      `SELECT users.role AS role, users.account_status AS status
         FROM work_tasks JOIN users ON users.id = work_tasks.user_id
        WHERE work_tasks.id = $1 AND work_tasks.user_id = $2`,
      [taskId, userId]
    );
    return result.rows[0];
  }

  async taskStillOwnsResources(input: {
    taskId: string;
    userId: string;
    volumeName: string;
    containerName: string;
  }): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM work_tasks WHERE id=$1 AND user_id=$2
       AND volume_name=$3 AND container_name=$4`,
      [input.taskId, input.userId, input.volumeName, input.containerName]
    );
    return result.rowCount === 1;
  }

  private async findActiveRunWith(
    executor: PostgresQueryExecutor,
    taskId: string
  ): Promise<WorkRunRow | undefined> {
    const result = await executor.query<StoredRunRow>(
      `SELECT * FROM work_runs WHERE task_id = $1
       AND status IN ('queued','preparing','running')
       ORDER BY created_at DESC LIMIT 1`,
      [taskId]
    );
    return result.rows[0] ? runRow(result.rows[0]) : undefined;
  }

  private async nextMessageIndex(
    executor: PostgresQueryExecutor,
    taskId: string
  ): Promise<number> {
    const result = await executor.query<
      { next_index: string } & QueryResultRow
    >(
      `SELECT (COALESCE(MAX(message_index), -1) + 1)::text AS next_index
       FROM work_messages WHERE task_id = $1`,
      [taskId]
    );
    return integer(result.rows[0]?.next_index || '0', 'next message index');
  }

  private async insertRun(
    executor: PostgresQueryExecutor,
    row: WorkRunRow
  ): Promise<void> {
    await executor.query(
      `INSERT INTO work_runs (
       id,task_id,model,provider_type,provider_id,status,error,created_at,started_at,finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.id,
        row.task_id,
        row.model,
        row.provider_type,
        row.provider_id,
        row.status,
        row.error === null ? null : replaceWorkTextNul(row.error),
        row.created_at,
        row.started_at,
        row.finished_at,
      ]
    );
  }

  private async insertMessageRow(
    executor: PostgresQueryExecutor,
    row: WorkMessageRow
  ): Promise<void> {
    await executor.query(
      `INSERT INTO work_messages (
       id,task_id,run_id,role,kind,content,metadata,message_index,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.id,
        row.task_id,
        row.run_id,
        row.role,
        row.kind,
        encodePostgresWorkMessageContent(row.content),
        row.metadata,
        row.message_index,
        row.created_at,
      ]
    );
  }

  private taskValues(row: WorkTaskRow): unknown[] {
    return [
      row.id,
      row.user_id,
      row.title,
      row.model,
      row.provider_type,
      row.provider_id,
      row.status,
      row.network_enabled,
      row.volume_name,
      row.container_name,
      row.host_path,
      row.policy_id,
      row.preview_url,
      row.preview_status,
      row.preview_upstream_host,
      row.preview_upstream_port,
      row.persona_id ?? null,
      row.status_blurb ? replaceWorkTextNul(row.status_blurb) : null,
      row.is_agent ?? null,
      row.last_seen_at ?? null,
      row.created_at,
      row.updated_at,
    ];
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
