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
import { parseWorkEventBlock, WorkEventStreamParser } from './workEventParser';

const taskId = 'task-stream';
const runId = 'run-stream';

const frame = (
  id: number,
  type: WorkRunEvent['type'],
  data: Record<string, unknown>,
  lineEnding = '\n'
): string => {
  const event: WorkRunEvent = {
    id,
    type,
    taskId,
    runId,
    timestamp: 1_000 + id,
    data,
  };
  return [
    `id: ${id}`,
    `event: ${type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join(lineEnding);
};

test('emits complete SSE events progressively across fragmented CRLF chunks', () => {
  const received: WorkRunEvent[] = [];
  const parser = new WorkEventStreamParser(taskId, runId, event =>
    received.push(event)
  );
  const reasoning = frame(
    1,
    'reasoning_delta',
    { delta: 'Inspecting ', total: 'Inspecting ' },
    '\r\n'
  );
  const response = frame(2, 'assistant_delta', {
    delta: 'Ready.',
    total: 'Ready.',
  });

  parser.push(reasoning.slice(0, 11));
  parser.push(reasoning.slice(11, 47));
  assert.equal(received.length, 0);
  parser.push(reasoning.slice(47));
  assert.deepEqual(
    received.map(event => event.type),
    ['reasoning_delta']
  );

  parser.push(response.slice(0, -2));
  assert.equal(received.length, 1);
  parser.push(response.slice(-2));
  assert.deepEqual(
    received.map(event => event.type),
    ['reasoning_delta', 'assistant_delta']
  );
  assert.equal(received[1]?.data.total, 'Ready.');
});

test('accepts multiline data and a final unterminated SSE event', () => {
  const received: WorkRunEvent[] = [];
  const parser = new WorkEventStreamParser(taskId, runId, event =>
    received.push(event)
  );

  parser.push(
    [
      ': heartbeat',
      'id: 3',
      'event: usage',
      'data: {"id":3,"type":"usage",',
      `data: "taskId":"${taskId}","runId":"${runId}","timestamp":1003,"data":{"totalTokens":12}}`,
      '',
      '',
    ].join('\n')
  );
  parser.finish(
    [
      'id: 4',
      'event: done',
      `data: {"id":4,"type":"done","taskId":"${taskId}","runId":"${runId}","timestamp":1004,"data":{"status":"completed"}}`,
    ].join('\n')
  );

  assert.deepEqual(
    received.map(event => [event.id, event.type]),
    [
      [3, 'usage'],
      [4, 'done'],
    ]
  );
  assert.equal(received[0]?.data.totalTokens, 12);
});

test('rejects malformed and cross-run events while accepting SSE field fallbacks', () => {
  assert.equal(
    parseWorkEventBlock(
      `id: 1\nevent: assistant_delta\ndata: {"taskId":"other-task","runId":"${runId}","data":{"delta":"wrong"}}`,
      taskId,
      runId
    ),
    undefined
  );
  assert.equal(
    parseWorkEventBlock(
      `id: nope\nevent: assistant_delta\ndata: {"data":{"delta":"wrong"}}`,
      taskId,
      runId
    ),
    undefined
  );

  const fallback = parseWorkEventBlock(
    'id: 5\nevent: assistant_delta\ndata: {"timestamp":"2026-07-26T12:00:00.000Z","data":{"delta":"accepted"}}',
    taskId,
    runId
  );
  assert.equal(fallback?.id, 5);
  assert.equal(fallback?.type, 'assistant_delta');
  assert.equal(fallback?.taskId, taskId);
  assert.equal(fallback?.runId, runId);
  assert.equal(fallback?.data.delta, 'accepted');
});
