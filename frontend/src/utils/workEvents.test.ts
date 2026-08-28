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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkRunEvent } from '@/types/work';
import { workStatusPresentation } from './workStatus';
import { applyWorkRunEvent, createWorkLiveRun } from './workEvents';

const event = (
  id: number,
  type: WorkRunEvent['type'],
  data: Record<string, unknown>
): WorkRunEvent => ({
  id,
  type,
  taskId: 'task-1',
  runId: 'run-1',
  timestamp: 1_000 + id,
  data,
});

test('applies an initial id-zero snapshot before duplicate filtering', () => {
  const initial = createWorkLiveRun('task-1', 'run-1');
  const snapshot = applyWorkRunEvent(
    initial,
    event(0, 'snapshot', {
      task: {
        id: 'task-1',
        status: 'running',
        activeRun: { id: 'run-1', status: 'running', startedAt: 750 },
      },
    })
  );

  assert.equal(snapshot.phase, 'thinking');
  assert.equal(snapshot.connection, 'connected');
  assert.equal(snapshot.lastEventId, 0);
  assert.equal(snapshot.startedAt, 750);
});

test('does not turn a queued run with a null start time into epoch zero', () => {
  const snapshot = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(0, 'snapshot', {
      task: {
        id: 'task-1',
        status: 'preparing',
        activeRun: {
          id: 'run-1',
          status: 'queued',
          startedAt: null,
        },
      },
    })
  );

  assert.equal(snapshot.startedAt, undefined);
});

test('reapplies reconnect snapshots at the current cursor without replaying deltas', () => {
  const streamed = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(4, 'assistant_delta', { text: 'Hello' })
  );
  const snapshot = applyWorkRunEvent(
    streamed,
    event(4, 'snapshot', {
      run: { phase: 'responding', response: 'Hello world' },
    })
  );
  const duplicate = applyWorkRunEvent(
    snapshot,
    event(4, 'assistant_delta', { text: 'Hello' })
  );

  assert.equal(snapshot.response, 'Hello world');
  assert.equal(snapshot.lastEventId, 4);
  assert.equal(duplicate.response, 'Hello world');
});

test('uses cumulative delta totals and exposes the current round budget', () => {
  const started = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(1, 'run_state', {
      status: 'running',
      phase: 'thinking',
      round: 3,
      roundLimit: 48,
    })
  );
  const first = applyWorkRunEvent(
    started,
    event(2, 'assistant_delta', { delta: 'Hello', total: 'Hello' })
  );
  const corrected = applyWorkRunEvent(
    first,
    event(3, 'assistant_delta', { delta: '!', total: 'Hello world!' })
  );

  assert.equal(corrected.response, 'Hello world!');
  assert.equal(corrected.round, 3);
  assert.equal(corrected.roundLimit, 48);
});

test('caps live text while preserving the newest streamed tokens', () => {
  const oversizedTotal = `${'a'.repeat(100_050)}TOTAL_END`;
  const truncatedTotal = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(1, 'assistant_delta', { total: oversizedTotal })
  );

  assert.equal(truncatedTotal.response.length, 100_000);
  assert.match(truncatedTotal.response, /^\[Earlier live output omitted\]\n\n/);
  assert.equal(truncatedTotal.response.endsWith('TOTAL_END'), true);

  const streamed = applyWorkRunEvent(
    truncatedTotal,
    event(2, 'assistant_delta', { delta: 'NEWEST_TOKEN' })
  );

  assert.equal(streamed.response.length, 100_000);
  assert.equal(streamed.response.endsWith('TOTAL_ENDNEWEST_TOKEN'), true);
  assert.equal(
    streamed.response.match(/\[Earlier live output omitted\]/g)?.length,
    1
  );
});

test('reduces reasoning, tools, skills, usage, and terminal state in order', () => {
  const events: WorkRunEvent[] = [
    event(1, 'reasoning_delta', { text: 'Inspecting ' }),
    event(2, 'reasoning_delta', { text: 'the project.' }),
    event(3, 'skill_loaded', {
      id: 'web-app',
      name: 'Web app',
      description: 'Build and verify a browser app.',
    }),
    event(4, 'tool_call', {
      toolCallId: 'call-1',
      name: 'read_file',
      arguments: { path: 'package.json' },
    }),
    event(5, 'tool_result', {
      toolCallId: 'call-1',
      name: 'read_file',
      output: '{"name":"demo"}',
      durationMs: 125,
    }),
    event(6, 'assistant_delta', { text: 'The project is ready.' }),
    event(7, 'usage', {
      input_tokens: 100,
      output_tokens: 25,
      tokens_per_second: 12.5,
    }),
    event(8, 'done', { status: 'completed' }),
  ];

  const reduced = events.reduce(
    (state, next) => applyWorkRunEvent(state, next),
    createWorkLiveRun('task-1', 'run-1')
  );

  assert.equal(reduced.reasoning, 'Inspecting the project.');
  assert.equal(reduced.response, 'The project is ready.');
  assert.deepEqual(reduced.skills, [
    {
      id: 'web-app',
      name: 'Web app',
      description: 'Build and verify a browser app.',
    },
  ]);
  assert.equal(reduced.tools.length, 1);
  assert.equal(reduced.tools[0]?.status, 'completed');
  assert.equal(reduced.tools[0]?.output, '{"name":"demo"}');
  assert.equal(reduced.tools[0]?.durationMs, 125);
  assert.deepEqual(reduced.usage, {
    inputTokens: 100,
    outputTokens: 25,
    totalTokens: 125,
    tokensPerSecond: 12.5,
  });
  assert.equal(reduced.phase, 'completed');
  assert.equal(reduced.terminal, true);
});

test('keeps a chronological timeline across interleaved thinking, tools, and text', () => {
  const events: WorkRunEvent[] = [
    event(1, 'reasoning_delta', { text: 'Planning the change.' }),
    event(2, 'assistant_delta', { text: 'Inspecting the project first.' }),
    event(3, 'tool_call', { toolCallId: 'call-1', name: 'read_file' }),
    event(4, 'tool_result', {
      toolCallId: 'call-1',
      name: 'read_file',
      output: '{}',
    }),
    event(5, 'assistant_delta', { text: 'Now writing the file.' }),
    event(6, 'tool_call', { toolCallId: 'call-2', name: 'write_file' }),
    event(7, 'tool_result', {
      toolCallId: 'call-2',
      name: 'write_file',
      output: 'ok',
    }),
    event(8, 'assistant_delta', { text: ' Done.' }),
  ];

  const reduced = events.reduce(
    (state, next) => applyWorkRunEvent(state, next),
    createWorkLiveRun('task-1', 'run-1')
  );

  assert.deepEqual(reduced.timeline, [
    { kind: 'reasoning', text: 'Planning the change.' },
    { kind: 'response', text: 'Inspecting the project first.' },
    { kind: 'tool', toolId: 'call-1' },
    { kind: 'response', text: 'Now writing the file.' },
    { kind: 'tool', toolId: 'call-2' },
    { kind: 'response', text: ' Done.' },
  ]);
  assert.equal(
    reduced.response,
    'Inspecting the project first.Now writing the file. Done.'
  );
});

test('rebuilds a canonical timeline from a reconnect snapshot', () => {
  const snapshot = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(9, 'snapshot', {
      run: {
        phase: 'responding',
        reasoning: 'Earlier thinking.',
        response: 'Earlier answer.',
        tools: [
          { id: 'call-1', name: 'read_file', status: 'completed', output: '' },
        ],
      },
    })
  );

  assert.deepEqual(snapshot.timeline, [
    { kind: 'reasoning', text: 'Earlier thinking.' },
    { kind: 'tool', toolId: 'call-1' },
    { kind: 'response', text: 'Earlier answer.' },
  ]);
});

test('collapses a timeline text kind when a cumulative total rewrites it', () => {
  const first = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(1, 'assistant_delta', { text: 'Round one text.' })
  );
  const withTool = applyWorkRunEvent(
    first,
    event(2, 'tool_call', { toolCallId: 'call-1', name: 'read_file' })
  );
  const rewritten = applyWorkRunEvent(
    withTool,
    event(3, 'assistant_delta', { total: 'A different final answer.' })
  );

  assert.deepEqual(rewritten.timeline, [
    { kind: 'tool', toolId: 'call-1' },
    { kind: 'response', text: 'A different final answer.' },
  ]);
  assert.equal(rewritten.response, 'A different final answer.');
});

test('treats needs-input completion as a terminal yellow state', () => {
  const reduced = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    event(1, 'done', {
      status: 'needs_input',
      message: 'Continue in the same workspace.',
    })
  );

  assert.equal(reduced.phase, 'needs_input');
  assert.equal(reduced.terminal, true);
  assert.equal(workStatusPresentation.needs_input.color, 'rgb(255, 204, 0)');
  assert.equal(
    workStatusPresentation.needs_input.labelKey,
    'work.statusLabels.needsInput'
  );
  assert.equal(
    workStatusPresentation.cancelled.labelKey,
    'work.statusLabels.needsInput'
  );
});

test('a pending approval blocks the run until resolved, and results clear it', () => {
  const pendingEvent = event(1, 'approval', {
    approvalId: 'approval-1',
    toolCallId: 'call-1',
    name: 'run_command',
    summary: { command: 'npm run build' },
    status: 'pending',
    expiresAt: 9_000,
  });
  const pending = applyWorkRunEvent(
    createWorkLiveRun('task-1', 'run-1'),
    pendingEvent
  );
  assert.equal(pending.pendingApproval?.approvalId, 'approval-1');
  assert.equal(pending.pendingApproval?.toolCallId, 'call-1');
  assert.deepEqual(pending.pendingApproval?.summary, {
    command: 'npm run build',
  });

  // A resolution for the same approval clears the card.
  const resolved = applyWorkRunEvent(
    pending,
    event(2, 'approval', {
      approvalId: 'approval-1',
      toolCallId: 'call-1',
      name: 'run_command',
      status: 'approved',
    })
  );
  assert.equal(resolved.pendingApproval, undefined);

  // A resolution for a different approval leaves the current card alone.
  const unrelated = applyWorkRunEvent(
    applyWorkRunEvent(createWorkLiveRun('task-1', 'run-1'), pendingEvent),
    event(2, 'approval', {
      approvalId: 'approval-other',
      toolCallId: 'call-other',
      name: 'delete_file',
      status: 'denied',
    })
  );
  assert.equal(unrelated.pendingApproval?.approvalId, 'approval-1');

  // A tool result for the gated call clears the card even when the
  // resolution event was lost (crash-reconciled runs), and terminal events
  // never leave a stale card behind.
  const clearedByResult = applyWorkRunEvent(
    applyWorkRunEvent(createWorkLiveRun('task-1', 'run-1'), pendingEvent),
    event(2, 'tool_result', {
      toolCallId: 'call-1',
      name: 'run_command',
      content: 'interrupted',
    })
  );
  assert.equal(clearedByResult.pendingApproval, undefined);

  const clearedByDone = applyWorkRunEvent(
    applyWorkRunEvent(createWorkLiveRun('task-1', 'run-1'), pendingEvent),
    event(2, 'done', { status: 'needs_input' })
  );
  assert.equal(clearedByDone.pendingApproval, undefined);
});
