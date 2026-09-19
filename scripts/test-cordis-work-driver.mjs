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
import { createWorkDshDriver } from '../backend/dist/cordis/dsh/work-driver.js';

const tool = {
  type: 'function',
  function: {
    name: 'work_read_file',
    description: 'Read an approved Work sandbox file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};
const request = (
  messages = [
    { role: 'user', content: 'inspect the workspace', images: ['image-data'] },
  ]
) => ({
  model: 'test-model',
  messages,
  tools: [tool],
  think: 'high',
  options: { temperature: 0.2 },
});
const answer = (content, calls) => ({
  model: 'test-model',
  created_at: '2026-01-01T00:00:00Z',
  done: true,
  prompt_eval_count: 4,
  eval_count: 2,
  message: {
    role: 'assistant',
    content,
    thinking: 'reasoning',
    providerMetadata: { replay: 'private-provider-state' },
    ...(calls ? { tool_calls: calls } : {}),
  },
});
const call = (id = 'call-1', name = 'work_read_file') => ({
  id,
  function: { name, arguments: { path: 'src/index.ts' } },
  providerMetadata: { thought: 'keep-me' },
});

function deadline() {
  return AbortSignal.timeout(5000);
}

test('native DSH returns live output and preserves the canonical Work request and provider response', async () => {
  const input = request();
  const output = answer('hello');
  const tokens = [];
  const reasoning = [];
  const driver = await createWorkDshDriver({
    generate: async (received, observer) => {
      assert.strictEqual(received, input);
      observer.onReasoning('reasoning');
      observer.onContent('hel');
      observer.onContent('lo');
      return output;
    },
  });
  try {
    const result = await driver.generate(
      input,
      {
        onContent: text => tokens.push(text),
        onReasoning: text => reasoning.push(text),
      },
      deadline()
    );
    assert.strictEqual(result, output);
    assert.deepEqual(tokens, ['hel', 'lo']);
    assert.deepEqual(reasoning, ['reasoning']);
  } finally {
    await driver.dispose();
  }
});

test('DSH pauses at tool calls until Work supplies approved sandbox results', async () => {
  let calls = 0;
  const first = answer('', [call()]);
  const second = answer('reviewed');
  const initial = request();
  const next = request([
    ...initial.messages,
    { ...first.message },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      tool_name: 'work_read_file',
      content: 'sandbox contents',
    },
  ]);
  const driver = await createWorkDshDriver({
    generate: async received => {
      calls += 1;
      assert.strictEqual(received, calls === 1 ? initial : next);
      return calls === 1 ? first : second;
    },
  });
  try {
    assert.strictEqual(await driver.generate(initial, {}, deadline()), first);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(
      calls,
      1,
      'DSH may not advance the provider while Work awaits approval'
    );
    assert.strictEqual(await driver.generate(next, {}, deadline()), second);
    assert.equal(calls, 2);
  } finally {
    await driver.dispose();
  }
});

test('approval denial is supplied as the next canonical tool result', async () => {
  let calls = 0;
  const driver = await createWorkDshDriver({
    generate: async received => {
      if (++calls === 1) return answer('', [call()]);
      assert.equal(
        received.messages.at(-1).content,
        'Permission denied by user'
      );
      return answer('I stopped');
    },
  });
  try {
    const first = await driver.generate(request(), {}, deadline());
    const next = request([
      { role: 'user', content: 'inspect' },
      first.message,
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: 'Permission denied by user',
      },
    ]);
    assert.equal(
      (await driver.generate(next, {}, deadline())).message.content,
      'I stopped'
    );
  } finally {
    await driver.dispose();
  }
});

test('provider calls without ids get a stable id shared with Work tool results', async () => {
  let calls = 0;
  const toolCall = call();
  delete toolCall.id;
  const driver = await createWorkDshDriver({
    generate: async () =>
      ++calls === 1 ? answer('', [toolCall]) : answer('done'),
  });
  try {
    const first = await driver.generate(request(), {}, deadline());
    assert.match(first.message.tool_calls[0].id, /^work-dsh-/);
    assert.deepEqual(
      first.message.tool_calls[0].providerMetadata,
      toolCall.providerMetadata
    );
    const next = request([
      {
        role: 'tool',
        tool_call_id: first.message.tool_calls[0].id,
        content: 'done',
      },
    ]);
    assert.equal(
      (await driver.generate(next, {}, deadline())).message.content,
      'done'
    );
  } finally {
    await driver.dispose();
  }
});

test('recovered canonical Work history does not re-execute historical tool calls', async () => {
  let calls = 0;
  const recovered = request([
    { role: 'user', content: 'read' },
    answer('', [call()]).message,
    { role: 'tool', tool_call_id: 'call-1', content: 'already executed' },
  ]);
  const driver = await createWorkDshDriver({
    generate: async received => {
      calls += 1;
      assert.strictEqual(received, recovered);
      return answer('continue from durable history');
    },
  });
  try {
    await driver.generate(recovered, {}, deadline());
    assert.equal(calls, 1);
  } finally {
    await driver.dispose();
  }
});

test('unknown host filesystem tools cannot execute in the isolated Work context', async () => {
  let calls = 0;
  const driver = await createWorkDshDriver({
    generate: async () =>
      ++calls === 1 ? answer('', [call('escape', 'read')]) : answer('denied'),
  });
  try {
    const first = await driver.generate(request(), {}, deadline());
    assert.equal(first.message.tool_calls[0].function.name, 'read');
    const next = request([
      { role: 'tool', tool_call_id: 'escape', content: 'Unknown tool: read' },
    ]);
    assert.equal(
      (await driver.generate(next, {}, deadline())).message.content,
      'denied'
    );
  } finally {
    await driver.dispose();
  }
});

test('disposing while waiting for Work results releases the native loop', async () => {
  const driver = await createWorkDshDriver({
    generate: async () => answer('', [call()]),
  });
  await driver.generate(request(), {}, deadline());
  await driver.dispose();
  await driver.dispose();
  await assert.rejects(driver.generate(request(), {}, deadline()), /disposed/);
});

test('cancellation aborts the underlying model request and rejects the Work step', async () => {
  const abort = new AbortController();
  let started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  let modelAborted = false;
  const driver = await createWorkDshDriver({
    generate: async (_request, _observer, signal) => {
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            modelAborted = true;
            reject(signal.reason);
          },
          { once: true }
        )
      );
    },
  });
  try {
    const pending = driver.generate(request(), {}, abort.signal);
    await ready;
    abort.abort(new Error('stop work'));
    await assert.rejects(pending, /stop work/);
    assert.equal(modelAborted, true);
  } finally {
    await driver.dispose();
  }
});

test('provider stream overflow aborts upstream and rejects instead of buffering without bound', async () => {
  let aborted = false;
  const driver = await createWorkDshDriver({
    generate: async (_request, observer, signal) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true }
      );
      observer.onContent('x'.repeat(2 * 1024 * 1024 + 1));
      return answer('unreachable');
    },
  });
  try {
    await assert.rejects(
      driver.generate(request(), {}, deadline()),
      /buffer limit/
    );
    assert.equal(aborted, true);
  } finally {
    await driver.dispose();
  }
});

test('an immediate text-only retry drains the rejected image step before accepting new callbacks', async () => {
  let calls = 0;
  let oldObserver;
  const output = answer('retried without images');
  const seen = [];
  const driver = await createWorkDshDriver({
    generate: async (received, observer) => {
      calls += 1;
      if (calls === 1) {
        assert.deepEqual(received.messages[0].images, ['image-data']);
        oldObserver = observer;
        throw new Error('image input is unsupported');
      }
      assert.equal(received.messages[0].images, undefined);
      oldObserver.onContent('stale first-step text');
      observer.onContent('retried without images');
      return output;
    },
  });
  try {
    await assert.rejects(
      driver.generate(request(), {}, deadline()),
      /image input is unsupported/
    );
    const retry = request([
      { role: 'user', content: 'retry without screenshots' },
    ]);
    assert.strictEqual(
      await driver.generate(
        retry,
        { onContent: text => seen.push(text) },
        deadline()
      ),
      output
    );
    assert.equal(calls, 2);
    assert.deepEqual(seen, ['retried without images']);
  } finally {
    await driver.dispose();
  }
});
