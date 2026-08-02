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
import { getDatabaseSafe } from '../db.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('plugin-usage');
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_ANALYTICS_DAYS = 1;
const MAX_ANALYTICS_DAYS = 365;
const RETENTION_DAYS = 400;

export type PluginUsageCapability =
  'chat' | 'embedding' | 'image' | 'tts' | 'audio' | 'video';
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
}

type Numberish = number | bigint | null;

const asNumber = (value: Numberish | undefined): number =>
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
  private lastPrunedAt = 0;

  record(input: PluginUsageEventInput): void {
    const db = getDatabaseSafe();
    if (!db) return;

    try {
      const createdAt = input.createdAt ?? Date.now();
      if (createdAt - this.lastPrunedAt >= DAY_MS) {
        db.prepare('DELETE FROM plugin_usage_events WHERE created_at < ?').run(
          createdAt - RETENTION_DAYS * DAY_MS
        );
        this.lastPrunedAt = createdAt;
      }
      const tokens = input.tokens;
      db.prepare(
        `INSERT INTO plugin_usage_events
          (id, user_id, plugin_id, plugin_name, capability, model, status,
           prompt_tokens, completion_tokens, total_tokens, input_units,
           output_units, unit_kind, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        input.userId || 'default',
        input.pluginId,
        input.pluginName,
        input.capability,
        input.model,
        input.status,
        tokens?.promptTokens ?? null,
        tokens?.completionTokens ?? null,
        tokens?.totalTokens ?? null,
        Math.max(0, Math.round(input.inputUnits ?? 0)),
        Math.max(0, Math.round(input.outputUnits ?? 0)),
        input.unitKind ?? null,
        Math.max(0, Math.round(input.durationMs)),
        createdAt
      );
    } catch (error) {
      // Metering must never make a provider request fail.
      logger.warn('Failed to record plugin usage:', error);
    }
  }

  getAnalytics(requestedDays = 30): PluginUsageAnalytics {
    const days = Math.min(
      MAX_ANALYTICS_DAYS,
      Math.max(MIN_ANALYTICS_DAYS, Math.round(requestedDays))
    );
    const to = Date.now();
    const startOfToday = new Date(to);
    startOfToday.setUTCHours(0, 0, 0, 0);
    const from = startOfToday.getTime() - (days - 1) * DAY_MS;
    const empty = this.emptyAnalytics(from, to, days);
    const db = getDatabaseSafe();
    if (!db) return empty;

    const totals = db
      .prepare(
        `SELECT
           COUNT(*) AS calls,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_calls,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed_calls,
           SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_calls,
           SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS metered_calls,
           SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
           SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
           SUM(COALESCE(total_tokens, 0)) AS reported_tokens,
           ROUND(AVG(duration_ms)) AS average_latency_ms,
           COUNT(DISTINCT user_id) AS unique_users
         FROM plugin_usage_events
         WHERE created_at >= ? AND created_at <= ?`
      )
      .get(from, to) as Record<string, Numberish>;

    const seriesRows = db
      .prepare(
        `SELECT
           CAST((created_at - ?) / ? AS INTEGER) AS bucket,
           COUNT(*) AS calls,
           SUM(COALESCE(total_tokens, 0)) AS tokens,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM plugin_usage_events
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY bucket
         ORDER BY bucket ASC`
      )
      .all(from, DAY_MS, from, to) as Array<Record<string, Numberish>>;

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

    const plugins = db
      .prepare(
        `SELECT plugin_id, plugin_name, COUNT(*) AS calls,
                SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
                ROUND(AVG(duration_ms)) AS average_latency_ms
         FROM plugin_usage_events
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY plugin_id, plugin_name
         ORDER BY calls DESC, tokens DESC
         LIMIT 50`
      )
      .all(from, to) as Array<Record<string, string | Numberish>>;

    const models = db
      .prepare(
        `SELECT model, plugin_id, plugin_name, COUNT(*) AS calls,
                SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
                ROUND(AVG(duration_ms)) AS average_latency_ms
         FROM plugin_usage_events
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY model, plugin_id, plugin_name
         ORDER BY calls DESC, tokens DESC
         LIMIT 100`
      )
      .all(from, to) as Array<Record<string, string | Numberish>>;

    const capabilities = db
      .prepare(
        `SELECT capability, COUNT(*) AS calls,
                SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(input_units) AS input_units,
                SUM(output_units) AS output_units
         FROM plugin_usage_events
         WHERE created_at >= ? AND created_at <= ?
         GROUP BY capability
         ORDER BY calls DESC`
      )
      .all(from, to) as Array<Record<string, string | Numberish>>;

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
        calls: asNumber(row.calls as Numberish),
        tokens: asNumber(row.tokens as Numberish),
        errors: asNumber(row.errors as Numberish),
        averageLatencyMs: asNumber(row.average_latency_ms as Numberish),
      })),
      models: models.map(row => ({
        model: String(row.model),
        pluginId: String(row.plugin_id),
        pluginName: String(row.plugin_name),
        calls: asNumber(row.calls as Numberish),
        tokens: asNumber(row.tokens as Numberish),
        errors: asNumber(row.errors as Numberish),
        averageLatencyMs: asNumber(row.average_latency_ms as Numberish),
      })),
      capabilities: capabilities.map(row => ({
        capability: String(row.capability) as PluginUsageCapability,
        calls: asNumber(row.calls as Numberish),
        tokens: asNumber(row.tokens as Numberish),
        inputUnits: asNumber(row.input_units as Numberish),
        outputUnits: asNumber(row.output_units as Numberish),
      })),
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
    };
  }
}

const pluginUsageService = new PluginUsageService();

export { PluginUsageService };
export default pluginUsageService;
