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

import {
  getWorkPersistence,
  replaceWorkTextNul,
  WorkPersistenceError,
  type WorkMessageRow,
  type WorkRunRow,
  type WorkTaskRow,
} from '../platform/workPersistence/index.js';
import { transactionalWorkExecutionEnqueuer } from '../platform/jobs/workExecutionEnqueuer.js';
import {
  WORK_EXECUTE_IDEMPOTENCY_SCOPE,
  WORK_EXECUTE_JOB_TYPE,
} from '../platform/jobs/domainJobContracts.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import {
  WorkMessage,
  WorkMessagePage,
  WorkPreviewStatus,
  WorkProviderSelection,
  WorkProviderType,
  WorkRun,
  WorkRunStatus,
  WorkAgentIdentityInput,
  WorkTaskDetail,
  WorkTaskRecord,
  WorkTaskSummary,
  WorkTaskStatus,
} from '../types/work.js';
import { createLogger } from '../utils/logger.js';
import { getCoordinator } from '../platform/coordination/service.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('services:work-task');
export const WORK_MESSAGE_PAGE_SIZE = 200;
export const WORK_MESSAGE_MAX_BYTES = 100_000;
export const WORK_MESSAGE_METADATA_MAX_BYTES = 100_000;
const WORK_MESSAGE_PAGE_MAX_BYTES = 1_000_000;
const WORK_CONTEXT_MAX_BYTES = 256_000;
export const WORK_ADMISSION_DEFAULTS = {
  // Keep these in step with WORK_RUNTIME_ADMISSION_DEFAULTS: two concurrent
  // runtimes per administrator, three per instance.
  maxActiveRuntimesGlobal: 3,
  maxActiveRuntimesPerUser: 2,
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

type TaskRow = WorkTaskRow;
type RunRow = WorkRunRow;
type MessageRow = WorkMessageRow;

export class WorkTaskService {
  private retiringUsers = new Set<string>();
  private retiringTasks = new Set<string>();
  private networkPolicyChanges = new Set<string>();

  private async resolveExecutionPublication(
    expectedTask: TaskRow,
    expectedRun: RunRow,
    expectedMessage: MessageRow,
    taskMayPreexist = false
  ): Promise<'absent' | 'committed' | 'ambiguous'> {
    try {
      const persistence = getWorkPersistence();
      const [task, run, messages, job] = await Promise.all([
        persistence.findTask(expectedTask.id, expectedTask.user_id),
        persistence.findRun(expectedRun.id),
        persistence.listMessages({ taskId: expectedTask.id, mode: 'all' }),
        getDurableJobRuntime().service.getByIdempotency(
          expectedTask.user_id,
          WORK_EXECUTE_IDEMPOTENCY_SCOPE,
          expectedRun.id
        ),
      ]);
      const message = messages.find(row => row.id === expectedMessage.id);
      if (!run && !message && !job && (taskMayPreexist || !task)) {
        return 'absent';
      }
      const exactTask =
        task?.id === expectedTask.id &&
        task.user_id === expectedTask.user_id &&
        task.title === expectedTask.title &&
        task.model === expectedTask.model &&
        task.provider_type === expectedTask.provider_type &&
        task.provider_id === expectedTask.provider_id &&
        task.network_enabled === expectedTask.network_enabled &&
        task.volume_name === expectedTask.volume_name &&
        task.container_name === expectedTask.container_name &&
        task.host_path === expectedTask.host_path &&
        task.policy_id === expectedTask.policy_id &&
        task.created_at === expectedTask.created_at;
      const exactRun =
        run?.id === expectedRun.id &&
        run.task_id === expectedRun.task_id &&
        run.model === expectedRun.model &&
        run.provider_type === expectedRun.provider_type &&
        run.provider_id === expectedRun.provider_id &&
        run.created_at === expectedRun.created_at;
      const exactMessage =
        message?.id === expectedMessage.id &&
        message.task_id === expectedMessage.task_id &&
        message.run_id === expectedMessage.run_id &&
        message.role === expectedMessage.role &&
        message.kind === expectedMessage.kind &&
        message.content === expectedMessage.content &&
        message.metadata === expectedMessage.metadata &&
        message.created_at === expectedMessage.created_at;
      const exactJob =
        job?.jobType === WORK_EXECUTE_JOB_TYPE &&
        job.actorUserId === expectedTask.user_id;
      return exactTask && exactRun && exactMessage && exactJob
        ? 'committed'
        : 'ambiguous';
    } catch {
      return 'ambiguous';
    }
  }

  async withUserLifecycleLease<T>(
    userId: string,
    operation: (assertHeld: () => Promise<void>) => Promise<T>
  ): Promise<T> {
    const coordinator = getCoordinator();
    const deadline = Date.now() + 10_000;
    let lease = await coordinator.acquireLease(
      `work-user-lifecycle:${userId}`,
      60_000
    );
    while (!lease && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      lease = await coordinator.acquireLease(
        `work-user-lifecycle:${userId}`,
        60_000
      );
    }
    if (!lease) {
      throw new WorkConflictError(
        'This user already has a Work lifecycle operation in progress.'
      );
    }
    let closed = false;
    let leaseLost = false;
    let renewalTimer: NodeJS.Timeout | undefined;
    const leaseLostError = (): WorkConflictError =>
      new WorkConflictError('The shared Work lifecycle lease was lost.');
    const markLost = (): void => {
      leaseLost = true;
    };
    const assertHeld = async (): Promise<void> => {
      if (closed || leaseLost) throw leaseLostError();
      try {
        if (await lease.extend(60_000)) return;
      } catch {
        // Report expiry and coordination outages through one safe fence.
      }
      markLost();
      throw leaseLostError();
    };
    const renew = async (): Promise<void> => {
      if (closed) return;
      try {
        if (!(await lease.extend(60_000))) markLost();
      } catch {
        markLost();
      }
      if (!closed && !leaseLost) renewalTimer = setTimeout(renew, 20_000);
    };
    renewalTimer = setTimeout(renew, 20_000);
    try {
      await assertHeld();
      const result = await operation(assertHeld);
      return result;
    } finally {
      closed = true;
      if (renewalTimer) clearTimeout(renewalTimer);
      await lease.release().catch(() => false);
    }
  }

  async createTaskWithRun(
    userId: string,
    message: string,
    model: string,
    networkEnabled: boolean,
    provider: WorkProviderSelection = { providerType: 'ollama' },
    hostPath?: string,
    policyId?: string,
    identity?: WorkAgentIdentityInput
  ): Promise<WorkTaskDetail> {
    return this.withUserLifecycleLease(userId, assertHeld =>
      this.createTaskWithRunWithLeaseHeld(
        userId,
        message,
        model,
        networkEnabled,
        provider,
        hostPath,
        policyId,
        identity,
        assertHeld
      )
    );
  }

  private async createTaskWithRunWithLeaseHeld(
    userId: string,
    message: string,
    model: string,
    networkEnabled: boolean,
    provider: WorkProviderSelection,
    hostPath?: string,
    policyId?: string,
    identity?: WorkAgentIdentityInput,
    assertHeld: () => Promise<void> = async () => undefined
  ): Promise<WorkTaskDetail> {
    await this.assertUserIsActive(userId);
    const selectedProvider = normalizeProvider(provider);
    const taskId = randomUUID();
    const runId = randomUUID();
    const messageId = randomUUID();
    const compactId = taskId.replace(/-/g, '');
    const now = Date.now();
    const title = deriveTitle(message);
    const selectedModel = cleanRequired(model);
    const taskRow: TaskRow = {
      id: taskId,
      user_id: userId,
      title,
      model: selectedModel,
      provider_type: selectedProvider.providerType,
      provider_id: selectedProvider.providerId || null,
      status: 'preparing',
      network_enabled: networkEnabled ? 1 : 0,
      volume_name: `libre-work-${compactId}`,
      container_name: `libre-work-${compactId}`,
      host_path: hostPath || null,
      policy_id: policyId || null,
      preview_url: null,
      preview_status: 'stopped',
      preview_upstream_host: null,
      preview_upstream_port: null,
      persona_id: identity?.personaId || null,
      status_blurb: null,
      is_agent: identity?.isAgent ? 1 : 0,
      // The creator is looking at the task they just made.
      last_seen_at: now,
      approvals_enabled: null,
      created_at: now,
      updated_at: now,
    };
    const runRow: RunRow = {
      id: runId,
      task_id: taskId,
      model: selectedModel,
      provider_type: selectedProvider.providerType,
      provider_id: selectedProvider.providerId || null,
      status: 'queued',
      error: null,
      created_at: now,
      started_at: null,
      finished_at: null,
    };
    const messageRow: MessageRow = {
      id: messageId,
      task_id: taskId,
      run_id: runId,
      role: 'user',
      kind: 'message',
      content: message,
      metadata: null,
      message_index: 0,
      created_at: now,
    };
    try {
      await assertHeld();
      await getWorkPersistence().createTaskWithRun(
        {
          task: taskRow,
          run: runRow,
          message: messageRow,
          limits: workAdmissionLimits,
        },
        transactionalWorkExecutionEnqueuer,
        assertHeld
      );
    } catch (error) {
      const outcome = await this.resolveExecutionPublication(
        taskRow,
        runRow,
        messageRow
      );
      if (outcome === 'committed') {
        return this.requireTaskDetail(taskId, userId);
      }
      if (outcome === 'ambiguous') {
        throw new WorkConflictError(
          'The Work task publication outcome is ambiguous. Reload before retrying.'
        );
      }
      throw translatePersistenceError(error);
    }
    return this.requireTaskDetail(taskId, userId);
  }

  async createRun(
    taskId: string,
    userId: string,
    message: string,
    model?: string,
    provider?: WorkProviderSelection,
    messageMetadata?: Record<string, unknown>
  ): Promise<WorkTaskDetail> {
    return this.withUserLifecycleLease(userId, assertHeld =>
      this.createRunWithLeaseHeld(
        taskId,
        userId,
        message,
        model,
        provider,
        assertHeld,
        messageMetadata
      )
    );
  }

  private async createRunWithLeaseHeld(
    taskId: string,
    userId: string,
    message: string,
    model?: string,
    provider?: WorkProviderSelection,
    assertHeld: () => Promise<void> = async () => undefined,
    messageMetadata?: Record<string, unknown>
  ): Promise<WorkTaskDetail> {
    const task = await this.requireMutableTaskRecord(taskId, userId);
    if (await this.getActiveRun(taskId)) {
      throw new WorkConflictError('This Work task already has an active run.');
    }
    const runId = randomUUID();
    const messageId = randomUUID();
    const selectedModel =
      model === undefined ? task.model : cleanRequired(model);
    const selectedProvider = normalizeProvider(
      provider || {
        providerType: task.providerType,
        providerId: task.providerId,
      }
    );
    const now = Date.now();
    const runRow: RunRow = {
      id: runId,
      task_id: taskId,
      model: selectedModel,
      provider_type: selectedProvider.providerType,
      provider_id: selectedProvider.providerId || null,
      status: 'queued',
      error: null,
      created_at: now,
      started_at: null,
      finished_at: null,
    };
    const messageRow: MessageRow = {
      id: messageId,
      task_id: taskId,
      run_id: runId,
      role: 'user',
      kind: 'message',
      content: message,
      metadata: serializeMetadata(messageMetadata) ?? null,
      message_index: 0,
      created_at: now,
    };
    try {
      await assertHeld();
      await getWorkPersistence().createRun(
        {
          taskId,
          userId,
          run: runRow,
          message: messageRow,
          limits: workAdmissionLimits,
        },
        transactionalWorkExecutionEnqueuer,
        assertHeld
      );
    } catch (error) {
      const expectedTask: TaskRow = {
        id: task.id,
        user_id: task.userId,
        title: task.title,
        model: selectedModel,
        provider_type: selectedProvider.providerType,
        provider_id: selectedProvider.providerId || null,
        status: 'preparing',
        network_enabled: task.networkEnabled ? 1 : 0,
        volume_name: task.volumeName,
        container_name: task.containerName,
        host_path: task.hostPath || null,
        policy_id: task.policyId || null,
        preview_url: task.previewUrl || null,
        preview_status: task.previewStatus,
        preview_upstream_host: task.previewUpstreamHost || null,
        preview_upstream_port: task.previewUpstreamPort || null,
        persona_id: task.personaId || null,
        status_blurb: task.statusBlurb || null,
        is_agent: task.isAgent ? 1 : 0,
        last_seen_at: task.lastSeenAt ?? null,
        approvals_enabled:
          task.approvalsEnabled === undefined
            ? null
            : task.approvalsEnabled
              ? 1
              : 0,
        created_at: task.createdAt,
        updated_at: task.updatedAt,
      };
      const outcome = await this.resolveExecutionPublication(
        expectedTask,
        runRow,
        messageRow,
        true
      );
      if (outcome === 'committed') {
        return this.requireTaskDetail(taskId, userId);
      }
      if (outcome === 'ambiguous') {
        throw new WorkConflictError(
          'The Work run publication outcome is ambiguous. Reload before retrying.'
        );
      }
      throw translatePersistenceError(error);
    }
    return this.requireTaskDetail(taskId, userId);
  }

  async listTasks(userId: string): Promise<WorkTaskSummary[]> {
    const rows = await getWorkPersistence().listTasks(userId);
    return Promise.all(rows.map(row => this.summaryFromRow(row)));
  }

  async listTaskRecords(userId: string): Promise<WorkTaskRecord[]> {
    const rows = await getWorkPersistence().listTaskRecords(userId);
    return rows.map(mapTaskRecord);
  }

  async listAllTaskRecords(): Promise<WorkTaskRecord[]> {
    return (await getWorkPersistence().listTaskRecords()).map(mapTaskRecord);
  }

  /** Every task with its owner's username, for the admin overview. */
  async listAllTasksWithOwner(): Promise<
    Array<{
      record: WorkTaskRecord;
      ownerUsername: string;
    }>
  > {
    const rows = await getWorkPersistence().listTasksWithOwners();
    return rows.map(row => ({
      record: mapTaskRecord(row),
      ownerUsername: row.owner_username,
    }));
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

  async beginTaskRetirement(
    taskId: string,
    userId: string,
    allowRetiringUser = false
  ): Promise<WorkTaskRecord> {
    if (!allowRetiringUser) {
      await this.assertUserIsActive(userId);
    }
    const task = await this.requireTaskRecord(taskId, userId);
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

  async requireMutableTaskRecord(
    taskId: string,
    userId: string
  ): Promise<WorkTaskRecord> {
    await this.assertUserIsActive(userId);
    const task = await this.requireTaskRecord(taskId, userId);
    this.assertTaskIsActive(taskId);
    this.assertNetworkPolicyStable(taskId);
    return task;
  }

  async assertTaskMutationAllowed(
    taskId: string,
    userId: string
  ): Promise<void> {
    await this.requireMutableTaskRecord(taskId, userId);
  }

  private async assertUserIsActive(userId: string): Promise<void> {
    if (this.retiringUsers.has(userId)) {
      throw new WorkConflictError('This user is being deleted.');
    }
    if (!(await getWorkPersistence().userCanUseWork(userId))) {
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

  async beginNetworkPolicyChange(
    taskId: string,
    userId: string
  ): Promise<WorkTaskRecord> {
    const task = await this.requireMutableTaskRecord(taskId, userId);
    if (await this.getActiveRun(taskId)) {
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

  async beginPreview(
    taskId: string,
    userId: string,
    allowActiveRun = false
  ): Promise<void> {
    await this.requireMutableTaskRecord(taskId, userId);
    try {
      await getWorkPersistence().beginPreview({
        taskId,
        userId,
        allowActiveRun,
        limits: workAdmissionLimits,
        updatedAt: Date.now(),
      });
    } catch (error) {
      throw translatePersistenceError(error, true);
    }
  }

  async getTaskDetail(
    taskId: string,
    userId: string
  ): Promise<WorkTaskDetail | undefined> {
    const row = await getWorkPersistence().findTask(taskId, userId);
    return row ? this.detailFromRow(row) : undefined;
  }

  async requireTaskDetail(
    taskId: string,
    userId: string
  ): Promise<WorkTaskDetail> {
    const task = await this.getTaskDetail(taskId, userId);
    if (!task) {
      throw new WorkNotFoundError();
    }
    return task;
  }

  async getTaskRecord(
    taskId: string,
    userId: string
  ): Promise<WorkTaskRecord | undefined> {
    const row = await getWorkPersistence().findTask(taskId, userId);
    return row ? mapTaskRecord(row) : undefined;
  }

  async requireTaskRecord(
    taskId: string,
    userId: string
  ): Promise<WorkTaskRecord> {
    const task = await this.getTaskRecord(taskId, userId);
    if (!task) {
      throw new WorkNotFoundError();
    }
    return task;
  }

  async updateTask(
    taskId: string,
    userId: string,
    updates: {
      title?: string;
      model?: string;
      providerType?: WorkProviderType;
      providerId?: string;
      networkEnabled?: boolean;
    }
  ): Promise<WorkTaskDetail> {
    const task = await this.requireMutableTaskRecord(taskId, userId);
    if (
      updates.networkEnabled !== undefined &&
      updates.networkEnabled !== task.networkEnabled &&
      (await this.getActiveRun(taskId))
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
    try {
      await getWorkPersistence().updateTask({
        taskId,
        userId,
        title,
        model,
        providerType: provider.providerType,
        providerId: provider.providerId || null,
        networkEnabled,
        updatedAt: Date.now(),
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
    return this.requireTaskDetail(taskId, userId);
  }

  async commitNetworkChange(
    taskId: string,
    userId: string,
    updates: {
      title?: string;
      model?: string;
      providerType?: WorkProviderType;
      providerId?: string;
      networkEnabled: boolean;
    }
  ): Promise<void> {
    await this.assertUserIsActive(userId);
    const task = await this.requireTaskRecord(taskId, userId);
    this.assertTaskIsActive(taskId);
    if (!this.networkPolicyChanges.has(taskId)) {
      throw new WorkConflictError(
        'This Work task has no active network policy change.'
      );
    }
    if (
      updates.networkEnabled !== task.networkEnabled &&
      (await this.getActiveRun(taskId))
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
    try {
      await getWorkPersistence().updateTask({
        taskId,
        userId,
        title,
        model,
        providerType: provider.providerType,
        providerId: provider.providerId || null,
        networkEnabled: updates.networkEnabled,
        updatedAt: Date.now(),
        requireNetworkChangeLease: true,
      });
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async deleteTask(taskId: string, userId: string): Promise<WorkTaskRecord> {
    const task = await this.requireTaskRecord(taskId, userId);
    if (!(await getWorkPersistence().deleteTask(taskId, userId))) {
      throw new WorkNotFoundError();
    }
    return task;
  }

  async addMessage(
    taskId: string,
    runId: string | undefined,
    role: WorkMessage['role'],
    kind: WorkMessage['kind'],
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<WorkMessage> {
    const id = randomUUID();
    const createdAt = Date.now();
    const boundedContent = boundUtf8(content, WORK_MESSAGE_MAX_BYTES);
    const serializedMetadata = serializeMetadata(metadata);
    const messageIndex = await getWorkPersistence().insertMessage({
      id,
      task_id: taskId,
      run_id: runId || null,
      role,
      kind,
      content: boundedContent,
      metadata: serializedMetadata || null,
      created_at: createdAt,
    });
    return {
      id,
      taskId,
      runId,
      messageIndex,
      role,
      kind,
      content: boundedContent,
      metadata: serializedMetadata ? metadata : undefined,
      createdAt,
    };
  }

  /**
   * A user message sent while a run is active: it joins the conversation
   * immediately and the agent picks it up at the next round boundary — no
   * need to stop the run (or lose the screen) to talk to the agent.
   */
  async addUserMessageToActiveRun(
    taskId: string,
    userId: string,
    content: string
  ): Promise<WorkMessage> {
    await this.requireMutableTaskRecord(taskId, userId);
    const run = await this.getActiveRun(taskId);
    if (!run) {
      throw new WorkConflictError(
        'This Work task has no active run. Send the message as a new run instead.'
      );
    }
    return this.addMessage(taskId, run.id, 'user', 'message', content, {
      midRun: true,
    });
  }

  async getMessages(taskId: string): Promise<WorkMessage[]> {
    const rows = await getWorkPersistence().listMessages({
      taskId,
      mode: 'all',
    });
    return rows.map(mapMessage);
  }

  async getRecentConversationMessages(
    taskId: string,
    limit = 30
  ): Promise<WorkMessage[]> {
    const boundedLimit = Math.min(30, Math.max(1, Math.trunc(limit)));
    const rows = await getWorkPersistence().listMessages({
      taskId,
      mode: 'conversation',
      limit: boundedLimit,
    });
    const selected: MessageRow[] = [];
    let selectedBytes = 0;
    for (const row of rows) {
      const bytes = contextRowBytes(row);
      if (bytes === undefined) {
        continue;
      }
      if (selectedBytes + bytes > WORK_CONTEXT_MAX_BYTES) {
        break;
      }
      selected.push(row);
      selectedBytes += bytes;
    }
    return selected.reverse().map(mapMessage);
  }

  async getRecentModelContextMessages(
    taskId: string,
    limit = 30
  ): Promise<WorkMessage[]> {
    const boundedLimit = Math.min(30, Math.max(1, Math.trunc(limit)));
    const rowLimit = boundedLimit * 6;
    const rows = await getWorkPersistence().listMessages({
      taskId,
      mode: 'model-context',
      limit: rowLimit,
    });
    const selected: MessageRow[] = [];
    let selectedBytes = 0;
    for (const row of rows) {
      const bytes = contextRowBytes(row);
      if (bytes === undefined) {
        continue;
      }
      if (selectedBytes + bytes > WORK_CONTEXT_MAX_BYTES) {
        break;
      }
      selected.push(row);
      selectedBytes += bytes;
    }
    const chronological = selected.reverse();
    while (
      chronological[0]?.kind === 'provider_state' ||
      chronological[0]?.kind === 'tool_result'
    ) {
      chronological.shift();
    }
    return chronological.map(mapMessage);
  }

  async getMessagePage(
    taskId: string,
    before?: number,
    limit = WORK_MESSAGE_PAGE_SIZE
  ): Promise<WorkMessagePage> {
    const pageSize = Math.min(
      WORK_MESSAGE_PAGE_SIZE,
      Math.max(1, Math.trunc(limit))
    );
    const rows = await getWorkPersistence().listMessages({
      taskId,
      mode: 'page',
      before,
      limit: pageSize + 1,
    });
    const selectedRows: MessageRow[] = [];
    let selectedBytes = 0;
    let examinedRows = 0;
    let lastExaminedIndex: number | undefined;
    for (const row of rows.slice(0, pageSize)) {
      const bytes = messageRowBytes(row);
      if (bytes === undefined) {
        examinedRows += 1;
        lastExaminedIndex = row.message_index;
        continue;
      }
      if (selectedBytes + bytes > WORK_MESSAGE_PAGE_MAX_BYTES) {
        break;
      }
      selectedRows.push(row);
      selectedBytes += bytes;
      examinedRows += 1;
      lastExaminedIndex = row.message_index;
    }
    const hasMore = rows.length > examinedRows;
    const pageRows = selectedRows.reverse();
    return {
      messages: pageRows.map(mapMessage),
      cursor: hasMore ? lastExaminedIndex : undefined,
      hasMore,
    };
  }

  async getRun(runId: string): Promise<WorkRun | undefined> {
    const row = await getWorkPersistence().findRun(runId);
    return row ? mapRun(row) : undefined;
  }

  async getActiveRun(taskId: string): Promise<WorkRun | undefined> {
    const row = await getWorkPersistence().findActiveRun(taskId);
    return row ? mapRun(row) : undefined;
  }

  async updateRun(
    runId: string,
    status: WorkRunStatus,
    options: { error?: string; started?: boolean; finished?: boolean } = {}
  ): Promise<WorkRun> {
    const now = Date.now();
    await getWorkPersistence().updateRun({
      runId,
      status,
      error: options.error ? replaceWorkTextNul(options.error) : null,
      started: Boolean(options.started),
      finished: Boolean(options.finished),
      now,
    });
    const run = await this.getRun(runId);
    if (!run) {
      throw new WorkNotFoundError('Work run not found.');
    }
    return run;
  }

  async updateTaskStatus(
    taskId: string,
    status: WorkTaskStatus,
    statusBlurb?: string | null
  ): Promise<void> {
    await getWorkPersistence().updateTaskStatus(
      taskId,
      status,
      Date.now(),
      statusBlurb
    );
  }

  async markTaskSeen(taskId: string, userId: string): Promise<void> {
    await getWorkPersistence().markTaskSeen(taskId, userId, Date.now());
  }

  /** Per-task approvals opt-in; null clears back to the default (off). */
  async setTaskApprovals(
    taskId: string,
    userId: string,
    enabled: boolean | null
  ): Promise<void> {
    const updated = await getWorkPersistence().setTaskApprovals(
      taskId,
      userId,
      enabled === null ? null : enabled ? 1 : 0,
      Date.now()
    );
    if (!updated) {
      throw new WorkNotFoundError();
    }
  }

  async updatePreview(
    taskId: string,
    status: WorkPreviewStatus,
    previewUrl?: string,
    upstream?: { host: string; port: number }
  ): Promise<void> {
    await getWorkPersistence().updatePreview(
      taskId,
      status,
      previewUrl || null,
      upstream?.host ?? null,
      upstream?.port ?? null,
      Date.now()
    );
  }

  async recoverOnStartup(): Promise<{
    tasks: WorkTaskRecord[];
    interruptedRuns: number;
    activePreviews: number;
  }> {
    let recovered;
    try {
      recovered = await getWorkPersistence().recoverOnStartup(Date.now());
    } catch (error) {
      logger.error('Failed to read Work tasks for startup recovery:', error);
      // Without the complete task inventory we cannot prove that every
      // preexisting command or preview container has been stopped. Abort
      // startup instead of allowing Work to run without supervision.
      throw error;
    }

    if (recovered.persistenceError) {
      // Container teardown is the security-critical half of recovery. Return
      // the rows already read even if SQLite cannot persist terminal states,
      // so startup can still stop every known command and preview process.
      logger.error(
        'Failed to persist recovered Work state on startup:',
        recovered.persistenceError
      );
    }
    return {
      tasks: recovered.tasks.map(mapTaskRecord),
      interruptedRuns: recovered.interruptedRuns,
      activePreviews: recovered.activePreviews,
    };
  }

  private async detailFromRow(row: TaskRow): Promise<WorkTaskDetail> {
    const messagePage = await this.getMessagePage(row.id);
    return {
      ...(await this.summaryFromRow(row)),
      messages: messagePage.messages,
      messageCursor: messagePage.cursor,
      hasMoreMessages: messagePage.hasMore,
    };
  }

  private async summaryFromRow(row: TaskRow): Promise<WorkTaskSummary> {
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
      activeRun: await this.getActiveRun(row.id),
      previewUrl: row.preview_url || undefined,
      previewStatus: row.preview_status,
      workspacePath: '/workspace',
      hostPath: row.host_path || undefined,
      policyId: row.policy_id || undefined,
      computerAvailable: await this.policyEnablesComputer(row.policy_id),
      personaId: row.persona_id || undefined,
      statusBlurb: row.status_blurb || undefined,
      isAgent: row.is_agent === 1,
      lastSeenAt: row.last_seen_at ?? undefined,
      approvalsEnabled:
        row.approvals_enabled === null
          ? undefined
          : row.approvals_enabled === 1,
    };
  }

  /**
   * Whether a task's policy grants the Work Computer. Policy-less tasks run
   * on the global defaults, which never enable the GUI. Fails closed.
   */
  private async policyEnablesComputer(
    policyId: string | null
  ): Promise<boolean> {
    if (!policyId) return false;
    try {
      const { default: workPolicyService } =
        await import('./workPolicyService.js');
      return (await workPolicyService.resolve(policyId)).guiEnabled === true;
    } catch {
      return false;
    }
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

export class WorkInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'WorkInputError';
  }
}

const translatePersistenceError = (
  error: unknown,
  previewContext = false
): unknown => {
  if (!(error instanceof WorkPersistenceError)) return error;
  switch (error.code) {
    case 'WORK_USER_FORBIDDEN':
      return new WorkForbiddenError();
    case 'WORK_USER_TASK_LIMIT':
      return new WorkAdmissionError(
        `This administrator already has the maximum of ${workAdmissionLimits.maxTasksPerUser} Work tasks.`,
        error.code
      );
    case 'WORK_GLOBAL_TASK_LIMIT':
      return new WorkAdmissionError(
        `This Libre WebUI instance already has the maximum of ${workAdmissionLimits.maxTasksGlobal} Work tasks.`,
        error.code
      );
    case 'WORK_USER_RUNTIME_LIMIT':
      return new WorkAdmissionError(
        `This administrator already has ${workAdmissionLimits.maxActiveRuntimesPerUser} active Work runtime(s). Wait for a run or preview to stop.`,
        error.code
      );
    case 'WORK_GLOBAL_RUNTIME_LIMIT':
      return new WorkAdmissionError(
        `This Libre WebUI instance already has ${workAdmissionLimits.maxActiveRuntimesGlobal} active Work runtime(s). Wait for a run or preview to stop.`,
        error.code
      );
    case 'WORK_ACTIVE_RUN':
      return new WorkConflictError(
        previewContext
          ? 'Wait for the active Work run to finish before starting a preview.'
          : 'This Work task already has an active run.'
      );
    case 'WORK_PREVIEW_ACTIVE':
      return new WorkConflictError(
        'Stop this Work task preview before starting another run.'
      );
    case 'WORK_TASK_NOT_FOUND':
      return new WorkNotFoundError();
    default:
      return error;
  }
};

/**
 * Deterministic one-line status for the agent sidebar: the first non-empty
 * line of a run's final assistant message, stripped of leading markdown
 * emphasis and bounded to 90 characters. Returns null when nothing usable
 * remains so callers can leave the previous blurb in place.
 */
export const deriveStatusBlurb = (text: string): string | null => {
  const line =
    text
      .split('\n')
      .map(candidate => candidate.trim())
      .find(candidate => candidate.length > 0) ?? '';
  const cleaned = line
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/\*\*/g, '')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > 90 ? `${cleaned.slice(0, 89).trimEnd()}…` : cleaned;
};

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
  hostPath: row.host_path || undefined,
  policyId: row.policy_id || undefined,
  previewUrl: row.preview_url || undefined,
  previewStatus: row.preview_status,
  previewUpstreamHost: row.preview_upstream_host || undefined,
  previewUpstreamPort: row.preview_upstream_port || undefined,
  personaId: row.persona_id || undefined,
  statusBlurb: row.status_blurb || undefined,
  isAgent: row.is_agent === 1,
  lastSeenAt: row.last_seen_at ?? undefined,
  approvalsEnabled:
    row.approvals_enabled === null ? undefined : row.approvals_enabled === 1,
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
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > WORK_MESSAGE_METADATA_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const serializeMetadata = (
  metadata?: Record<string, unknown>
): string | undefined => {
  if (!metadata) return undefined;
  const serialized = JSON.stringify(metadata);
  return Buffer.byteLength(serialized, 'utf8') <=
    WORK_MESSAGE_METADATA_MAX_BYTES
    ? serialized
    : undefined;
};

const contextRowBytes = (row: MessageRow): number | undefined => {
  const totalBytes = messageRowBytes(row);
  return totalBytes !== undefined && totalBytes <= WORK_CONTEXT_MAX_BYTES
    ? totalBytes
    : undefined;
};

const messageRowBytes = (row: MessageRow): number | undefined => {
  const contentBytes = Buffer.byteLength(row.content, 'utf8');
  const metadataBytes = Buffer.byteLength(row.metadata || '', 'utf8');
  if (
    contentBytes > WORK_MESSAGE_MAX_BYTES ||
    metadataBytes > WORK_MESSAGE_METADATA_MAX_BYTES
  ) {
    return undefined;
  }
  return contentBytes + metadataBytes;
};

const deriveTitle = (message: string): string => {
  const firstLine = message.trim().split(/\r?\n/, 1)[0] || 'New Work';
  return cleanTitle(firstLine.slice(0, 80));
};

const rejectWorkTextNul = (value: string, field: string): string => {
  if (value.includes('\u0000')) {
    throw new WorkInputError(`${field} cannot contain U+0000.`);
  }
  return value;
};

const cleanTitle = (value: string): string =>
  replaceWorkTextNul(value).trim().slice(0, 120) || 'New Work';

const cleanRequired = (value: string): string => {
  const cleaned = rejectWorkTextNul(value, 'Work model').trim();
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
