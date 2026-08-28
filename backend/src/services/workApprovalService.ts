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

/**
 * Work action approvals (A5). A run whose task (or policy) requires review
 * pauses before a side-effecting tool call and waits for the owner's
 * decision: allow once, allow always (which persists a per-task rule), or
 * deny. Decisions are durable rows so any replica can decide; the waiting
 * run polls the row with an in-process fast path, exactly like chat tool
 * approvals. Timeout or denial reaches the model as an ordinary tool
 * result, never as silent execution.
 */

import { EventEmitter } from 'node:events';
import { v4 as uuidv4 } from 'uuid';
import {
  getWorkPersistence,
  type WorkApprovalRow,
  type WorkApprovalRuleRow,
  type WorkApprovalScope,
} from '../platform/workPersistence/index.js';
import type { WorkLiveApproval } from '../types/work.js';
import { recordAuditEvent } from './securityAuditService.js';

/** An unanswered approval stops waiting after this long (same as takeover). */
export const WORK_APPROVAL_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 1_000;
const SUMMARY_MAX_BYTES = 4_096;
const PATTERN_MAX_LENGTH = 256;

/** The Work tools that pause for review when approvals are active. */
export const GATED_WORK_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'computer_act',
  'delete_file',
  'move_file',
]);

const decisionEmitter = new EventEmitter();
decisionEmitter.setMaxListeners(0);

const persistence = () => getWorkPersistence();

const firstCommandToken = (command: unknown): string | null => {
  if (typeof command !== 'string') return null;
  const token = command.trim().split(/\s+/, 1)[0] ?? '';
  return token ? token.slice(0, PATTERN_MAX_LENGTH) : null;
};

/**
 * The rule scope an Always-allow decision creates. `run_command` scopes to
 * the command's program (first token) so one decision does not open the
 * whole shell; every other gated tool scopes to the tool itself.
 */
export const deriveRulePattern = (
  toolName: string,
  summary: Record<string, unknown> | undefined
): string | null =>
  toolName === 'run_command' ? firstCommandToken(summary?.command) : null;

/** Whether a persisted rule covers this call. */
export const ruleCovers = (
  rule: Pick<WorkApprovalRuleRow, 'tool_name' | 'pattern'>,
  toolName: string,
  summary: Record<string, unknown> | undefined
): boolean => {
  if (rule.tool_name !== toolName) return false;
  if (rule.pattern === null) return true;
  return (
    toolName === 'run_command' &&
    firstCommandToken(summary?.command) === rule.pattern
  );
};

export interface WorkApprovalView extends WorkLiveApproval {
  taskId: string;
  runId: string;
  createdAt: number;
  resolvedAt?: number;
  scope: WorkApprovalScope;
}

export interface WorkApprovalRuleView {
  id: string;
  taskId: string;
  toolName: string;
  pattern?: string;
  createdAt: number;
}

const parseSummary = (
  raw: string | null
): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const mapApproval = (row: WorkApprovalRow): WorkApprovalView => ({
  approvalId: row.id,
  taskId: row.task_id,
  runId: row.run_id,
  toolCallId: row.tool_call_id,
  name: row.tool_name,
  summary: parseSummary(row.summary),
  status: row.status,
  scope: row.scope,
  createdAt: row.created_at,
  ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  expiresAt: row.expires_at,
});

export const mapApprovalRule = (
  row: WorkApprovalRuleRow
): WorkApprovalRuleView => ({
  id: row.id,
  taskId: row.task_id,
  toolName: row.tool_name,
  ...(row.pattern !== null ? { pattern: row.pattern } : {}),
  createdAt: row.created_at,
});

export interface PendingWorkApprovalRequest {
  taskId: string;
  runId: string;
  userId: string;
  toolCallId: string;
  toolName: string;
  summary: Record<string, unknown>;
}

class WorkApprovalService {
  /** Rules for one task; failures resolve to "no rules" (gate stays closed). */
  async rulesForTask(taskId: string): Promise<WorkApprovalRuleView[]> {
    const rows = await persistence().listApprovalRules(taskId);
    return rows.map(mapApprovalRule);
  }

  /** Whether an existing rule already allows this call. */
  async callIsPreapproved(
    taskId: string,
    toolName: string,
    summary: Record<string, unknown>
  ): Promise<boolean> {
    const rules = await persistence().listApprovalRules(taskId);
    return rules.some(rule => ruleCovers(rule, toolName, summary));
  }

  async createPending(
    request: PendingWorkApprovalRequest
  ): Promise<WorkApprovalView> {
    const now = Date.now();
    let summary: string | null = JSON.stringify(request.summary);
    if (Buffer.byteLength(summary, 'utf8') > SUMMARY_MAX_BYTES) summary = null;
    const row: WorkApprovalRow = {
      id: uuidv4(),
      task_id: request.taskId,
      run_id: request.runId,
      user_id: request.userId,
      tool_call_id: request.toolCallId,
      tool_name: request.toolName,
      summary,
      status: 'pending',
      scope: 'once',
      created_at: now,
      resolved_at: null,
      expires_at: now + WORK_APPROVAL_TIMEOUT_MS,
    };
    await persistence().insertApproval(row);
    return mapApproval(row);
  }

  async listPending(taskId: string): Promise<WorkApprovalView[]> {
    await persistence().expirePendingApprovals(Date.now());
    const rows = await persistence().listPendingApprovals(taskId);
    return rows.map(mapApproval);
  }

  /**
   * Resolve a pending approval exactly once; null when it already resolved
   * or expired. An approved `always` decision also persists the rule that
   * auto-allows future matching calls on this task.
   */
  async decide(
    taskId: string,
    approvalId: string,
    actorUserId: string,
    decision: { approve: boolean; scope: WorkApprovalScope }
  ): Promise<WorkApprovalView | null> {
    const now = Date.now();
    await persistence().expirePendingApprovals(now);
    const scope: WorkApprovalScope = decision.approve ? decision.scope : 'once';
    const row = await persistence().resolvePendingApproval(
      approvalId,
      taskId,
      decision.approve ? 'approved' : 'denied',
      scope,
      now
    );
    if (!row) return null;
    const approval = mapApproval(row);
    if (decision.approve && scope === 'always') {
      await persistence().insertApprovalRule({
        id: uuidv4(),
        task_id: taskId,
        user_id: actorUserId,
        tool_name: row.tool_name,
        pattern: deriveRulePattern(row.tool_name, approval.summary),
        created_at: now,
      });
    }
    recordAuditEvent({
      action: decision.approve ? 'work.action-approve' : 'work.action-deny',
      result: 'success',
      actorUserId,
      targetType: 'work-approval',
      targetId: approvalId,
      details: { tool: row.tool_name, scope, taskId },
    });
    decisionEmitter.emit(approvalId, approval);
    return approval;
  }

  async deleteRule(
    taskId: string,
    ruleId: string,
    actorUserId: string
  ): Promise<boolean> {
    const deleted = await persistence().deleteApprovalRule(ruleId, taskId);
    if (deleted) {
      recordAuditEvent({
        action: 'work.approval-rule-revoke',
        result: 'success',
        actorUserId,
        targetType: 'work-approval-rule',
        targetId: ruleId,
        details: { taskId },
      });
    }
    return deleted;
  }

  /**
   * Wait for a pending approval to resolve. In-process fast path plus
   * database polling so a decision made on another replica is honored.
   * Returns an expired view on timeout; rejects only on abort.
   */
  async waitForDecision(
    taskId: string,
    approvalId: string,
    signal?: AbortSignal
  ): Promise<WorkApprovalView> {
    return new Promise<WorkApprovalView>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = (): void => {
        settled = true;
        decisionEmitter.removeListener(approvalId, onDecision);
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };
      const finish = (approval: WorkApprovalView): void => {
        if (settled) return;
        cleanup();
        resolve(approval);
      };
      const onDecision = (approval: WorkApprovalView): void => finish(approval);
      const onAbort = (): void => {
        if (settled) return;
        cleanup();
        reject(
          signal?.reason instanceof Error ? signal.reason : new Error('aborted')
        );
      };

      decisionEmitter.on(approvalId, onDecision);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }

      const poll = async (): Promise<void> => {
        if (settled) return;
        try {
          await persistence().expirePendingApprovals(Date.now());
          const row = await persistence().findApproval(approvalId, taskId);
          if (!row) {
            finish({
              approvalId,
              taskId,
              runId: '',
              toolCallId: '',
              name: '',
              status: 'expired',
              scope: 'once',
              createdAt: Date.now(),
            });
            return;
          }
          if (row.status !== 'pending') {
            finish(mapApproval(row));
            return;
          }
        } catch {
          // Transient read failures fall through to the next poll.
        }
        if (!settled) timer = setTimeout(poll, POLL_INTERVAL_MS);
      };
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    });
  }
}

export const workApprovalService = new WorkApprovalService();
export default workApprovalService;
