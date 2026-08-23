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

import workModelProviderService, {
  WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY,
  WORK_TOOL_ARGUMENTS_ERROR_MESSAGE,
} from './workModelProviderService.js';
import workEventService from './workEventService.js';
import {
  buildWorkAgentSystemPrompt,
  buildWorkBudgetExhaustionPrompt,
  buildWorkComputerAmbiguityPrompt,
  buildWorkComputerStallPrompt,
  buildWorkEmptyRoundNudgePrompt,
  buildWorkStatusBlurbPrompt,
  workAgentSkillsForContext,
  WORK_WRITE_FILE_RECOMMENDED_CHARS,
  workToolCallBudget,
} from './workAgentGuidance.js';
import workPolicyService from './workPolicyService.js';
import workRuntimeService, {
  WORK_COMPUTER_ACTION_LIMIT,
  WorkCommandResult,
  WorkComputerObservation,
} from './workRuntimeService.js';
import workScreenControlService, {
  WORK_SCREEN_ASSIST_TIMEOUT_MS,
} from './workScreenControlService.js';
import workComputerTeachService from './workComputerTeachService.js';
import {
  isWebSearchAvailable,
  userCanUseWebSearch,
  webSearch,
} from './webSearchService.js';
import { userModel } from '../models/userModel.js';
import workTaskService, {
  WORK_MESSAGE_METADATA_MAX_BYTES,
  WorkConflictError,
  WorkNotFoundError,
  deriveStatusBlurb,
} from './workTaskService.js';
import { OllamaChatMessage, OllamaChatResponse } from '../types/index.js';
import {
  WorkMessage,
  WorkRun,
  WorkTaskDetail,
  WorkTaskRecord,
  WorkToolCall,
} from '../types/work.js';
import { createLogger } from '../utils/logger.js';
import { getDurableJobRuntime } from '../platform/jobs/durableJobRuntime.js';
import {
  boundedOpenAIResponsesOutputItems,
  OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY,
  OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY,
  OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY,
} from '../utils/openAIResponsesAdapter.js';
import {
  OWNER_DELETE_CONTENT_JOB_TYPE,
  WORK_EXECUTE_IDEMPOTENCY_SCOPE,
} from '../platform/jobs/domainJobContracts.js';

const logger = createLogger('services:work-agent');
export const WORK_PROVIDER_STATE_METADATA_KEY = 'workProviderState';
export const WORK_EMPTY_MODEL_RESPONSE_METADATA_KEY = 'emptyModelResponse';
// A reasoning-heavy model occasionally ends a round with neither text nor
// tool calls. Treating that as the final answer strands the run mid-task,
// so nudge it back to work a bounded number of times per run first.
const WORK_EMPTY_ROUND_NUDGE_LIMIT = 2;
// Cross-run replay only needs the shape of past tool calls, not full
// write_file payloads; bound each persisted argument set.
const WORK_CHAT_TOOL_CALL_ARGUMENTS_MAX_BYTES = 4_096;
// Persona instructions share the taught-skill bound so one persona cannot
// crowd the working context out of the system prompt.
const PERSONA_INSTRUCTION_MAX_CHARS = 6_000;
// A finished run should surface promptly: the colloquial status line is a
// nicety, never worth holding the terminal event beyond this bound.
const WORK_STATUS_BLURB_TIMEOUT_MS = 8_000;
const INTERRUPTED_TOOL_RESULT =
  'Tool execution was interrupted; outcome unknown. Inspect the workspace before retrying.';

export const WORK_TOOL_SCHEMAS: Record<string, unknown>[] = [
  functionTool('list_files', 'List direct children of a workspace directory.', {
    path: stringProperty(
      'Relative directory path. Defaults to workspace root.'
    ),
  }),
  functionTool(
    'read_file',
    'Read a UTF-8 text file from the persistent workspace.',
    { path: stringProperty('Relative file path.') },
    ['path']
  ),
  functionTool(
    'write_file',
    'Create or replace a UTF-8 text file in the persistent workspace.',
    {
      path: stringProperty('Relative file path.'),
      content: stringProperty(
        `Complete file content. Keep one write below ${WORK_WRITE_FILE_RECOMMENDED_CHARS.toLocaleString('en-US')} characters and split larger implementations into focused files.`
      ),
    },
    ['path', 'content']
  ),
  functionTool(
    'delete_file',
    'Delete a workspace file or directory. Directories require recursive: true. Works while a preview is running.',
    {
      path: stringProperty('Relative file or directory path.'),
      recursive: {
        type: 'boolean',
        description:
          'Required as true to delete a directory with its contents.',
      },
    },
    ['path']
  ),
  functionTool(
    'move_file',
    'Move or rename a workspace file or directory. Destination parents are created; an existing destination is never overwritten. Works while a preview is running.',
    {
      from: stringProperty('Relative source path.'),
      to: stringProperty('Relative destination path.'),
    },
    ['from', 'to']
  ),
  functionTool(
    'search_files',
    'Search text recursively in workspace files.',
    {
      query: stringProperty('Literal text to find.'),
      path: stringProperty(
        'Relative directory path. Defaults to workspace root.'
      ),
    },
    ['query']
  ),
  functionTool(
    'run_command',
    'Run a shell command inside the isolated workspace container.',
    {
      command: stringProperty('Shell command to run from /workspace.'),
      timeout_ms: {
        type: 'integer',
        description: 'Optional timeout in milliseconds, capped at 600000.',
      },
    },
    ['command']
  ),
  functionTool(
    'start_preview',
    'Start the workspace web application on the managed preview port. When command is omitted, Libre WebUI detects a package.json dev script or a static index.html.',
    {
      command: stringProperty(
        `Optional custom server command. It must listen on 0.0.0.0:${workRuntimeService.previewPort}.`
      ),
    }
  ),
  functionTool('stop_preview', 'Stop the running workspace preview.', {}),
];

// Offered per run, only when an administrator enabled web search and the
// task has network access: an "offline" task should stay offline even
// though the search request itself egresses from the backend.
export const WORK_WEB_SEARCH_TOOL_SCHEMA: Record<string, unknown> =
  functionTool(
    'web_search',
    'Search the web through the server-configured search engine. Returns titles, URLs, and snippets.',
    {
      query: stringProperty('Search query.'),
      max_results: {
        type: 'integer',
        description:
          "Optional result count. Defaults to 5, capped by the server's configured limit.",
      },
    },
    ['query']
  );

// Offered only when the task's policy enables the Work Computer and the
// task has network access: the agent's eyes and hands on the GUI session.
export const WORK_COMPUTER_TOOL_SCHEMAS: Record<string, unknown>[] = [
  functionTool(
    'computer_observe',
    "Look at the task's virtual computer screen. Returns the current screenshot with the cursor position, active window, page URL, and which element holds keyboard focus.",
    {}
  ),
  functionTool(
    'computer_act',
    'Perform batched mouse and keyboard actions on the virtual computer, then return the screenshot after they settle. The batch stops early (and tells you) if the window, title, or window count changes mid-batch — later coordinates would target the previous screen — or if a "focus" assertion fails.',
    {
      actions: {
        type: 'array',
        description:
          `Up to ${WORK_COMPUTER_ACTION_LIMIT} actions executed in order. Each action is an object with "type" plus type-specific fields: ` +
          'move {x,y}; click / double_click / right_click {x,y optional — clicks the current position without them}; ' +
          'type {text}; key {keys, an xdotool name or chord such as "Return" or "ctrl+l"}; ' +
          'scroll {direction: "up"|"down", amount optional, x,y optional}; ' +
          'scroll_until {direction, target: {text} or {edge: "top"|"bottom"}, maxAmount optional ≤30, x,y optional} — goal-directed scrolling that stops when the target text is visible and reports a visibility receipt, always preferable to blind scroll amounts; ' +
          'wait {ms, at most 5000}. ' +
          'type and key accept an optional "focus" string: the action runs only when the focused element, page URL, or window title contains it — use it before typing anything that must land in a specific field. ' +
          'Clicks at explicit coordinates return a receipt saying whether pixels near the click changed.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [
                'move',
                'click',
                'double_click',
                'right_click',
                'type',
                'key',
                'scroll',
                'scroll_until',
                'wait',
              ],
            },
            x: { type: 'integer' },
            y: { type: 'integer' },
            text: { type: 'string' },
            keys: { type: 'string' },
            focus: { type: 'string' },
            direction: { type: 'string', enum: ['up', 'down'] },
            amount: { type: 'integer' },
            maxAmount: { type: 'integer' },
            target: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                edge: { type: 'string', enum: ['top', 'bottom'] },
              },
            },
            ms: { type: 'integer' },
          },
          required: ['type'],
        },
      },
      subgoal: {
        type: 'string',
        description:
          'One short sentence naming what this batch is meant to achieve (e.g. "open the settings page"). Persisted with the result as a checkpoint, and echoed back if the loop needs to recover — declare it on every consequential batch.',
      },
      expect: {
        type: 'object',
        description:
          'Optional expected outcome, verified by the runtime after the batch settles (polled up to withinMs, default 5000). ' +
          'Declare it for any consequential batch so you learn whether the intent succeeded, not merely that input was delivered. ' +
          '"pending" in the result means not observed before the deadline — re-observe before assuming failure.',
        properties: {
          titleContains: {
            type: 'string',
            description: 'The active window title should contain this text.',
          },
          urlContains: {
            type: 'string',
            description: 'The browser URL should contain this text.',
          },
          regionChanged: {
            type: 'object',
            description:
              'Pixels in this screen region should change relative to the start of the batch.',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
            },
            required: ['x', 'y', 'width', 'height'],
          },
          withinMs: { type: 'integer' },
        },
      },
    },
    ['actions']
  ),
  functionTool(
    'request_takeover',
    'Ask the user to take control of the virtual computer screen — for signing in, a CAPTCHA, 2FA, or any step you must not perform yourself. Waits until the user finishes and hands control back (or a timeout passes). While the user is driving, your computer tools are blocked.',
    {
      reason: stringProperty(
        'What you need the user to do on the screen, stated concretely.'
      ),
    },
    ['reason']
  ),
];

export async function workToolSchemasForTask(task: {
  networkEnabled: boolean;
  userId: string;
  policyId?: string | null;
}): Promise<Record<string, unknown>[]> {
  const schemas = [...WORK_TOOL_SCHEMAS];
  if (
    task.networkEnabled &&
    (await isWebSearchAvailable()) &&
    (await userCanUseWebSearch(await userModel.getUserById(task.userId)))
  ) {
    schemas.push(WORK_WEB_SEARCH_TOOL_SCHEMA);
  }
  if (await workRuntimeService.computerToolsAvailable(task)) {
    schemas.push(...WORK_COMPUTER_TOOL_SCHEMAS);
  }
  return schemas;
}

export class WorkAgentService {
  private controllers = new Map<string, AbortController>();
  private executions = new Map<string, Promise<void>>();

  start(taskId: string, runId: string, userId: string): void {
    queueMicrotask(() => {
      const execution = this.execute(taskId, runId, userId)
        .catch(error => {
          logger.error(`Unhandled Work run failure for ${runId}:`, error);
        })
        .finally(() => {
          if (this.executions.get(runId) === execution) {
            this.executions.delete(runId);
          }
        });
      this.executions.set(runId, execution);
    });
  }

  /**
   * Durable worker entrypoint. An interrupted active run is moved back to the
   * queue while its persisted provider/tool transcript is retained. Missing
   * tool results are restored as "outcome unknown", so the exact external
   * call is not blindly replayed after a worker crash.
   */
  async executeDurable(
    taskId: string,
    runId: string,
    userId: string
  ): Promise<void> {
    const task = await workTaskService.requireTaskRecord(taskId, userId);
    const run = await workTaskService.getRun(runId);
    if (!run || run.taskId !== taskId) {
      throw new WorkNotFoundError('Work run not found.');
    }
    if (!isActiveRunStatus(run.status)) return;
    if (run.status !== 'queued') {
      // A worker can disappear while its sandbox continues running. Fence all
      // other lifecycle operations, stop that unknown execution, and only then
      // reconcile the durable transcript. Replaying against the old container
      // would allow both workers to mutate one workspace concurrently.
      workRuntimeService.beginTaskSuspension(taskId);
      try {
        await workRuntimeService.interruptContainer(task);
      } finally {
        workRuntimeService.releaseTaskSuspension(taskId);
      }
      await this.reconcileInterruptedToolCalls(taskId, runId);
      await workTaskService.updateRun(runId, 'queued');
      // Tasks deliberately have no queued state: idle means durable work is
      // admitted but no container/provider side effect has started yet.
      await workTaskService.updateTaskStatus(taskId, 'idle');
    }
    await this.execute(taskId, runId, userId);
  }

  /**
   * Materialize every tool intent whose worker disappeared before its result
   * commit. This must run while the caller owns the durable job lease. The
   * persisted result is both user-visible and part of the next model request;
   * checking the transcript first makes a crash after the insert safe to
   * reclaim without duplicating the result.
   */
  async reconcileInterruptedToolCalls(
    taskId: string,
    runId: string
  ): Promise<number> {
    const messages = await workTaskService.getMessages(taskId);
    const settled = new Set(
      messages
        .filter(
          message =>
            message.runId === runId &&
            message.role === 'tool' &&
            message.kind === 'tool_result'
        )
        .map(message => message.metadata?.toolCallId)
        .filter((value): value is string =>
          Boolean(typeof value === 'string' && value)
        )
    );
    const pending = new Map<string, { name: string; message: WorkMessage }>();
    for (const message of messages) {
      if (message.runId !== runId || message.kind !== 'tool_call') continue;
      const toolCallId = message.metadata?.toolCallId;
      const name = message.metadata?.name;
      if (
        typeof toolCallId !== 'string' ||
        !toolCallId ||
        typeof name !== 'string' ||
        !name ||
        settled.has(toolCallId)
      ) {
        continue;
      }
      pending.set(toolCallId, { name, message });
    }

    let reconciled = 0;
    for (const [toolCallId, { name }] of pending) {
      if (settled.has(toolCallId)) continue;
      const metadata = {
        name,
        toolName: name,
        toolCallId,
        error: true,
        outcomeUnknown: true,
        interrupted: true,
      };
      const result = await workTaskService.addMessage(
        taskId,
        runId,
        'tool',
        'tool_result',
        INTERRUPTED_TOOL_RESULT,
        metadata
      );
      settled.add(toolCallId);
      reconciled += 1;
      await workEventService.publish(
        taskId,
        runId,
        'tool_result',
        {
          toolCallId,
          name,
          phase: 'failed',
          content: INTERRUPTED_TOOL_RESULT,
          error: true,
          outcomeUnknown: true,
          message: result,
        },
        `message:${result.id}`
      );
    }
    return reconciled;
  }

  async cancel(taskId: string, userId: string): Promise<WorkTaskDetail> {
    const task = await workTaskService.requireMutableTaskRecord(taskId, userId);
    return this.cancelTask(task, userId);
  }

  async removeTask(taskId: string, userId: string): Promise<void> {
    await this.removeTaskInternal(taskId, userId, false);
  }

  private async cancelTask(
    task: WorkTaskRecord,
    userId: string
  ): Promise<WorkTaskDetail> {
    const taskId = task.id;
    const run = await workTaskService.getActiveRun(taskId);
    if (!run) {
      throw new WorkConflictError('This Work task has no active run.');
    }
    this.controllers.get(run.id)?.abort();
    await workRuntimeService.stopContainer(task);
    await this.executions.get(run.id);
    if (isActiveRunStatus((await workTaskService.getRun(run.id))?.status)) {
      await workTaskService.updateRun(run.id, 'cancelled', {
        error: 'Cancelled by user.',
        finished: true,
      });
      await workTaskService.updateTaskStatus(taskId, 'cancelled');
      await workTaskService.updatePreview(taskId, 'stopped');
      await workEventService.publish(
        taskId,
        run.id,
        'done',
        {
          status: 'cancelled',
          error: 'Cancelled by user.',
        },
        'terminal:cancelled'
      );
    }
    return workTaskService.requireTaskDetail(taskId, userId);
  }

  async removeTasksForUser(userId: string): Promise<void> {
    await workTaskService.withUserLifecycleLease(userId, async assertHeld => {
      workTaskService.beginUserRetirement(userId);
      try {
        await this.removeTasksWithRetirementHeld(userId, assertHeld);
      } finally {
        workTaskService.releaseUserRetirement(userId);
      }
    });
  }

  /**
   * Persist a cross-replica account fence before deleting external state.
   * A failed drain deliberately leaves the account `retiring`, so a retry can
   * continue while authentication and all new Work admission stay denied.
   */
  async retireAndDeleteUser(
    userId: string,
    actorUserId: string
  ): Promise<boolean> {
    return workTaskService.withUserLifecycleLease(userId, async assertHeld => {
      workTaskService.beginUserRetirement(userId);
      try {
        await assertHeld();
        if (!(await userModel.beginUserRetirement(userId))) return false;
        await this.drainDurableJobsForUser(userId);
        await this.removeTasksWithRetirementHeld(userId, assertHeld);
        // Catch a request admitted before retirement that committed its job
        // after the first zero observation. Retiring actors cannot be claimed,
        // and this pass terminalizes any such late queue entry.
        await this.drainDurableJobsForUser(userId);
        await assertHeld();
        return userModel.deleteUserAndEnqueueCleanup(userId, actorUserId);
      } finally {
        workTaskService.releaseUserRetirement(userId);
      }
    });
  }

  private async removeTasksWithRetirementHeld(
    userId: string,
    assertHeld: () => Promise<void> = async () => undefined
  ): Promise<void> {
    const tasks = await workTaskService.listTaskRecords(userId);
    for (const task of tasks) {
      await assertHeld();
      await this.removeTaskInternal(task.id, userId, true);
    }
  }

  private async drainDurableJobsForUser(userId: string): Promise<void> {
    const service = getDurableJobRuntime().service;
    const deadline = Date.now() + 60_000;
    while (true) {
      // Cleanup jobs initiated by this actor protect other already-deleted
      // owners. They retain audit attribution to the actor and must reach
      // success before this identity can disappear; cancelling them strands
      // the other owner's vectors/blobs forever.
      await service.cancelAllForActor(userId, 'actor-revoked', {
        excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
      });
      const ordinaryActive = await service.countActiveForActor(userId, {
        excludeJobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
      });
      const cleanupActive = await service.countActiveForActor(userId, {
        jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
      });
      const cleanupNotSucceeded = await service.countNonSucceededForActor(
        userId,
        {
          jobTypes: [OWNER_DELETE_CONTENT_JOB_TYPE],
          excludeHandledLifecycleJobs: true,
        }
      );
      if (
        ordinaryActive === 0 &&
        cleanupActive === 0 &&
        cleanupNotSucceeded === 0
      ) {
        return;
      }
      if (cleanupActive === 0 && cleanupNotSucceeded > 0) {
        throw new WorkConflictError(
          'This account remains retired because an initiated owner cleanup did not succeed.'
        );
      }
      if (Date.now() >= deadline) {
        throw new WorkConflictError(
          'This account remains retired while its jobs and initiated owner cleanups finish draining.'
        );
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async revokeWorkAccessForUser<T>(
    userId: string,
    revoke: () => Promise<T>
  ): Promise<T> {
    return workTaskService.withUserLifecycleLease(userId, assertHeld =>
      this.revokeWorkAccessWithLeaseHeld(userId, revoke, assertHeld)
    );
  }

  private async revokeWorkAccessWithLeaseHeld<T>(
    userId: string,
    revoke: () => Promise<T>,
    assertHeld: () => Promise<void>
  ): Promise<T> {
    workTaskService.beginUserRetirement(userId);
    const tasks = await workTaskService.listTaskRecords(userId);
    const suspendedTaskIds: string[] = [];
    try {
      for (const task of tasks) {
        workRuntimeService.beginTaskSuspension(task.id);
        suspendedTaskIds.push(task.id);
      }

      // Persist revocation before depending on Docker cleanup. Even when a
      // daemon outage prevents teardown, current-role authorization denies
      // every subsequent Work request and a retry/restart can finish cleanup.
      await assertHeld();
      const result = await revoke();
      const activeRuns = new Map(
        await Promise.all(
          tasks.map(
            async task =>
              [task.id, await workTaskService.getActiveRun(task.id)] as const
          )
        )
      );
      for (const run of activeRuns.values()) {
        if (run) this.controllers.get(run.id)?.abort();
      }

      const cleanupResults = await Promise.allSettled(
        tasks.map(async task => {
          const run = activeRuns.get(task.id);
          try {
            // Do not wait behind a helper or preview lifecycle operation before
            // revoking its execution. The task suspension above prevents new
            // work; the serialized stop below catches a concurrent create.
            await workRuntimeService.interruptContainer(task);
          } catch (error) {
            logger.warn(
              `Immediate Work interruption failed for task ${task.id}; retrying through the lifecycle queue:`,
              error
            );
          }
          await workRuntimeService.stopContainer(task);
          if (
            run &&
            isActiveRunStatus((await workTaskService.getRun(run.id))?.status)
          ) {
            await workTaskService.updateRun(run.id, 'cancelled', {
              error: 'Administrator access was revoked.',
              finished: true,
            });
            await workTaskService.updateTaskStatus(task.id, 'cancelled');
            await workEventService.publish(
              task.id,
              run.id,
              'done',
              {
                status: 'cancelled',
                error: 'Administrator access was revoked.',
              },
              'terminal:cancelled'
            );
          }
          await workTaskService.updatePreview(task.id, 'stopped');
          if (run) await this.executions.get(run.id);
        })
      );
      const cleanupFailure = cleanupResults.find(
        cleanupResult => cleanupResult.status === 'rejected'
      );
      if (cleanupFailure?.status === 'rejected') {
        throw cleanupFailure.reason;
      }
      return result;
    } finally {
      for (const taskId of suspendedTaskIds) {
        workRuntimeService.releaseTaskSuspension(taskId);
      }
      workTaskService.releaseUserRetirement(userId);
    }
  }

  releaseUserRetirement(userId: string): void {
    workTaskService.releaseUserRetirement(userId);
  }

  private async removeTaskInternal(
    taskId: string,
    userId: string,
    allowRetiringUser: boolean
  ): Promise<void> {
    const task = await workTaskService.beginTaskRetirement(
      taskId,
      userId,
      allowRetiringUser
    );
    try {
      if (await workTaskService.getActiveRun(taskId)) {
        await this.cancelTask(task, userId);
      }
      await workRuntimeService.removeTask(task, allowRetiringUser);
      try {
        await workTaskService.deleteTask(taskId, userId);
      } finally {
        workRuntimeService.finalizeTaskRemoval(taskId);
      }
      workTaskService.finalizeTaskRetirement(taskId);
    } catch (error) {
      workTaskService.releaseTaskRetirement(taskId);
      throw error;
    }
  }

  async shutdown(): Promise<{ stopped: number; failed: number }> {
    workRuntimeService.beginShutdown();
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    const tasks = await workTaskService.listAllTaskRecords();
    const results = await Promise.allSettled(
      tasks.map(task => workRuntimeService.stopContainer(task))
    );
    await Promise.allSettled(this.executions.values());
    return {
      stopped: results.filter(result => result.status === 'fulfilled').length,
      failed: results.filter(result => result.status === 'rejected').length,
    };
  }

  private async execute(
    taskId: string,
    runId: string,
    userId: string
  ): Promise<void> {
    const controller = new AbortController();
    const durableAttemptIdentity = String(
      (
        await getDurableJobRuntime().service.getByIdempotency(
          userId,
          WORK_EXECUTE_IDEMPOTENCY_SCOPE,
          runId
        )
      )?.attemptCount ?? 0
    );
    this.controllers.set(runId, controller);
    let task: WorkTaskRecord | undefined;
    let releaseExecutionLease: (() => void) | undefined;
    let executionContainerSettled = false;
    const settleExecutionContainer = async (): Promise<void> => {
      if (!task || executionContainerSettled) return;
      await this.cleanupExecutionContainer(task);
      executionContainerSettled = true;
    };
    try {
      task = await workTaskService.requireTaskRecord(taskId, userId);
      const run = await workTaskService.getRun(runId);
      if (!run || run.taskId !== taskId) {
        throw new WorkNotFoundError('Work run not found.');
      }
      // A cancel request can arrive in the microtask gap between persisting a
      // queued run and starting its executor. Never revive a terminal run.
      if (run.status !== 'queued') {
        return;
      }
      await workTaskService.updateRun(runId, 'preparing', { started: true });
      await workTaskService.updateTaskStatus(taskId, 'preparing');
      await workEventService.publish(
        taskId,
        runId,
        'run_state',
        {
          status: 'preparing',
          phase: 'preparing',
        },
        'transition:preparing',
        durableAttemptIdentity
      );
      const computerAvailable =
        await workRuntimeService.computerToolsAvailable(task);
      let taughtSkills: Array<{
        slug: string;
        name: string;
        instructions: string;
      }> = [];
      if (computerAvailable) {
        try {
          taughtSkills =
            await workComputerTeachService.taughtSkillsForUser(userId);
        } catch (error) {
          logger.warn(`Could not load taught skills for run ${runId}:`, error);
        }
      }
      let persona: { name: string; instructions?: string } | undefined;
      if (task.personaId) {
        try {
          const { personaService } = await import('./personaService.js');
          const record = await personaService.getBasicPersonaById(
            task.personaId,
            userId
          );
          if (record) {
            const instructions = record.parameters?.system_prompt
              ?.trim()
              .slice(0, PERSONA_INSTRUCTION_MAX_CHARS);
            persona = {
              name: record.name,
              ...(instructions ? { instructions } : {}),
            };
            await workEventService.publish(
              taskId,
              runId,
              'skill_loaded',
              {
                id: `persona:${record.id}`,
                name: record.name,
                description: 'Persona identity this agent runs under.',
              },
              `skill:persona:${record.id}`,
              durableAttemptIdentity
            );
          } else {
            logger.warn(
              `Persona ${task.personaId} for task ${taskId} is no longer accessible; running without it.`
            );
          }
        } catch (error) {
          logger.warn(`Could not load persona for run ${runId}:`, error);
        }
      }
      for (const skill of workAgentSkillsForContext({ computerAvailable })) {
        await workEventService.publish(
          taskId,
          runId,
          'skill_loaded',
          {
            id: skill.id,
            name: skill.title,
            description: skill.instructions[0],
          },
          `skill:${skill.id}`,
          durableAttemptIdentity
        );
      }
      for (const skill of taughtSkills) {
        await workEventService.publish(
          taskId,
          runId,
          'skill_loaded',
          {
            id: `taught:${skill.slug}`,
            name: skill.name,
            description: 'Taught procedure demonstrated by the user.',
          },
          `skill:taught:${skill.slug}`,
          durableAttemptIdentity
        );
      }
      releaseExecutionLease = await workRuntimeService.prepare(
        task,
        controller.signal
      );
      await this.throwIfCancelled(runId, controller);
      await workTaskService.updateRun(runId, 'running', { started: true });
      await workTaskService.updateTaskStatus(taskId, 'running');
      const roundLimit = workRuntimeService.limits.maxRounds;
      const toolCallLimit = workToolCallBudget(roundLimit);
      const providerSelection = {
        providerType: run.providerType,
        providerId: run.providerId,
      } as const;
      const providerRoutingFingerprint =
        await workModelProviderService.getRoutingFingerprint(
          run.model,
          providerSelection,
          userId
        );
      const providerStateScope =
        await workModelProviderService.getResponsesStateScope(
          run.model,
          providerSelection,
          userId
        );
      const messages = await this.contextMessages(
        task,
        roundLimit,
        computerAvailable,
        taughtSkills,
        providerStateScope,
        run,
        persona
      );
      let totalToolCalls = 0;
      let accumulatedInputTokens = 0;
      let accumulatedOutputTokens = 0;
      let streamedAssistantTotal = '';
      let streamedReasoningTotal = '';
      let budgetReason = 'round';
      let emptyRoundNudges = 0;
      // Computer-loop stall detection: an identical action against a screen
      // whose pixels did not change is the signature of a grounding loop —
      // a dead coordinate, a click that never lands. One recovery notice,
      // then a handoff, instead of burning the remaining rounds.
      let computerStallSignature = '';
      let computerStallRepeats = 0;
      let computerStallNudged = false;
      // Ambiguity budget: consecutive unverified expectations mean the loop
      // is acting on assumptions; one re-grounding notice before it
      // compounds.
      let consecutivePendingExpectations = 0;
      let ambiguityNudged = false;
      const computerContext: WorkComputerRunContext = {};
      const loopStats = {
        rounds: 0,
        toolCalls: 0,
        screenshots: 0,
        fences: 0,
        expectationsPassed: 0,
        expectationsPending: 0,
        stallNudges: 0,
        ambiguityNudges: 0,
      };
      // Reasoning-channel models (DeepSeek and friends) sometimes place
      // their entire answer in reasoning and leave content empty. Keep the
      // last reasoning so a run can end with the model's actual findings
      // instead of a placeholder.
      let lastReasoningContent = '';

      // Mid-run user messages join the model context at round boundaries,
      // so the user can steer the agent without cancelling the run. Seed
      // with what the restored context already contains so nothing repeats.
      const injectedMidRunMessages = new Set(
        (await workTaskService.getMessages(taskId))
          .filter(message => message.metadata?.midRun === true)
          .map(message => message.id)
      );
      roundLoop: for (let round = 0; round < roundLimit; round++) {
        await this.throwIfCancelled(runId, controller);
        loopStats.rounds = round + 1;
        for (const message of await workTaskService.getMessages(taskId)) {
          if (
            message.runId === runId &&
            message.role === 'user' &&
            message.kind === 'message' &&
            message.metadata?.midRun === true &&
            !injectedMidRunMessages.has(message.id)
          ) {
            injectedMidRunMessages.add(message.id);
            messages.push({ role: 'user', content: message.content });
          }
        }
        await workEventService.publish(
          taskId,
          runId,
          'run_state',
          {
            status: 'running',
            phase: 'thinking',
            round: round + 1,
            roundLimit,
          },
          `round:${round + 1}:thinking`,
          durableAttemptIdentity
        );
        const contentStream = new WorkDeltaPublisher(
          taskId,
          runId,
          'assistant_delta',
          streamedAssistantTotal,
          `round:${round + 1}`,
          durableAttemptIdentity
        );
        const reasoningStream = new WorkDeltaPublisher(
          taskId,
          runId,
          'reasoning_delta',
          streamedReasoningTotal,
          `round:${round + 1}`,
          durableAttemptIdentity
        );
        let roundInputTokens = 0;
        let roundOutputTokens = 0;
        const roundStartedAt = Date.now();
        let response: OllamaChatResponse;
        try {
          await this.assertStableProviderRouting(
            run,
            userId,
            providerRoutingFingerprint
          );
          response = await workModelProviderService.generateChatStreamResponse(
            {
              model: run.model,
              messages,
              tools: await workToolSchemasForTask(task),
              stream: true,
            },
            providerSelection,
            userId,
            {
              onContent: delta => contentStream.push(delta),
              onReasoning: delta => reasoningStream.push(delta),
              onUsage: usage => {
                roundInputTokens = usage.promptTokens ?? roundInputTokens;
                roundOutputTokens = usage.completionTokens ?? roundOutputTokens;
                void workEventService.publish(taskId, runId, 'usage', {
                  inputTokens: accumulatedInputTokens + roundInputTokens,
                  outputTokens: accumulatedOutputTokens + roundOutputTokens,
                  totalTokens:
                    accumulatedInputTokens +
                    roundInputTokens +
                    accumulatedOutputTokens +
                    roundOutputTokens,
                  durationMs: Date.now() - roundStartedAt,
                });
              },
            },
            controller.signal
          );
        } finally {
          contentStream.flush();
          reasoningStream.flush();
          streamedAssistantTotal = contentStream.currentTotal;
          streamedReasoningTotal = reasoningStream.currentTotal;
        }
        await this.throwIfCancelled(runId, controller);
        assertCompleteProviderResponse(response);
        accumulatedInputTokens += roundInputTokens;
        accumulatedOutputTokens += roundOutputTokens;
        const toolCalls = normalizeToolCalls(response);
        const boundedProviderOutput = boundedOpenAIResponsesOutputItems(
          response.message.providerMetadata?.[
            OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY
          ]
        );
        const providerMetadata = response.message.providerMetadata;
        const hasResponsesStateMetadata =
          providerMetadata?.[OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY] ===
            true ||
          providerMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY] !==
            undefined ||
          providerMetadata?.[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY] !==
            undefined;
        const providerStateMetadata = toPersistedWorkProviderState(
          run,
          providerMetadata
        );
        if (
          toolCalls.length > 0 &&
          (providerStateScope || hasResponsesStateMetadata) &&
          (providerMetadata?.[OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY] ===
            true ||
            !providerStateScope ||
            providerMetadata?.[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY] !==
              providerStateScope ||
            !boundedProviderOutput.items ||
            !providerStateMetadata)
        ) {
          throw new WorkAgentHttpError(
            'The provider returned tool calls without bounded durable replay state.',
            502,
            'WORK_PROVIDER_INVALID_TOOL_CALLS'
          );
        }
        totalToolCalls += toolCalls.length;
        if (totalToolCalls > toolCallLimit) {
          budgetReason = 'tool-call';
          break roundLoop;
        }
        const assistantContent = boundUtf8(
          response.message?.content?.trim() || '',
          100_000
        );
        const reasoningContent = boundUtf8(
          response.message?.thinking?.trim() || '',
          100_000
        );
        if (reasoningContent) {
          lastReasoningContent = reasoningContent;
          await workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'reasoning',
            reasoningContent,
            { providerExposed: true, round: round + 1 }
          );
        }
        if (toolCalls.length === 0) {
          if (
            !assistantContent &&
            emptyRoundNudges < WORK_EMPTY_ROUND_NUDGE_LIMIT
          ) {
            // A round with no text and no tool calls carries no result;
            // completing here would strand the run mid-task. Preserve any
            // provider replay state, then send the model back to work.
            emptyRoundNudges += 1;
            if (response.message.providerMetadata) {
              messages.push({
                role: 'assistant',
                content: '',
                providerMetadata: response.message.providerMetadata,
              });
            } else if (reasoningContent) {
              // Without provider replay state, dropping the turn makes the
              // model's reasoning vanish from its own context — it then
              // repeats itself until the nudges run out. Replay the
              // reasoning as the assistant turn so the nudge continues the
              // thought instead of restarting it.
              messages.push({
                role: 'assistant',
                content: reasoningContent,
              });
            }
            if (providerStateMetadata) {
              await workTaskService.addMessage(
                taskId,
                runId,
                'assistant',
                'provider_state',
                '',
                providerStateMetadata
              );
            }
            messages.push({
              role: 'user',
              content: buildWorkEmptyRoundNudgePrompt(),
            });
            continue;
          }
          // Fall back to the model's reasoning before the placeholder: a
          // reasoning-channel model's findings beat a dead-end notice. The
          // metadata flag below keeps either fallback out of future model
          // context.
          const finalContent =
            assistantContent ||
            lastReasoningContent ||
            'The model completed without returning a text response.';
          await workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'message',
            finalContent,
            assistantContent
              ? providerStateMetadata
              : {
                  // The placeholder tells the user what happened, but it is
                  // not something the model said; keep it out of future
                  // model context unless it carries provider replay state.
                  [WORK_EMPTY_MODEL_RESPONSE_METADATA_KEY]: true,
                  ...(providerStateMetadata ?? {}),
                }
          );
          // Keep completion hidden until the disposable container has either
          // stopped or been retained for a verified live preview. Consumers
          // can then refresh files immediately without racing teardown.
          await settleExecutionContainer();
          await this.throwIfCancelled(runId, controller);
          if (
            !isActiveRunStatus((await workTaskService.getRun(runId))?.status)
          ) {
            return;
          }
          const completedBlurb = await this.statusBlurbForRun(
            task,
            run,
            userId,
            finalContent,
            controller.signal
          );
          await workTaskService.updateRun(runId, 'completed', {
            finished: true,
          });
          await workTaskService.updateTaskStatus(
            taskId,
            'completed',
            completedBlurb
          );
          await workEventService.publish(
            taskId,
            runId,
            'done',
            {
              status: 'completed',
              loopStats,
            },
            'terminal:completed'
          );
          if (task.isAgent === true) {
            await this.notifyAgentLifecycle(task, {
              type: 'work-run-finished',
              title: `${task.title} finished its run`,
              body: completedBlurb,
              sourceKey: `work-run:${runId}:completed`,
            });
          }
          return;
        }
        const toolValidationErrors = new Map<WorkToolCall, string>();
        for (const call of toolCalls) {
          const validationError = validateToolCallArguments(call);
          if (validationError) toolValidationErrors.set(call, validationError);
        }
        const hasInvalidToolArguments = toolValidationErrors.size > 0;

        messages.push({
          role: 'assistant',
          content: assistantContent,
          tool_calls: toolCalls as unknown as Record<string, unknown>[],
          ...(response.message.providerMetadata
            ? { providerMetadata: response.message.providerMetadata }
            : {}),
        });
        // Responses-mode providers persist their durable replay state; every
        // other provider persists the tool calls themselves so the next run's
        // restored context keeps the tool history instead of dropping it.
        const persistedAssistantMetadata =
          providerStateMetadata ?? toPersistedWorkChatToolCalls(run, toolCalls);
        if (assistantContent) {
          await workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'message',
            assistantContent,
            persistedAssistantMetadata
          );
        } else if (persistedAssistantMetadata) {
          await workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'provider_state',
            '',
            persistedAssistantMetadata
          );
        }
        for (const call of toolCalls) {
          await this.throwIfCancelled(runId, controller);
          const toolCallMetadata = {
            ...summarizeToolCall(call),
            round: round + 1,
          };
          const toolCallMessage = await workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'tool_call',
            `Calling ${call.function.name}`,
            toolCallMetadata
          );
          await workEventService.publish(
            taskId,
            runId,
            'run_state',
            {
              status: 'running',
              phase: 'using_tool',
              round: round + 1,
              roundLimit,
            },
            `tool:${call.id}:state`,
            durableAttemptIdentity
          );
          await workEventService.publish(
            taskId,
            runId,
            'tool_call',
            {
              toolCallId: call.id,
              name: call.function.name,
              arguments: toolCallMetadata,
              metadata: toolCallMetadata,
              phase: 'running',
              message: toolCallMessage,
            },
            `message:${toolCallMessage.id}`
          );
          let toolOutput: string;
          let toolImages: string[] | undefined;
          let toolMetadata: Record<string, unknown> = {
            name: call.function.name,
            toolCallId: call.id,
            toolName: call.function.name,
          };
          const toolStartedAt = Date.now();
          try {
            const validationError = toolValidationErrors.get(call);
            if (validationError) {
              throw new WorkAgentHttpError(
                validationError,
                400,
                'WORK_INVALID_TOOL_ARGUMENTS'
              );
            }
            if (hasInvalidToolArguments) {
              throw new WorkAgentHttpError(
                'This tool call was not executed because another call in the same model response had incomplete or invalid arguments. Retry the batch with smaller payloads.',
                400,
                'WORK_TOOL_BATCH_NOT_EXECUTED'
              );
            }
            const result = await this.executeTool(task, call, {
              signal: controller.signal,
              computer: computerContext,
              runId,
            });
            toolOutput = result.content;
            toolImages = result.images;
            toolMetadata = { ...toolMetadata, ...result.metadata };
          } catch (error) {
            toolOutput =
              error instanceof Error
                ? `Tool error: ${error.message}`
                : 'Tool error.';
            toolMetadata.error = true;
          }
          toolMetadata.durationMs = Date.now() - toolStartedAt;
          loopStats.toolCalls += 1;
          if (toolMetadata.screenshot === true) loopStats.screenshots += 1;
          if (toolMetadata.fence) loopStats.fences += 1;
          const expectOutcome = (
            toolMetadata.expect as { outcome?: string } | undefined
          )?.outcome;
          if (expectOutcome === 'passed') loopStats.expectationsPassed += 1;
          if (expectOutcome === 'pending') loopStats.expectationsPending += 1;
          if (call.function.name === 'computer_act') {
            if (expectOutcome === 'pending') {
              consecutivePendingExpectations += 1;
            } else if (expectOutcome === 'passed') {
              consecutivePendingExpectations = 0;
            }
          }
          const boundedOutput = boundPersistedToolOutput(toolOutput);
          if (boundedOutput !== toolOutput) {
            toolMetadata.outputTruncated = true;
            toolOutput = boundedOutput;
          }
          const toolResultMessage = await workTaskService.addMessage(
            taskId,
            runId,
            'tool',
            'tool_result',
            toolOutput,
            toolMetadata
          );
          await workEventService.publish(
            taskId,
            runId,
            'tool_result',
            {
              toolCallId: call.id,
              name: call.function.name,
              phase: toolMetadata.error ? 'failed' : 'completed',
              content: toolOutput,
              error: toolMetadata.error === true,
              message: toolResultMessage,
            },
            `message:${toolResultMessage.id}`
          );
          messages.push({
            role: 'tool',
            content: toolOutput,
            tool_name: call.function.name,
            tool_call_id: call.id,
            ...(toolImages?.length ? { images: toolImages } : {}),
          });
          // Screenshots are live-context-only: persisted messages keep the
          // text observation, and only the most recent screenshots stay in
          // model context so a long computer session cannot flood tokens.
          retainRecentWorkImages(messages);
          if (
            (call.function.name === 'computer_act' ||
              call.function.name === 'computer_observe') &&
            typeof toolMetadata.screenshotSha256 === 'string'
          ) {
            let argsSignature = '';
            try {
              argsSignature = JSON.stringify(
                call.function.arguments ?? ''
              ).slice(0, 2_000);
            } catch {
              argsSignature = '';
            }
            const signature = [
              toolMetadata.screenshotSha256,
              call.function.name,
              argsSignature,
            ].join('|');
            if (signature === computerStallSignature) {
              computerStallRepeats += 1;
            } else {
              computerStallSignature = signature;
              computerStallRepeats = 0;
            }
          }
        }
        if (computerStallRepeats >= 2) {
          computerStallRepeats = 0;
          computerStallSignature = '';
          if (!computerStallNudged) {
            computerStallNudged = true;
            loopStats.stallNudges += 1;
            messages.push({
              role: 'user',
              content: buildWorkComputerStallPrompt(
                computerContext.lastSubgoal
              ),
            });
          } else {
            budgetReason = 'computer-stall';
            break roundLoop;
          }
        }
        if (consecutivePendingExpectations >= 2 && !ambiguityNudged) {
          ambiguityNudged = true;
          consecutivePendingExpectations = 0;
          loopStats.ambiguityNudges += 1;
          messages.push({
            role: 'user',
            content: buildWorkComputerAmbiguityPrompt(
              computerContext.lastSubgoal
            ),
          });
        }
      }
      await this.throwIfCancelled(runId, controller);
      await workEventService.publish(
        taskId,
        runId,
        'run_state',
        {
          status: 'running',
          phase: 'responding',
          round: roundLimit,
          roundLimit,
        },
        'handoff:responding',
        durableAttemptIdentity
      );
      const handoffContentStream = new WorkDeltaPublisher(
        taskId,
        runId,
        'assistant_delta',
        streamedAssistantTotal,
        'handoff',
        durableAttemptIdentity
      );
      const handoffReasoningStream = new WorkDeltaPublisher(
        taskId,
        runId,
        'reasoning_delta',
        streamedReasoningTotal,
        'handoff',
        durableAttemptIdentity
      );
      let handoffInputTokens = 0;
      let handoffOutputTokens = 0;
      const handoffStartedAt = Date.now();
      let handoffResponse: OllamaChatResponse;
      try {
        try {
          await this.assertStableProviderRouting(
            run,
            userId,
            providerRoutingFingerprint
          );
          handoffResponse =
            await workModelProviderService.generateChatStreamResponse(
              {
                model: run.model,
                messages: [
                  ...messages,
                  {
                    role: 'user',
                    content: `${buildWorkBudgetExhaustionPrompt()}\n${
                      budgetReason === 'computer-stall'
                        ? 'The run was stopped because repeated computer actions kept producing an unchanged screen even after a recovery notice.'
                        : `The ${budgetReason} budget was reached.`
                    }`,
                  },
                ],
                tools: [],
                options:
                  run.providerType === 'plugin'
                    ? { num_predict: 2048 }
                    : undefined,
                stream: true,
              },
              providerSelection,
              userId,
              {
                onContent: delta => handoffContentStream.push(delta),
                onReasoning: delta => handoffReasoningStream.push(delta),
                onUsage: usage => {
                  handoffInputTokens = usage.promptTokens ?? handoffInputTokens;
                  handoffOutputTokens =
                    usage.completionTokens ?? handoffOutputTokens;
                  void workEventService.publish(taskId, runId, 'usage', {
                    inputTokens: accumulatedInputTokens + handoffInputTokens,
                    outputTokens: accumulatedOutputTokens + handoffOutputTokens,
                    totalTokens:
                      accumulatedInputTokens +
                      handoffInputTokens +
                      accumulatedOutputTokens +
                      handoffOutputTokens,
                    durationMs: Date.now() - handoffStartedAt,
                  });
                },
              },
              controller.signal
            );
          assertCompleteProviderResponse(handoffResponse);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const fallback = `The run reached its ${budgetReason} budget. The final provider handoff was unavailable${
            error instanceof Error ? `: ${error.message}` : '.'
          }\n\nStart a follow-up run to continue in the same durable workspace.`;
          handoffContentStream.push(fallback);
          handoffResponse = {
            model: run.model,
            created_at: new Date().toISOString(),
            message: {
              role: 'assistant',
              content: fallback,
            },
            done: true,
          };
        }
      } finally {
        handoffContentStream.flush();
        handoffReasoningStream.flush();
      }
      await this.throwIfCancelled(runId, controller);
      const handoffReasoning = boundUtf8(
        handoffResponse.message?.thinking?.trim() || '',
        100_000
      );
      if (handoffReasoning) {
        await workTaskService.addMessage(
          taskId,
          runId,
          'assistant',
          'reasoning',
          handoffReasoning,
          { providerExposed: true, budgetHandoff: true }
        );
      }
      const handoffContent = boundUtf8(
        handoffResponse.message?.content?.trim() ||
          `The run reached its ${budgetReason} budget. Start a follow-up run to continue in the same workspace.`,
        100_000
      );
      const handoffProviderStateMetadata = toPersistedWorkProviderState(
        run,
        handoffResponse.message.providerMetadata
      );
      await workTaskService.addMessage(
        taskId,
        runId,
        'assistant',
        'message',
        handoffContent,
        {
          budgetHandoff: true,
          budgetReason,
          loopStats,
          ...handoffProviderStateMetadata,
        }
      );
      await settleExecutionContainer();
      await this.throwIfCancelled(runId, controller);
      if (!isActiveRunStatus((await workTaskService.getRun(runId))?.status))
        return;
      const handoffBlurb = await this.statusBlurbForRun(
        task,
        run,
        userId,
        handoffContent,
        controller.signal
      );
      await workTaskService.updateRun(runId, 'needs_input', { finished: true });
      await workTaskService.updateTaskStatus(
        taskId,
        'needs_input',
        handoffBlurb
      );
      await workEventService.publish(
        taskId,
        runId,
        'done',
        {
          status: 'needs_input',
          budgetReason,
          loopStats,
        },
        'terminal:needs_input'
      );
      if (task.isAgent === true) {
        await this.notifyAgentLifecycle(task, {
          type: 'work-run-attention',
          title: `${task.title} needs your input`,
          body: handoffBlurb,
          sourceKey: `work-run:${runId}:needs_input`,
        });
      }
    } catch (error) {
      const currentRun = await workTaskService.getRun(runId);
      if (currentRun?.status === 'cancelled' || controller.signal.aborted) {
        if (task) {
          try {
            await workRuntimeService.stopContainer(task);
            executionContainerSettled = true;
            if (
              isActiveRunStatus((await workTaskService.getRun(runId))?.status)
            ) {
              await workTaskService.updateRun(runId, 'cancelled', {
                error: 'Cancelled by user.',
                finished: true,
              });
              await workTaskService.updateTaskStatus(taskId, 'cancelled');
              await workTaskService.updatePreview(taskId, 'stopped');
              await workEventService.publish(
                taskId,
                runId,
                'done',
                {
                  status: 'cancelled',
                  error: 'Cancelled by user.',
                },
                'terminal:cancelled'
              );
            }
          } catch (cleanupError) {
            logger.error(
              `Could not stop cancelled Work task ${taskId}:`,
              cleanupError
            );
          }
        }
        return;
      }
      const message =
        error instanceof Error
          ? error.message
          : 'Work run failed unexpectedly.';
      await settleExecutionContainer();
      const settledRun = await workTaskService.getRun(runId);
      if (controller.signal.aborted || settledRun?.status === 'cancelled') {
        if (isActiveRunStatus(settledRun?.status)) {
          await workTaskService.updateRun(runId, 'cancelled', {
            error: 'Cancelled by user.',
            finished: true,
          });
          await workTaskService.updateTaskStatus(taskId, 'cancelled');
          await workTaskService.updatePreview(taskId, 'stopped');
          await workEventService.publish(
            taskId,
            runId,
            'done',
            {
              status: 'cancelled',
              error: 'Cancelled by user.',
            },
            'terminal:cancelled'
          );
        }
        return;
      }
      if (!isActiveRunStatus(settledRun?.status)) {
        return;
      }
      await workTaskService.addMessage(
        taskId,
        runId,
        'assistant',
        'error',
        message
      );
      await workTaskService.updateRun(runId, 'failed', {
        error: message,
        finished: true,
      });
      await workTaskService.updateTaskStatus(
        taskId,
        'failed',
        deriveStatusBlurb(message)
      );
      await workEventService.publish(
        taskId,
        runId,
        'error',
        {
          message,
          code: error instanceof WorkAgentHttpError ? error.code : undefined,
        },
        'terminal:error'
      );
      await workEventService.publish(
        taskId,
        runId,
        'done',
        {
          status: 'failed',
          error: message,
        },
        'terminal:failed'
      );
      if (task?.isAgent === true) {
        await this.notifyAgentLifecycle(task, {
          type: 'work-run-attention',
          title: `${task.title} hit an error`,
          body: deriveStatusBlurb(message),
          sourceKey: `work-run:${runId}:failed`,
        });
      }
    } finally {
      this.controllers.delete(runId);
      try {
        await settleExecutionContainer();
      } finally {
        releaseExecutionLease?.();
      }
    }
  }

  private async cleanupExecutionContainer(task: WorkTaskRecord): Promise<void> {
    // A watched Work Computer screen outlives the run for the same reason a
    // preview does: someone is looking at it.
    if (workRuntimeService.screenSessionCount(task.id) > 0) return;
    try {
      // A preview is intentionally allowed to outlive the model run so the
      // user can inspect it in the Work pane. Preserve only a verified ready
      // preview; every other run leaves no reason for the idle tail container
      // to remain running.
      if (await workRuntimeService.isPreviewRunning(task)) return;
    } catch (error) {
      logger.warn(
        `Could not verify the preview after Work run ${task.id}; stopping its container:`,
        error
      );
    }

    try {
      await workRuntimeService.stopContainer(task);
      if (await workTaskService.getTaskRecord(task.id, task.userId)) {
        await workTaskService.updatePreview(task.id, 'stopped');
      }
    } catch (error) {
      // Cleanup failures must remain visible without obscuring the model
      // outcome; the caller publishes terminal run state after this returns.
      logger.error(
        `Could not stop idle Work container ${task.containerName}:`,
        error
      );
    }
  }

  private async assertStableProviderRouting(
    run: Pick<WorkRun, 'providerType' | 'providerId' | 'model'>,
    userId: string,
    expectedFingerprint: string
  ): Promise<void> {
    const currentFingerprint =
      await workModelProviderService.getRoutingFingerprint(
        run.model,
        {
          providerType: run.providerType,
          providerId: run.providerId,
        },
        userId
      );
    if (currentFingerprint !== expectedFingerprint) {
      throw new WorkAgentHttpError(
        'The provider routing changed while this Work run was active. Start a new run with the updated provider configuration.',
        409,
        'WORK_PROVIDER_ROUTING_CHANGED'
      );
    }
  }

  private async contextMessages(
    task: WorkTaskRecord,
    roundLimit: number,
    computerAvailable: boolean,
    taughtSkills: readonly { name: string; instructions: string }[],
    providerStateScope?: string,
    provider: Pick<WorkRun, 'providerType' | 'providerId' | 'model'> = task,
    persona?: { name: string; instructions?: string }
  ): Promise<OllamaChatMessage[]> {
    const persisted = restorePersistedWorkContext(
      await workTaskService.getRecentModelContextMessages(task.id, 30),
      provider,
      providerStateScope
    );
    return [
      {
        role: 'system',
        content: buildWorkAgentSystemPrompt({
          networkEnabled: task.networkEnabled,
          computerAvailable,
          ...(taughtSkills.length > 0 ? { taughtSkills } : {}),
          ...(persona ? { persona } : {}),
          previewPort: workRuntimeService.previewPort,
          roundBudget: roundLimit,
          commandTimeoutMs: workRuntimeService.limits.commandTimeoutMs,
          maxOutputChars: workRuntimeService.limits.maxOutputChars,
        }),
      },
      ...persisted,
    ];
  }

  private async executeTool(
    task: WorkTaskRecord,
    call: WorkToolCall,
    context: {
      signal?: AbortSignal;
      // Mutable per-run state: the last computer observation, for diffing
      // consecutive screens so the model learns what its action changed.
      computer?: WorkComputerRunContext;
      // For run-scoped notification dedupe (one takeover alert per run).
      runId?: string;
    } = {}
  ): Promise<{
    content: string;
    metadata?: Record<string, unknown>;
    // Base64 PNG screenshots for the model's live context. Never persisted:
    // durable messages carry only the text observation.
    images?: string[];
  }> {
    const args = call.function.arguments;
    switch (call.function.name) {
      case 'list_files': {
        const result = await workRuntimeService.listFiles(
          task,
          optionalString(args.path) || '.'
        );
        return {
          content: JSON.stringify(result.entries, null, 2).slice(
            0,
            workRuntimeService.limits.maxOutputChars
          ),
        };
      }
      case 'read_file': {
        const result = await workRuntimeService.readFile(
          task,
          requiredString(args.path, 'path')
        );
        return {
          content: result.content.slice(
            0,
            workRuntimeService.limits.maxOutputChars
          ),
          metadata: { path: result.path, size: result.size },
        };
      }
      case 'write_file': {
        const result = await workRuntimeService.writeFile(
          task,
          requiredString(args.path, 'path'),
          requiredString(args.content, 'content', true)
        );
        return {
          content: `Wrote ${result.size} bytes to ${result.path}.`,
          metadata: { path: result.path, size: result.size },
        };
      }
      case 'delete_file': {
        const result = await workRuntimeService.deletePath(
          task,
          requiredString(args.path, 'path'),
          args.recursive === true
        );
        return {
          content: `Deleted ${result.type} ${result.path}.`,
          metadata: { path: result.path, type: result.type },
        };
      }
      case 'move_file': {
        const result = await workRuntimeService.movePath(
          task,
          requiredString(args.from, 'from'),
          requiredString(args.to, 'to')
        );
        return {
          content: `Moved ${result.from} to ${result.to}.`,
          metadata: { from: result.from, to: result.to },
        };
      }
      case 'search_files': {
        const result = await workRuntimeService.searchFiles(
          task,
          requiredString(args.query, 'query'),
          optionalString(args.path) || '.'
        );
        return commandResult(result);
      }
      case 'web_search': {
        if (
          !task.networkEnabled ||
          !(await isWebSearchAvailable()) ||
          !(await userCanUseWebSearch(await userModel.getUserById(task.userId)))
        ) {
          throw new WorkAgentHttpError(
            'Web search is not available for this task.',
            403,
            'WORK_WEB_SEARCH_UNAVAILABLE'
          );
        }
        const query = requiredString(args.query, 'query');
        const results = await webSearch(
          query,
          optionalInteger(args.max_results) ?? 5
        );
        const content =
          results.length === 0
            ? 'No results.'
            : results
                .map(
                  (result, index) =>
                    `[${index + 1}] ${result.title}\n${result.url}${
                      result.content ? `\n${result.content}` : ''
                    }`
                )
                .join('\n\n');
        return {
          content: content.slice(0, workRuntimeService.limits.maxOutputChars),
          metadata: { query, results: results.length },
        };
      }
      case 'run_command': {
        const timeout = optionalInteger(args.timeout_ms);
        const result = await workRuntimeService.runCommand(
          task,
          requiredString(args.command, 'command'),
          timeout
        );
        return commandResult(result);
      }
      case 'start_preview': {
        const url = await workRuntimeService.startPreview(
          task,
          optionalString(args.command),
          {
            onStarting: () =>
              workTaskService.beginPreview(task.id, task.userId, true),
            onRunning: (previewUrl, endpoint) =>
              workTaskService.updatePreview(
                task.id,
                'running',
                previewUrl,
                endpoint
              ),
            onFailed: () => workTaskService.updatePreview(task.id, 'failed'),
          }
        );
        return {
          content: `Preview started at ${url}.`,
          metadata: { previewUrl: url },
        };
      }
      case 'stop_preview':
        await workRuntimeService.stopPreview(task, {
          onStopped: () => workTaskService.updatePreview(task.id, 'stopped'),
        });
        return { content: 'Preview stopped.' };
      case 'computer_observe': {
        await this.assertComputerToolsAvailable(task);
        await this.assertComputerNotHumanControlled(task);
        return computerToolResult(
          await workRuntimeService.computerObserve(task),
          undefined,
          context.computer
        );
      }
      case 'computer_act': {
        await this.assertComputerToolsAvailable(task);
        await this.assertComputerNotHumanControlled(task);
        const actions = Array.isArray(args.actions) ? args.actions : [];
        const subgoal = optionalString(args.subgoal)?.trim().slice(0, 300);
        const observation = await workRuntimeService.computerAct(
          task,
          actions,
          args.expect
        );
        const result = computerToolResult(
          observation,
          actions.length,
          context.computer
        );
        if (subgoal) {
          // The checkpoint rides the durable transcript: goal, actions, and
          // verified outcome persist together for resume and audit.
          result.metadata.subgoal = subgoal;
          result.content = `Subgoal: ${subgoal}\n${result.content}`;
          if (context.computer) context.computer.lastSubgoal = subgoal;
        }
        return result;
      }
      case 'request_takeover': {
        await this.assertComputerToolsAvailable(task);
        if (
          (await workPolicyService.resolve(task.policyId)).takeoverEnabled ===
          false
        ) {
          return {
            content:
              "This task's Work policy does not allow human takeover of the screen. No one can be handed control; state the exact blocker in your response so the user can address it another way.",
            metadata: { outcome: 'disabled' },
          };
        }
        const reason = requiredString(args.reason, 'reason').slice(0, 1_000);
        // The on-screen banner is visible only while the Screen tab is
        // open and connected, so a takeover request also notifies — this
        // is the "Chief of Staff needs you: 2FA on the CRM" moment. One
        // notification per run: repeat requests in the same run dedupe.
        await this.notifyAgentLifecycle(task, {
          type: 'work-takeover',
          title: `${task.title} needs you on its screen`,
          body: reason,
          sourceKey: context.runId
            ? `work-takeover:${context.runId}`
            : `work-takeover:${task.id}:${Date.now()}`,
        });
        const outcome = await workScreenControlService.waitForAssist(
          task.id,
          reason,
          {
            timeoutMs: WORK_SCREEN_ASSIST_TIMEOUT_MS,
            signal: context.signal,
          }
        );
        if (outcome === 'released') {
          return {
            content:
              'The user took control of the computer and has handed it back. Use computer_observe to see the current screen before continuing.',
            metadata: { outcome },
          };
        }
        if (outcome === 'still_controlled') {
          return {
            content:
              'The user is still controlling the computer. Your computer tools stay blocked until they finish; continue with other work or wait.',
            metadata: { outcome },
          };
        }
        return {
          content:
            'No one took over the screen within the waiting period. State the exact blocker in your response so the user can handle it later.',
          metadata: { outcome },
        };
      }
      default:
        throw new WorkAgentHttpError(
          `Unknown tool: ${call.function.name}`,
          400,
          'WORK_UNKNOWN_TOOL'
        );
    }
  }

  private async assertComputerToolsAvailable(
    task: WorkTaskRecord
  ): Promise<void> {
    if (!(await workRuntimeService.computerToolsAvailable(task))) {
      throw new WorkAgentHttpError(
        'The Work Computer is not available for this task.',
        403,
        'WORK_COMPUTER_UNAVAILABLE'
      );
    }
  }

  /**
   * While a human holds the control lease, the agent's eyes and hands are
   * both off: acting would fight the user's input, and observing could
   * capture usernames or one-time codes typed during a sign-in.
   */
  private async assertComputerNotHumanControlled(
    task: WorkTaskRecord
  ): Promise<void> {
    if (await workScreenControlService.current(task.id)) {
      throw new WorkAgentHttpError(
        'A user is controlling the Work Computer right now. Wait for them to finish (request_takeover reports when control is handed back).',
        409,
        'WORK_COMPUTER_HUMAN_CONTROL'
      );
    }
  }

  private async throwIfCancelled(
    runId: string,
    controller: AbortController
  ): Promise<void> {
    if (
      controller.signal.aborted ||
      (await workTaskService.getRun(runId))?.status === 'cancelled'
    ) {
      throw new WorkAgentHttpError(
        'Work run was cancelled.',
        409,
        'WORK_RUN_CANCELLED'
      );
    }
  }

  /**
   * Agent lifecycle notification, in-app plus web push. Best effort: the
   * run and task rows are the source of truth, so a notification failure
   * never fails the run. The source key is run-scoped because dedupe is
   * permanent per user until the inbox cap prunes it.
   */
  private async notifyAgentLifecycle(
    task: WorkTaskRecord,
    input: {
      type: 'work-run-finished' | 'work-run-attention' | 'work-takeover';
      title: string;
      body?: string | null;
      sourceKey: string;
    }
  ): Promise<void> {
    try {
      const { notificationService } = await import('./notificationService.js');
      await notificationService.publish({
        userId: task.userId,
        type: input.type,
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        href: `/work/${task.id}`,
        sourceKey: input.sourceKey,
      });
    } catch {
      // Best effort only.
    }
  }

  /**
   * Sidebar status line for a finished run. Agents get one cheap no-tools
   * model request for a colloquial ~8-word status ("Inbox at zero. 2
   * replies ready."); every failure, timeout, or non-agent task falls back
   * to the deterministic first-line blurb. The reply is passed through the
   * same deterministic bounds, so the model can only ever produce one
   * bounded line. WORK_STATUS_BLURB_MODEL=0 disables the model call.
   */
  private async statusBlurbForRun(
    task: WorkTaskRecord,
    run: Pick<WorkRun, 'providerType' | 'providerId' | 'model'>,
    userId: string,
    finalContent: string,
    signal: AbortSignal
  ): Promise<string | null> {
    const deterministic = deriveStatusBlurb(finalContent);
    if (task.isAgent !== true) return deterministic;
    if (process.env.WORK_STATUS_BLURB_MODEL === '0') return deterministic;
    try {
      const response =
        await workModelProviderService.generateChatStreamResponse(
          {
            model: run.model,
            messages: [
              {
                role: 'user',
                content: buildWorkStatusBlurbPrompt(finalContent),
              },
            ],
            tools: [],
            options:
              run.providerType === 'plugin' ? { num_predict: 64 } : undefined,
            stream: true,
          },
          {
            providerType: run.providerType,
            providerId: run.providerId,
          },
          userId,
          {},
          AbortSignal.any([
            signal,
            AbortSignal.timeout(WORK_STATUS_BLURB_TIMEOUT_MS),
          ])
        );
      return (
        deriveStatusBlurb(response.message?.content ?? '') ?? deterministic
      );
    } catch {
      return deterministic;
    }
  }
}

class WorkDeltaPublisher {
  private pending = '';
  private total = '';
  private separatorPending = '';
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;

  constructor(
    private readonly taskId: string,
    private readonly runId: string,
    private readonly type: 'assistant_delta' | 'reasoning_delta',
    initialTotal = '',
    private readonly occurrenceScope = 'stream',
    private readonly attemptIdentity = '0'
  ) {
    this.total = initialTotal;
    this.separatorPending = initialTotal ? '\n\n' : '';
  }

  get currentTotal(): string {
    return this.total;
  }

  push(delta: string): void {
    if (!delta) return;
    const next = `${this.separatorPending}${delta}`;
    this.separatorPending = '';
    this.pending += next;
    this.total = boundUtf8(this.total + next, 100_000);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 32);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.pending) return;
    const delta = this.pending;
    this.pending = '';
    workEventService.publish(
      this.taskId,
      this.runId,
      this.type,
      { delta, total: this.total },
      `${this.occurrenceScope}:${++this.sequence}`,
      this.attemptIdentity
    );
  }
}

export class WorkAgentHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'WorkAgentHttpError';
    this.status = status;
    this.code = code;
  }
}

interface PersistedWorkProviderState {
  providerType: WorkRun['providerType'];
  providerId?: string;
  model: string;
  providerMetadata?: Record<string, unknown>;
  toolCalls?: PersistedWorkChatToolCall[];
}

interface PersistedWorkChatToolCall {
  id: string;
  name: string;
  // JSON-encoded arguments, bounded — replay context, not an exact record.
  arguments: string;
}

function toPersistedWorkProviderState(
  run: Pick<WorkRun, 'providerType' | 'providerId' | 'model'>,
  providerMetadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const boundedOutput = boundedOpenAIResponsesOutputItems(
    providerMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
  );
  if (
    providerMetadata?.[OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY] === true ||
    !boundedOutput.items ||
    typeof providerMetadata?.[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY] !==
      'string'
  ) {
    return undefined;
  }

  const persisted = {
    [WORK_PROVIDER_STATE_METADATA_KEY]: {
      providerType: run.providerType,
      ...(run.providerId ? { providerId: run.providerId } : {}),
      model: run.model,
      providerMetadata: {
        ...providerMetadata,
        [OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: boundedOutput.items,
      },
    } satisfies PersistedWorkProviderState,
  };
  try {
    return Buffer.byteLength(JSON.stringify(persisted), 'utf8') <=
      WORK_MESSAGE_METADATA_MAX_BYTES
      ? persisted
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Chat-completions providers (Ollama, OpenRouter-style plugins) have no
 * durable Responses replay state, so persist the tool calls themselves:
 * without them, cross-run context restoration cannot rebuild the
 * assistant/tool message pairs and silently drops every tool result — the
 * model then re-discovers its own work each turn.
 */
function toPersistedWorkChatToolCalls(
  run: Pick<WorkRun, 'providerType' | 'providerId' | 'model'>,
  toolCalls: WorkToolCall[]
): Record<string, unknown> | undefined {
  if (toolCalls.length === 0) return undefined;
  const persisted = {
    [WORK_PROVIDER_STATE_METADATA_KEY]: {
      providerType: run.providerType,
      ...(run.providerId ? { providerId: run.providerId } : {}),
      model: run.model,
      toolCalls: toolCalls.map(call => ({
        id: call.id,
        name: call.function.name,
        arguments: boundedToolCallArgumentsJson(call.function.arguments),
      })),
    } satisfies PersistedWorkProviderState,
  };
  try {
    return Buffer.byteLength(JSON.stringify(persisted), 'utf8') <=
      WORK_MESSAGE_METADATA_MAX_BYTES
      ? persisted
      : undefined;
  } catch {
    return undefined;
  }
}

function boundedToolCallArgumentsJson(
  args: Record<string, unknown>,
  maxBytes = WORK_CHAT_TOOL_CALL_ARGUMENTS_MAX_BYTES
): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized;
  const truncated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    truncated[key] =
      typeof value === 'string' && value.length > 512
        ? `${value.slice(0, 512)}… [truncated for replay]`
        : value;
  }
  try {
    serialized = JSON.stringify(truncated);
    return Buffer.byteLength(serialized, 'utf8') <= maxBytes
      ? serialized
      : '{}';
  } catch {
    return '{}';
  }
}

/**
 * Read back tool calls persisted by toPersistedWorkChatToolCalls. Fails
 * closed: any malformed entry drops the whole batch, so restoration falls
 * back to visible assistant text exactly like malformed Responses state.
 */
function persistedChatToolCalls(
  message: WorkMessage
): Array<{ id: string; name: string; arguments: string }> | undefined {
  const state = objectValue(
    message.metadata?.[WORK_PROVIDER_STATE_METADATA_KEY]
  );
  const rawCalls = state?.toolCalls;
  if (!Array.isArray(rawCalls) || rawCalls.length === 0) return undefined;
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const value of rawCalls) {
    const call = objectValue(value);
    if (
      !call ||
      typeof call.id !== 'string' ||
      call.id.length === 0 ||
      typeof call.name !== 'string' ||
      call.name.length === 0
    ) {
      return undefined;
    }
    calls.push({
      id: call.id,
      name: call.name,
      arguments: typeof call.arguments === 'string' ? call.arguments : '{}',
    });
  }
  return calls;
}

export function restorePersistedWorkContext(
  messages: WorkMessage[],
  provider: Pick<WorkRun, 'providerType' | 'providerId' | 'model'>,
  expectedStateScope?: string
): OllamaChatMessage[] {
  const restored: OllamaChatMessage[] = [];
  let pendingGroup:
    | {
        assistant: OllamaChatMessage;
        fallback?: OllamaChatMessage;
        calls: Array<{ id: string; name: string }>;
        expectedCallIds: Set<string>;
        results: OllamaChatMessage[];
        resultIds: Set<string>;
        invalid: boolean;
      }
    | undefined;

  const flushPendingGroup = (): void => {
    if (!pendingGroup) return;
    if (pendingGroup.invalid) {
      if (pendingGroup.fallback) restored.push(pendingGroup.fallback);
      pendingGroup = undefined;
      return;
    }

    restored.push(pendingGroup.assistant, ...pendingGroup.results);
    for (const call of pendingGroup.calls) {
      if (pendingGroup.resultIds.has(call.id)) continue;
      restored.push({
        role: 'tool',
        content: INTERRUPTED_TOOL_RESULT,
        tool_name: call.name,
        tool_call_id: call.id,
      });
    }
    pendingGroup = undefined;
  };

  for (const message of messages) {
    if (
      message.kind === 'provider_state' ||
      (message.role === 'assistant' && message.kind === 'message')
    ) {
      flushPendingGroup();
      const providerMetadata = matchingWorkProviderMetadata(
        message,
        provider,
        expectedStateScope
      );
      // Chat-mode rounds persist their tool calls directly (no Responses
      // replay state exists for them). Restore those only when the current
      // provider requires no such state either — the strict Responses
      // invariant stays fail-closed.
      const chatCalls =
        !providerMetadata && !expectedStateScope
          ? persistedChatToolCalls(message)
          : undefined;
      const responseCalls = providerMetadata
        ? responseFunctionCalls(providerMetadata)
        : (chatCalls ?? []);
      const rawFunctionCallCount = providerMetadata
        ? Array.isArray(
            providerMetadata[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
          )
          ? (
              providerMetadata[
                OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY
              ] as unknown[]
            ).filter(item => objectValue(item)?.type === 'function_call').length
          : 0
        : responseCalls.length;
      const expectedCallIds = new Set(responseCalls.map(call => call.id));

      if (
        !providerMetadata &&
        message.metadata?.[WORK_EMPTY_MODEL_RESPONSE_METADATA_KEY] === true
      ) {
        // The empty-response placeholder informs the user; it is not
        // something the model said, so keep it out of model context.
        continue;
      }
      if (
        message.kind === 'provider_state' &&
        !providerMetadata &&
        !chatCalls
      ) {
        continue;
      }
      if (message.kind !== 'message' && message.kind !== 'provider_state') {
        continue;
      }
      if (
        expectedCallIds.size !== responseCalls.length ||
        rawFunctionCallCount !== responseCalls.length
      ) {
        if (message.kind === 'message') {
          restored.push({ role: 'assistant', content: message.content });
        }
        continue;
      }

      const assistant: OllamaChatMessage = {
        role: 'assistant',
        content: message.content,
        ...(responseCalls.length > 0
          ? {
              tool_calls: responseCalls.map(call => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: call.arguments,
                },
              })),
            }
          : {}),
        ...(providerMetadata ? { providerMetadata } : {}),
      };
      if (responseCalls.length === 0) {
        restored.push(assistant);
        continue;
      }

      pendingGroup = {
        assistant,
        ...(message.kind === 'message'
          ? {
              fallback: {
                role: 'assistant',
                content: message.content,
              },
            }
          : {}),
        calls: responseCalls,
        expectedCallIds,
        results: [],
        resultIds: new Set(),
        invalid: false,
      };
      continue;
    }

    if (message.role === 'user' && message.kind === 'message') {
      flushPendingGroup();
      restored.push({ role: 'user', content: message.content });
      continue;
    }

    if (message.role !== 'tool' || message.kind !== 'tool_result') {
      continue;
    }

    const toolCallId =
      typeof message.metadata?.toolCallId === 'string'
        ? message.metadata.toolCallId
        : undefined;
    if (!toolCallId || !pendingGroup) continue;
    if (
      !pendingGroup.expectedCallIds.has(toolCallId) ||
      pendingGroup.resultIds.has(toolCallId)
    ) {
      pendingGroup.invalid = true;
      continue;
    }
    const matchingCall = pendingGroup.calls.find(
      call => call.id === toolCallId
    );
    if (!matchingCall) {
      pendingGroup.invalid = true;
      continue;
    }
    const persistedName =
      typeof message.metadata?.name === 'string'
        ? message.metadata.name
        : undefined;
    pendingGroup.results.push({
      role: 'tool',
      content: message.content,
      tool_name: persistedName || matchingCall.name,
      tool_call_id: toolCallId,
    });
    pendingGroup.resultIds.add(toolCallId);
  }

  flushPendingGroup();
  return restored;
}

function matchingWorkProviderMetadata(
  message: WorkMessage,
  provider: Pick<WorkRun, 'providerType' | 'providerId' | 'model'>,
  expectedStateScope?: string
): Record<string, unknown> | undefined {
  const state = objectValue(
    message.metadata?.[WORK_PROVIDER_STATE_METADATA_KEY]
  );
  const providerMetadata = objectValue(state?.providerMetadata);
  const boundedOutput = boundedOpenAIResponsesOutputItems(
    providerMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
  );
  if (
    state?.providerType !== provider.providerType ||
    (state.providerId || undefined) !== (provider.providerId || undefined) ||
    state.model !== provider.model ||
    !expectedStateScope ||
    providerMetadata?.[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY] !==
      expectedStateScope ||
    !boundedOutput.items
  ) {
    return undefined;
  }
  return {
    ...providerMetadata,
    [OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: boundedOutput.items,
  };
}

function responseFunctionCalls(
  providerMetadata: Record<string, unknown>
): Array<{ id: string; name: string; arguments: unknown }> {
  const outputItems =
    providerMetadata[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY];
  if (!Array.isArray(outputItems)) return [];

  return outputItems.flatMap(itemValue => {
    const item = objectValue(itemValue);
    if (
      item?.type !== 'function_call' ||
      typeof item.name !== 'string' ||
      item.name.length === 0 ||
      typeof item.call_id !== 'string' ||
      item.call_id.length === 0
    ) {
      return [];
    }
    return [
      {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments ?? '',
      },
    ];
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertCompleteProviderResponse(response: OllamaChatResponse): void {
  if (!response.done_reason?.startsWith('incomplete:')) return;

  const reason = response.done_reason.slice('incomplete:'.length) || 'unknown';
  throw new WorkAgentHttpError(
    `The provider returned an incomplete response (${reason}). Retry with a larger output-token limit or a smaller request.`,
    502,
    'WORK_PROVIDER_INCOMPLETE_RESPONSE'
  );
}

export function normalizeToolCalls(
  response: OllamaChatResponse
): WorkToolCall[] {
  const raw = response.message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const responsesMetadata = response.message?.providerMetadata;
  const isResponsesCallBatch =
    typeof responsesMetadata?.[OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY] ===
      'string' ||
    responsesMetadata?.[OPENAI_RESPONSES_STATE_DROPPED_METADATA_KEY] === true ||
    Array.isArray(
      responsesMetadata?.[OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]
    );
  const calls: WorkToolCall[] = [];
  for (const [index, value] of raw.entries()) {
    if (!value || typeof value !== 'object') {
      if (isResponsesCallBatch) {
        throw new WorkAgentHttpError(
          'The provider returned a malformed tool call.',
          502,
          'WORK_PROVIDER_INVALID_TOOL_CALLS'
        );
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    const fn =
      record.function && typeof record.function === 'object'
        ? (record.function as Record<string, unknown>)
        : undefined;
    if (!fn || typeof fn.name !== 'string' || !fn.name) {
      if (isResponsesCallBatch) {
        throw new WorkAgentHttpError(
          'The provider returned a tool call without a function name.',
          502,
          'WORK_PROVIDER_INVALID_TOOL_CALLS'
        );
      }
      continue;
    }
    let args: Record<string, unknown> = {};
    let argumentError: string | undefined;
    if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>;
    } else if (typeof fn.arguments === 'string') {
      try {
        const parsed = JSON.parse(fn.arguments);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        } else if (fn.arguments.trim()) {
          argumentError = WORK_TOOL_ARGUMENTS_ERROR_MESSAGE;
        }
      } catch {
        args = {};
        if (fn.arguments.trim()) {
          argumentError = WORK_TOOL_ARGUMENTS_ERROR_MESSAGE;
        }
      }
    }
    const providerMetadata =
      record.providerMetadata &&
      typeof record.providerMetadata === 'object' &&
      !Array.isArray(record.providerMetadata)
        ? {
            ...(record.providerMetadata as Record<string, unknown>),
          }
        : {};
    if (argumentError) {
      providerMetadata[WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY] = argumentError;
    }
    const explicitId = typeof record.id === 'string' ? record.id : undefined;
    if (explicitId !== undefined && !explicitId.trim()) {
      throw new WorkAgentHttpError(
        'The provider returned a tool call with an empty ID.',
        502,
        'WORK_PROVIDER_INVALID_TOOL_CALLS'
      );
    }
    if (isResponsesCallBatch && explicitId === undefined) {
      throw new WorkAgentHttpError(
        'The Responses provider returned a tool call without an exact call_id.',
        502,
        'WORK_PROVIDER_INVALID_TOOL_CALLS'
      );
    }
    calls.push({
      id: explicitId ?? `tool-${Date.now()}-${index}`,
      ...(typeof record.thoughtSignature === 'string'
        ? { thoughtSignature: record.thoughtSignature }
        : {}),
      ...(Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
      function: { name: fn.name, arguments: args },
    });
  }
  if (calls.length > 16) {
    throw new WorkAgentHttpError(
      'The provider returned more than 16 tool calls in one response.',
      502,
      'WORK_PROVIDER_INVALID_TOOL_CALLS'
    );
  }
  const callIds = new Set<string>();
  for (const call of calls) {
    if (callIds.has(call.id)) {
      throw new WorkAgentHttpError(
        `The provider returned duplicate tool call ID "${call.id}".`,
        502,
        'WORK_PROVIDER_INVALID_TOOL_CALLS'
      );
    }
    callIds.add(call.id);
  }
  return calls;
}

function functionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
      },
    },
  };
}

function stringProperty(description: string): Record<string, string> {
  return { type: 'string', description };
}

function requiredString(
  value: unknown,
  name: string,
  allowEmpty = false
): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new WorkAgentHttpError(
      `Tool argument "${name}" must be a string.`,
      400,
      'WORK_INVALID_TOOL_ARGUMENT'
    );
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function validateToolCallArguments(call: WorkToolCall): string | undefined {
  const providerArgumentError =
    call.providerMetadata?.[WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY];
  if (typeof providerArgumentError === 'string') {
    return providerArgumentError;
  }

  const args = call.function.arguments;
  const invalidRequiredString = (
    name: string,
    allowEmpty = false
  ): string | undefined => {
    const value = args[name];
    if (typeof value === 'string' && (allowEmpty || value.trim())) {
      return undefined;
    }
    return `The model returned invalid arguments for ${call.function.name}: "${name}" must be a string. Retry with every required field; split large write_file content into focused files.`;
  };

  switch (call.function.name) {
    case 'list_files':
    case 'start_preview':
    case 'stop_preview':
    case 'computer_observe':
      return undefined;
    case 'computer_act':
      return Array.isArray(args.actions) && args.actions.length > 0
        ? undefined
        : `The model returned invalid arguments for computer_act: "actions" must be a non-empty array of action objects.`;
    case 'read_file':
    case 'delete_file':
      return invalidRequiredString('path');
    case 'write_file':
      return (
        invalidRequiredString('path') || invalidRequiredString('content', true)
      );
    case 'move_file':
      return invalidRequiredString('from') || invalidRequiredString('to');
    case 'search_files':
    case 'web_search':
      return invalidRequiredString('query');
    case 'request_takeover':
      return invalidRequiredString('reason');
    case 'run_command':
      return invalidRequiredString('command');
    default:
      return `The model requested an unknown tool: ${call.function.name}.`;
  }
}

function isActiveRunStatus(status: unknown): boolean {
  return status === 'queued' || status === 'preparing' || status === 'running';
}

function summarizeToolCall(call: WorkToolCall): Record<string, unknown> {
  const args = call.function.arguments;
  const metadata: Record<string, unknown> = {
    name: call.function.name,
    toolCallId: call.id,
  };
  const includeString = (
    key: string,
    value: unknown,
    maxLength = 1_024
  ): void => {
    if (typeof value !== 'string') return;
    metadata[key] = value.slice(0, maxLength);
    if (value.length > maxLength) metadata[`${key}Truncated`] = true;
  };
  switch (call.function.name) {
    case 'write_file':
      includeString('path', args.path);
      if (typeof args.content === 'string') {
        metadata.contentLength = Buffer.byteLength(args.content, 'utf8');
      }
      break;
    case 'read_file':
    case 'list_files':
      includeString('path', args.path);
      break;
    case 'delete_file':
      includeString('path', args.path);
      if (args.recursive === true) metadata.recursive = true;
      break;
    case 'move_file':
      includeString('from', args.from);
      includeString('to', args.to);
      break;
    case 'search_files':
      includeString('path', args.path);
      includeString('query', args.query, 500);
      break;
    case 'web_search':
      includeString('query', args.query, 500);
      break;
    case 'run_command':
      includeString('command', args.command, 2_000);
      if (typeof args.timeout_ms === 'number') {
        metadata.timeoutMs = args.timeout_ms;
      }
      break;
    case 'start_preview':
      includeString('command', args.command, 2_000);
      break;
    case 'request_takeover':
      includeString('reason', args.reason, 500);
      break;
    case 'computer_act':
      if (Array.isArray(args.actions)) {
        metadata.actionCount = args.actions.length;
        includeString(
          'actions',
          args.actions
            .map(action =>
              action && typeof action === 'object'
                ? String((action as Record<string, unknown>).type ?? '?')
                : '?'
            )
            .join(','),
          500
        );
      }
      break;
    default:
      break;
  }
  return metadata;
}

/**
 * Screenshots the live model context keeps (rakazo's trick): the newest
 * screenshot-bearing tool results retain their images, everything older
 * drops back to its text observation. Bounds tokens and sidesteps most of
 * the cross-run screenshot persistence problem — a resumed run re-observes.
 */
const WORK_LIVE_SCREENSHOT_MESSAGE_LIMIT = 2;

function retainRecentWorkImages(
  messages: OllamaChatMessage[],
  limit = WORK_LIVE_SCREENSHOT_MESSAGE_LIMIT
): void {
  let retained = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message.images?.length) continue;
    retained += 1;
    if (retained > limit) delete message.images;
  }
}

/** Per-run computer state threaded through the loop for observation diffs. */
interface WorkComputerRunContext {
  previous?: {
    screenshotSha256?: string;
    window: string;
    url?: string;
    pageFocus?: boolean;
  };
  lastSubgoal?: string;
}

function computerObservationDiff(
  observation: WorkComputerObservation,
  computerContext?: WorkComputerRunContext
): string[] {
  const previous = computerContext?.previous;
  if (computerContext) {
    computerContext.previous = {
      ...(observation.screenshotSha256
        ? { screenshotSha256: observation.screenshotSha256 }
        : {}),
      window: observation.window,
      ...(observation.url ? { url: observation.url } : {}),
      ...(observation.pageFocus !== undefined
        ? { pageFocus: observation.pageFocus }
        : {}),
    };
  }
  if (!previous?.screenshotSha256 || !observation.screenshotSha256) return [];
  if (previous.screenshotSha256 === observation.screenshotSha256) {
    return [
      'Since the previous observation: the screen is IDENTICAL — nothing changed visually.',
    ];
  }
  const transitions = [
    ...(previous.window !== observation.window
      ? [`window "${previous.window}" → "${observation.window}"`]
      : []),
    ...(previous.url !== observation.url
      ? [`URL ${previous.url || '(none)'} → ${observation.url || '(none)'}`]
      : []),
    ...(previous.pageFocus !== observation.pageFocus
      ? [`page focus ${previous.pageFocus} → ${observation.pageFocus}`]
      : []),
  ];
  return [
    `Since the previous observation: the screen changed${transitions.length ? ` (${transitions.join('; ')})` : ' (same window, title, and URL)'}.`,
  ];
}

function computerToolResult(
  observation: WorkComputerObservation,
  actionCount?: number,
  computerContext?: WorkComputerRunContext
): { content: string; metadata: Record<string, unknown>; images: string[] } {
  const ranCount = observation.fence
    ? observation.fence.afterAction
    : actionCount;
  const browserChrome =
    observation.pageFocus === false && /chromium/i.test(observation.window);
  const diffLines = computerObservationDiff(observation, computerContext);
  const receiptLines = [
    ...(observation.clickReceipts?.length
      ? [
          `Click receipts: ${observation.clickReceipts
            .map(
              receipt =>
                `#${receipt.action} (${receipt.x},${receipt.y}) ${receipt.changed ? 'changed nearby pixels' : 'NO visible change nearby'}`
            )
            .join('; ')}.`,
        ]
      : []),
    ...(observation.scrollReceipts?.map(receipt =>
      receipt.found === null
        ? `Scroll receipt: action #${receipt.action} scrolled ${receipt.scrolledUnits} unit(s) — no semantic signal, target visibility unknown.`
        : receipt.found && receipt.visible
          ? `Scroll receipt: action #${receipt.action} scrolled ${receipt.scrolledUnits} unit(s) — target is now visible.`
          : receipt.found
            ? `Scroll receipt: action #${receipt.action} scrolled ${receipt.scrolledUnits} unit(s) — target found but still not fully visible.`
            : `Scroll receipt: action #${receipt.action} scrolled ${receipt.scrolledUnits} unit(s) — target NOT found in the scrolled range.`
    ) ?? []),
  ];
  const summary = [
    ...(observation.fence
      ? [`BATCH STOPPED EARLY: ${observation.fence.detail}`]
      : []),
    ...(actionCount !== undefined
      ? [
          `Applied ${ranCount} of ${actionCount} action${actionCount === 1 ? '' : 's'} and captured the settled screen.`,
        ]
      : []),
    `Screen ${observation.width}x${observation.height}, cursor at ${observation.cursorX},${observation.cursorY}.`,
    observation.window
      ? `Active window: ${observation.window}` +
        (observation.windowId !== undefined
          ? ` (#${observation.windowId}${observation.windowCount !== undefined ? `, ${observation.windowCount} visible` : ''})`
          : '')
      : 'No active window.',
    ...(observation.url ? [`Page URL: ${observation.url}`] : []),
    ...(browserChrome
      ? [
          'Keyboard focus: the browser UI, NOT the page — typed text would go to the omnibox or a browser dialog.',
        ]
      : observation.focusedElement
        ? [`Focused element: ${observation.focusedElement}`]
        : []),
    ...(observation.expect
      ? [
          observation.expect.outcome === 'passed'
            ? 'Declared expectation: PASSED.'
            : `Declared expectation: NOT yet observed (pending${observation.expect.unmet?.length ? `: ${observation.expect.unmet.join(', ')}` : ''}) — re-observe before assuming failure.`,
        ]
      : []),
    ...receiptLines,
    ...diffLines,
    ...(observation.screenshotSha256
      ? [`Screenshot sha256: ${observation.screenshotSha256.slice(0, 16)}`]
      : []),
    'The screenshot accompanies this result.',
  ].join('\n');
  return {
    content: summary,
    metadata: {
      screenshot: true,
      width: observation.width,
      height: observation.height,
      cursorX: observation.cursorX,
      cursorY: observation.cursorY,
      window: observation.window.slice(0, 300),
      ...(observation.windowId !== undefined
        ? { windowId: observation.windowId }
        : {}),
      ...(observation.windowCount !== undefined
        ? { windowCount: observation.windowCount }
        : {}),
      ...(observation.url ? { url: observation.url } : {}),
      ...(observation.pageFocus !== undefined
        ? { pageFocus: observation.pageFocus }
        : {}),
      ...(observation.focusedElement
        ? { focusedElement: observation.focusedElement }
        : {}),
      ...(observation.screenshotSha256
        ? { screenshotSha256: observation.screenshotSha256 }
        : {}),
      ...(observation.fence ? { fence: observation.fence } : {}),
      ...(observation.expect ? { expect: observation.expect } : {}),
      ...(observation.clickReceipts?.length
        ? { clickReceipts: observation.clickReceipts }
        : {}),
      ...(observation.scrollReceipts?.length
        ? { scrollReceipts: observation.scrollReceipts }
        : {}),
      ...(actionCount !== undefined ? { actionCount } : {}),
      ...(ranCount !== undefined && ranCount !== actionCount
        ? { ranCount }
        : {}),
    },
    images: [observation.screenshotBase64],
  };
}

function boundPersistedToolOutput(value: string): string {
  const maxLength = 20_000;
  if (value.length <= maxLength) return value;
  const half = Math.floor(maxLength / 2);
  return `${value.slice(0, half)}\n... tool output truncated ...\n${value.slice(-half)}`;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '\n... response truncated ...';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  const prefix = Buffer.from(value, 'utf8')
    .subarray(0, budget)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}${suffix}`;
}

function commandResult(result: WorkCommandResult): {
  content: string;
  metadata: Record<string, unknown>;
} {
  const sections = [`exit_code: ${result.exitCode}`];
  if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
  if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
  return {
    content: sections.join('\n'),
    metadata: {
      exitCode: result.exitCode,
      truncated: result.truncated,
    },
  };
}

export const workAgentService = new WorkAgentService();
export default workAgentService;
