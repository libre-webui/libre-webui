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
 * Tool approval policy (TOOL-04). Read-only tools run without asking.
 * Side-effecting tools require the user's decision: once, for this chat, or
 * always for this tool on this server. Decisions are durable rows, so a
 * standing approval survives restarts and a pending request can be decided
 * from any replica; the waiting generation polls the row (with an
 * in-process fast path) and treats timeout or denial as a tool error the
 * model sees, never as silent execution.
 */

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getPersistence } from '../persistence/index.js';
import type { StoredToolApprovalRecord } from '../persistence/index.js';
import type {
  ToolApproval,
  ToolApprovalScope,
  ToolApprovalStatus,
} from '../types/tools.js';
import { encryptionService } from './encryptionService.js';
import { recordAuditEvent } from './securityAuditService.js';

export const APPROVAL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 400;
const MAX_LISTED_APPROVALS = 200;

const approvals = () =>
  getPersistence(encryptionService).repositories.resources.toolApprovals;

const decisionEmitter = new EventEmitter();
decisionEmitter.setMaxListeners(0);

export const argumentsDigest = (args: string): string =>
  createHash('sha256').update(args).digest('hex');

export const mapApprovalRow = (
  row: StoredToolApprovalRecord
): ToolApproval => ({
  id: row.id,
  ...(row.session_id ? { sessionId: row.session_id } : {}),
  ...(row.server_id ? { serverId: row.server_id } : {}),
  toolName: row.tool_name,
  ...(row.call_id ? { callId: row.call_id } : {}),
  scope: row.scope as ToolApprovalScope,
  status: row.status as ToolApprovalStatus,
  createdAt: row.created_at,
  ...(row.resolved_at !== null ? { resolvedAt: row.resolved_at } : {}),
  ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
});

/** A standing decision that already covers this call, if any. */
export async function findStandingApproval(
  userId: string,
  serverId: string | null,
  toolName: string,
  sessionId: string | null
): Promise<ToolApproval | null> {
  const row = await approvals().findStanding(
    userId,
    serverId,
    toolName,
    sessionId
  );
  return row ? mapApprovalRow(row) : null;
}

export interface PendingApprovalRequest {
  userId: string;
  /** Null for private sessions, which are never persisted. */
  sessionId: string | null;
  serverId: string | null;
  toolName: string;
  callId: string;
  argumentsJson: string;
}

export async function createPendingApproval(
  request: PendingApprovalRequest
): Promise<ToolApproval> {
  const now = Date.now();
  const record: StoredToolApprovalRecord = {
    id: uuidv4(),
    user_id: request.userId,
    session_id: request.sessionId,
    server_id: request.serverId,
    tool_name: request.toolName,
    call_id: request.callId,
    arguments_digest: argumentsDigest(request.argumentsJson),
    scope: 'once',
    status: 'pending',
    created_at: now,
    resolved_at: null,
    expires_at: now + APPROVAL_TIMEOUT_MS,
  };
  await approvals().insert(record);
  return mapApprovalRow(record);
}

export interface ApprovalDecisionInput {
  approve: boolean;
  scope: ToolApprovalScope;
}

/** Resolve a pending approval exactly once; null when it already resolved or expired. */
export async function decideApproval(
  userId: string,
  approvalId: string,
  decision: ApprovalDecisionInput
): Promise<ToolApproval | null> {
  const now = Date.now();
  const pending = await approvals().findByOwner(approvalId, userId);
  if (!pending) return null;
  // A session-scoped decision needs a persisted session to bind to.
  const scope: ToolApprovalScope =
    decision.scope === 'session' && !pending.session_id
      ? 'once'
      : decision.scope;
  const row = await approvals().resolvePending(
    approvalId,
    userId,
    decision.approve ? 'approved' : 'denied',
    scope,
    now
  );
  if (!row) return null;
  recordAuditEvent({
    action: decision.approve ? 'tool.approve' : 'tool.deny',
    result: 'success',
    actorUserId: userId,
    targetType: 'tool-approval',
    targetId: approvalId,
    details: { tool: row.tool_name, scope, serverId: row.server_id },
  });
  const approval = mapApprovalRow(row);
  decisionEmitter.emit(approvalId, approval);
  return approval;
}

/**
 * Wait for a pending approval to resolve. Combines an in-process fast path
 * with database polling so decisions made on another replica are honored.
 * Returns the resolved approval, or an expired view on timeout.
 */
export async function waitForDecision(
  userId: string,
  approvalId: string,
  signal?: AbortSignal
): Promise<ToolApproval> {
  return new Promise<ToolApproval>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      settled = true;
      decisionEmitter.removeListener(approvalId, onDecision);
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };
    const finish = (approval: ToolApproval): void => {
      if (settled) return;
      cleanup();
      resolve(approval);
    };
    const onDecision = (approval: ToolApproval): void => finish(approval);
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
        await approvals().expirePending(Date.now());
        const row = await approvals().findByOwner(approvalId, userId);
        if (!row) {
          finish({
            id: approvalId,
            toolName: '',
            scope: 'once',
            status: 'expired',
            createdAt: Date.now(),
          });
          return;
        }
        if (row.status !== 'pending') {
          finish(mapApprovalRow(row));
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

export async function listPendingApprovals(
  userId: string
): Promise<ToolApproval[]> {
  await approvals().expirePending(Date.now());
  const rows = await approvals().listPendingByOwner(
    userId,
    MAX_LISTED_APPROVALS
  );
  return rows.map(mapApprovalRow);
}

export async function listStandingApprovals(
  userId: string
): Promise<ToolApproval[]> {
  const rows = await approvals().listStandingByOwner(
    userId,
    MAX_LISTED_APPROVALS
  );
  return rows.map(mapApprovalRow);
}

/** Revoke a standing (or pending) approval the user owns. */
export async function revokeApproval(
  userId: string,
  approvalId: string
): Promise<boolean> {
  const deleted = await approvals().deleteByOwner(approvalId, userId);
  if (deleted) {
    recordAuditEvent({
      action: 'tool.approval-revoke',
      result: 'success',
      actorUserId: userId,
      targetType: 'tool-approval',
      targetId: approvalId,
    });
  }
  return deleted;
}
