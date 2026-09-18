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
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
} from '@deepseek-ai/dsh-llm';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const built = file =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'cordis', 'dsh', file))
      .href
  );
const plugin = await built('native-provider-plugin.js');
const protocol = await built('native-provider-protocol.js');
const { NativeDshProviderService } = await built('native-provider-client.js');
const providerId = 'deepseek-official';
const rawRequest = (model = 'deepseek-flash') => ({
  provider: providerId,
  model,
  messages: [
    createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'hello' }],
    }),
  ],
});

async function fixture(options = {}) {
  const directory = await realpath(await mkdtemp('/tmp/lw-native-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'provider.sock');
  const ctx = new Context();
  const calls = [];
  const usage = [];
  await ctx.plugin(LlmRuntime);
  class Adapter extends LlmAdapter {
    providerInfo(id) {
      return { id, name: 'Native DeepSeek' };
    }
    async listModels(provider) {
      return [
        { provider, id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
        { provider, id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ];
    }
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 32768 },
        defaultMaxTokens: 4096,
        reasoning: {
          efforts: [
            { id: 'none', name: 'Off' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      };
    }
    async *stream(call) {
      calls.push(call);
      const last = call.messages.at(-1);
      const input = last?.content.find(block => block.type === 'text')?.text;
      if (input === 'wait') {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'waiting' };
        await new Promise((resolve, reject) => {
          const abort = () => reject(call.signal.reason);
          call.signal.addEventListener('abort', abort, { once: true });
          if (call.signal.aborted) abort();
        });
        return;
      }
      const toolResult = last?.content.find(
        block => block.type === 'tool-result'
      );
      if (call.tools?.length && !toolResult && !call.purpose) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield {
          type: 'reasoning-delta',
          index: 0,
          text: 'Read the Work file.',
        };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'reasoning', text: 'Read the Work file.' },
        };
        yield { type: 'block-start', index: 1, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 1,
          id: 'work-call',
          name: 'read_file',
          argumentsDelta: '{"path":"notes.txt"}',
        };
        yield {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: 'work-call',
            name: 'read_file',
            arguments: '{"path":"notes.txt"}',
          },
        };
        yield {
          type: 'usage',
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            cacheReadTokens: 4,
            totalTokens: 9,
          },
        };
        yield {
          type: 'finish',
          reason: { kind: 'tool-calls' },
          replayState: { response: { opaque: 'native-signed-fixture' } },
        };
        return;
      }
      const text =
        call.purpose === 'session-title'
          ? 'Native model title'
          : toolResult
            ? `Used ${toolResult.content[0].text}`
            : `Answer from ${call.model}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter([providerId], new Adapter());
  ctx.llm.registerConfigurableProviders([
    {
      provider: providerId,
      displayName: 'Native DeepSeek',
      settingsNs: 'llm-deepseek',
      settingsPath: [],
    },
  ]);
  const fiber = ctx.plugin(plugin, {
    socketPath,
    requestTimeoutMs: 2000,
    ...options,
  });
  await fiber;
  const client = new NativeDshProviderService({
    authorize: async userId => userId === 'admin',
    socketPath: () => socketPath,
    assertUsageAllowed: async () => {},
    recordUsage: event => {
      usage.push(event);
    },
  });
  return {
    ctx,
    fiber,
    socketPath,
    directory,
    calls,
    usage,
    client,
    async close() {
      await ctx.fiber.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function request(socketPath, endpoint, body, headers = {}) {
  const bytes = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        method: 'POST',
        path: endpoint,
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bytes),
          ...headers,
        },
      },
      response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
          })
        );
        response.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(bytes);
  });
}

function chunks(response) {
  return response.text
    .trim()
    .split('\n')
    .map(line => protocol.parseNativeProviderChunk(JSON.parse(line)));
}

test('private native socket advertises configured models and only mounts the LLM service', async () => {
  const item = await fixture();
  try {
    assert.equal((await lstat(item.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(item.socketPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(item.socketPath)).uid, process.getuid());
    assert.equal(item.ctx.get('agents'), undefined);
    assert.equal(item.ctx.get('sessions'), undefined);
    assert.equal(item.ctx.get('tools'), undefined);
    const response = await request(item.socketPath, '/catalog', {});
    assert.equal(response.status, 200);
    const catalog = protocol.parseNativeProviderCatalog(
      JSON.parse(response.text)
    );
    assert.deepEqual(
      catalog.models.map(model => model.name),
      ['DeepSeek-V41-Flash', 'DeepSeek-V4-Pro']
    );
    assert.equal(catalog.models[0].providerId, providerId);
    assert.equal(catalog.models[0].contextWindow, 32768);
    assert.equal(catalog.models[0].reasoning.defaultEffort, 'high');
    assert.equal(
      response.headers[protocol.NATIVE_PROVIDER_INSTANCE_HEADER],
      catalog.instanceId
    );
    assert.equal(item.calls.length, 0);
    assert.equal((await item.client.catalog('admin')).status, 'ready');
  } finally {
    await item.close();
  }
});

test('the real client preserves Work tools, reasoning, correlation and provider replay over the socket', async () => {
  const item = await fixture();
  try {
    const messages = [
      { role: 'system', content: 'Work supplies the instructions.' },
      { role: 'user', content: 'Read notes.txt.' },
    ];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a Work file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      },
    ];
    const first = await item.client.generate(
      { model: 'deepseek-flash', messages, tools },
      providerId,
      'admin'
    );
    assert.equal(first.message.thinking, 'Read the Work file.');
    assert.equal(first.message.tool_calls[0].id, 'work-call');
    assert.equal(first.prompt_eval_count, 6);
    assert.equal(first.eval_count, 3);
    assert.equal(
      first.message.providerMetadata.nativeDsh.replayState.response.opaque,
      'native-signed-fixture'
    );
    assert.equal(
      typeof first.message.providerMetadata.nativeDsh.instanceId,
      'string'
    );
    const second = await item.client.generate(
      {
        model: 'deepseek-flash',
        messages: [
          ...messages,
          first.message,
          { role: 'tool', content: 'FILEVALUE', tool_call_id: 'work-call' },
        ],
        tools,
      },
      providerId,
      'admin'
    );
    assert.equal(second.message.content, 'Used FILEVALUE');
    const replay = item.calls[1].messages.find(
      message => message.role === 'assistant'
    );
    assert.equal(
      replay.source.replayState.response.opaque,
      'native-signed-fixture'
    );
    assert.equal(replay.content[0].type, 'reasoning');
    assert.equal(
      item.calls[1].messages.at(-1).content[0].toolCallId,
      'work-call'
    );
    assert.equal(item.calls[0].tools[0].name, 'read_file');
    assert.equal(
      item.ctx.get('tools'),
      undefined,
      'tool declarations are sent to the model without a native tool executor'
    );
    assert.equal(item.ctx.get('agents'), undefined);
    item.ctx.emit('llm/adapters-updated');
    const changed = await item.client.generate(
      {
        model: 'deepseek-flash',
        messages: [
          ...messages,
          first.message,
          {
            role: 'tool',
            content: 'AFTER-ROTATION',
            tool_call_id: 'work-call',
          },
        ],
        tools,
      },
      providerId,
      'admin'
    );
    assert.equal(changed.message.content, 'Used AFTER-ROTATION');
    const rotatedReplay = item.calls[2].messages.find(
      message => message.role === 'assistant'
    );
    assert.equal(
      rotatedReplay.source.replayState,
      undefined,
      'a new provider generation must not receive old signed state'
    );
    assert.equal(
      rotatedReplay.content.find(block => block.type === 'reasoning').text,
      'Read the Work file.'
    );
    assert.equal(
      rotatedReplay.content.find(block => block.type === 'tool-call').id,
      'work-call'
    );
  } finally {
    await item.close();
  }
});

test('native auxiliary text uses purpose without creating agent sessions or offering tools', async () => {
  const item = await fixture();
  try {
    assert.equal(
      await item.client.text({
        providerId,
        model: 'deepseek-v4-pro',
        userId: 'admin',
        prompt: 'Name this task.',
        purpose: 'session-title',
      }),
      'Native model title'
    );
    assert.equal(item.calls[0].purpose, 'session-title');
    assert.equal(item.calls[0].tools, undefined);
    assert.equal(item.calls[0].sessionId, undefined);
    assert.equal(item.ctx.get('sessions'), undefined);
  } finally {
    await item.close();
  }
});

test('native generations rotate and stale selected snapshots are refused before model work', async () => {
  const item = await fixture();
  try {
    const first = JSON.parse(
      (await request(item.socketPath, '/catalog', {})).text
    );
    const fingerprint = await item.client.routingFingerprint(
      providerId,
      'deepseek-flash',
      'admin'
    );
    item.ctx.emit('llm/adapters-updated');
    const second = JSON.parse(
      (await request(item.socketPath, '/catalog', {})).text
    );
    assert.notEqual(second.instanceId, first.instanceId);
    assert.notEqual(
      await item.client.routingFingerprint(
        providerId,
        'deepseek-flash',
        'admin'
      ),
      fingerprint
    );
    assert.equal(
      (
        await request(item.socketPath, '/generate', {
          ...rawRequest(),
          instanceId: first.instanceId,
        })
      ).status,
      409
    );
    assert.equal(item.calls.length, 0);
    assert.equal(
      (await request(item.socketPath, '/generate', rawRequest('missing-model')))
        .status,
      422
    );
    assert.equal(item.calls.length, 0);
    const before = second.instanceId;
    item.ctx.emit('credentials/reference-updated', 'fixture-key');
    assert.notEqual(
      JSON.parse((await request(item.socketPath, '/catalog', {})).text)
        .instanceId,
      before
    );
  } finally {
    await item.close();
  }
});

test('native generation validates only its selected provider and exact model metadata', async () => {
  const item = await fixture({ requestTimeoutMs: 100 });
  let unrelatedCatalogCalls = 0;
  const resolvedModels = [];
  const originalResolve = item.ctx.llm.resolveModelInfo.bind(item.ctx.llm);
  class UnrelatedAdapter extends LlmAdapter {
    providerInfo(id) {
      return { id, name: 'Unrelated unavailable provider' };
    }
    async listModels() {
      unrelatedCatalogCalls += 1;
      return new Promise(() => {});
    }
    async resolveModel() {
      assert.fail('unrelated metadata must not be resolved');
    }
    async *stream() {
      assert.fail('unrelated provider must not generate');
    }
  }
  item.ctx.llm.registerAdapter(['unrelated-provider'], new UnrelatedAdapter());
  item.ctx.llm.resolveModelInfo = (provider, model, signal) => {
    resolvedModels.push(model);
    if (model !== 'deepseek-flash') return new Promise(() => {});
    return originalResolve(provider, model, signal);
  };
  try {
    const response = await request(item.socketPath, '/generate', rawRequest());
    assert.equal(response.status, 200);
    assert.equal(chunks(response).at(-1).reason.kind, 'stop');
    assert.deepEqual(resolvedModels, ['deepseek-flash']);
    assert.equal(unrelatedCatalogCalls, 0);
    assert.equal(item.calls.length, 1);
    assert.equal(
      (await request(item.socketPath, '/generate', rawRequest('missing')))
        .status,
      422
    );
    assert.equal(
      item.calls.length,
      1,
      'unknown models must not reach generation'
    );
    assert.equal(unrelatedCatalogCalls, 0);
  } finally {
    item.ctx.llm.resolveModelInfo = originalResolve;
    await item.close();
  }
});

test('native metadata resolution receives cancellation when its request times out', async () => {
  const item = await fixture({ requestTimeoutMs: 30 });
  const originalResolve = item.ctx.llm.resolveModelInfo;
  let metadataSignal;
  let metadataAborted = false;
  item.ctx.llm.resolveModelInfo = (_provider, _model, signal) => {
    metadataSignal = signal;
    return new Promise((resolve, reject) => {
      const abort = () => {
        metadataAborted = true;
        reject(signal.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  };
  try {
    const response = await request(item.socketPath, '/generate', rawRequest());
    assert.equal(response.status, 504);
    assert.equal(metadataSignal?.aborted, true);
    assert.equal(metadataAborted, true);
    assert.equal(item.calls.length, 0);
  } finally {
    item.ctx.llm.resolveModelInfo = originalResolve;
    await item.close();
  }
});

test('native request schema rejects cross-service fields, file capabilities and oversized bodies', async () => {
  const item = await fixture();
  try {
    const valid = rawRequest();
    for (const extra of [
      { sessionId: 'other-session' },
      { agents: [] },
      { signal: {} },
      { purpose: 'execute-tools' },
    ]) {
      assert.equal(
        (await request(item.socketPath, '/generate', { ...valid, ...extra }))
          .status,
        400
      );
    }
    const file = structuredClone(valid);
    file.messages[0].content = [
      { type: 'file', attachment: { id: 'private-native-file' } },
    ];
    assert.equal(
      (await request(item.socketPath, '/generate', file)).status,
      400
    );
    assert.equal(
      (
        await request(item.socketPath, '/generate', valid, {
          'content-length': protocol.MAX_REQUEST_BYTES + 1,
        })
      ).status,
      413
    );
    assert.equal(
      (await request(item.socketPath, '/catalog', { keys: true })).status,
      400
    );
    assert.equal(item.calls.length, 0);
  } finally {
    await item.close();
  }
});

test('client cancellation aborts the native model and plugin disposal removes its socket', async () => {
  const item = await fixture();
  try {
    const controller = new AbortController();
    const stream = item.client.stream(
      {
        model: 'deepseek-flash',
        userId: 'admin',
        signal: controller.signal,
        messages: [{ role: 'user', content: 'wait' }],
      },
      providerId
    );
    assert.deepEqual((await stream.next()).value, {
      type: 'text',
      text: 'waiting',
    });
    controller.abort(new Error('Cancel native fixture'));
    await assert.rejects(stream.next(), /abort|cancel/i);
    for (
      let attempt = 0;
      !item.calls[0].signal.aborted && attempt < 100;
      attempt++
    )
      await delay(5);
    assert.equal(item.calls[0].signal.aborted, true);
    await item.fiber.dispose();
    await assert.rejects(lstat(item.socketPath), { code: 'ENOENT' });
  } finally {
    await item.close();
  }
});

test('native streams preserve failure/max-token/usage vocabulary and reject missing finish', async () => {
  const item = await fixture();
  const original = item.ctx.llm.stream;
  try {
    for (const reason of [
      { kind: 'max-tokens' },
      {
        kind: 'error',
        failure: {
          code: 'RATE_LIMIT',
          message: 'Try later',
          status: 429,
          providerRetryAfterMs: 2000,
        },
      },
    ]) {
      item.ctx.llm.stream = async function* () {
        yield {
          type: 'usage',
          usage: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            reasoningTokens: 1,
            totalTokens: 10,
          },
        };
        yield { type: 'finish', reason };
      };
      const received = chunks(
        await request(item.socketPath, '/generate', rawRequest())
      );
      assert.deepEqual(received.at(-1).reason, reason);
      assert.equal(received[0].usage.cacheWriteTokens, 4);
    }
    item.ctx.llm.stream = async function* () {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'unfinished' };
    };
    const received = chunks(
      await request(item.socketPath, '/generate', rawRequest())
    );
    assert.equal(received.at(-1).reason.kind, 'error');
    assert.equal(
      received.at(-1).reason.failure.code,
      'NATIVE_PROVIDER_STREAM_FAILED'
    );
  } finally {
    item.ctx.llm.stream = original;
    await item.close();
  }
});

test('unsafe socket directories and occupied paths are refused without replacing files', async () => {
  const directory = await realpath(await mkdtemp('/tmp/lw-native-bad-'));
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  try {
    await chmod(directory, 0o755);
    await assert.rejects(
      plugin.apply(ctx, { socketPath: path.join(directory, 'provider.sock') }),
      /0700/
    );
    await chmod(directory, 0o700);
    const existing = path.join(directory, 'existing.sock');
    await writeFile(existing, 'keep this file');
    await assert.rejects(
      plugin.apply(ctx, { socketPath: existing }),
      /already exists/
    );
    assert.equal(await readFile(existing, 'utf8'), 'keep this file');
    const linked = path.join(directory, 'linked');
    await symlink(directory, linked);
    await assert.rejects(
      plugin.apply(ctx, { socketPath: path.join(linked, 'provider.sock') }),
      /symbolic links/
    );
  } finally {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a provider generation change aborts an active inference instead of mixing configurations', async () => {
  const item = await fixture();
  try {
    const stream = item.client.stream(
      {
        model: 'deepseek-flash',
        userId: 'admin',
        messages: [{ role: 'user', content: 'wait' }],
      },
      providerId
    );
    assert.equal((await stream.next()).value.type, 'text');
    item.ctx.emit('llm/adapters-updated');
    await assert.rejects(stream.next(), /NATIVE_PROVIDER_CHANGED/);
    assert.equal(item.calls[0].signal.aborted, true);
  } finally {
    await item.close();
  }
});

test('native request timeout terminates a stalled provider and permits plugin cleanup', async () => {
  const item = await fixture({ requestTimeoutMs: 30 });
  const original = item.ctx.llm.stream;
  let signal;
  item.ctx.llm.stream = async function* (call) {
    signal = call.signal;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'stalled' };
    await new Promise(() => {});
  };
  try {
    const response = await request(item.socketPath, '/generate', rawRequest());
    assert.equal(response.status, 200);
    assert.equal(chunks(response).at(-1).reason.kind, 'error');
    assert.equal(signal.aborted, true);
    await item.fiber.dispose();
    await assert.rejects(lstat(item.socketPath), { code: 'ENOENT' });
  } finally {
    item.ctx.llm.stream = original;
    await item.close();
  }
});

test('native UI and raw settings metadata leave active inference intact while provider changes abort it', async () => {
  const item = await fixture();
  try {
    const fingerprint = await item.client.routingFingerprint(
      providerId,
      'deepseek-flash',
      'admin'
    );
    const stream = item.client.stream(
      {
        model: 'deepseek-flash',
        userId: 'admin',
        messages: [{ role: 'user', content: 'wait' }],
      },
      providerId
    );
    assert.equal((await stream.next()).value.type, 'text');
    item.ctx.emit(
      'settings/updated',
      'ui-theme',
      { preference: 'dark' },
      { preference: 'light' },
      'update'
    );
    item.ctx.emit('settings/document-updated', 'ui-theme', 1);
    item.ctx.emit('settings/document-updated', 'llm-deepseek', 2);
    assert.equal(item.calls[0].signal.aborted, false);
    assert.equal(
      await item.client.routingFingerprint(
        providerId,
        'deepseek-flash',
        'admin'
      ),
      fingerprint
    );
    item.ctx.emit(
      'settings/updated',
      'llm-deepseek',
      { baseURL: 'changed' },
      { baseURL: 'previous' },
      'update'
    );
    await assert.rejects(stream.next(), /NATIVE_PROVIDER_CHANGED/);
    assert.equal(item.calls[0].signal.aborted, true);
    assert.notEqual(
      await item.client.routingFingerprint(
        providerId,
        'deepseek-flash',
        'admin'
      ),
      fingerprint
    );
  } finally {
    await item.close();
  }
});

test('one native usage event is recorded per Work, Chat stream and auxiliary text inference', async () => {
  const item = await fixture();
  try {
    await item.client.catalog('admin');
    await item.client.assertModel(providerId, 'deepseek-flash', 'admin');
    await item.client.routingFingerprint(providerId, 'deepseek-flash', 'admin');
    assert.deepEqual(item.usage, []);
    const started = Date.now();
    await item.client.generate(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'Read this Work file.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read Work file',
              parameters: { type: 'object' },
            },
          },
        ],
      },
      providerId,
      'admin'
    );
    assert.equal(
      item.usage.length,
      1,
      'generate and its inner stream share one record'
    );
    assert.deepEqual(item.usage[0].usage, {
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      totalTokens: 9,
    });
    for await (const _event of item.client.stream(
      {
        model: 'deepseek-flash',
        userId: 'admin',
        messages: [{ role: 'user', content: 'Chat directly.' }],
      },
      providerId
    )) {
      /* drain */
    }
    assert.equal(item.usage.length, 2);
    await item.client.text({
      providerId,
      model: 'deepseek-v4-pro',
      userId: 'admin',
      prompt: 'Name this task.',
      purpose: 'session-title',
    });
    assert.equal(
      item.usage.length,
      3,
      'auxiliary catalog checks are not provider calls'
    );
    assert.equal(item.calls.length, 3);
    assert.deepEqual(
      item.usage.map(event => event.model),
      ['deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro']
    );
    for (const event of item.usage) {
      assert.equal(event.userId, 'admin');
      assert.equal(event.providerId, providerId);
      assert.equal(event.providerName, 'Native DeepSeek');
      assert.equal(event.status, 'success');
      assert.ok(event.createdAt >= started && event.createdAt <= Date.now());
      assert.ok(Number.isFinite(event.durationMs) && event.durationMs >= 0);
    }
    assert.equal(
      item.usage[1].usage,
      undefined,
      'missing usage remains unmetered rather than guessed'
    );
    await assert.rejects(
      item.client.generate(
        { model: 'missing', messages: [] },
        providerId,
        'admin'
      ),
      /unavailable/
    );
    await assert.rejects(
      item.client.generate(
        { model: 'deepseek-flash', messages: [] },
        providerId,
        'member'
      ),
      /administrator/
    );
    await assert.rejects(
      item.client.generate(
        { model: 'deepseek-flash', messages: [] },
        providerId,
        'admin',
        {},
        AbortSignal.abort(new Error('Stopped before inference'))
      ),
      /Stopped before inference/
    );
    assert.equal(
      item.usage.length,
      3,
      'authorization, catalog and pre-dispatch cancellation do not count as inference'
    );
  } finally {
    await item.close();
  }
});

test('native terminal error and cancellation retain any reported disjoint cache usage exactly once', async () => {
  const item = await fixture();
  const original = item.ctx.llm.stream;
  const usage = {
    inputTokens: 5,
    outputTokens: 7,
    cacheReadTokens: 11,
    cacheWriteTokens: 13,
    totalTokens: 36,
  };
  try {
    for (const kind of ['error', 'aborted']) {
      item.ctx.llm.stream = async function* () {
        yield { type: 'usage', usage };
        yield {
          type: 'finish',
          reason: {
            kind,
            failure: {
              code: 'FIXTURE_FAILURE',
              message: 'Do not expose diagnostics',
            },
          },
        };
      };
      await assert.rejects(
        item.client.generate(
          { model: 'deepseek-flash', messages: [] },
          providerId,
          'admin'
        ),
        /FIXTURE_FAILURE/
      );
    }
    assert.equal(item.usage.length, 2);
    assert.deepEqual(
      item.usage.map(event => event.status),
      ['error', 'cancelled']
    );
    assert.ok(
      item.usage.every(
        event => JSON.stringify(event.usage) === JSON.stringify(usage)
      )
    );
  } finally {
    item.ctx.llm.stream = original;
    await item.close();
  }
});

test('caller abort and early iterator return each record one cancelled native call with seen usage', async () => {
  const item = await fixture();
  const original = item.ctx.llm.stream;
  const usage = {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 5,
    totalTokens: 10,
  };
  item.ctx.llm.stream = async function* (call) {
    yield { type: 'usage', usage };
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: 'waiting' };
    await new Promise((resolve, reject) => {
      const abort = () => reject(call.signal.reason);
      call.signal.addEventListener('abort', abort, { once: true });
      if (call.signal.aborted) abort();
    });
  };
  try {
    for (const stop of ['abort', 'return']) {
      const controller = new AbortController();
      const stream = item.client.stream(
        {
          model: 'deepseek-flash',
          userId: 'admin',
          signal: controller.signal,
          messages: [{ role: 'user', content: 'Wait.' }],
        },
        providerId
      );
      assert.equal((await stream.next()).value.text, 'waiting');
      if (stop === 'abort') {
        controller.abort(new Error('Stop native accounting fixture'));
        await assert.rejects(stream.next(), /abort|Stop native/i);
      } else await stream.return();
    }
    assert.equal(item.usage.length, 2);
    assert.ok(item.usage.every(event => event.status === 'cancelled'));
    assert.ok(
      item.usage.every(
        event => JSON.stringify(event.usage) === JSON.stringify(usage)
      )
    );
  } finally {
    item.ctx.llm.stream = original;
    await item.close();
  }
});

test('a usage recorder failure does not fail a completed native model call or retry its record', async () => {
  const item = await fixture();
  let attempts = 0;
  const client = new NativeDshProviderService({
    authorize: async userId => userId === 'admin',
    socketPath: () => item.socketPath,
    assertUsageAllowed: async () => {},
    recordUsage: async () => {
      attempts++;
      throw new Error('Fixture ledger unavailable');
    },
  });
  try {
    const response = await client.generate(
      {
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'Hello' }],
      },
      providerId,
      'admin'
    );
    assert.equal(response.message.content, 'Answer from deepseek-flash');
    assert.equal(attempts, 1);
    assert.equal(item.calls.length, 1);
  } finally {
    await item.close();
  }
});

test('native hard-budget denial happens before inference dispatch and creates no usage event', async () => {
  const item = await fixture();
  const admissions = [];
  const usage = [];
  const client = new NativeDshProviderService({
    authorize: async userId => userId === 'admin',
    socketPath: () => item.socketPath,
    assertUsageAllowed: async input => {
      admissions.push(input);
      throw new Error('Fixture hard budget exceeded');
    },
    recordUsage: event => {
      usage.push(event);
    },
  });
  try {
    await assert.rejects(
      client.generate(
        {
          model: 'deepseek-flash',
          messages: [{ role: 'user', content: 'Do not dispatch.' }],
        },
        providerId,
        'admin'
      ),
      /hard budget exceeded/
    );
    assert.deepEqual(admissions, [
      { userId: 'admin', providerId, model: 'deepseek-flash' },
    ]);
    assert.deepEqual(usage, []);
    assert.deepEqual(item.calls, []);
  } finally {
    await item.close();
  }
});
