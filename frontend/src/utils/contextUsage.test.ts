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
  COMPACTION_SUMMARY_PREFIX,
  buildContextUsage,
  formatTokenCount,
  resolveContextBudget,
  selectContextMessages,
} from './contextUsage';
import type { ChatMessage } from '@/types';

const ollamaModel = { isPlugin: false } as const;

let nextId = 0;
const message = (
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage => ({
  id: `m-${(nextId += 1)}`,
  role,
  content,
  timestamp: extra.timestamp ?? 0,
  ...extra,
});

test('the window comes from the most specific setting that names one', () => {
  assert.equal(
    resolveContextBudget({
      model: ollamaModel,
      sessionOptions: { num_ctx: 8192 },
      pinnedOptions: { num_ctx: 16384 },
      modelDefaults: { num_ctx: 40960 },
      globalOptions: { num_ctx: 2048 },
    }),
    8192
  );

  assert.equal(
    resolveContextBudget({
      model: ollamaModel,
      pinnedOptions: { num_ctx: 16384 },
      modelDefaults: { num_ctx: 40960 },
    }),
    16384
  );

  assert.equal(
    resolveContextBudget({
      model: ollamaModel,
      modelDefaults: { num_ctx: 40960 },
    }),
    40960
  );

  assert.equal(
    resolveContextBudget({
      model: ollamaModel,
      globalOptions: { num_ctx: 2048 },
    }),
    2048
  );
  assert.equal(resolveContextBudget({ model: ollamaModel }), undefined);
});

test('an unresolved model or an agent has no window at all', () => {
  assert.equal(
    resolveContextBudget({ globalOptions: { num_ctx: 2048 } }),
    undefined,
    'a model list still loading must not borrow the Ollama default'
  );
  assert.equal(
    resolveContextBudget({
      model: { ...ollamaModel, isAgent: true },
      globalOptions: { num_ctx: 2048 },
    }),
    undefined,
    'an agent conversation is not measured against num_ctx'
  );
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
      model: ollamaModel,
      sessionOptions: { num_ctx: 0 },
      globalOptions: { num_ctx: 2048 },
    }),
    2048
  );
  assert.equal(
    resolveContextBudget({
      model: ollamaModel,
      pinnedOptions: { num_ctx: -1 },
      modelDefaults: { num_ctx: 40960 },
    }),
    40960,
    'a pin left over from a hosted model should not empty the meter'
  );
  assert.equal(
    resolveContextBudget({
      model: ollamaModel,
      sessionOptions: { num_ctx: -1 },
    }),
    undefined
  );
});

test('only messages the server would send are counted', () => {
  const selected = selectContextMessages([
    message('system', 'live system'),
    message('system', 'stale summary', { isActive: false }),
    message('user', 'compacted away', { isActive: false }),
    ...Array.from({ length: 6 }, (_, index) =>
      message(index % 2 === 0 ? 'user' : 'assistant', `turn ${index}`)
    ),
  ]);

  assert.equal(selected.length, 7);
  assert.equal(selected[0].content, 'live system');
  assert.ok(selected.every(entry => entry.isActive !== false));
});

test('the rolling window keeps the last ten turns starting on a user turn', () => {
  const turns = Array.from({ length: 25 }, (_, index) =>
    message(index % 2 === 0 ? 'user' : 'assistant', `turn ${index}`)
  );
  const selected = selectContextMessages(turns);

  assert.ok(selected.length <= 10);
  assert.equal(selected[0].role, 'user');
  assert.equal(selected[selected.length - 1].content, 'turn 24');
});

test('CJK text and images are priced like the server prices them', () => {
  const cjk = buildContextUsage({
    messages: [message('user', '日本語のテスト')],
  });
  assert.equal(cjk.used, 4 + 7, 'CJK costs about a token per character');

  const withImage = buildContextUsage({
    messages: [
      message('user', 'look', { images: ['data:image/png;base64,x'] }),
    ],
  });
  const withoutImage = buildContextUsage({
    messages: [message('user', 'look')],
  });
  assert.equal(withImage.used - withoutImage.used, 768);
});

test('a chat with no measured reply is estimated from what would be sent', () => {
  const usage = buildContextUsage({
    messages: [
      message('system', 'x'.repeat(400)),
      message('user', 'y'.repeat(800)),
      message('assistant', 'z'.repeat(400), { thinking: 'w'.repeat(200) }),
    ],
    budget: 10000,
  });

  assert.equal(usage.measured, false);
  assert.equal(usage.used, 462);
  assert.equal(usage.ratio, 0.0462);
});

test('deactivated history costs nothing', () => {
  const active = buildContextUsage({
    messages: [message('user', 'y'.repeat(400))],
  });
  const withDeadWeight = buildContextUsage({
    messages: [
      message('user', 'z'.repeat(8000), { isActive: false }),
      message('assistant', 'z'.repeat(8000), { isActive: false }),
      message('user', 'y'.repeat(400)),
    ],
  });

  assert.equal(withDeadWeight.used, active.used);
});

test('a measured total anchors the count', () => {
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

test('a streaming placeholder extends the measured count instead of discarding it', () => {
  const settled = buildContextUsage({
    messages: [
      message('user', 'hello'),
      message('assistant', 'hi', {
        statistics: { prompt_eval_count: 4000, eval_count: 96 },
      }),
    ],
    budget: 8192,
  });
  const streaming = buildContextUsage({
    messages: [
      message('user', 'hello'),
      message('assistant', 'hi', {
        statistics: { prompt_eval_count: 4000, eval_count: 96 },
      }),
      message('user', 'q'.repeat(40)),
      message('assistant', ''),
    ],
    budget: 8192,
  });

  assert.equal(streaming.measured, true, 'no flip back to a bare estimate');
  assert.equal(streaming.used, settled.used + (4 + 10) + 4);
});

test('a prompt the server adds is counted even though no message holds it', () => {
  const withPersona = buildContextUsage({
    messages: [message('user', 'hello')],
    systemPrompt: 'p'.repeat(400),
  });

  assert.equal(withPersona.used, 100 + 4 + 2);
  assert.equal(withPersona.budget, undefined);
  assert.equal(withPersona.ratio, undefined);
});

test('a persona prompt replaces stored system messages but keeps the summary', () => {
  const summary = `${COMPACTION_SUMMARY_PREFIX}${'s'.repeat(100)}`;
  const usage = buildContextUsage({
    messages: [
      message('system', 'x'.repeat(4000)),
      message('system', summary),
      message('user', 'hi'),
    ],
    systemPrompt: 'p'.repeat(400),
  });

  // Persona prompt + summary + user turn; the replaced system message is not
  // sent and therefore not counted.
  assert.equal(usage.used, 100 + (4 + Math.ceil(summary.length / 4)) + (4 + 1));
});

test('over budget reads as over budget rather than as exactly full', () => {
  const usage = buildContextUsage({
    messages: [
      message('user', 'hello'),
      message('assistant', 'hi', {
        statistics: { prompt_eval_count: 9000, eval_count: 0 },
      }),
    ],
    budget: 4096,
  });

  assert.ok((usage.ratio ?? 0) > 1);
});

test('token counts stay short enough to read at a glance', () => {
  assert.equal(formatTokenCount(0, 'en'), '0');
  assert.equal(formatTokenCount(138, 'en'), '138');
  assert.equal(formatTokenCount(999, 'en'), '999');
  assert.equal(formatTokenCount(1500, 'en'), '1.5K');
  assert.equal(formatTokenCount(6400, 'en'), '6.4K');
  assert.equal(formatTokenCount(8000, 'en'), '8K');
  assert.equal(formatTokenCount(262144, 'en'), '262.1K');
});
