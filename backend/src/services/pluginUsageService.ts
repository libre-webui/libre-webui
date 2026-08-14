/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from 'crypto';
import { getPersistence } from '../persistence/index.js';
import { createLogger } from '../utils/logger.js';
import { encryptionService } from './encryptionService.js';

const logger = createLogger('plugin-usage');
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ANALYTICS_DAYS = 1;
const MAX_ANALYTICS_DAYS = 365;
const HEATMAP_DAYS = 365;
const HEATMAP_TOP_MODELS = 5;
const HEATMAP_MODELS_PER_DAY = 5;
const RETENTION_DAYS = 400;

export type PluginUsageCapability =
  'chat' | 'embedding' | 'image' | 'stt' | 'tts' | 'audio' | 'video';
export type PluginUsageStatus = 'success' | 'error' | 'cancelled';

export interface ProviderTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface PluginUsageEventInput {
  userId?: string;
  pluginId: string;
  pluginName: string;
  capability: PluginUsageCapability;
  model: string;
  status: PluginUsageStatus;
  durationMs: number;
  tokens?: ProviderTokenUsage;
  inputUnits?: number;
  outputUnits?: number;
  unitKind?: 'characters' | 'images' | 'inputs' | 'jobs' | 'seconds' | 'bytes';
  createdAt?: number;
}

export interface PluginUsageAnalytics {
  range: { from: number; to: number; days: number };
  totals: {
    calls: number;
    successfulCalls: number;
    failedCalls: number;
    cancelledCalls: number;
    meteredCalls: number;
    promptTokens: number;
    completionTokens: number;
    reportedTokens: number;
    averageLatencyMs: number;
    uniqueUsers: number;
  };
  series: Array<{
    timestamp: number;
    calls: number;
    tokens: number;
    errors: number;
  }>;
  plugins: Array<{
    pluginId: string;
    pluginName: string;
    calls: number;
    tokens: number;
    errors: number;
    averageLatencyMs: number;
  }>;
  models: Array<{
    model: string;
    pluginId: string;
    pluginName: string;
    calls: number;
    tokens: number;
    errors: number;
    averageLatencyMs: number;
  }>;
  capabilities: Array<{
    capability: PluginUsageCapability;
    calls: number;
    tokens: number;
    inputUnits: number;
    outputUnits: number;
  }>;
  /**
   * Contribution-style calendar over a fixed trailing year, independent of the
   * requested range: per-day call counts with each day's leading models.
   */
  heatmap: {
    from: number;
    days: number;
    /** Top models across the whole year, most-called first. */
    models: string[];
    cells: Array<{
      timestamp: number;
      calls: number;
      models: Array<{ model: string; calls: number }>;
    }>;
  };
}

const asNumber = (value: unknown): number =>
  typeof value === 'bigint' ? Number(value) : Number(value ?? 0);

const nonNegativeInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.round(value);
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;

/** Normalize the usage shapes returned by OpenAI-compatible and Anthropic APIs. */
export function normalizeProviderTokenUsage(
  response: unknown
): ProviderTokenUsage | undefined {
  const root = asRecord(response);
  const usage = asRecord(root?.usage) || asRecord(root?.usage_metadata);
  if (!usage) return undefined;

  const promptTokens = nonNegativeInteger(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.promptTokenCount ??
      usage.inputTokenCount
  );
  const completionTokens = nonNegativeInteger(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.candidatesTokenCount ??
      usage.outputTokenCount
  );
  const reportedTotal = nonNegativeInteger(
    usage.total_tokens ?? usage.totalTokenCount
  );

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    reportedTotal === undefined
  ) {
    return undefined;
  }

  const normalizedPrompt = promptTokens ?? 0;
  const normalizedCompletion = completionTokens ?? 0;
  return {
    promptTokens: normalizedPrompt,
    completionTokens: normalizedCompletion,
    totalTokens: reportedTotal ?? normalizedPrompt + normalizedCompletion,
  };
}

class PluginUsageService {
  async record(input: PluginUsageEventInput): Promise<void> {
    const userId = input.userId?.trim();
    // Usage rows are user-owned and carry a foreign key in team mode. Never
    // invent a synthetic identity: background callers must propagate the
    // durable job actor, while genuinely system-scoped calls are not metered.
    if (!userId) return;
    const createdAt = input.createdAt ?? Date.now();
    const tokens = input.tokens;
    // Metering is intentionally best effort and must never make a provider
    // request fail. The repository still performs prune+insert atomically.
    try {
      await this.repository().recordAndPrune(
        {
          id: randomUUID(),
          user_id: userId,
          plugin_id: input.pluginId,
          plugin_name: input.pluginName,
          capability: input.capability,
          model: input.model,
          status: input.status,
          prompt_tokens: tokens?.promptTokens ?? null,
          completion_tokens: tokens?.completionTokens ?? null,
          total_tokens: tokens?.totalTokens ?? null,
          input_units: Math.max(0, Math.round(input.inputUnits ?? 0)),
          output_units: Math.max(0, Math.round(input.outputUnits ?? 0)),
          unit_kind: input.unitKind ?? null,
          duration_ms: Math.max(0, Math.round(input.durationMs)),
          created_at: createdAt,
        },
        createdAt - RETENTION_DAYS * DAY_MS
      );
    } catch (error) {
      logger.warn('Failed to record plugin usage:', error);
    }
  }

  async getAnalytics(requestedDays = 30): Promise<PluginUsageAnalytics> {
    const days = Math.min(
      MAX_ANALYTICS_DAYS,
      Math.max(MIN_ANALYTICS_DAYS, Math.round(requestedDays))
    );
    const to = Date.now();
    const startOfToday = new Date(to);
    startOfToday.setUTCHours(0, 0, 0, 0);
    const from = startOfToday.getTime() - (days - 1) * DAY_MS;
    const heatmapFrom = startOfToday.getTime() - (HEATMAP_DAYS - 1) * DAY_MS;
    const repository = this.repository();
    const [totals, seriesRows, plugins, models, heatmapRows, capabilities] =
      await Promise.all([
        repository.totals(from, to),
        repository.series(from, to, DAY_MS),
        repository.plugins(from, to),
        repository.models(from, to),
        repository.heatmap(heatmapFrom, to, DAY_MS),
        repository.capabilities(from, to),
      ]);

    const seriesByBucket = new Map(
      seriesRows.map(row => [asNumber(row.bucket), row])
    );
    const series = Array.from({ length: days }, (_, bucket) => {
      const row = seriesByBucket.get(bucket);
      return {
        timestamp: from + bucket * DAY_MS,
        calls: asNumber(row?.calls),
        tokens: asNumber(row?.tokens),
        errors: asNumber(row?.errors),
      };
    });

    const heatmapBuckets = new Map<
      number,
      Array<{ model: string; calls: number }>
    >();
    const heatmapModelTotals = new Map<string, number>();
    for (const row of heatmapRows) {
      const bucket = asNumber(row.bucket);
      if (bucket < 0 || bucket >= HEATMAP_DAYS) continue;
      const model = String(row.model ?? '');
      const calls = asNumber(row.calls);
      if (!model || calls <= 0) continue;
      const entries = heatmapBuckets.get(bucket) ?? [];
      entries.push({ model, calls });
      heatmapBuckets.set(bucket, entries);
      heatmapModelTotals.set(
        model,
        (heatmapModelTotals.get(model) ?? 0) + calls
      );
    }
    const heatmap = {
      from: heatmapFrom,
      days: HEATMAP_DAYS,
      models: [...heatmapModelTotals.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, HEATMAP_TOP_MODELS)
        .map(([model]) => model),
      cells: [...heatmapBuckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, entries]) => ({
          timestamp: heatmapFrom + bucket * DAY_MS,
          calls: entries.reduce((sum, entry) => sum + entry.calls, 0),
          models: entries
            .sort((a, b) => b.calls - a.calls)
            .slice(0, HEATMAP_MODELS_PER_DAY),
        })),
    };

    return {
      range: { from, to, days },
      totals: {
        calls: asNumber(totals.calls),
        successfulCalls: asNumber(totals.successful_calls),
        failedCalls: asNumber(totals.failed_calls),
        cancelledCalls: asNumber(totals.cancelled_calls),
        meteredCalls: asNumber(totals.metered_calls),
        promptTokens: asNumber(totals.prompt_tokens),
        completionTokens: asNumber(totals.completion_tokens),
        reportedTokens: asNumber(totals.reported_tokens),
        averageLatencyMs: asNumber(totals.average_latency_ms),
        uniqueUsers: asNumber(totals.unique_users),
      },
      series,
      plugins: plugins.map(row => ({
        pluginId: String(row.plugin_id),
        pluginName: String(row.plugin_name),
        calls: asNumber(row.calls),
        tokens: asNumber(row.tokens),
        errors: asNumber(row.errors),
        averageLatencyMs: asNumber(row.average_latency_ms),
      })),
      models: models.map(row => ({
        model: String(row.model),
        pluginId: String(row.plugin_id),
        pluginName: String(row.plugin_name),
        calls: asNumber(row.calls),
        tokens: asNumber(row.tokens),
        errors: asNumber(row.errors),
        averageLatencyMs: asNumber(row.average_latency_ms),
      })),
      capabilities: capabilities.map(row => ({
        capability: String(row.capability) as PluginUsageCapability,
        calls: asNumber(row.calls),
        tokens: asNumber(row.tokens),
        inputUnits: asNumber(row.input_units),
        outputUnits: asNumber(row.output_units),
      })),
      heatmap,
    };
  }

  private emptyAnalytics(
    from: number,
    to: number,
    days: number
  ): PluginUsageAnalytics {
    return {
      range: { from, to, days },
      totals: {
        calls: 0,
        successfulCalls: 0,
        failedCalls: 0,
        cancelledCalls: 0,
        meteredCalls: 0,
        promptTokens: 0,
        completionTokens: 0,
        reportedTokens: 0,
        averageLatencyMs: 0,
        uniqueUsers: 0,
      },
      series: Array.from({ length: days }, (_, bucket) => ({
        timestamp: from + bucket * DAY_MS,
        calls: 0,
        tokens: 0,
        errors: 0,
      })),
      plugins: [],
      models: [],
      capabilities: [],
      heatmap: {
        from: from - (HEATMAP_DAYS - days) * DAY_MS,
        days: HEATMAP_DAYS,
        models: [],
        cells: [],
      },
    };
  }

  private repository() {
    return getPersistence(encryptionService).repositories.extensions
      .pluginUsage;
  }
}

const pluginUsageService = new PluginUsageService();

export { PluginUsageService };
export default pluginUsageService;
