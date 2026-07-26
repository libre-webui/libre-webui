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

import workModelProviderService from './workModelProviderService.js';
import workEventService from './workEventService.js';
import {
  buildWorkAgentSystemPrompt,
  buildWorkBudgetExhaustionPrompt,
  WORK_AGENT_SKILLS,
  workToolCallBudget,
} from './workAgentGuidance.js';
import workRuntimeService, { WorkCommandResult } from './workRuntimeService.js';
import workTaskService, {
  WorkConflictError,
  WorkNotFoundError,
} from './workTaskService.js';
import { OllamaChatMessage, OllamaChatResponse } from '../types/index.js';
import { WorkTaskDetail, WorkTaskRecord, WorkToolCall } from '../types/work.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-agent');

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
      content: stringProperty('Complete file content.'),
    },
    ['path', 'content']
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
    'Start the workspace web application on the managed preview port.',
    {
      command: stringProperty(
        `Optional development-server command. It must listen on 0.0.0.0:${workRuntimeService.previewPort}.`
      ),
    }
  ),
  functionTool('stop_preview', 'Stop the running workspace preview.', {}),
];

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

  async cancel(taskId: string, userId: string): Promise<WorkTaskDetail> {
    const task = workTaskService.requireMutableTaskRecord(taskId, userId);
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
    const run = workTaskService.getActiveRun(taskId);
    if (!run) {
      throw new WorkConflictError('This Work task has no active run.');
    }
    this.controllers.get(run.id)?.abort();
    await workRuntimeService.stopContainer(task);
    await this.executions.get(run.id);
    if (isActiveRunStatus(workTaskService.getRun(run.id)?.status)) {
      workTaskService.updateRun(run.id, 'cancelled', {
        error: 'Cancelled by user.',
        finished: true,
      });
      workTaskService.updateTaskStatus(taskId, 'cancelled');
      workTaskService.updatePreview(taskId, 'stopped');
      workEventService.publish(taskId, run.id, 'done', {
        status: 'cancelled',
        error: 'Cancelled by user.',
      });
    }
    return workTaskService.requireTaskDetail(taskId, userId);
  }

  async removeTasksForUser(userId: string): Promise<void> {
    workTaskService.beginUserRetirement(userId);
    try {
      const tasks = workTaskService.listTaskRecords(userId);
      for (const task of tasks) {
        await this.removeTaskInternal(task.id, userId, true);
      }
    } catch (error) {
      workTaskService.releaseUserRetirement(userId);
      throw error;
    }
  }

  async revokeWorkAccessForUser<T>(
    userId: string,
    revoke: () => Promise<T>
  ): Promise<T> {
    workTaskService.beginUserRetirement(userId);
    const tasks = workTaskService.listTaskRecords(userId);
    const suspendedTaskIds: string[] = [];
    try {
      for (const task of tasks) {
        workRuntimeService.beginTaskSuspension(task.id);
        suspendedTaskIds.push(task.id);
      }

      // Persist revocation before depending on Docker cleanup. Even when a
      // daemon outage prevents teardown, current-role authorization denies
      // every subsequent Work request and a retry/restart can finish cleanup.
      const result = await revoke();
      const activeRuns = new Map(
        tasks.map(task => [task.id, workTaskService.getActiveRun(task.id)])
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
            isActiveRunStatus(workTaskService.getRun(run.id)?.status)
          ) {
            workTaskService.updateRun(run.id, 'cancelled', {
              error: 'Administrator access was revoked.',
              finished: true,
            });
            workTaskService.updateTaskStatus(task.id, 'cancelled');
            workEventService.publish(task.id, run.id, 'done', {
              status: 'cancelled',
              error: 'Administrator access was revoked.',
            });
          }
          workTaskService.updatePreview(task.id, 'stopped');
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
    const task = workTaskService.beginTaskRetirement(
      taskId,
      userId,
      allowRetiringUser
    );
    try {
      if (workTaskService.getActiveRun(taskId)) {
        await this.cancelTask(task, userId);
      }
      await workRuntimeService.removeTask(task, allowRetiringUser);
      try {
        workTaskService.deleteTask(taskId, userId);
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
    const tasks = workTaskService.listAllTaskRecords();
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
      task = workTaskService.requireTaskRecord(taskId, userId);
      const run = workTaskService.getRun(runId);
      if (!run || run.taskId !== taskId) {
        throw new WorkNotFoundError('Work run not found.');
      }
      // A cancel request can arrive in the microtask gap between persisting a
      // queued run and starting its executor. Never revive a terminal run.
      if (run.status !== 'queued') {
        return;
      }
      workTaskService.updateRun(runId, 'preparing', { started: true });
      workTaskService.updateTaskStatus(taskId, 'preparing');
      workEventService.publish(taskId, runId, 'run_state', {
        status: 'preparing',
        phase: 'preparing',
      });
      for (const skill of WORK_AGENT_SKILLS) {
        workEventService.publish(taskId, runId, 'skill_loaded', {
          id: skill.id,
          name: skill.title,
          description: skill.instructions[0],
        });
      }
      releaseExecutionLease = await workRuntimeService.prepare(
        task,
        controller.signal
      );
      this.throwIfCancelled(runId, controller);
      workTaskService.updateRun(runId, 'running', { started: true });
      workTaskService.updateTaskStatus(taskId, 'running');
      const roundLimit = workRuntimeService.limits.maxRounds;
      const toolCallLimit = workToolCallBudget(roundLimit);
      const messages = this.contextMessages(task, roundLimit);
      let totalToolCalls = 0;
      let accumulatedInputTokens = 0;
      let accumulatedOutputTokens = 0;
      let streamedAssistantTotal = '';
      let streamedReasoningTotal = '';
      let budgetReason = 'round';

      roundLoop: for (let round = 0; round < roundLimit; round++) {
        this.throwIfCancelled(runId, controller);
        workEventService.publish(taskId, runId, 'run_state', {
          status: 'running',
          phase: 'thinking',
          round: round + 1,
          roundLimit,
        });
        const contentStream = new WorkDeltaPublisher(
          taskId,
          runId,
          'assistant_delta',
          streamedAssistantTotal
        );
        const reasoningStream = new WorkDeltaPublisher(
          taskId,
          runId,
          'reasoning_delta',
          streamedReasoningTotal
        );
        let roundInputTokens = 0;
        let roundOutputTokens = 0;
        const roundStartedAt = Date.now();
        let response: OllamaChatResponse;
        try {
          response = await workModelProviderService.generateChatStreamResponse(
            {
              model: run.model,
              messages,
              tools: WORK_TOOL_SCHEMAS,
              options:
                run.providerType === 'plugin'
                  ? { num_predict: 4096 }
                  : undefined,
              stream: true,
            },
            {
              providerType: run.providerType,
              providerId: run.providerId,
            },
            userId,
            {
              onContent: delta => contentStream.push(delta),
              onReasoning: delta => reasoningStream.push(delta),
              onUsage: usage => {
                roundInputTokens = usage.promptTokens ?? roundInputTokens;
                roundOutputTokens = usage.completionTokens ?? roundOutputTokens;
                workEventService.publish(taskId, runId, 'usage', {
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
        this.throwIfCancelled(runId, controller);
        accumulatedInputTokens += roundInputTokens;
        accumulatedOutputTokens += roundOutputTokens;
        const toolCalls = normalizeToolCalls(response);
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
          workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'reasoning',
            reasoningContent,
            { providerExposed: true, round: round + 1 }
          );
        }
        if (toolCalls.length === 0) {
          const finalContent =
            assistantContent ||
            'The model completed without returning a text response.';
          workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'message',
            finalContent
          );
          // Keep completion hidden until the disposable container has either
          // stopped or been retained for a verified live preview. Consumers
          // can then refresh files immediately without racing teardown.
          await settleExecutionContainer();
          this.throwIfCancelled(runId, controller);
          if (!isActiveRunStatus(workTaskService.getRun(runId)?.status)) {
            return;
          }
          workTaskService.updateRun(runId, 'completed', { finished: true });
          workTaskService.updateTaskStatus(taskId, 'completed');
          workEventService.publish(taskId, runId, 'done', {
            status: 'completed',
          });
          return;
        }

        messages.push({
          role: 'assistant',
          content: assistantContent,
          tool_calls: toolCalls as unknown as Record<string, unknown>[],
        });
        if (assistantContent) {
          workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'message',
            assistantContent
          );
        }
        for (const call of toolCalls) {
          this.throwIfCancelled(runId, controller);
          const toolCallMetadata = summarizeToolCall(call);
          const toolCallMessage = workTaskService.addMessage(
            taskId,
            runId,
            'assistant',
            'tool_call',
            `Calling ${call.function.name}`,
            toolCallMetadata
          );
          workEventService.publish(taskId, runId, 'run_state', {
            status: 'running',
            phase: 'using_tool',
            round: round + 1,
            roundLimit,
          });
          workEventService.publish(taskId, runId, 'tool_call', {
            toolCallId: call.id,
            name: call.function.name,
            arguments: toolCallMetadata,
            metadata: toolCallMetadata,
            phase: 'running',
            message: toolCallMessage,
          });
          let toolOutput: string;
          let toolMetadata: Record<string, unknown> = {
            name: call.function.name,
            toolCallId: call.id,
            toolName: call.function.name,
          };
          try {
            const result = await this.executeTool(task, call);
            toolOutput = result.content;
            toolMetadata = { ...toolMetadata, ...result.metadata };
          } catch (error) {
            toolOutput =
              error instanceof Error
                ? `Tool error: ${error.message}`
                : 'Tool error.';
            toolMetadata.error = true;
          }
          const boundedOutput = boundPersistedToolOutput(toolOutput);
          if (boundedOutput !== toolOutput) {
            toolMetadata.outputTruncated = true;
            toolOutput = boundedOutput;
          }
          const toolResultMessage = workTaskService.addMessage(
            taskId,
            runId,
            'tool',
            'tool_result',
            toolOutput,
            toolMetadata
          );
          workEventService.publish(taskId, runId, 'tool_result', {
            toolCallId: call.id,
            name: call.function.name,
            phase: toolMetadata.error ? 'failed' : 'completed',
            content: toolOutput,
            error: toolMetadata.error === true,
            message: toolResultMessage,
          });
          messages.push({
            role: 'tool',
            content: toolOutput,
            tool_name: call.function.name,
          });
        }
      }
      this.throwIfCancelled(runId, controller);
      workEventService.publish(taskId, runId, 'run_state', {
        status: 'running',
        phase: 'responding',
        round: roundLimit,
        roundLimit,
      });
      const handoffContentStream = new WorkDeltaPublisher(
        taskId,
        runId,
        'assistant_delta',
        streamedAssistantTotal
      );
      const handoffReasoningStream = new WorkDeltaPublisher(
        taskId,
        runId,
        'reasoning_delta',
        streamedReasoningTotal
      );
      let handoffInputTokens = 0;
      let handoffOutputTokens = 0;
      const handoffStartedAt = Date.now();
      let handoffResponse: OllamaChatResponse;
      try {
        try {
          handoffResponse =
            await workModelProviderService.generateChatStreamResponse(
              {
                model: run.model,
                messages: [
                  ...messages,
                  {
                    role: 'user',
                    content: `${buildWorkBudgetExhaustionPrompt()}\nThe ${budgetReason} budget was reached.`,
                  },
                ],
                tools: [],
                options:
                  run.providerType === 'plugin'
                    ? { num_predict: 2048 }
                    : undefined,
                stream: true,
              },
              {
                providerType: run.providerType,
                providerId: run.providerId,
              },
              userId,
              {
                onContent: delta => handoffContentStream.push(delta),
                onReasoning: delta => handoffReasoningStream.push(delta),
                onUsage: usage => {
                  handoffInputTokens = usage.promptTokens ?? handoffInputTokens;
                  handoffOutputTokens =
                    usage.completionTokens ?? handoffOutputTokens;
                  workEventService.publish(taskId, runId, 'usage', {
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
      this.throwIfCancelled(runId, controller);
      const handoffReasoning = boundUtf8(
        handoffResponse.message?.thinking?.trim() || '',
        100_000
      );
      if (handoffReasoning) {
        workTaskService.addMessage(
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
      workTaskService.addMessage(
        taskId,
        runId,
        'assistant',
        'message',
        handoffContent,
        { budgetHandoff: true, budgetReason }
      );
      await settleExecutionContainer();
      this.throwIfCancelled(runId, controller);
      if (!isActiveRunStatus(workTaskService.getRun(runId)?.status)) return;
      workTaskService.updateRun(runId, 'needs_input', { finished: true });
      workTaskService.updateTaskStatus(taskId, 'needs_input');
      workEventService.publish(taskId, runId, 'done', {
        status: 'needs_input',
        budgetReason,
      });
    } catch (error) {
      const currentRun = workTaskService.getRun(runId);
      if (currentRun?.status === 'cancelled' || controller.signal.aborted) {
        if (task) {
          try {
            await workRuntimeService.stopContainer(task);
            executionContainerSettled = true;
            if (isActiveRunStatus(workTaskService.getRun(runId)?.status)) {
              workTaskService.updateRun(runId, 'cancelled', {
                error: 'Cancelled by user.',
                finished: true,
              });
              workTaskService.updateTaskStatus(taskId, 'cancelled');
              workTaskService.updatePreview(taskId, 'stopped');
              workEventService.publish(taskId, runId, 'done', {
                status: 'cancelled',
                error: 'Cancelled by user.',
              });
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
      const settledRun = workTaskService.getRun(runId);
      if (controller.signal.aborted || settledRun?.status === 'cancelled') {
        if (isActiveRunStatus(settledRun?.status)) {
          workTaskService.updateRun(runId, 'cancelled', {
            error: 'Cancelled by user.',
            finished: true,
          });
          workTaskService.updateTaskStatus(taskId, 'cancelled');
          workTaskService.updatePreview(taskId, 'stopped');
          workEventService.publish(taskId, runId, 'done', {
            status: 'cancelled',
            error: 'Cancelled by user.',
          });
        }
        return;
      }
      if (!isActiveRunStatus(settledRun?.status)) {
        return;
      }
      workTaskService.addMessage(taskId, runId, 'assistant', 'error', message);
      workTaskService.updateRun(runId, 'failed', {
        error: message,
        finished: true,
      });
      workTaskService.updateTaskStatus(taskId, 'failed');
      workEventService.publish(taskId, runId, 'error', {
        message,
        code: error instanceof WorkAgentHttpError ? error.code : undefined,
      });
      workEventService.publish(taskId, runId, 'done', {
        status: 'failed',
        error: message,
      });
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
      if (workTaskService.getTaskRecord(task.id, task.userId)) {
        workTaskService.updatePreview(task.id, 'stopped');
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

  private contextMessages(
    task: WorkTaskRecord,
    roundLimit: number
  ): OllamaChatMessage[] {
    const persisted = workTaskService
      .getRecentConversationMessages(task.id, 30)
      .map(message => ({
        role: message.role,
        content: message.content,
      })) satisfies OllamaChatMessage[];
    return [
      {
        role: 'system',
        content: buildWorkAgentSystemPrompt({
          networkEnabled: task.networkEnabled,
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
    call: WorkToolCall
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
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
      case 'search_files': {
        const result = await workRuntimeService.searchFiles(
          task,
          requiredString(args.query, 'query'),
          optionalString(args.path) || '.'
        );
        return commandResult(result);
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
            onRunning: previewUrl =>
              workTaskService.updatePreview(task.id, 'running', previewUrl),
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
      default:
        throw new WorkAgentHttpError(
          `Unknown tool: ${call.function.name}`,
          400,
          'WORK_UNKNOWN_TOOL'
        );
    }
  }

  private throwIfCancelled(runId: string, controller: AbortController): void {
    if (
      controller.signal.aborted ||
      workTaskService.getRun(runId)?.status === 'cancelled'
    ) {
      throw new WorkAgentHttpError(
        'Work run was cancelled.',
        409,
        'WORK_RUN_CANCELLED'
      );
    }
  }
}

class WorkDeltaPublisher {
  private pending = '';
  private total = '';
  private separatorPending = '';
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly taskId: string,
    private readonly runId: string,
    private readonly type: 'assistant_delta' | 'reasoning_delta',
    initialTotal = ''
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
    workEventService.publish(this.taskId, this.runId, this.type, {
      delta,
    });
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

export function normalizeToolCalls(
  response: OllamaChatResponse
): WorkToolCall[] {
  const raw = response.message?.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((value, index) => {
      if (!value || typeof value !== 'object') return [];
      const record = value as Record<string, unknown>;
      const fn =
        record.function && typeof record.function === 'object'
          ? (record.function as Record<string, unknown>)
          : undefined;
      if (!fn || typeof fn.name !== 'string') return [];
      let args: Record<string, unknown> = {};
      if (fn.arguments && typeof fn.arguments === 'object') {
        args = fn.arguments as Record<string, unknown>;
      } else if (typeof fn.arguments === 'string') {
        try {
          const parsed = JSON.parse(fn.arguments);
          if (parsed && typeof parsed === 'object') {
            args = parsed as Record<string, unknown>;
          }
        } catch {
          args = {};
        }
      }
      return [
        {
          id:
            typeof record.id === 'string'
              ? record.id
              : `tool-${Date.now()}-${index}`,
          ...(typeof record.thoughtSignature === 'string'
            ? { thoughtSignature: record.thoughtSignature }
            : {}),
          ...(record.providerMetadata &&
          typeof record.providerMetadata === 'object' &&
          !Array.isArray(record.providerMetadata)
            ? {
                providerMetadata: record.providerMetadata as Record<
                  string,
                  unknown
                >,
              }
            : {}),
          function: { name: fn.name, arguments: args },
        },
      ];
    })
    .slice(0, 16);
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
    case 'search_files':
      includeString('path', args.path);
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
    default:
      break;
  }
  return metadata;
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
