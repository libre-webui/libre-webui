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
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  abortChatGenerationOnResponseClose,
  ChatGenerationCancelledError,
  ChatGenerationRegistry,
  isChatGenerationCancelled,
  UserChatGenerationRegistry,
} from '../backend/dist/utils/chatCancellation.js';
import { streamOllamaChatResponse } from '../backend/dist/utils/ollamaStreaming.js';
import ollamaService from '../backend/dist/services/ollamaService.js';
import { streamPluginResponse } from '../backend/dist/utils/pluginStreaming.js';
import { streamAssistantFakeChunks } from '../backend/dist/utils/websocketMessages.js';

const socket = () => {
  const messages = [];
  return {
    messages,
    send(value) {
      messages.push(JSON.parse(value));
    },
  };
};

test('Ollama streaming receives the caller signal and cancellation is not sent as an error', async () => {
  const ws = socket();
  const controller = new AbortController();
  let forwardedSignal;
  const source = {
    async generateChatStreamResponse(
      _request,
      _onChunk,
      onError,
      _onComplete,
      signal
    ) {
      forwardedSignal = signal;
      await new Promise(resolve => {
        signal.addEventListener(
          'abort',
          () => {
            onError(signal.reason);
            resolve();
          },
          { once: true }
        );
      });
    },
  };

  const resultPromise = streamOllamaChatResponse({
    ws,
    request: { model: 'test', messages: [], stream: true },
    streamSource: source,
    messageId: 'assistant-1',
    signal: controller.signal,
  });
  controller.abort(new ChatGenerationCancelledError());
  const result = await resultPromise;

  assert.equal(forwardedSignal, controller.signal);
  assert.equal(result.completed, false);
  assert.equal(
    isChatGenerationCancelled(result.error, controller.signal),
    true
  );
  assert.deepEqual(ws.messages, []);
});

test('Ollama cancellation keeps the generation reserved until an abort-ignoring transport settles', async () => {
  const ws = socket();
  const controller = new AbortController();
  let releaseTransport;
  let transportSettled = false;
  const source = {
    async generateChatStreamResponse() {
      await new Promise(resolve => {
        releaseTransport = resolve;
      });
      transportSettled = true;
    },
  };

  let wrapperSettled = false;
  const resultPromise = streamOllamaChatResponse({
    ws,
    request: { model: 'test', messages: [], stream: true },
    streamSource: source,
    messageId: 'assistant-delayed-teardown',
    signal: controller.signal,
  });
  resultPromise.then(() => {
    wrapperSettled = true;
  });
  await new Promise(resolve => setImmediate(resolve));

  controller.abort(new ChatGenerationCancelledError());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transportSettled, false);
  assert.equal(
    wrapperSettled,
    false,
    'the caller must not release registry/provider slots during transport teardown'
  );

  releaseTransport();
  const result = await resultPromise;
  assert.equal(transportSettled, true);
  assert.equal(result.completed, false);
  assert.equal(
    isChatGenerationCancelled(result.error, controller.signal),
    true
  );
  assert.deepEqual(ws.messages, []);
});

test('plugin streaming stops before buffered chunks can be published', async () => {
  const ws = socket();
  const controller = new AbortController();
  let release;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  async function* chunks() {
    yield { type: 'content', content: 'first' };
    await blocked;
    yield { type: 'content', content: 'late' };
  }

  const resultPromise = streamPluginResponse({
    ws,
    chunks: chunks(),
    messageId: 'assistant-2',
    signal: controller.signal,
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new ChatGenerationCancelledError());
  release();

  await assert.rejects(resultPromise, error =>
    isChatGenerationCancelled(error, controller.signal)
  );
  assert.equal(ws.messages.length, 1);
  assert.equal(ws.messages[0].data.total, 'first');
});

test('fake streaming releases its delay immediately when cancelled', async () => {
  const ws = socket();
  const controller = new AbortController();
  const resultPromise = streamAssistantFakeChunks(
    ws,
    'one two three four five six',
    'assistant-3',
    30_000,
    controller.signal
  );
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new ChatGenerationCancelledError());
  await resultPromise;

  assert.equal(ws.messages.length, 1);
});

test('an early HTTP response close aborts generation and cleanup detaches it', () => {
  class ResponseStub extends EventEmitter {
    writableEnded = false;
  }
  const response = new ResponseStub();
  const first = abortChatGenerationOnResponseClose(response);
  response.emit('close');
  assert.equal(first.controller.signal.aborted, true);

  const second = abortChatGenerationOnResponseClose(response);
  second.cleanup();
  response.emit('close');
  assert.equal(second.controller.signal.aborted, false);
});

test('the generation registry cancels stale work without deleting an immediate retry', () => {
  const registry = new ChatGenerationRegistry();
  const first = registry.start('session-1', 'assistant-old');
  const retry = registry.start('session-1', 'assistant-retry');

  assert.equal(first.controller.signal.aborted, true);
  assert.equal(retry.controller.signal.aborted, false);
  assert.equal(registry.size, 1);

  registry.finish(first);
  assert.equal(registry.size, 1);
  assert.equal(
    registry.cancel('another-session', retry.assistantMessageId),
    false
  );
  assert.equal(retry.controller.signal.aborted, false);
  assert.equal(registry.cancel('session-1', retry.assistantMessageId), true);
  assert.equal(retry.controller.signal.aborted, true);

  registry.finish(retry);
  assert.equal(registry.size, 0);
});

test('the generation registry bounds fan-out and aborts duplicate IDs', () => {
  const registry = new ChatGenerationRegistry(2);
  const first = registry.start('session-1', 'assistant-shared');
  const replacement = registry.start('session-2', 'assistant-shared');
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(registry.size, 1);

  registry.start('session-3', 'assistant-3');
  assert.throws(
    () => registry.start('session-4', 'assistant-4'),
    /already has 2 active chat generations/
  );
  assert.equal(replacement.controller.signal.aborted, false);
  assert.equal(registry.size, 2);
});

test('the user registry bounds provider work across separate sockets', () => {
  const registry = new UserChatGenerationRegistry(2);
  const first = {
    sessionId: 'session-1',
    assistantMessageId: 'assistant-1',
    controller: new AbortController(),
  };
  const second = {
    sessionId: 'session-2',
    assistantMessageId: 'assistant-2',
    controller: new AbortController(),
  };
  registry.start('user-a', first);
  registry.start('user-a', second);
  assert.throws(
    () =>
      registry.start('user-a', {
        sessionId: 'session-3',
        assistantMessageId: 'assistant-3',
        controller: new AbortController(),
      }),
    /account already has 2 active chat generations/
  );

  const replacement = {
    sessionId: first.sessionId,
    assistantMessageId: 'assistant-retry',
    controller: new AbortController(),
  };
  registry.start('user-a', replacement);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(registry.sizeForUser('user-a'), 2);

  registry.start('user-b', {
    sessionId: 'session-3',
    assistantMessageId: 'assistant-3',
    controller: new AbortController(),
  });
  assert.equal(registry.sizeForUser('user-b'), 1);

  registry.finish('user-a', first);
  assert.equal(registry.sizeForUser('user-a'), 2);
  registry.finish('user-a', replacement);
  registry.finish('user-a', second);
  assert.equal(registry.sizeForUser('user-a'), 0);
});

test('Ollama model-default preparation forwards Stop cancellation', async () => {
  const originalClient = ollamaService.client;
  const controller = new AbortController();
  let forwardedSignal;
  ollamaService.client = {
    post(_url, _body, config) {
      forwardedSignal = config.signal;
      return new Promise((_resolve, reject) => {
        config.signal.addEventListener(
          'abort',
          () => reject(config.signal.reason),
          { once: true }
        );
      });
    },
  };

  try {
    const defaults = ollamaService.getModelDefaults(
      `cancel-defaults-${Date.now()}`,
      controller.signal
    );
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new ChatGenerationCancelledError());
    await assert.rejects(defaults, error =>
      isChatGenerationCancelled(error, controller.signal)
    );
    assert.equal(forwardedSignal, controller.signal);
  } finally {
    ollamaService.client = originalClient;
  }
});

test('Ollama service settles once and rejects a stream without a done record', async () => {
  const originalClient = ollamaService.longOperationClient;
  const request = { model: 'test', messages: [], stream: true };
  try {
    ollamaService.longOperationClient = {
      async post() {
        return {
          data: Readable.from([
            Buffer.from(
              `${JSON.stringify({
                model: 'test',
                message: { role: 'assistant', content: 'done' },
                done: true,
              })}\n`
            ),
          ]),
        };
      },
    };
    let completed = 0;
    let failed = 0;
    await ollamaService.generateChatStreamResponse(
      request,
      () => {},
      () => failed++,
      () => completed++
    );
    assert.equal(completed, 1);
    assert.equal(failed, 0);

    ollamaService.longOperationClient = {
      async post() {
        return {
          data: Readable.from([
            Buffer.from(
              `${JSON.stringify({
                model: 'test',
                message: { role: 'assistant', content: 'partial' },
                done: false,
              })}\n`
            ),
          ]),
        };
      },
    };
    let incompleteError;
    await ollamaService.generateChatStreamResponse(
      request,
      () => {},
      error => {
        incompleteError = error;
      },
      () => assert.fail('an incomplete stream must not complete')
    );
    assert.match(incompleteError.message, /ended before completion/);
  } finally {
    ollamaService.longOperationClient = originalClient;
  }
});
