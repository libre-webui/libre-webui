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
import {
  buildContextUsage,
  formatTokenCount,
  measuredContextTokens,
  resolveContextBudget,
} from './contextUsage';
import type { ChatMessage } from '@/types';

const message = (
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage => ({
  id: `${role}-${content.length}-${extra.timestamp ?? 0}`,
  role,
  content,
  timestamp: extra.timestamp ?? 0,
  ...extra,
});

test('the window comes from the most specific setting that names one', () => {
  assert.equal(
    resolveContextBudget({
      sessionOptions: { num_ctx: 8192 },
      pinnedOptions: { num_ctx: 16384 },
      modelDefaults: { num_ctx: 40960 },
      globalOptions: { num_ctx: 2048 },
    }),
    8192
  );

  assert.equal(
    resolveContextBudget({
      pinnedOptions: { num_ctx: 16384 },
      modelDefaults: { num_ctx: 40960 },
    }),
    16384
  );

  assert.equal(
    resolveContextBudget({ modelDefaults: { num_ctx: 40960 } }),
    40960
  );

  assert.equal(
    resolveContextBudget({ globalOptions: { num_ctx: 2048 } }),
    2048
  );
  assert.equal(resolveContextBudget({}), undefined);
});

test('a local setting cannot claim to resize a provider window', () => {
  assert.equal(
    resolveContextBudget({
      model: { isPlugin: true, contextLength: 200000 },
      sessionOptions: { num_ctx: 8192 },
    }),
    200000,
    'num_ctx is an Ollama runtime option, not a provider limit'
  );

  assert.equal(
    resolveContextBudget({
      model: { isPlugin: true },
      sessionOptions: { num_ctx: 8192 },
    }),
    undefined,
    'a provider that publishes no window leaves the meter without one'
  );
});

test('a window of zero or less falls through to the next setting', () => {
  assert.equal(
    resolveContextBudget({
      sessionOptions: { num_ctx: 0 },
      globalOptions: { num_ctx: 2048 },
    }),
    2048
  );
  assert.equal(
    resolveContextBudget({
      pinnedOptions: { num_ctx: -1 },
      modelDefaults: { num_ctx: 40960 },
    }),
    40960,
    'a pin left over from a hosted model should not empty the meter'
  );
  assert.equal(
    resolveContextBudget({ sessionOptions: { num_ctx: -1 } }),
    undefined
  );
});

test('the last reply reports what the next prompt carries', () => {
  const messages = [
    message('user', 'hello'),
    message('assistant', 'hi', {
      statistics: { prompt_eval_count: 1200, eval_count: 300 },
    }),
  ];

  assert.equal(measuredContextTokens(messages), 1500);
});

test('a reply with no statistics leaves the count to the estimate', () => {
  assert.equal(
    measuredContextTokens([
      message('user', 'hello'),
      message('assistant', 'hi'),
    ]),
    undefined
  );
  assert.equal(measuredContextTokens([message('user', 'hello')]), undefined);
});

test('usage splits into what the prompt holds and what the chat holds', () => {
  const usage = buildContextUsage({
    messages: [
      message('system', 'x'.repeat(400)),
      message('user', 'y'.repeat(800)),
      message('assistant', 'z'.repeat(400), { thinking: 'w'.repeat(200) }),
    ],
    budget: 10000,
  });

  assert.equal(usage.measured, false);
  assert.deepEqual(usage.segments, [
    { key: 'systemPrompt', tokens: 104 },
    { key: 'messages', tokens: 308 },
    { key: 'reasoning', tokens: 50 },
  ]);
  assert.equal(usage.used, 462);
  assert.equal(usage.ratio, 0.0462);
});

test('a measured total wins over the estimate', () => {
  const usage = buildContextUsage({
    messages: [
      message('user', 'hello'),
      message('assistant', 'hi', {
        statistics: { prompt_eval_count: 4000, eval_count: 96 },
      }),
    ],
    budget: 8192,
  });

  assert.equal(usage.measured, true);
  assert.equal(usage.used, 4096);
  assert.equal(usage.ratio, 0.5);
});

test('a prompt the server adds is counted even though no message holds it', () => {
  const withPersona = buildContextUsage({
    messages: [message('user', 'hello')],
    systemPrompt: 'p'.repeat(400),
  });

  assert.equal(withPersona.segments[0].tokens, 100);
  assert.equal(withPersona.budget, undefined);
  assert.equal(withPersona.ratio, undefined);
});

test('a full window reads as full rather than as more than full', () => {
  const usage = buildContextUsage({
    messages: [
      message('user', 'hello'),
      message('assistant', 'hi', {
        statistics: { prompt_eval_count: 9000, eval_count: 0 },
      }),
    ],
    budget: 4096,
  });

  assert.equal(usage.ratio, 1);
});

test('token counts stay short enough to read at a glance', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(138), '138');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1500), '1.5k');
  assert.equal(formatTokenCount(6400), '6.4k');
  assert.equal(formatTokenCount(8000), '8k');
  assert.equal(formatTokenCount(262144), '262k');
});
