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

import type {
  WorkLiveApproval,
  WorkLiveRun,
  WorkLiveRunPhase,
  WorkLiveSegment,
  WorkLiveToolActivity,
  WorkRunEvent,
  WorkRunLoopStats,
  WorkRunSkill,
  WorkRunUsage,
} from '@/types/work';

const LIVE_TEXT_CHARACTER_LIMIT = 100_000;
const LIVE_TEXT_OMISSION_PREFIX = '[Earlier live output omitted]\n\n';

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const firstString = (
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
};

const firstNumber = (
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined => {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const candidate = Number(raw);
    if (Number.isFinite(candidate)) return candidate;
  }
  return undefined;
};

const phaseFrom = (
  value: unknown,
  fallback: WorkLiveRunPhase
): WorkLiveRunPhase => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (normalized === 'queued') return 'queued';
  if (normalized === 'preparing' || normalized === 'starting')
    return 'preparing';
  if (
    normalized === 'thinking' ||
    normalized === 'running' ||
    normalized === 'working'
  )
    return 'thinking';
  if (
    normalized === 'using_tool' ||
    normalized === 'tool' ||
    normalized === 'tool_call'
  )
    return 'using_tool';
  if (
    normalized === 'responding' ||
    normalized === 'streaming' ||
    normalized === 'assistant'
  )
    return 'responding';
  if (
    normalized === 'completed' ||
    normalized === 'complete' ||
    normalized === 'done'
  )
    return 'completed';
  if (
    normalized === 'needs_input' ||
    normalized === 'needsinput' ||
    normalized === 'blocked'
  )
    return 'needs_input';
  if (normalized === 'failed' || normalized === 'error') return 'failed';
  if (
    normalized === 'cancelled' ||
    normalized === 'canceled' ||
    normalized === 'stopped'
  )
    return 'cancelled';
  return fallback;
};

const appendDelta = (
  current: string,
  data: Record<string, unknown>
): string => {
  const total = firstString(data, 'total');
  if (total !== undefined) return capLiveText(total);
  const text = firstString(data, 'text', 'content', 'delta', 'reasoning') || '';
  if (data.replace === true || data.cumulative === true)
    return capLiveText(text);
  return capLiveText(current + text);
};

const capLiveText = (value: string): string => {
  const wasAlreadyTruncated = value.startsWith(LIVE_TEXT_OMISSION_PREFIX);
  const content = wasAlreadyTruncated
    ? value.slice(LIVE_TEXT_OMISSION_PREFIX.length)
    : value;
  const availableCharacters =
    LIVE_TEXT_CHARACTER_LIMIT - LIVE_TEXT_OMISSION_PREFIX.length;

  if (!wasAlreadyTruncated && content.length <= LIVE_TEXT_CHARACTER_LIMIT)
    return content;
  if (wasAlreadyTruncated && content.length <= availableCharacters)
    return LIVE_TEXT_OMISSION_PREFIX + content;

  return LIVE_TEXT_OMISSION_PREFIX + content.slice(-availableCharacters);
};

const appendTimelineText = (
  timeline: WorkLiveSegment[],
  kind: 'reasoning' | 'response',
  aggregateBefore: string,
  aggregateAfter: string
): WorkLiveSegment[] => {
  if (aggregateAfter === aggregateBefore) return timeline;
  if (aggregateAfter.startsWith(aggregateBefore)) {
    const delta = aggregateAfter.slice(aggregateBefore.length);
    const last = timeline[timeline.length - 1];
    if (last && last.kind === kind) {
      return [
        ...timeline.slice(0, -1),
        { kind, text: capLiveText(last.text + delta) },
      ];
    }
    return [...timeline, { kind, text: capLiveText(delta) }];
  }
  // A cumulative total rewrote earlier text (or the cap trimmed the head).
  // Collapse this kind into a single segment holding the authoritative total.
  const kept = timeline.filter(segment => segment.kind !== kind);
  return [...kept, { kind, text: aggregateAfter }];
};

const appendTimelineTool = (
  timeline: WorkLiveSegment[],
  toolId: string
): WorkLiveSegment[] =>
  timeline.some(segment => segment.kind === 'tool' && segment.toolId === toolId)
    ? timeline
    : [...timeline, { kind: 'tool', toolId }];

const usageFrom = (
  data: Record<string, unknown>,
  current?: WorkRunUsage
): WorkRunUsage => {
  const usage = asRecord(data.usage) || data;
  const next: WorkRunUsage = { ...current };
  const fields: Array<[keyof WorkRunUsage, string[]]> = [
    [
      'inputTokens',
      ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'],
    ],
    [
      'outputTokens',
      [
        'outputTokens',
        'output_tokens',
        'completionTokens',
        'completion_tokens',
      ],
    ],
    ['reasoningTokens', ['reasoningTokens', 'reasoning_tokens']],
    ['cachedTokens', ['cachedTokens', 'cached_tokens']],
    ['totalTokens', ['totalTokens', 'total_tokens']],
    ['tokensPerSecond', ['tokensPerSecond', 'tokens_per_second']],
    ['durationMs', ['durationMs', 'duration_ms']],
  ];
  for (const [field, keys] of fields) {
    const value = firstNumber(usage, ...keys);
    if (value !== undefined) next[field] = value;
  }
  if (
    next.totalTokens === undefined &&
    (next.inputTokens !== undefined || next.outputTokens !== undefined)
  ) {
    next.totalTokens = (next.inputTokens || 0) + (next.outputTokens || 0);
  }
  return next;
};

const skillFrom = (
  data: Record<string, unknown>,
  index: number
): WorkRunSkill => {
  const skill = asRecord(data.skill) || data;
  const name = firstString(skill, 'name', 'title', 'skill') || 'Skill';
  return {
    id: firstString(skill, 'id', 'skillId', 'skill_id') || `${name}-${index}`,
    name,
    description: firstString(skill, 'description', 'summary'),
  };
};

const toolFrom = (
  data: Record<string, unknown>,
  timestamp: number,
  fallbackIndex: number
): WorkLiveToolActivity => {
  const tool = asRecord(data.tool) || data;
  const message = asRecord(tool.message);
  const messageMetadata = message ? asRecord(message.metadata) : undefined;
  const details = messageMetadata ? { ...messageMetadata, ...tool } : tool;
  const name =
    firstString(details, 'name', 'toolName', 'tool_name', 'function') || 'tool';
  return {
    id:
      firstString(details, 'id', 'toolCallId', 'tool_call_id', 'callId') ||
      `${name}-${fallbackIndex}`,
    name,
    status:
      details.isError === true || details.is_error === true
        ? 'error'
        : 'running',
    arguments:
      details.arguments ??
      details.input ??
      details.args ??
      details.parameters ??
      undefined,
    metadata: asRecord(details.metadata) || messageMetadata,
    startedAt:
      firstNumber(details, 'startedAt', 'started_at', 'timestamp') || timestamp,
  };
};

const toolsFromSnapshot = (
  value: unknown,
  timestamp: number
): WorkLiveToolActivity[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = asRecord(item);
    if (!record) return [];
    const tool = toolFrom(record, timestamp, index);
    const output = firstString(record, 'output', 'content', 'result');
    const status = phaseFrom(record.status, 'using_tool');
    return [
      {
        ...tool,
        status:
          record.isError === true || record.is_error === true
            ? 'error'
            : status === 'completed'
              ? 'completed'
              : tool.status,
        output,
        finishedAt: firstNumber(record, 'finishedAt', 'finished_at'),
        durationMs: firstNumber(record, 'durationMs', 'duration_ms'),
      },
    ];
  });
};

export const createWorkLiveRun = (
  taskId: string,
  runId: string,
  startedAt?: number
): WorkLiveRun => ({
  taskId,
  runId,
  connection: 'idle',
  phase: 'queued',
  lastEventId: 0,
  reasoning: '',
  response: '',
  timeline: [],
  tools: [],
  skills: [],
  startedAt,
  terminal: false,
});

const applySnapshot = (
  current: WorkLiveRun,
  event: WorkRunEvent
): WorkLiveRun => {
  const live =
    asRecord(event.data.liveRun) ||
    asRecord(event.data.live_run) ||
    asRecord(event.data.run) ||
    event.data;
  const task = asRecord(event.data.task) || asRecord(event.data.detail);
  const activeRun = task ? asRecord(task.activeRun) : undefined;
  const reasoning = firstString(live, 'reasoning', 'thinking');
  const response = firstString(live, 'response', 'assistant', 'content');
  const snapshotPhase = phaseFrom(
    live.phase ?? live.status ?? activeRun?.status ?? task?.status,
    current.phase
  );
  const phase =
    current.lastEventId > 0 &&
    snapshotPhase !== 'completed' &&
    snapshotPhase !== 'needs_input' &&
    snapshotPhase !== 'failed' &&
    snapshotPhase !== 'cancelled' &&
    live.phase === undefined
      ? current.phase
      : snapshotPhase;
  const tools = toolsFromSnapshot(
    live.tools ?? live.toolActivities ?? live.tool_activities,
    event.timestamp
  );
  const rawSkills = live.skills;
  const skills = Array.isArray(rawSkills)
    ? rawSkills.flatMap((item, index) => {
        const record = asRecord(item);
        return record ? [skillFrom(record, index)] : [];
      })
    : current.skills;
  const terminal =
    live.terminal === true ||
    phase === 'completed' ||
    phase === 'needs_input' ||
    phase === 'failed' ||
    phase === 'cancelled';
  const nextReasoning =
    reasoning === undefined ? current.reasoning : capLiveText(reasoning);
  const nextResponse =
    response === undefined ? current.response : capLiveText(response);
  const nextTools = tools.length > 0 ? tools : current.tools;
  let timeline = appendTimelineText(
    current.timeline,
    'reasoning',
    current.reasoning,
    nextReasoning
  );
  for (const tool of nextTools) {
    timeline = appendTimelineTool(timeline, tool.id);
  }
  timeline = appendTimelineText(
    timeline,
    'response',
    current.response,
    nextResponse
  );
  return {
    ...current,
    phase,
    reasoning: nextReasoning,
    response: nextResponse,
    timeline,
    tools: nextTools,
    skills,
    usage: asRecord(live.usage)
      ? usageFrom(live, current.usage)
      : current.usage,
    round:
      firstNumber(live, 'round', 'roundIndex', 'round_index') ?? current.round,
    roundLimit:
      firstNumber(live, 'roundLimit', 'round_limit') ?? current.roundLimit,
    startedAt:
      firstNumber(live, 'startedAt', 'started_at') ??
      (activeRun
        ? firstNumber(activeRun, 'startedAt', 'started_at')
        : undefined) ??
      current.startedAt,
    finishedAt:
      firstNumber(live, 'finishedAt', 'finished_at') ?? current.finishedAt,
    error: firstString(live, 'error', 'message') ?? current.error,
    terminal,
    budgetReason:
      firstString(live, 'budgetReason', 'budget_reason') ??
      current.budgetReason,
    loopStats: loopStatsFrom(live.loopStats) ?? current.loopStats,
    pendingApproval: terminal
      ? undefined
      : asRecord(live.pendingApproval ?? live.pending_approval)
        ? approvalFrom(
            asRecord(live.pendingApproval ?? live.pending_approval) ?? {}
          )
        : current.pendingApproval,
  };
};

const LOOP_STAT_KEYS = [
  'rounds',
  'toolCalls',
  'screenshots',
  'fences',
  'expectationsPassed',
  'expectationsPending',
  'stallNudges',
  'ambiguityNudges',
] as const;

export const loopStatsFrom = (value: unknown): WorkRunLoopStats | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const stats: WorkRunLoopStats = {};
  for (const key of LOOP_STAT_KEYS) {
    const entry = record[key];
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      stats[key] = entry;
    }
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
};

const approvalFrom = (
  data: Record<string, unknown>
): WorkLiveApproval | undefined => {
  const approvalId = firstString(data, 'approvalId', 'approval_id');
  const toolCallId = firstString(data, 'toolCallId', 'tool_call_id');
  const name = firstString(data, 'name', 'toolName', 'tool_name');
  if (!approvalId || !toolCallId || !name) return undefined;
  const status = firstString(data, 'status');
  return {
    approvalId,
    toolCallId,
    name,
    summary: asRecord(data.summary),
    status:
      status === 'approved' || status === 'denied' || status === 'expired'
        ? status
        : 'pending',
    expiresAt: firstNumber(data, 'expiresAt', 'expires_at'),
  };
};

const upsertTool = (
  tools: WorkLiveToolActivity[],
  next: WorkLiveToolActivity
): WorkLiveToolActivity[] => {
  const index = tools.findIndex(tool => tool.id === next.id);
  if (index === -1) return [...tools, next];
  const updated = [...tools];
  updated[index] = { ...tools[index], ...next };
  return updated;
};

export const applyWorkRunEvent = (
  existing: WorkLiveRun | undefined,
  event: WorkRunEvent
): WorkLiveRun => {
  const current =
    existing?.taskId === event.taskId && existing.runId === event.runId
      ? existing
      : createWorkLiveRun(event.taskId, event.runId, event.timestamp);
  if (event.type !== 'snapshot' && event.id <= current.lastEventId)
    return current;

  let next: WorkLiveRun = {
    ...current,
    connection: 'connected',
    connectionError: undefined,
    lastEventId: Math.max(current.lastEventId, event.id),
  };

  if (event.type === 'snapshot') {
    next = applySnapshot(next, event);
  } else if (event.type === 'run_state') {
    const phase = phaseFrom(
      event.data.phase ?? event.data.status ?? event.data.state,
      next.phase
    );
    next = {
      ...next,
      phase,
      round:
        firstNumber(event.data, 'round', 'roundIndex', 'round_index') ??
        next.round,
      roundLimit:
        firstNumber(event.data, 'roundLimit', 'round_limit') ?? next.roundLimit,
      startedAt:
        firstNumber(event.data, 'startedAt', 'started_at') ?? next.startedAt,
      terminal:
        next.terminal ||
        phase === 'completed' ||
        phase === 'needs_input' ||
        phase === 'failed' ||
        phase === 'cancelled',
    };
  } else if (event.type === 'reasoning_delta') {
    const reasoning = appendDelta(next.reasoning, event.data);
    next = {
      ...next,
      phase: 'thinking',
      reasoning,
      timeline: appendTimelineText(
        next.timeline,
        'reasoning',
        next.reasoning,
        reasoning
      ),
    };
  } else if (event.type === 'assistant_delta') {
    const response = appendDelta(next.response, event.data);
    next = {
      ...next,
      phase: 'responding',
      response,
      timeline: appendTimelineText(
        next.timeline,
        'response',
        next.response,
        response
      ),
    };
  } else if (event.type === 'tool_call') {
    const tool = toolFrom(event.data, event.timestamp, next.tools.length);
    next = {
      ...next,
      phase: 'using_tool',
      tools: upsertTool(next.tools, tool),
      timeline: appendTimelineTool(next.timeline, tool.id),
    };
  } else if (event.type === 'tool_result') {
    const result = toolFrom(event.data, event.timestamp, next.tools.length);
    const currentTool = next.tools.find(tool => tool.id === result.id);
    const error =
      event.data.isError === true ||
      event.data.is_error === true ||
      event.data.error === true;
    next = {
      ...next,
      phase: 'thinking',
      tools: upsertTool(next.tools, {
        ...currentTool,
        ...result,
        status: error ? 'error' : 'completed',
        arguments: currentTool?.arguments ?? result.arguments,
        startedAt: currentTool?.startedAt ?? result.startedAt,
        output:
          firstString(event.data, 'output', 'content', 'result', 'message') ||
          '',
        finishedAt:
          firstNumber(event.data, 'finishedAt', 'finished_at') ||
          event.timestamp,
        durationMs: firstNumber(event.data, 'durationMs', 'duration_ms'),
      }),
      // A result for the gated call clears its approval card even when the
      // resolution event was lost (crash-reconciled runs).
      pendingApproval:
        next.pendingApproval?.toolCallId === result.id
          ? undefined
          : next.pendingApproval,
    };
  } else if (event.type === 'approval') {
    const approval = approvalFrom(event.data);
    if (approval) {
      next =
        approval.status === 'pending'
          ? { ...next, pendingApproval: approval }
          : next.pendingApproval?.approvalId === approval.approvalId
            ? { ...next, pendingApproval: undefined }
            : next;
    }
  } else if (event.type === 'usage') {
    next = { ...next, usage: usageFrom(event.data, next.usage) };
  } else if (event.type === 'skill_loaded') {
    const skill = skillFrom(event.data, next.skills.length);
    next = {
      ...next,
      skills: next.skills.some(item => item.id === skill.id)
        ? next.skills
        : [...next.skills, skill],
    };
  } else if (event.type === 'error') {
    next = {
      ...next,
      phase: 'failed',
      error:
        firstString(event.data, 'message', 'error') ||
        'The Work run stopped unexpectedly.',
      finishedAt:
        firstNumber(event.data, 'finishedAt', 'finished_at') || event.timestamp,
      terminal: event.data.terminal !== false,
      pendingApproval: undefined,
    };
  } else if (event.type === 'done') {
    const phase = phaseFrom(
      event.data.status ?? event.data.state ?? event.data.phase,
      'completed'
    );
    next = {
      ...next,
      phase,
      error: firstString(event.data, 'error', 'message') ?? next.error,
      usage: asRecord(event.data.usage)
        ? usageFrom(event.data, next.usage)
        : next.usage,
      finishedAt:
        firstNumber(event.data, 'finishedAt', 'finished_at') || event.timestamp,
      terminal: true,
      budgetReason:
        firstString(event.data, 'budgetReason', 'budget_reason') ??
        next.budgetReason,
      loopStats: loopStatsFrom(event.data.loopStats) ?? next.loopStats,
      pendingApproval: undefined,
    };
  }

  return next;
};
