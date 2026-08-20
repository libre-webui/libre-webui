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
 * Opt-in OpenTelemetry export over OTLP/HTTP JSON (OBS-02).
 *
 * The encoder is deliberately in-repo: the OTLP JSON mapping for spans,
 * cumulative counters, and log records is small and stable, and vendoring
 * it keeps the dependency surface unchanged. Everything here is
 * fail-open-for-requests: bounded buffers drop the oldest telemetry under
 * pressure, a collector outage costs one debug line and never blocks or
 * fails application work, and every attribute passes through the same
 * redaction used for structured logs, so prompts, provider bodies, and
 * credential-shaped keys never leave the process.
 *
 * Nothing is exported unless OTEL_EXPORTER_OTLP_ENDPOINT is set.
 */

import { randomBytes } from 'node:crypto';
import { redactLogFields } from '../utils/logRedaction.js';
import { currentLogContext } from './requestContext.js';

const MAX_BUFFERED_SPANS = 2048;
const MAX_BUFFERED_LOGS = 2048;
const MAX_COUNTER_SERIES = 512;
const FLUSH_INTERVAL_MS = 5_000;
const EXPORT_TIMEOUT_MS = 3_000;

export interface OtelSpanInput {
  name: string;
  /** 1 = internal, 2 = server, 3 = client (OTLP SpanKind). */
  kind?: 1 | 2 | 3;
  startMs: number;
  endMs: number;
  ok: boolean;
  attributes?: Record<string, unknown>;
}

interface BufferedSpan extends OtelSpanInput {
  traceId: string;
  spanId: string;
}

interface BufferedLogRecord {
  timeMs: number;
  severity: string;
  scope: string;
  message: string;
  requestId?: string;
  jobId?: string;
}

interface CounterSeries {
  name: string;
  attributes: Record<string, string | number | boolean>;
  value: number;
  startMs: number;
}

interface OtelState {
  spans: BufferedSpan[];
  logs: BufferedLogRecord[];
  counters: Map<string, CounterSeries>;
  droppedSpans: number;
  droppedLogs: number;
  timer: NodeJS.Timeout | null;
  exportFailures: number;
}

const state: OtelState = {
  spans: [],
  logs: [],
  counters: new Map(),
  droppedSpans: 0,
  droppedLogs: 0,
  timer: null,
  exportFailures: 0,
};

const processStartMs = Date.now();

export const otelEndpoint = (): string | null => {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
};

export const isOtelEnabled = (): boolean => otelEndpoint() !== null;

const otelHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!raw) return headers;
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
};

const serviceName = (): string =>
  process.env.OTEL_SERVICE_NAME?.trim() || 'libre-webui';

const hexId = (bytes: number): string => randomBytes(bytes).toString('hex');

const toNano = (ms: number): string => `${Math.round(ms)}000000`;

type AttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

const encodeAttributeValue = (value: unknown): AttributeValue => {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
};

const encodeAttributes = (
  attributes: Record<string, unknown> | undefined
): Array<{ key: string; value: AttributeValue }> => {
  if (!attributes) return [];
  const redacted = redactLogFields(attributes) as Record<string, unknown>;
  return Object.entries(redacted)
    .filter(([, value]) => value !== undefined && value !== null)
    .slice(0, 32)
    .map(([key, value]) => ({
      key,
      value: encodeAttributeValue(
        typeof value === 'object' ? JSON.stringify(value) : value
      ),
    }));
};

const resource = () => ({
  attributes: [{ key: 'service.name', value: { stringValue: serviceName() } }],
});

const scope = () => ({ name: 'libre-webui' });

const ensureTimer = (): void => {
  if (state.timer || !isOtelEnabled()) return;
  state.timer = setInterval(() => {
    void flushOtel();
  }, FLUSH_INTERVAL_MS);
  state.timer.unref();
};

/** Record one finished span. No-op unless the exporter is configured. */
export const recordOtelSpan = (input: OtelSpanInput): void => {
  if (!isOtelEnabled()) return;
  ensureTimer();
  if (state.spans.length >= MAX_BUFFERED_SPANS) {
    state.spans.shift();
    state.droppedSpans += 1;
  }
  state.spans.push({ ...input, traceId: hexId(16), spanId: hexId(8) });
};

/** Increment a monotonic counter series. No-op unless configured. */
export const incrementOtelCounter = (
  name: string,
  attributes: Record<string, string | number | boolean> = {},
  value = 1
): void => {
  if (!isOtelEnabled()) return;
  ensureTimer();
  const key = `${name}|${JSON.stringify(attributes)}`;
  const existing = state.counters.get(key);
  if (existing) {
    existing.value += value;
    return;
  }
  if (state.counters.size >= MAX_COUNTER_SERIES) return;
  state.counters.set(key, {
    name,
    attributes,
    value,
    startMs: Date.now(),
  });
};

/** Buffer one log record for export. No-op unless configured. */
export const recordOtelLog = (
  severity: string,
  logScope: string,
  message: string
): void => {
  if (!isOtelEnabled()) return;
  ensureTimer();
  if (state.logs.length >= MAX_BUFFERED_LOGS) {
    state.logs.shift();
    state.droppedLogs += 1;
  }
  const context = currentLogContext();
  state.logs.push({
    timeMs: Date.now(),
    severity,
    scope: logScope,
    message,
    ...(context?.requestId ? { requestId: context.requestId } : {}),
    ...(context?.jobId ? { jobId: context.jobId } : {}),
  });
};

const post = async (path: string, body: unknown): Promise<boolean> => {
  const endpoint = otelEndpoint();
  if (!endpoint) return false;
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: 'POST',
      headers: otelHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const encodeSpans = (spans: BufferedSpan[]) => ({
  resourceSpans: [
    {
      resource: resource(),
      scopeSpans: [
        {
          scope: scope(),
          spans: spans.map(span => ({
            traceId: span.traceId,
            spanId: span.spanId,
            name: span.name,
            kind: span.kind ?? 1,
            startTimeUnixNano: toNano(span.startMs),
            endTimeUnixNano: toNano(span.endMs),
            attributes: encodeAttributes(span.attributes),
            status: { code: span.ok ? 1 : 2 },
          })),
        },
      ],
    },
  ],
});

const encodeCounters = (counters: CounterSeries[]) => ({
  resourceMetrics: [
    {
      resource: resource(),
      scopeMetrics: [
        {
          scope: scope(),
          metrics: counters.map(series => ({
            name: series.name,
            unit: '1',
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [
                {
                  startTimeUnixNano: toNano(processStartMs),
                  timeUnixNano: toNano(Date.now()),
                  asInt: String(series.value),
                  attributes: encodeAttributes(series.attributes),
                },
              ],
            },
          })),
        },
      ],
    },
  ],
});

const encodeLogs = (logs: BufferedLogRecord[]) => ({
  resourceLogs: [
    {
      resource: resource(),
      scopeLogs: [
        {
          scope: scope(),
          logRecords: logs.map(record => ({
            timeUnixNano: toNano(record.timeMs),
            severityText: record.severity,
            body: { stringValue: record.message },
            attributes: encodeAttributes({
              'log.scope': record.scope,
              ...(record.requestId ? { requestId: record.requestId } : {}),
              ...(record.jobId ? { jobId: record.jobId } : {}),
            }),
          })),
        },
      ],
    },
  ],
});

/**
 * Push every buffered signal to the collector. Failures drop the batch:
 * telemetry is best-effort by contract and must never apply backpressure
 * to the application.
 */
export const flushOtel = async (): Promise<void> => {
  if (!isOtelEnabled()) return;
  const spans = state.spans.splice(0);
  const logs = state.logs.splice(0);
  const counters = [...state.counters.values()].map(series => ({ ...series }));
  const exports: Array<Promise<boolean>> = [];
  if (spans.length > 0) exports.push(post('/v1/traces', encodeSpans(spans)));
  if (counters.length > 0) {
    exports.push(post('/v1/metrics', encodeCounters(counters)));
  }
  if (logs.length > 0) exports.push(post('/v1/logs', encodeLogs(logs)));
  if (exports.length === 0) return;
  const results = await Promise.all(exports);
  if (results.some(ok => !ok)) state.exportFailures += 1;
};

/**
 * Time one durable-job handler execution as an internal span plus an
 * executions counter. A no-op wrapper unless OTLP export is configured.
 */
export const instrumentDurableJobExecution = async <T>(
  jobType: string,
  attemptCount: number,
  execute: () => Promise<T>
): Promise<T> => {
  if (!isOtelEnabled()) return execute();
  const startMs = Date.now();
  try {
    const result = await execute();
    recordOtelSpan({
      name: `durable-job ${jobType}`,
      kind: 1,
      startMs,
      endMs: Date.now(),
      ok: true,
      attributes: { jobType, attempt: attemptCount },
    });
    incrementOtelCounter('durable.job.executions', {
      jobType,
      outcome: 'success',
    });
    return result;
  } catch (error) {
    recordOtelSpan({
      name: `durable-job ${jobType}`,
      kind: 1,
      startMs,
      endMs: Date.now(),
      ok: false,
      attributes: { jobType, attempt: attemptCount },
    });
    incrementOtelCounter('durable.job.executions', {
      jobType,
      outcome: 'failure',
    });
    throw error;
  }
};

/** Test and shutdown hook: stop the flush loop and clear buffers. */
export const resetOtel = (): void => {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.spans.length = 0;
  state.logs.length = 0;
  state.counters.clear();
  state.droppedSpans = 0;
  state.droppedLogs = 0;
  state.exportFailures = 0;
};

/** Introspection for tests and diagnostics. */
export const otelStats = () => ({
  bufferedSpans: state.spans.length,
  bufferedLogs: state.logs.length,
  counterSeries: state.counters.size,
  droppedSpans: state.droppedSpans,
  droppedLogs: state.droppedLogs,
  exportFailures: state.exportFailures,
});
