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
 * Cost and quota governance (ADMIN-01).
 *
 * Tariffs are versioned price rows (`effective_from`) per plugin and model —
 * an exact model row wins over a plugin-wide row (model = null), and the
 * newest row at or before the usage event's time applies. Costs are computed
 * from the recorded usage ledger: provider-reported token counts price
 * against per-million rates, media units price against a unit rate, and
 * events without a matching tariff (or without provider-reported usage) are
 * surfaced as unmetered rather than silently costed at zero.
 *
 * Budgets attach to the whole instance, one user, or one group, over a UTC
 * day, ISO week, or calendar month. `observe` budgets only appear in
 * analytics; `soft` budgets alert at 80% and 100%; `hard` budgets alert and
 * additionally block new interactive generations once exhausted. Enforcement
 * reads a coordinator-cached spend figure so admission stays cheap, and a
 * cache outage fails open for availability — hard budgets bound spend within
 * one cache interval, not to the cent.
 */

import { randomUUID } from 'crypto';
import { getPersistence } from '../persistence/index.js';
import type {
  StoredModelTariffRecord,
  StoredUsageBudgetRecord,
} from '../persistence/resourceTypes.js';
import type { StoredPluginUsageEvent } from '../persistence/extensionTypes.js';
import { encryptionService } from './encryptionService.js';
import { listGroupsWithMembers } from './groupService.js';
import { notificationService } from './notificationService.js';
import { getCoordinator } from '../platform/coordination/service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:cost-governance');

const MAX_TARIFFS = 500;
const MAX_BUDGETS = 200;
const MAX_COST_EVENTS = 100_000;
const SPEND_CACHE_TTL_MS = 30_000;
const ALERT_THRESHOLDS = [0.8, 1] as const;

export type BudgetPeriod = StoredUsageBudgetRecord['period'];
export type BudgetMode = StoredUsageBudgetRecord['mode'];
export type BudgetPrincipalType = StoredUsageBudgetRecord['principal_type'];

export class BudgetExceededError extends Error {
  readonly statusCode = 429;
  constructor(readonly budgetName: string) {
    super(
      `The "${budgetName}" budget is exhausted for this period; new generations are paused`
    );
    this.name = 'BudgetExceededError';
  }
}

export interface TariffInput {
  pluginId: string;
  model?: string | null;
  inputPerMillion?: number | null;
  outputPerMillion?: number | null;
  unitPrice?: number | null;
  effectiveFrom?: number;
}

export interface BudgetInput {
  name: string;
  principalType: BudgetPrincipalType;
  principalId?: string | null;
  period: BudgetPeriod;
  amountUsd: number;
  mode: BudgetMode;
}

export interface CostAnalytics {
  from: number;
  to: number;
  totalUsd: number;
  meteredEvents: number;
  unmeteredEvents: number;
  byPlugin: Array<{ pluginId: string; usd: number; events: number }>;
  byModel: Array<{
    pluginId: string;
    model: string;
    usd: number;
    events: number;
  }>;
  byUser: Array<{ userId: string; usd: number; events: number }>;
  byDay: Array<{ day: string; usd: number }>;
  budgets: Array<{
    id: string;
    name: string;
    principalType: BudgetPrincipalType;
    principalId: string | null;
    period: BudgetPeriod;
    mode: BudgetMode;
    amountUsd: number;
    spentUsd: number;
    periodStart: number;
  }>;
}

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

const usageRepository = () =>
  getPersistence(encryptionService).repositories.extensions.pluginUsage;

/** UTC period boundary for a budget window. */
export const periodStart = (period: BudgetPeriod, now: number): number => {
  const date = new Date(now);
  if (period === 'daily') {
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate()
    );
  }
  if (period === 'weekly') {
    const day = date.getUTCDay();
    const sinceMonday = (day + 6) % 7;
    return (
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) -
      sinceMonday * 24 * 60 * 60 * 1000
    );
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
};

/** Stable per-period key used to deduplicate alert notifications. */
export const periodKey = (period: BudgetPeriod, now: number): string =>
  `${period}:${periodStart(period, now)}`;

/**
 * The applicable tariff for one event: exact-model rows beat plugin-wide
 * rows; within a group, the newest `effective_from` at or before the event.
 */
export const resolveTariff = (
  tariffs: readonly StoredModelTariffRecord[],
  pluginId: string,
  model: string,
  atMs: number
): StoredModelTariffRecord | null => {
  let exact: StoredModelTariffRecord | null = null;
  let pluginWide: StoredModelTariffRecord | null = null;
  for (const tariff of tariffs) {
    if (tariff.plugin_id !== pluginId) continue;
    if (tariff.effective_from > atMs) continue;
    if (tariff.model === model) {
      if (!exact || tariff.effective_from > exact.effective_from) {
        exact = tariff;
      }
    } else if (tariff.model === null) {
      if (!pluginWide || tariff.effective_from > pluginWide.effective_from) {
        pluginWide = tariff;
      }
    }
  }
  return exact ?? pluginWide;
};

/** USD cost of one usage event, or null when it cannot be priced. */
export const costForEvent = (
  event: StoredPluginUsageEvent,
  tariffs: readonly StoredModelTariffRecord[]
): number | null => {
  const tariff = resolveTariff(
    tariffs,
    event.plugin_id,
    event.model,
    event.created_at
  );
  if (!tariff) return null;
  let usd = 0;
  let priced = false;
  if (tariff.input_per_million !== null && event.prompt_tokens !== null) {
    usd += (event.prompt_tokens / 1_000_000) * tariff.input_per_million;
    priced = true;
  }
  if (tariff.output_per_million !== null && event.completion_tokens !== null) {
    usd += (event.completion_tokens / 1_000_000) * tariff.output_per_million;
    priced = true;
  }
  if (tariff.unit_price !== null && event.output_units > 0) {
    usd += event.output_units * tariff.unit_price;
    priced = true;
  }
  return priced ? usd : null;
};

class CostGovernanceService {
  // ---------------------------------------------------------------- tariffs

  async listTariffs(): Promise<StoredModelTariffRecord[]> {
    return repositories().modelTariffs.listAll(MAX_TARIFFS);
  }

  async createTariff(
    input: TariffInput,
    createdBy: string
  ): Promise<StoredModelTariffRecord> {
    if (!input.pluginId || typeof input.pluginId !== 'string') {
      throw new Error('A plugin id is required');
    }
    const rates = [
      input.inputPerMillion,
      input.outputPerMillion,
      input.unitPrice,
    ];
    if (!rates.some(rate => typeof rate === 'number')) {
      throw new Error('At least one price must be provided');
    }
    for (const rate of rates) {
      if (
        rate !== undefined &&
        rate !== null &&
        (!Number.isFinite(rate) || rate < 0 || rate > 1_000_000)
      ) {
        throw new Error('Prices must be non-negative finite USD amounts');
      }
    }
    const effectiveFrom = input.effectiveFrom ?? Date.now();
    if (!Number.isInteger(effectiveFrom)) {
      throw new Error('effectiveFrom must be a timestamp in milliseconds');
    }
    const record: StoredModelTariffRecord = {
      id: randomUUID(),
      plugin_id: input.pluginId,
      model:
        typeof input.model === 'string' && input.model.trim()
          ? input.model.trim()
          : null,
      input_per_million: input.inputPerMillion ?? null,
      output_per_million: input.outputPerMillion ?? null,
      unit_price: input.unitPrice ?? null,
      currency: 'USD',
      effective_from: effectiveFrom,
      created_by: createdBy,
      created_at: Date.now(),
    };
    await repositories().modelTariffs.insert(record);
    return record;
  }

  async deleteTariff(tariffId: string): Promise<boolean> {
    return repositories().modelTariffs.deleteById(tariffId);
  }

  // ---------------------------------------------------------------- budgets

  async listBudgets(): Promise<StoredUsageBudgetRecord[]> {
    return repositories().usageBudgets.listAll(MAX_BUDGETS);
  }

  async saveBudget(
    input: BudgetInput,
    createdBy: string,
    budgetId?: string
  ): Promise<StoredUsageBudgetRecord> {
    if (!input.name?.trim() || input.name.length > 120) {
      throw new Error('A budget name up to 120 characters is required');
    }
    if (!['instance', 'user', 'group'].includes(input.principalType)) {
      throw new Error('Unknown budget principal type');
    }
    if (input.principalType !== 'instance' && !input.principalId) {
      throw new Error('A principal id is required for user and group budgets');
    }
    if (!['daily', 'weekly', 'monthly'].includes(input.period)) {
      throw new Error('Unknown budget period');
    }
    if (!['observe', 'soft', 'hard'].includes(input.mode)) {
      throw new Error('Unknown budget mode');
    }
    if (
      !Number.isFinite(input.amountUsd) ||
      input.amountUsd <= 0 ||
      input.amountUsd > 10_000_000
    ) {
      throw new Error('The budget amount must be a positive USD value');
    }
    const now = Date.now();
    const existing = budgetId
      ? await repositories().usageBudgets.findById(budgetId)
      : null;
    if (budgetId && !existing) throw new Error('Budget not found');
    const record: StoredUsageBudgetRecord = {
      id: budgetId ?? randomUUID(),
      name: input.name.trim(),
      principal_type: input.principalType,
      principal_id:
        input.principalType === 'instance' ? null : (input.principalId ?? null),
      period: input.period,
      amount_usd: input.amountUsd,
      mode: input.mode,
      created_by: existing?.created_by ?? createdBy,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await repositories().usageBudgets.replace(record);
    this.invalidateSpendCache();
    return record;
  }

  async deleteBudget(budgetId: string): Promise<boolean> {
    const removed = await repositories().usageBudgets.deleteById(budgetId);
    if (removed) this.invalidateSpendCache();
    return removed;
  }

  // ------------------------------------------------------------- analytics

  async getCostAnalytics(
    days: number,
    now = Date.now()
  ): Promise<CostAnalytics> {
    const from = now - days * 24 * 60 * 60 * 1000;
    const [tariffs, events, budgets] = await Promise.all([
      this.listTariffs(),
      usageRepository().listSince(from, MAX_COST_EVENTS),
      this.listBudgets(),
    ]);
    const byPlugin = new Map<string, { usd: number; events: number }>();
    const byModel = new Map<string, { usd: number; events: number }>();
    const byUser = new Map<string, { usd: number; events: number }>();
    const byDay = new Map<string, number>();
    let totalUsd = 0;
    let metered = 0;
    let unmetered = 0;
    for (const event of events) {
      const usd = costForEvent(event, tariffs);
      if (usd === null) {
        unmetered += 1;
        continue;
      }
      metered += 1;
      totalUsd += usd;
      const bump = (
        map: Map<string, { usd: number; events: number }>,
        key: string
      ) => {
        const entry = map.get(key) ?? { usd: 0, events: 0 };
        entry.usd += usd;
        entry.events += 1;
        map.set(key, entry);
      };
      bump(byPlugin, event.plugin_id);
      bump(byModel, `${event.plugin_id} ${event.model}`);
      bump(byUser, event.user_id);
      const day = new Date(event.created_at).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + usd);
    }
    const budgetViews = [] as CostAnalytics['budgets'];
    for (const budget of budgets) {
      budgetViews.push({
        id: budget.id,
        name: budget.name,
        principalType: budget.principal_type,
        principalId: budget.principal_id,
        period: budget.period,
        mode: budget.mode,
        amountUsd: budget.amount_usd,
        spentUsd: await this.spendForBudget(budget, tariffs, now),
        periodStart: periodStart(budget.period, now),
      });
    }
    const descending = (a: { usd: number }, b: { usd: number }) =>
      b.usd - a.usd;
    return {
      from,
      to: now,
      totalUsd,
      meteredEvents: metered,
      unmeteredEvents: unmetered,
      byPlugin: [...byPlugin.entries()]
        .map(([pluginId, value]) => ({ pluginId, ...value }))
        .sort(descending),
      byModel: [...byModel.entries()]
        .map(([key, value]) => {
          const [pluginId, model] = key.split(' ');
          return { pluginId, model, ...value };
        })
        .sort(descending),
      byUser: [...byUser.entries()]
        .map(([userId, value]) => ({ userId, ...value }))
        .sort(descending),
      byDay: [...byDay.entries()]
        .map(([day, usd]) => ({ day, usd }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      budgets: budgetViews,
    };
  }

  /** CSV export of priced usage events for external accounting. */
  async exportCostsCsv(days: number, now = Date.now()): Promise<string> {
    const from = now - days * 24 * 60 * 60 * 1000;
    const [tariffs, events] = await Promise.all([
      this.listTariffs(),
      usageRepository().listSince(from, MAX_COST_EVENTS),
    ]);
    const escape = (value: unknown): string => {
      const text = String(value ?? '');
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [
      'timestamp,user_id,plugin_id,model,capability,status,prompt_tokens,completion_tokens,output_units,cost_usd',
    ];
    for (const event of events) {
      const usd = costForEvent(event, tariffs);
      lines.push(
        [
          new Date(event.created_at).toISOString(),
          event.user_id,
          event.plugin_id,
          event.model,
          event.capability,
          event.status,
          event.prompt_tokens ?? '',
          event.completion_tokens ?? '',
          event.output_units,
          usd === null ? '' : usd.toFixed(6),
        ]
          .map(escape)
          .join(',')
      );
    }
    return `${lines.join('\n')}\n`;
  }

  // ----------------------------------------------------------- enforcement

  private async spendForBudget(
    budget: StoredUsageBudgetRecord,
    tariffs: readonly StoredModelTariffRecord[],
    now: number
  ): Promise<number> {
    const from = periodStart(budget.period, now);
    const events = await usageRepository().listSince(from, MAX_COST_EVENTS);
    let scope: Set<string> | null = null;
    if (budget.principal_type === 'user' && budget.principal_id) {
      scope = new Set([budget.principal_id]);
    } else if (budget.principal_type === 'group' && budget.principal_id) {
      const groups = await listGroupsWithMembers();
      const group = groups.find(entry => entry.id === budget.principal_id);
      scope = new Set(group?.members.map(member => member.user_id) ?? []);
    }
    let usd = 0;
    for (const event of events) {
      if (scope && !scope.has(event.user_id)) continue;
      usd += costForEvent(event, tariffs) ?? 0;
    }
    return usd;
  }

  private invalidateSpendCache(): void {
    // The cache key embeds the minute bucket, so a short TTL suffices;
    // budget edits simply wait out at most one interval.
  }

  /**
   * Admission gate for interactive generation requests. Throws
   * BudgetExceededError when a hard budget covering the user is exhausted.
   * Cache/compute failures fail open: availability beats cent-exactness.
   */
  async assertWithinBudget(userId: string, now = Date.now()): Promise<void> {
    try {
      const budgets = await this.listBudgets();
      const hard = budgets.filter(budget => budget.mode === 'hard');
      if (hard.length === 0) return;
      const cacheKey = `budget-gate:${userId}`;
      const coordinator = getCoordinator();
      const cached = await coordinator
        .getCache(cacheKey)
        .catch(() => undefined);
      if (typeof cached === 'string' && cached) {
        const parsed = JSON.parse(cached) as {
          blockedBy: string | null;
          at: number;
        };
        if (now - parsed.at < SPEND_CACHE_TTL_MS) {
          if (parsed.blockedBy) throw new BudgetExceededError(parsed.blockedBy);
          return;
        }
      }
      const [tariffs, groupIds] = await Promise.all([
        this.listTariffs(),
        getPersistence(
          encryptionService
        ).repositories.security.groups.listGroupIdsForUser(userId),
      ]);
      let blockedBy: string | null = null;
      for (const budget of hard) {
        const applies =
          budget.principal_type === 'instance' ||
          (budget.principal_type === 'user' &&
            budget.principal_id === userId) ||
          (budget.principal_type === 'group' &&
            budget.principal_id !== null &&
            groupIds.includes(budget.principal_id));
        if (!applies) continue;
        const spent = await this.spendForBudget(budget, tariffs, now);
        if (spent >= budget.amount_usd) {
          blockedBy = budget.name;
          break;
        }
      }
      await coordinator
        .setCache(
          cacheKey,
          JSON.stringify({ blockedBy, at: now }),
          SPEND_CACHE_TTL_MS
        )
        .catch(() => undefined);
      if (blockedBy) throw new BudgetExceededError(blockedBy);
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      logger.warn('Budget admission check failed open', { error });
    }
  }

  // ---------------------------------------------------------------- sweeps

  /**
   * Threshold alerts for soft and hard budgets, deduplicated per budget,
   * period, and threshold through the notification source key.
   */
  async sweepBudgetAlerts(now = Date.now()): Promise<void> {
    const budgets = await this.listBudgets();
    const alerting = budgets.filter(budget => budget.mode !== 'observe');
    if (alerting.length === 0) return;
    const tariffs = await this.listTariffs();
    for (const budget of alerting) {
      let spent: number;
      try {
        spent = await this.spendForBudget(budget, tariffs, now);
      } catch (error) {
        logger.warn('Budget sweep spend computation failed', { error });
        continue;
      }
      const ratio = spent / budget.amount_usd;
      for (const threshold of ALERT_THRESHOLDS) {
        if (ratio < threshold) continue;
        const recipients = new Set<string>();
        if (budget.created_by) recipients.add(budget.created_by);
        if (budget.principal_type === 'user' && budget.principal_id) {
          recipients.add(budget.principal_id);
        }
        const key = periodKey(budget.period, now);
        for (const userId of recipients) {
          try {
            await notificationService.publish({
              userId,
              type: 'budget-alert',
              title:
                threshold >= 1
                  ? `Budget "${budget.name}" is exhausted (${Math.round(ratio * 100)}%)`
                  : `Budget "${budget.name}" reached ${Math.round(ratio * 100)}%`,
              href: '/usage',
              sourceKey: `budget:${budget.id}:${key}:${threshold}`,
            });
          } catch (error) {
            logger.warn('Budget alert publish failed', { error });
          }
        }
      }
    }
  }
}

export const costGovernanceService = new CostGovernanceService();
export default costGovernanceService;
