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

import {
  WorkLiveEvent,
  WorkLiveEventDataMap,
  WorkLiveRunSnapshot,
  WorkLiveRunSnapshotTool,
  WorkLiveEventType,
} from '../types/work.js';

export const WORK_EVENT_REPLAY_LIMIT = 512;
export const WORK_EVENT_REPLAY_MAX_BYTES = 1_000_000;
export const WORK_EVENT_RETENTION_MS = 5 * 60_000;
export const WORK_EVENT_MAX_RESUME_CURSOR = Number.MAX_SAFE_INTEGER - 1_000_000;
const WORK_LIVE_TEXT_MAX_BYTES = 100_000;
const WORK_LIVE_TOOL_OUTPUT_MAX_BYTES = 4_000;
const WORK_LIVE_TOOL_SNAPSHOT_LIMIT = 128;

export type WorkLiveEventListener = (event: WorkLiveEvent) => void;

export interface WorkEventReplay {
  events: WorkLiveEvent[];
  latestEventId: number;
  snapshotEventId: number;
  truncated: boolean;
  snapshot: WorkLiveRunSnapshot;
}

interface StoredWorkEvent {
  event: WorkLiveEvent;
  bytes: number;
}

interface WorkEventStream {
  nextEventId: number;
  events: StoredWorkEvent[];
  replayBytes: number;
  listeners: Set<WorkLiveEventListener>;
  snapshot: WorkLiveRunSnapshot;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface WorkEventServiceOptions {
  replayLimit?: number;
  replayMaxBytes?: number;
  retentionMs?: number;
}

export class WorkEventService {
  private readonly streams = new Map<string, WorkEventStream>();
  private readonly replayLimit: number;
  private readonly replayMaxBytes: number;
  private readonly retentionMs: number;

  constructor(options: WorkEventServiceOptions = {}) {
    this.replayLimit = positiveInteger(
      options.replayLimit,
      WORK_EVENT_REPLAY_LIMIT
    );
    this.replayMaxBytes = positiveInteger(
      options.replayMaxBytes,
      WORK_EVENT_REPLAY_MAX_BYTES
    );
    this.retentionMs = nonNegativeInteger(
      options.retentionMs,
      WORK_EVENT_RETENTION_MS
    );
  }

  publish<T extends Exclude<WorkLiveEventType, 'snapshot'>>(
    taskId: string,
    runId: string,
    type: T,
    data: WorkLiveEventDataMap[T]
  ): WorkLiveEvent<T> {
    const stream = this.requireStream(taskId, runId);
    this.cancelCleanup(stream);
    const event = {
      id: stream.nextEventId++,
      type,
      taskId,
      runId,
      timestamp: Date.now(),
      data,
    } as WorkLiveEvent<T>;
    const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
    stream.events.push({ event, bytes });
    stream.replayBytes += bytes;
    updateSnapshot(stream.snapshot, event);
    this.pruneReplay(stream);

    for (const listener of [...stream.listeners]) {
      try {
        listener(event);
      } catch {
        // A disconnected or otherwise broken subscriber must never fail the
        // autonomous run that produced the event.
        stream.listeners.delete(listener);
      }
    }
    if (stream.listeners.size === 0) {
      this.scheduleCleanup(taskId, runId, stream);
    }
    return event;
  }

  subscribe(
    taskId: string,
    runId: string,
    listener: WorkLiveEventListener
  ): () => void {
    const key = streamKey(taskId, runId);
    const stream = this.requireStream(taskId, runId);
    this.cancelCleanup(stream);
    stream.listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      stream.listeners.delete(listener);
      if (stream.listeners.size === 0) {
        this.scheduleCleanup(taskId, runId, stream, key);
      }
    };
  }

  advanceCursor(taskId: string, runId: string, after: number): void {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      after > WORK_EVENT_MAX_RESUME_CURSOR
    ) {
      throw new RangeError('Work event cursor is outside the safe range.');
    }
    const stream = this.requireStream(taskId, runId);
    stream.nextEventId = Math.max(stream.nextEventId, after + 1);
  }

  replay(taskId: string, runId: string, after = 0): WorkEventReplay {
    const stream = this.streams.get(streamKey(taskId, runId));
    if (!stream) {
      return {
        events: [],
        latestEventId: 0,
        snapshotEventId: 0,
        truncated: false,
        snapshot: emptySnapshot(),
      };
    }
    const latestEventId = stream.nextEventId - 1;
    const boundedAfter = Math.min(Math.max(0, after), latestEventId);
    const events = stream.events
      .map(stored => stored.event)
      .filter(event => event.id > boundedAfter);
    const snapshotEventId = events[0]?.id ? events[0].id - 1 : latestEventId;
    return {
      events,
      latestEventId,
      snapshotEventId,
      truncated:
        boundedAfter < latestEventId &&
        (events.length === 0 || events[0].id > boundedAfter + 1),
      snapshot: cloneSnapshot(stream.snapshot),
    };
  }

  emitSnapshot(
    taskId: string,
    runId: string,
    eventId: number,
    data: WorkLiveEventDataMap['snapshot'],
    listener: WorkLiveEventListener
  ): WorkLiveEvent<'snapshot'> {
    const event: WorkLiveEvent<'snapshot'> = {
      id: Math.max(0, Math.trunc(eventId)),
      type: 'snapshot',
      taskId,
      runId,
      timestamp: Date.now(),
      data,
    };
    listener(event);
    return event;
  }

  getSubscriberCount(taskId: string, runId: string): number {
    return this.streams.get(streamKey(taskId, runId))?.listeners.size ?? 0;
  }

  clear(taskId: string, runId: string): void {
    const key = streamKey(taskId, runId);
    const stream = this.streams.get(key);
    if (!stream) return;
    this.cancelCleanup(stream);
    stream.listeners.clear();
    this.streams.delete(key);
  }

  reset(): void {
    for (const stream of this.streams.values()) {
      this.cancelCleanup(stream);
      stream.listeners.clear();
    }
    this.streams.clear();
  }

  private requireStream(taskId: string, runId: string): WorkEventStream {
    const key = streamKey(taskId, runId);
    let stream = this.streams.get(key);
    if (!stream) {
      stream = {
        nextEventId: 1,
        events: [],
        replayBytes: 0,
        listeners: new Set(),
        snapshot: emptySnapshot(),
      };
      this.streams.set(key, stream);
    }
    return stream;
  }

  private pruneReplay(stream: WorkEventStream): void {
    while (
      stream.events.length > this.replayLimit ||
      stream.replayBytes > this.replayMaxBytes
    ) {
      const removed = stream.events.shift();
      if (!removed) break;
      stream.replayBytes -= removed.bytes;
    }
  }

  private scheduleCleanup(
    taskId: string,
    runId: string,
    stream: WorkEventStream,
    key = streamKey(taskId, runId)
  ): void {
    this.cancelCleanup(stream);
    // An active run can legitimately spend longer than the retention window
    // inside one provider call or command while nobody is viewing it. Keep its
    // compact, bounded snapshot so returning viewers do not lose the current
    // reasoning, response, tools, or event cursor. Terminal streams expire
    // after the normal reconnect grace period.
    if (!stream.snapshot.terminal) return;
    stream.cleanupTimer = setTimeout(() => {
      if (this.streams.get(key) === stream && stream.listeners.size === 0) {
        this.streams.delete(key);
      }
    }, this.retentionMs);
    stream.cleanupTimer.unref?.();
  }

  private cancelCleanup(stream: WorkEventStream): void {
    if (!stream.cleanupTimer) return;
    clearTimeout(stream.cleanupTimer);
    stream.cleanupTimer = undefined;
  }
}

function emptySnapshot(): WorkLiveRunSnapshot {
  return {
    reasoning: '',
    response: '',
    tools: [],
    skills: [],
    terminal: false,
  };
}

function cloneSnapshot(snapshot: WorkLiveRunSnapshot): WorkLiveRunSnapshot {
  return {
    ...snapshot,
    tools: snapshot.tools.map(tool => ({
      ...tool,
      arguments: tool.arguments ? { ...tool.arguments } : undefined,
      metadata: tool.metadata ? { ...tool.metadata } : undefined,
    })),
    usage: snapshot.usage ? { ...snapshot.usage } : undefined,
    skills: snapshot.skills.map(skill => ({ ...skill })),
  };
}

function updateSnapshot(
  snapshot: WorkLiveRunSnapshot,
  event: WorkLiveEvent
): void {
  switch (event.type) {
    case 'run_state':
      snapshot.status = event.data.status;
      snapshot.phase = event.data.phase;
      snapshot.round = event.data.round ?? snapshot.round;
      snapshot.roundLimit = event.data.roundLimit ?? snapshot.roundLimit;
      return;
    case 'reasoning_delta':
      snapshot.reasoning = liveText(
        event.data.total ?? snapshot.reasoning + event.data.delta
      );
      return;
    case 'assistant_delta':
      snapshot.response = liveText(
        event.data.total ?? snapshot.response + event.data.delta
      );
      return;
    case 'tool_call':
      upsertSnapshotTool(snapshot, {
        id: event.data.toolCallId,
        name: event.data.name,
        status: 'running',
        arguments: event.data.arguments
          ? { ...event.data.arguments }
          : undefined,
        metadata: event.data.metadata ? { ...event.data.metadata } : undefined,
        startedAt: event.timestamp,
      });
      return;
    case 'tool_result': {
      const existing = snapshot.tools.find(
        tool => tool.id === event.data.toolCallId
      );
      const failed = event.data.error === true || event.data.phase === 'failed';
      const resultMetadata = event.data.message?.metadata;
      upsertSnapshotTool(snapshot, {
        ...existing,
        id: event.data.toolCallId,
        name: event.data.name,
        status: failed ? 'failed' : 'completed',
        isError: failed || undefined,
        metadata:
          existing?.metadata || resultMetadata
            ? { ...existing?.metadata, ...resultMetadata }
            : undefined,
        output:
          typeof event.data.content === 'string'
            ? boundedTail(event.data.content, WORK_LIVE_TOOL_OUTPUT_MAX_BYTES)
            : existing?.output,
        finishedAt: event.timestamp,
      });
      return;
    }
    case 'usage':
      snapshot.usage = { ...snapshot.usage, ...event.data };
      return;
    case 'skill_loaded':
      if (!snapshot.skills.some(skill => skill.id === event.data.id)) {
        snapshot.skills.push({ ...event.data });
      }
      return;
    case 'error':
      snapshot.status = 'failed';
      snapshot.phase = 'failed';
      snapshot.error = event.data.message;
      snapshot.terminal = true;
      return;
    case 'done':
      snapshot.status = event.data.status;
      snapshot.phase = event.data.status;
      snapshot.error = event.data.error ?? snapshot.error;
      snapshot.budgetReason = event.data.budgetReason ?? snapshot.budgetReason;
      snapshot.terminal = true;
      return;
    case 'snapshot':
      return;
  }
}

function upsertSnapshotTool(
  snapshot: WorkLiveRunSnapshot,
  tool: WorkLiveRunSnapshotTool
): void {
  const index = snapshot.tools.findIndex(candidate => candidate.id === tool.id);
  if (index >= 0) {
    snapshot.tools[index] = tool;
    return;
  }
  snapshot.tools.push(tool);
  if (snapshot.tools.length > WORK_LIVE_TOOL_SNAPSHOT_LIMIT) {
    snapshot.tools.splice(
      0,
      snapshot.tools.length - WORK_LIVE_TOOL_SNAPSHOT_LIMIT
    );
  }
}

function liveText(value: string): string {
  return boundedTail(value, WORK_LIVE_TEXT_MAX_BYTES);
}

function boundedTail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const prefix = '... earlier live output omitted ...\n';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(prefix, 'utf8'));
  const bytes = Buffer.from(value, 'utf8');
  const tail = bytes
    .subarray(Math.max(0, bytes.length - budget))
    .toString('utf8')
    .replace(/^\uFFFD/, '');
  return `${prefix}${tail}`;
}

function streamKey(taskId: string, runId: string): string {
  return `${taskId}\u0000${runId}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number
): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

export const workEventService = new WorkEventService();
export default workEventService;
