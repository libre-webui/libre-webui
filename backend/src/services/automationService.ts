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
import type {
  Automation,
  AutomationNotify,
  AutomationRun,
  AutomationRunStatus,
  AutomationStatus,
  AutomationTrigger,
} from '../types/index.js';
import { encryptionService } from './encryptionService.js';
import { getPersistence } from '../persistence/index.js';
import { PersistenceResourceLimitError } from '../persistence/resourceTypes.js';
import type {
  StoredAutomationRecord,
  StoredAutomationRunRecord,
} from '../persistence/resourceTypes.js';
import { nextRunAt, validateTriggers } from '../utils/automationSchedule.js';
import {
  MAX_AUTOMATION_INSTRUCTIONS_LENGTH,
  MAX_AUTOMATION_NAME_LENGTH,
  MAX_AUTOMATIONS_PER_USER,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';

const RUN_LIST_LIMIT = 500;

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

/**
 * The stored provider column carries the normalized selection as
 * `providerType` or `providerType:providerId`; null means Auto.
 */
export const encodeProvider = (
  providerType?: string,
  providerId?: string
): string | null => {
  if (!providerType) return null;
  return providerId ? `${providerType}:${providerId}` : providerType;
};

export const decodeProvider = (
  value: string | null
): { providerType?: string; providerId?: string } => {
  if (!value) return {};
  const separator = value.indexOf(':');
  if (separator === -1) return { providerType: value };
  return {
    providerType: value.slice(0, separator),
    providerId: value.slice(separator + 1),
  };
};

const mapAutomationRow = (row: StoredAutomationRecord): Automation => ({
  id: row.id,
  name: encryptionService.decrypt(row.name),
  instructions: encryptionService.decrypt(row.instructions),
  triggers: JSON.parse(row.triggers) as AutomationTrigger[],
  ...(row.provider ? { provider: row.provider } : {}),
  ...(row.model ? { model: row.model } : {}),
  notify: row.notify as AutomationNotify,
  status: row.status as AutomationStatus,
  ...(row.next_run_at !== null ? { nextRunAt: row.next_run_at } : {}),
  ...(row.last_run_at !== null ? { lastRunAt: row.last_run_at } : {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapRunRow = (row: StoredAutomationRunRecord): AutomationRun => ({
  id: row.id,
  automationId: row.automation_id,
  scheduledFor: row.scheduled_for,
  ...(row.started_at !== null ? { startedAt: row.started_at } : {}),
  ...(row.finished_at !== null ? { finishedAt: row.finished_at } : {}),
  status: row.status as AutomationRunStatus,
  ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
  ...(row.error !== null ? { error: row.error } : {}),
  seen: row.seen_at !== null,
  createdAt: row.created_at,
});

export interface AutomationInput {
  name: string;
  instructions: string;
  triggers: unknown;
  provider?: string;
  model?: string;
  notify?: AutomationNotify;
}

class AutomationService {
  async getAutomations(userId: string): Promise<Automation[]> {
    const rows = await repositories().automations.listByOwner(
      userId,
      MAX_AUTOMATIONS_PER_USER
    );
    return rows.map(mapAutomationRow);
  }

  async getAutomation(
    automationId: string,
    userId: string
  ): Promise<Automation | undefined> {
    const row = await repositories().automations.findByOwner(
      automationId,
      userId
    );
    return row ? mapAutomationRow(row) : undefined;
  }

  /** Owner-blind lookup for the durable job handler and scheduler. */
  async getAutomationRecord(
    automationId: string
  ): Promise<(Automation & { userId: string }) | undefined> {
    const row = await repositories().automations.findById(automationId);
    return row ? { ...mapAutomationRow(row), userId: row.user_id } : undefined;
  }

  async createAutomation(
    input: AutomationInput,
    userId: string
  ): Promise<Automation> {
    return this.persistAutomation(input, userId, undefined);
  }

  async updateAutomation(
    automationId: string,
    input: AutomationInput,
    userId: string
  ): Promise<Automation | undefined> {
    const existing = await repositories().automations.findByOwner(
      automationId,
      userId
    );
    if (!existing) return undefined;
    return this.persistAutomation(input, userId, existing);
  }

  private async persistAutomation(
    input: AutomationInput,
    userId: string,
    existing: StoredAutomationRecord | undefined
  ): Promise<Automation> {
    if (
      !input.name.trim() ||
      input.name.length > MAX_AUTOMATION_NAME_LENGTH ||
      !input.instructions.trim() ||
      input.instructions.length > MAX_AUTOMATION_INSTRUCTIONS_LENGTH
    ) {
      throw new ResourcePolicyError(
        'Automation name or instructions are missing or exceed the maximum size',
        400
      );
    }
    const triggers = validateTriggers(input.triggers);
    const now = Date.now();
    const status = (existing?.status ?? 'active') as AutomationStatus;
    const record: StoredAutomationRecord = {
      id: existing?.id ?? uuidv4(),
      user_id: userId,
      name: encryptionService.encrypt(input.name.trim()),
      instructions: encryptionService.encrypt(input.instructions.trim()),
      triggers: JSON.stringify(triggers),
      provider: input.provider ?? null,
      model: input.model ?? null,
      notify: input.notify === 'off' ? 'off' : 'app',
      status,
      // Editing reschedules from now; a paused automation stays dormant.
      next_run_at: status === 'active' ? nextRunAt(triggers, now) : null,
      last_run_at: existing?.last_run_at ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    try {
      await repositories().automations.replaceWithLimit(
        record,
        MAX_AUTOMATIONS_PER_USER
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ResourcePolicyError(
          `A user may store at most ${MAX_AUTOMATIONS_PER_USER} automations`,
          409
        );
      }
      throw error;
    }
    return mapAutomationRow(record);
  }

  async setAutomationStatus(
    automationId: string,
    userId: string,
    status: AutomationStatus
  ): Promise<Automation | undefined> {
    const row = await repositories().automations.findByOwner(
      automationId,
      userId
    );
    if (!row) return undefined;
    const now = Date.now();
    const nextRun =
      status === 'active'
        ? nextRunAt(JSON.parse(row.triggers) as AutomationTrigger[], now)
        : null;
    const updated = await repositories().automations.setStatus(
      automationId,
      userId,
      status,
      nextRun,
      now
    );
    if (!updated) return undefined;
    return mapAutomationRow({
      ...row,
      status,
      next_run_at: nextRun,
      updated_at: now,
    });
  }

  async deleteAutomation(
    automationId: string,
    userId: string
  ): Promise<boolean> {
    return repositories().automations.deleteByOwner(automationId, userId);
  }

  // ----- runs -----

  async createRun(
    automationId: string,
    userId: string,
    scheduledFor: number
  ): Promise<AutomationRun> {
    const record: StoredAutomationRunRecord = {
      id: uuidv4(),
      automation_id: automationId,
      user_id: userId,
      scheduled_for: scheduledFor,
      started_at: null,
      finished_at: null,
      status: 'queued',
      session_id: null,
      assistant_message_id: null,
      error: null,
      seen_at: null,
      created_at: Date.now(),
    };
    await repositories().automationRuns.insert(record);
    return mapRunRow(record);
  }

  async getRunRecord(
    runId: string,
    userId: string
  ): Promise<StoredAutomationRunRecord | null> {
    return repositories().automationRuns.findByOwner(runId, userId);
  }

  async listRuns(
    userId: string,
    options: { automationId?: string; from?: number; to?: number } = {}
  ): Promise<AutomationRun[]> {
    const rows = await repositories().automationRuns.listByOwner(userId, {
      ...options,
      maximum: RUN_LIST_LIMIT,
    });
    return rows.map(mapRunRow);
  }

  async listUnfinishedRunRecords(): Promise<StoredAutomationRunRecord[]> {
    return repositories().automationRuns.listUnfinished(200);
  }

  async markRunStarted(
    runId: string,
    sessionId: string,
    assistantMessageId: string
  ): Promise<boolean> {
    return repositories().automationRuns.markStarted(
      runId,
      sessionId,
      assistantMessageId,
      Date.now()
    );
  }

  async finalizeRun(
    runId: string,
    status: 'succeeded' | 'failed',
    error: string | null = null,
    context?: { userId: string; automationId: string }
  ): Promise<boolean> {
    const finalized = await repositories().automationRuns.finalize(
      runId,
      status,
      Date.now(),
      error
    );
    if (finalized && status === 'failed' && context) {
      // Failure awareness must not depend on the automations page being
      // open; publish an in-app notification unless the automation opted
      // out of notifications entirely.
      try {
        const automation = await this.getAutomationRecord(context.automationId);
        if (automation && automation.notify !== 'off') {
          const { notificationService } =
            await import('./notificationService.js');
          await notificationService.publish({
            userId: context.userId,
            type: 'automation-failed',
            title: `Automation "${automation.name}" failed`,
            ...(error ? { body: error } : {}),
            href: '/automations',
            sourceKey: `automation-run-failed:${runId}`,
          });
        }
      } catch {
        // Best effort: the run row already records the failure.
      }
    }
    return finalized;
  }

  async runsSummary(userId: string): Promise<{
    unseenCount: number;
    days: { succeeded: number; failed: number }[];
  }> {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const start = new Date(now);
    const todayStart = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate()
    ).getTime();
    const windowStart = todayStart - 29 * dayMs;
    const [unseenCount, runs] = await Promise.all([
      repositories().automationRuns.countUnseenFinished(userId),
      repositories().automationRuns.listByOwner(userId, {
        from: windowStart,
        maximum: RUN_LIST_LIMIT,
      }),
    ]);
    const days = Array.from({ length: 30 }, () => ({
      succeeded: 0,
      failed: 0,
    }));
    for (const run of runs) {
      const index = Math.floor((run.scheduled_for - windowStart) / dayMs);
      if (index < 0 || index >= 30) continue;
      if (run.status === 'succeeded') days[index].succeeded += 1;
      else if (run.status === 'failed') days[index].failed += 1;
    }
    return { unseenCount, days };
  }

  async markRunsSeen(userId: string): Promise<number> {
    return repositories().automationRuns.markSeenBefore(userId, Date.now());
  }
}

const automationService = new AutomationService();
export default automationService;
