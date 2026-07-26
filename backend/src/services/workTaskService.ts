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

import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../db.js';
import {
  WorkMessage,
  WorkMessagePage,
  WorkPreviewStatus,
  WorkProviderSelection,
  WorkProviderType,
  WorkRun,
  WorkRunStatus,
  WorkTaskDetail,
  WorkTaskRecord,
  WorkTaskSummary,
  WorkTaskStatus,
} from '../types/work.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-task');
const ACTIVE_RUN_STATUSES: WorkRunStatus[] = ['queued', 'preparing', 'running'];
const ACTIVE_PREVIEW_STATUSES: WorkPreviewStatus[] = ['starting', 'running'];
export const WORK_MESSAGE_PAGE_SIZE = 200;
export const WORK_MESSAGE_MAX_BYTES = 100_000;
const WORK_MESSAGE_PAGE_MAX_BYTES = 1_000_000;
const WORK_CONTEXT_MAX_BYTES = 256_000;
export const WORK_ADMISSION_DEFAULTS = {
  maxActiveRuntimesGlobal: 2,
  maxActiveRuntimesPerUser: 1,
  maxTasksGlobal: 500,
  maxTasksPerUser: 100,
} as const;

const workAdmissionLimits = {
  maxActiveRuntimesGlobal: positiveInteger(
    process.env.WORK_MAX_ACTIVE_RUNTIMES_GLOBAL,
    WORK_ADMISSION_DEFAULTS.maxActiveRuntimesGlobal
  ),
  maxActiveRuntimesPerUser: positiveInteger(
    process.env.WORK_MAX_ACTIVE_RUNTIMES_PER_USER,
    WORK_ADMISSION_DEFAULTS.maxActiveRuntimesPerUser
  ),
  maxTasksGlobal: positiveInteger(
    process.env.WORK_MAX_TASKS_GLOBAL,
    WORK_ADMISSION_DEFAULTS.maxTasksGlobal
  ),
  maxTasksPerUser: positiveInteger(
    process.env.WORK_MAX_TASKS_PER_USER,
    WORK_ADMISSION_DEFAULTS.maxTasksPerUser
  ),
};

interface TaskRow {
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
  preview_url: string | null;
  preview_status: WorkPreviewStatus;
  created_at: number;
  updated_at: number;
}

interface RunRow {
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

interface MessageRow {
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

export class WorkTaskService {
  private retiringUsers = new Set<string>();
  private retiringTasks = new Set<string>();
  private networkPolicyChanges = new Set<string>();

  createTaskWithRun(
    userId: string,
    message: string,
    model: string,
    networkEnabled: boolean,
    provider: WorkProviderSelection = { providerType: 'ollama' }
  ): WorkTaskDetail {
    this.assertUserIsActive(userId);
    const selectedProvider = normalizeProvider(provider);
    const db = getDatabase();
    const taskId = uuidv4();
    const runId = uuidv4();
    const messageId = uuidv4();
    const compactId = taskId.replace(/-/g, '');
    const now = Date.now();
    const title = deriveTitle(message);
    const transaction = db.transaction(() => {
      this.assertTaskAdmission(userId);
      this.assertRuntimeAdmission(userId);
      db.prepare(
        `INSERT INTO work_tasks (
          id, user_id, title, model, provider_type, provider_id, status,
          network_enabled, volume_name, container_name, preview_status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?, ?, 'stopped', ?, ?)`
      ).run(
        taskId,
        userId,
        title,
        model,
        selectedProvider.providerType,
        selectedProvider.providerId || null,
        networkEnabled ? 1 : 0,
        `libre-work-${compactId}`,
        `libre-work-${compactId}`,
        now,
        now
      );
      db.prepare(
        `INSERT INTO work_runs (
          id, task_id, model, provider_type, provider_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?)`
      ).run(
        runId,
        taskId,
        model,
        selectedProvider.providerType,
        selectedProvider.providerId || null,
        now
      );
      db.prepare(
        `INSERT INTO work_messages (
          id, task_id, run_id, role, kind, content, message_index, created_at
        ) VALUES (?, ?, ?, 'user', 'message', ?, 0, ?)`
      ).run(messageId, taskId, runId, message, now);
    });
    transaction();
    return this.requireTaskDetail(taskId, userId);
  }

  createRun(
    taskId: string,
    userId: string,
    message: string,
    model?: string,
    provider?: WorkProviderSelection
  ): WorkTaskDetail {
    const task = this.requireMutableTaskRecord(taskId, userId);
    if (this.getActiveRun(taskId)) {
      throw new WorkConflictError('This Work task already has an active run.');
    }
    const db = getDatabase();
    const runId = uuidv4();
    const messageId = uuidv4();
    const selectedModel = model?.trim() || task.model;
    const selectedProvider = normalizeProvider(
      provider || {
        providerType: task.providerType,
        providerId: task.providerId,
      }
    );
    const now = Date.now();
    const transaction = db.transaction(() => {
      if (this.getActiveRun(taskId)) {
        throw new WorkConflictError(
          'This Work task already has an active run.'
        );
      }
      if (ACTIVE_PREVIEW_STATUSES.includes(task.previewStatus)) {
        throw new WorkConflictError(
          'Stop this Work task preview before starting another run.'
        );
      }
      this.assertRuntimeAdmission(userId, taskId);
      const nextIndex = this.nextMessageIndex(taskId);
      db.prepare(
        `INSERT INTO work_runs (
          id, task_id, model, provider_type, provider_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?)`
      ).run(
        runId,
        taskId,
        selectedModel,
        selectedProvider.providerType,
        selectedProvider.providerId || null,
        now
      );
      db.prepare(
        `INSERT INTO work_messages (
          id, task_id, run_id, role, kind, content, message_index, created_at
        ) VALUES (?, ?, ?, 'user', 'message', ?, ?, ?)`
      ).run(messageId, taskId, runId, message, nextIndex, now);
      db.prepare(
        `UPDATE work_tasks
         SET model = ?, provider_type = ?, provider_id = ?,
             status = 'preparing', updated_at = ?
         WHERE id = ?`
      ).run(
        selectedModel,
        selectedProvider.providerType,
        selectedProvider.providerId || null,
        now,
        taskId
      );
    });
    transaction();
    return this.requireTaskDetail(taskId, userId);
  }

  listTasks(userId: string): WorkTaskSummary[] {
    const rows = getDatabase()
      .prepare(
        `SELECT * FROM work_tasks
         WHERE user_id = ?
         ORDER BY updated_at DESC`
      )
      .all(userId) as TaskRow[];
    return rows.map(row => this.summaryFromRow(row));
  }

  listTaskRecords(userId: string): WorkTaskRecord[] {
    const rows = getDatabase()
      .prepare(
        `SELECT * FROM work_tasks
         WHERE user_id = ?
         ORDER BY created_at ASC`
      )
      .all(userId) as TaskRow[];
    return rows.map(mapTaskRecord);
  }

  listAllTaskRecords(): WorkTaskRecord[] {
    return (
      getDatabase()
        .prepare('SELECT * FROM work_tasks ORDER BY created_at ASC')
        .all() as TaskRow[]
    ).map(mapTaskRecord);
  }

  beginUserRetirement(userId: string): void {
    if (this.retiringUsers.has(userId)) {
      throw new WorkConflictError(
        'Work tasks for this user are already being deleted.'
      );
    }
    this.retiringUsers.add(userId);
  }

  releaseUserRetirement(userId: string): void {
    this.retiringUsers.delete(userId);
  }

  beginTaskRetirement(
    taskId: string,
    userId: string,
    allowRetiringUser = false
  ): WorkTaskRecord {
    if (!allowRetiringUser) {
      this.assertUserIsActive(userId);
    }
    const task = this.requireTaskRecord(taskId, userId);
    this.assertNetworkPolicyStable(taskId);
    if (this.retiringTasks.has(taskId)) {
      throw new WorkConflictError('This Work task is already being deleted.');
    }
    this.retiringTasks.add(taskId);
    return task;
  }

  releaseTaskRetirement(taskId: string): void {
    this.retiringTasks.delete(taskId);
  }

  finalizeTaskRetirement(taskId: string): void {
    this.retiringTasks.delete(taskId);
  }

  requireMutableTaskRecord(taskId: string, userId: string): WorkTaskRecord {
    this.assertUserIsActive(userId);
    const task = this.requireTaskRecord(taskId, userId);
    this.assertTaskIsActive(taskId);
    this.assertNetworkPolicyStable(taskId);
    return task;
  }

  assertTaskMutationAllowed(taskId: string, userId: string): void {
    this.requireMutableTaskRecord(taskId, userId);
  }

  private assertUserIsActive(userId: string): void {
    if (this.retiringUsers.has(userId)) {
      throw new WorkConflictError('This user is being deleted.');
    }
    const current = getDatabase()
      .prepare('SELECT role FROM users WHERE id = ?')
      .get(userId) as { role: string } | undefined;
    if (current?.role !== 'admin') {
      throw new WorkForbiddenError();
    }
  }

  private assertTaskIsActive(taskId: string): void {
    if (this.retiringTasks.has(taskId)) {
      throw new WorkConflictError('This Work task is being deleted.');
    }
  }

  private assertNetworkPolicyStable(taskId: string): void {
    if (this.networkPolicyChanges.has(taskId)) {
      throw new WorkConflictError(
        'This Work task network policy is being changed.'
      );
    }
  }

  beginNetworkPolicyChange(taskId: string, userId: string): WorkTaskRecord {
    const task = this.requireMutableTaskRecord(taskId, userId);
    if (this.getActiveRun(taskId)) {
      throw new WorkConflictError(
        'Network access cannot be changed during an active run.'
      );
    }
    this.networkPolicyChanges.add(taskId);
    return task;
  }

  releaseNetworkPolicyChange(taskId: string): void {
    this.networkPolicyChanges.delete(taskId);
  }

  beginPreview(taskId: string, userId: string, allowActiveRun = false): void {
    const transaction = getDatabase().transaction(() => {
      const task = this.requireMutableTaskRecord(taskId, userId);
      const activeRun = this.getActiveRun(taskId);
      if (activeRun && !allowActiveRun) {
        throw new WorkConflictError(
          'Wait for the active Work run to finish before starting a preview.'
        );
      }
      this.assertRuntimeAdmission(userId, taskId);
      if (!ACTIVE_PREVIEW_STATUSES.includes(task.previewStatus)) {
        this.updatePreview(taskId, 'starting');
      }
    });
    transaction();
  }

  getTaskDetail(taskId: string, userId: string): WorkTaskDetail | undefined {
    const row = this.getTaskRow(taskId, userId);
    return row ? this.detailFromRow(row) : undefined;
  }

  requireTaskDetail(taskId: string, userId: string): WorkTaskDetail {
    const task = this.getTaskDetail(taskId, userId);
    if (!task) {
      throw new WorkNotFoundError();
    }
    return task;
  }

  getTaskRecord(taskId: string, userId: string): WorkTaskRecord | undefined {
    const row = this.getTaskRow(taskId, userId);
    return row ? mapTaskRecord(row) : undefined;
  }

  requireTaskRecord(taskId: string, userId: string): WorkTaskRecord {
    const task = this.getTaskRecord(taskId, userId);
    if (!task) {
      throw new WorkNotFoundError();
    }
    return task;
  }

  updateTask(
    taskId: string,
    userId: string,
    updates: {
      title?: string;
      model?: string;
      providerType?: WorkProviderType;
      providerId?: string;
      networkEnabled?: boolean;
    }
  ): WorkTaskDetail {
    const task = this.requireMutableTaskRecord(taskId, userId);
    if (
      updates.networkEnabled !== undefined &&
      updates.networkEnabled !== task.networkEnabled &&
      this.getActiveRun(taskId)
    ) {
      throw new WorkConflictError(
        'Network access cannot be changed during an active run.'
      );
    }
    const title =
      updates.title === undefined ? task.title : cleanTitle(updates.title);
    const model =
      updates.model === undefined ? task.model : cleanRequired(updates.model);
    const provider = normalizeProvider({
      providerType: updates.providerType ?? task.providerType,
      providerId:
        updates.providerType === 'ollama'
          ? undefined
          : updates.providerId === undefined
            ? task.providerId
            : updates.providerId,
    });
    const networkEnabled = updates.networkEnabled ?? task.networkEnabled;
    getDatabase()
      .prepare(
        `UPDATE work_tasks
         SET title = ?, model = ?, provider_type = ?, provider_id = ?,
             network_enabled = ?, updated_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        title,
        model,
        provider.providerType,
        provider.providerId || null,
        networkEnabled ? 1 : 0,
        Date.now(),
        taskId,
        userId
      );
    return this.requireTaskDetail(taskId, userId);
  }

  commitNetworkChange(
    taskId: string,
    userId: string,
    updates: {
      title?: string;
      model?: string;
      providerType?: WorkProviderType;
      providerId?: string;
      networkEnabled: boolean;
    }
  ): void {
    this.assertUserIsActive(userId);
    const task = this.requireTaskRecord(taskId, userId);
    this.assertTaskIsActive(taskId);
    if (!this.networkPolicyChanges.has(taskId)) {
      throw new WorkConflictError(
        'This Work task has no active network policy change.'
      );
    }
    if (
      updates.networkEnabled !== task.networkEnabled &&
      this.getActiveRun(taskId)
    ) {
      throw new WorkConflictError(
        'Network access cannot be changed during an active run.'
      );
    }
    const title =
      updates.title === undefined ? task.title : cleanTitle(updates.title);
    const model =
      updates.model === undefined ? task.model : cleanRequired(updates.model);
    const provider = normalizeProvider({
      providerType: updates.providerType ?? task.providerType,
      providerId:
        updates.providerType === 'ollama'
          ? undefined
          : updates.providerId === undefined
            ? task.providerId
            : updates.providerId,
    });
    const networkChanged = updates.networkEnabled !== task.networkEnabled;
    getDatabase()
      .prepare(
        `UPDATE work_tasks
         SET title = ?, model = ?, provider_type = ?, provider_id = ?,
             network_enabled = ?,
             preview_status = CASE
               WHEN ? = 1 THEN 'stopped'
               ELSE preview_status
             END,
             preview_url = CASE
               WHEN ? = 1 THEN NULL
               ELSE preview_url
             END,
             updated_at = ?
         WHERE id = ? AND user_id = ?`
      )
      .run(
        title,
        model,
        provider.providerType,
        provider.providerId || null,
        updates.networkEnabled ? 1 : 0,
        networkChanged ? 1 : 0,
        networkChanged ? 1 : 0,
        Date.now(),
        taskId,
        userId
      );
  }

  private assertTaskAdmission(userId: string): void {
    const counts = getDatabase()
      .prepare(
        `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END), 0) AS per_user
         FROM work_tasks`
      )
      .get(userId) as { total: number; per_user: number };
    if (counts.per_user >= workAdmissionLimits.maxTasksPerUser) {
      throw new WorkAdmissionError(
        `This administrator already has the maximum of ${workAdmissionLimits.maxTasksPerUser} Work tasks.`,
        'WORK_USER_TASK_LIMIT'
      );
    }
    if (counts.total >= workAdmissionLimits.maxTasksGlobal) {
      throw new WorkAdmissionError(
        `This Libre WebUI instance already has the maximum of ${workAdmissionLimits.maxTasksGlobal} Work tasks.`,
        'WORK_GLOBAL_TASK_LIMIT'
      );
    }
  }

  private assertRuntimeAdmission(userId: string, taskId?: string): void {
    const activeRunPlaceholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    const activePreviewPlaceholders = ACTIVE_PREVIEW_STATUSES.map(
      () => '?'
    ).join(', ');
    const counts = getDatabase()
      .prepare(
        `WITH active_tasks AS (
           SELECT DISTINCT work_tasks.id AS task_id, work_tasks.user_id
           FROM work_tasks
           JOIN work_runs ON work_runs.task_id = work_tasks.id
           WHERE work_runs.status IN (${activeRunPlaceholders})
           UNION
           SELECT id AS task_id, user_id
           FROM work_tasks
           WHERE preview_status IN (${activePreviewPlaceholders})
         )
         SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END), 0) AS per_user
         FROM active_tasks
         WHERE ? IS NULL OR task_id != ?`
      )
      .get(
        ...ACTIVE_RUN_STATUSES,
        ...ACTIVE_PREVIEW_STATUSES,
        userId,
        taskId || null,
        taskId || null
      ) as { total: number; per_user: number };
    if (counts.per_user >= workAdmissionLimits.maxActiveRuntimesPerUser) {
      throw new WorkAdmissionError(
        `This administrator already has ${workAdmissionLimits.maxActiveRuntimesPerUser} active Work runtime(s). Wait for a run or preview to stop.`,
        'WORK_USER_RUNTIME_LIMIT'
      );
    }
    if (counts.total >= workAdmissionLimits.maxActiveRuntimesGlobal) {
      throw new WorkAdmissionError(
        `This Libre WebUI instance already has ${workAdmissionLimits.maxActiveRuntimesGlobal} active Work runtime(s). Wait for a run or preview to stop.`,
        'WORK_GLOBAL_RUNTIME_LIMIT'
      );
    }
  }

  deleteTask(taskId: string, userId: string): WorkTaskRecord {
    const task = this.requireTaskRecord(taskId, userId);
    const result = getDatabase()
      .prepare('DELETE FROM work_tasks WHERE id = ? AND user_id = ?')
      .run(taskId, userId);
    if (!result.changes) {
      throw new WorkNotFoundError();
    }
    return task;
  }

  addMessage(
    taskId: string,
    runId: string | undefined,
    role: WorkMessage['role'],
    kind: WorkMessage['kind'],
    content: string,
    metadata?: Record<string, unknown>
  ): WorkMessage {
    const db = getDatabase();
    const id = uuidv4();
    const createdAt = Date.now();
    const messageIndex = this.nextMessageIndex(taskId);
    const boundedContent = boundUtf8(content, WORK_MESSAGE_MAX_BYTES);
    db.prepare(
      `INSERT INTO work_messages (
        id, task_id, run_id, role, kind, content, metadata,
        message_index, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      taskId,
      runId || null,
      role,
      kind,
      boundedContent,
      metadata ? JSON.stringify(metadata) : null,
      messageIndex,
      createdAt
    );
    this.touchTask(taskId);
    return {
      id,
      taskId,
      runId,
      messageIndex,
      role,
      kind,
      content: boundedContent,
      metadata,
      createdAt,
    };
  }

  getMessages(taskId: string): WorkMessage[] {
    const rows = getDatabase()
      .prepare(
        `SELECT id, task_id, run_id, message_index, role, kind, content,
                metadata, created_at
         FROM work_messages
         WHERE task_id = ?
         ORDER BY message_index ASC`
      )
      .all(taskId) as MessageRow[];
    return rows.map(mapMessage);
  }

  getRecentConversationMessages(taskId: string, limit = 30): WorkMessage[] {
    const boundedLimit = Math.min(30, Math.max(1, Math.trunc(limit)));
    const rows = getDatabase()
      .prepare(
        `SELECT id, task_id, run_id, message_index, role, kind, content,
                metadata, created_at
         FROM work_messages
         WHERE task_id = ?
           AND kind = 'message'
           AND role IN ('user', 'assistant')
         ORDER BY message_index DESC
         LIMIT ?`
      )
      .all(taskId, boundedLimit) as MessageRow[];
    const selected: MessageRow[] = [];
    let selectedBytes = 0;
    for (const row of rows) {
      const bytes = Buffer.byteLength(row.content, 'utf8');
      if (
        selected.length > 0 &&
        selectedBytes + bytes > WORK_CONTEXT_MAX_BYTES
      ) {
        break;
      }
      selected.push(row);
      selectedBytes += Math.min(bytes, WORK_MESSAGE_MAX_BYTES);
    }
    return selected.reverse().map(mapMessage);
  }

  getMessagePage(
    taskId: string,
    before?: number,
    limit = WORK_MESSAGE_PAGE_SIZE
  ): WorkMessagePage {
    const pageSize = Math.min(
      WORK_MESSAGE_PAGE_SIZE,
      Math.max(1, Math.trunc(limit))
    );
    const rows = (
      before === undefined
        ? getDatabase()
            .prepare(
              `SELECT id, task_id, run_id, message_index, role, kind, content,
                      metadata, created_at
               FROM work_messages
               WHERE task_id = ?
               ORDER BY message_index DESC
               LIMIT ?`
            )
            .all(taskId, pageSize + 1)
        : getDatabase()
            .prepare(
              `SELECT id, task_id, run_id, message_index, role, kind, content,
                      metadata, created_at
               FROM work_messages
               WHERE task_id = ? AND message_index < ?
               ORDER BY message_index DESC
               LIMIT ?`
            )
            .all(taskId, before, pageSize + 1)
    ) as MessageRow[];
    const selectedRows: MessageRow[] = [];
    let selectedBytes = 0;
    for (const row of rows.slice(0, pageSize)) {
      const bytes = Math.min(
        Buffer.byteLength(row.content, 'utf8'),
        WORK_MESSAGE_MAX_BYTES
      );
      if (
        selectedRows.length > 0 &&
        selectedBytes + bytes > WORK_MESSAGE_PAGE_MAX_BYTES
      ) {
        break;
      }
      selectedRows.push(row);
      selectedBytes += bytes;
    }
    const hasMore = rows.length > selectedRows.length || rows.length > pageSize;
    const pageRows = selectedRows.reverse();
    return {
      messages: pageRows.map(mapMessage),
      cursor: hasMore ? pageRows[0]?.message_index : undefined,
      hasMore,
    };
  }

  getRun(runId: string): WorkRun | undefined {
    const row = getDatabase()
      .prepare('SELECT * FROM work_runs WHERE id = ?')
      .get(runId) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  getActiveRun(taskId: string): WorkRun | undefined {
    const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ');
    const row = getDatabase()
      .prepare(
        `SELECT * FROM work_runs
         WHERE task_id = ? AND status IN (${placeholders})
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(taskId, ...ACTIVE_RUN_STATUSES) as RunRow | undefined;
    return row ? mapRun(row) : undefined;
  }

  updateRun(
    runId: string,
    status: WorkRunStatus,
    options: { error?: string; started?: boolean; finished?: boolean } = {}
  ): WorkRun {
    const now = Date.now();
    getDatabase()
      .prepare(
        `UPDATE work_runs
         SET status = ?,
             error = ?,
             started_at = CASE WHEN ? = 1 THEN COALESCE(started_at, ?) ELSE started_at END,
             finished_at = CASE WHEN ? = 1 THEN ? ELSE finished_at END
         WHERE id = ?`
      )
      .run(
        status,
        options.error || null,
        options.started ? 1 : 0,
        now,
        options.finished ? 1 : 0,
        now,
        runId
      );
    const run = this.getRun(runId);
    if (!run) {
      throw new WorkNotFoundError('Work run not found.');
    }
    return run;
  }

  updateTaskStatus(taskId: string, status: WorkTaskStatus): void {
    getDatabase()
      .prepare(
        `UPDATE work_tasks
         SET status = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, Date.now(), taskId);
  }

  updatePreview(
    taskId: string,
    status: WorkPreviewStatus,
    previewUrl?: string
  ): void {
    getDatabase()
      .prepare(
        `UPDATE work_tasks
         SET preview_status = ?, preview_url = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(status, previewUrl || null, Date.now(), taskId);
  }

  recoverOnStartup(): {
    tasks: WorkTaskRecord[];
    interruptedRuns: number;
    activePreviews: number;
  } {
    let db: ReturnType<typeof getDatabase>;
    let taskRows: TaskRow[];
    try {
      db = getDatabase();
      taskRows = db.prepare('SELECT * FROM work_tasks').all() as TaskRow[];
    } catch (error) {
      logger.error('Failed to read Work tasks for startup recovery:', error);
      // Without the complete task inventory we cannot prove that every
      // preexisting command or preview container has been stopped. Abort
      // startup instead of allowing Work to run without supervision.
      throw error;
    }

    let interruptedRuns = 0;
    let activePreviews = 0;
    try {
      interruptedRuns = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM work_runs
             WHERE status IN ('queued', 'preparing', 'running')`
          )
          .get() as { count: number }
      ).count;
      activePreviews = (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM work_tasks
             WHERE preview_status IN ('starting', 'running')`
          )
          .get() as { count: number }
      ).count;
    } catch (error) {
      logger.error('Failed to count interrupted Work state:', error);
    }

    try {
      const now = Date.now();
      const transaction = db.transaction(() => {
        db.prepare(
          `UPDATE work_tasks
           SET status = 'failed', updated_at = ?
           WHERE status IN ('preparing', 'running')
              OR id IN (
                SELECT task_id FROM work_runs
                WHERE status IN ('queued', 'preparing', 'running')
              )`
        ).run(now);
        db.prepare(
          `UPDATE work_tasks
           SET preview_status = 'stopped', preview_url = NULL, updated_at = ?
           WHERE preview_status != 'stopped' OR preview_url IS NOT NULL`
        ).run(now);
        db.prepare(
          `UPDATE work_runs
           SET status = 'failed',
               error = 'Backend restarted while this run was active.',
               finished_at = ?
           WHERE status IN ('queued', 'preparing', 'running')`
        ).run(now);
      });
      transaction();
    } catch (error) {
      // Container teardown is the security-critical half of recovery. Return
      // the rows already read even if SQLite cannot persist terminal states,
      // so startup can still stop every known command and preview process.
      logger.error('Failed to persist recovered Work state on startup:', error);
    }
    return {
      tasks: taskRows.map(mapTaskRecord),
      interruptedRuns,
      activePreviews,
    };
  }

  private getTaskRow(taskId: string, userId: string): TaskRow | undefined {
    return getDatabase()
      .prepare('SELECT * FROM work_tasks WHERE id = ? AND user_id = ?')
      .get(taskId, userId) as TaskRow | undefined;
  }

  private detailFromRow(row: TaskRow): WorkTaskDetail {
    const messagePage = this.getMessagePage(row.id);
    return {
      ...this.summaryFromRow(row),
      messages: messagePage.messages,
      messageCursor: messagePage.cursor,
      hasMoreMessages: messagePage.hasMore,
    };
  }

  private summaryFromRow(row: TaskRow): WorkTaskSummary {
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      providerType: row.provider_type,
      providerId: row.provider_id || undefined,
      status: row.status,
      networkEnabled: Boolean(row.network_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeRun: this.getActiveRun(row.id),
      previewUrl: row.preview_url || undefined,
      previewStatus: row.preview_status,
      workspacePath: '/workspace',
    };
  }

  private nextMessageIndex(taskId: string): number {
    const row = getDatabase()
      .prepare(
        `SELECT COALESCE(MAX(message_index), -1) + 1 AS next_index
         FROM work_messages WHERE task_id = ?`
      )
      .get(taskId) as { next_index: number };
    return row.next_index;
  }

  private touchTask(taskId: string): void {
    getDatabase()
      .prepare('UPDATE work_tasks SET updated_at = ? WHERE id = ?')
      .run(Date.now(), taskId);
  }
}

export class WorkNotFoundError extends Error {
  readonly status = 404;

  constructor(message = 'Work task not found.') {
    super(message);
    this.name = 'WorkNotFoundError';
  }
}

export class WorkConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'WorkConflictError';
  }
}

export class WorkForbiddenError extends Error {
  readonly status = 403;

  constructor(message = 'Admin access is required for Work tasks.') {
    super(message);
    this.name = 'WorkForbiddenError';
  }
}

export class WorkAdmissionError extends Error {
  readonly status = 429;
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'WorkAdmissionError';
    this.code = code;
  }
}

const mapTaskRecord = (row: TaskRow): WorkTaskRecord => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  model: row.model,
  providerType: row.provider_type,
  providerId: row.provider_id || undefined,
  status: row.status,
  networkEnabled: Boolean(row.network_enabled),
  volumeName: row.volume_name,
  containerName: row.container_name,
  previewUrl: row.preview_url || undefined,
  previewStatus: row.preview_status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapRun = (row: RunRow): WorkRun => ({
  id: row.id,
  taskId: row.task_id,
  model: row.model,
  providerType: row.provider_type,
  providerId: row.provider_id || undefined,
  status: row.status,
  error: row.error || undefined,
  createdAt: row.created_at,
  startedAt: row.started_at || undefined,
  finishedAt: row.finished_at || undefined,
});

const mapMessage = (row: MessageRow): WorkMessage => ({
  id: row.id,
  taskId: row.task_id,
  runId: row.run_id || undefined,
  messageIndex: row.message_index,
  role: row.role,
  kind: row.kind,
  content: boundUtf8(row.content, WORK_MESSAGE_MAX_BYTES),
  metadata: parseMetadata(row.metadata),
  createdAt: row.created_at,
});

const parseMetadata = (
  value: string | null
): Record<string, unknown> | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const deriveTitle = (message: string): string => {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] || 'New Work';
  return cleanTitle(firstLine.slice(0, 80));
};

const cleanTitle = (value: string): string =>
  value.trim().slice(0, 120) || 'New Work';

const cleanRequired = (value: string): string => {
  const cleaned = value.trim();
  if (!cleaned) {
    throw new Error('Model cannot be empty.');
  }
  return cleaned;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const normalizeProvider = (
  provider: WorkProviderSelection
): WorkProviderSelection => {
  if (provider.providerType === 'ollama') {
    return { providerType: 'ollama' };
  }
  const providerId = provider.providerId?.trim();
  if (!providerId) {
    throw new Error('Plugin provider ID cannot be empty.');
  }
  return { providerType: 'plugin', providerId };
};

const boundUtf8 = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '\n... message truncated ...';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  const prefix = Buffer.from(value, 'utf8')
    .subarray(0, budget)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}${suffix}`;
};

export const workTaskService = new WorkTaskService();
export default workTaskService;
