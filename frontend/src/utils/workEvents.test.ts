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
