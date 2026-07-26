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

import type { WorkRunEvent, WorkRunEventType } from '@/types/work';

const eventTypes = new Set<WorkRunEventType>([
  'snapshot',
  'run_state',
  'reasoning_delta',
  'assistant_delta',
  'tool_call',
  'tool_result',
  'usage',
  'skill_loaded',
  'error',
  'done',
]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const eventTimestamp = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
};

const normalizeEvent = (
  payload: unknown,
  sseId: string | undefined,
  sseType: string | undefined,
  expectedTaskId: string,
  expectedRunId: string
): WorkRunEvent | undefined => {
  const record = asRecord(payload);
  if (!record) return undefined;
  const id = Number(record.id ?? sseId);
  const type = String(record.type ?? sseType ?? '');
  const taskId = String(record.taskId ?? expectedTaskId);
  const runId = String(record.runId ?? expectedRunId);
  if (
    !Number.isSafeInteger(id) ||
    id < 0 ||
    !eventTypes.has(type as WorkRunEventType) ||
    taskId !== expectedTaskId ||
    runId !== expectedRunId
  ) {
    return undefined;
  }
  const rawData = record.data;
  return {
    id,
    type: type as WorkRunEventType,
    taskId,
    runId,
    timestamp: eventTimestamp(record.timestamp),
    data:
      asRecord(rawData) || (rawData === undefined ? {} : { content: rawData }),
  };
};

export const parseWorkEventBlock = (
  block: string,
  expectedTaskId: string,
  expectedRunId: string
): WorkRunEvent | undefined => {
  let id: string | undefined;
  let type: string | undefined;
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const rawValue = separator === -1 ? '' : line.slice(separator + 1);
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'id') id = value;
    if (field === 'event') type = value;
    if (field === 'data') data.push(value);
  }

  if (data.length === 0) return undefined;
  const serialized = data.join('\n');
  if (serialized === '[DONE]') {
    return normalizeEvent(
      {
        id,
        type: 'done',
        taskId: expectedTaskId,
        runId: expectedRunId,
        timestamp: Date.now(),
        data: {},
      },
      id,
      type,
      expectedTaskId,
      expectedRunId
    );
  }
  try {
    return normalizeEvent(
      JSON.parse(serialized),
      id,
      type,
      expectedTaskId,
      expectedRunId
    );
  } catch {
    return undefined;
  }
};

export class WorkEventStreamParser {
  private buffer = '';

  constructor(
    private readonly taskId: string,
    private readonly runId: string,
    private readonly onEvent: (event: WorkRunEvent) => void
  ) {}

  push(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    this.drain();
  }

  finish(chunk = ''): void {
    this.buffer += chunk;
    this.drain();
    if (!this.buffer.trim()) {
      this.buffer = '';
      return;
    }
    const event = parseWorkEventBlock(
      this.buffer.replace(/\r\n?/g, '\n'),
      this.taskId,
      this.runId
    );
    this.buffer = '';
    if (event) this.onEvent(event);
  }

  private drain(): void {
    let boundary = /\r?\n\r?\n/.exec(this.buffer);
    while (boundary?.index !== undefined) {
      const block = this.buffer
        .slice(0, boundary.index)
        .replace(/\r\n?/g, '\n');
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const event = parseWorkEventBlock(block, this.taskId, this.runId);
      if (event) this.onEvent(event);
      boundary = /\r?\n\r?\n/.exec(this.buffer);
    }
  }
}
