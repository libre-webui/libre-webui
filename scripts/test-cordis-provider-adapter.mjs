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

/**
 * The Libre WebUI provider adapter's chunk grammar.
 *
 * DSH validates an adapter's stream against a strict grammar: a `block-start`
 * before any delta at that index, a matching `block-end` before the finish, at
 * most one `usage`, and a terminal `finish` that is last. A mistake there does
 * not surface as a wrong answer — it fails the turn — so the ordering is tested
 * directly against a provider that produces known increments, including the
 * awkward shapes (a tool call with no text, text with no tool call, empty
 * deltas, and usage).
 *
 * The engine's own validator is what runs here, so this is the real contract
 * rather than a restatement of it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const backendDir = path.join(repoRoot, 'backend');
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-adapter-'));
process.env.DATA_DIR = tempRoot;
process.env.PLUGINS_DIR = path.join(tempRoot, 'plugins');
process.env.ENCRYPTION_KEY = '7'.repeat(64);
process.env.JWT_SECRET = 'cordis-provider-adapter-test-secret';
delete process.env.LIBRE_CORDIS_USER;
delete process.env.DEFAULT_MODEL;
await mkdir(process.env.PLUGINS_DIR);

const requests = [];
let pendingResponseClosed;
let localCatalogUnavailable = false;
let localGenerationUnavailable = false;
let includePseudoModels = false;
let omitLocalToolCallIds = false;
const providerServer = createServer(async (request, response) => {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  requests.push({ url: request.url, body });
  if (request.url === '/api/tags') {
    if (localCatalogUnavailable) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Local catalog unavailable' }));
      return;
    }
    response.end(
      JSON.stringify({
        models: [
          ...(includePseudoModels
            ? [
                { name: 'persona:fixture-persona' },
                { name: 'codex:gpt-test' },
                { name: 'agent:pi' },
              ]
            : []),
          { name: 'local-tool-model' },
        ],
      })
    );
    return;
  }
  if (request.url === '/api/show') {
    response.end(
      JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'] })
    );
    return;
  }
  if (request.url?.endsWith('/v1/models')) {
    response.end(
      JSON.stringify({
        data: [
          ...(includePseudoModels
            ? [
                { id: 'persona:fixture-persona' },
                { id: 'dsh' },
                { id: 'agent:codex' },
              ]
            : []),
          { id: 'remote-tool-model' },
          { id: 'local-tool-model' },
        ],
      })
    );
    return;
  }
  const local = request.url === '/api/chat';
  if (local && localGenerationUnavailable) {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: 'Local generation unavailable' }));
    return;
  }
  response.writeHead(200, {
    'Content-Type': local ? 'application/x-ndjson' : 'text/event-stream',
  });
  const write = value =>
    response.write(
      local
        ? `${JSON.stringify(value)}\n`
        : `data: ${JSON.stringify(value)}\n\n`
    );
  const result =
    body.messages?.at(-1)?.role === 'tool' ? body.messages.at(-1) : undefined;
  if (
    body.messages?.some(message => message.content === 'wait for cancellation')
  ) {
    response.once('close', () => pendingResponseClosed?.());
    write(
      local
        ? { message: { role: 'assistant', content: 'waiting' }, done: false }
        : { choices: [{ delta: { content: 'waiting' } }] }
    );
    return;
  }
  if (body.messages?.some(message => message.content === 'truncate')) {
    write(
      local
        ? {
            message: { role: 'assistant', content: 'partial' },
            done: true,
            done_reason: 'length',
          }
        : {
            choices: [
              { delta: { content: 'partial' }, finish_reason: 'length' },
            ],
          }
    );
  } else if (result) {
    write(
      local
        ? {
            message: { role: 'assistant', content: `Read: ${result.content}` },
            done: true,
            done_reason: 'stop',
          }
        : {
            choices: [
              {
                delta: { content: `Read: ${result.content}` },
                finish_reason: 'stop',
              },
            ],
          }
    );
  } else {
    const toolCall = {
      ...(local && omitLocalToolCallIds ? {} : { id: 'read-1' }),
      type: 'function',
      function: {
        name: 'read_file',
        arguments: local ? { path: 'notes.txt' } : '{"path":"notes.txt"}',
      },
    };
    write(
      local
        ? {
            message: {
              role: 'assistant',
              thinking: 'Read the file first.',
              content: '',
              tool_calls: [toolCall],
            },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 8,
            eval_count: 3,
          }
        : {
            choices: [
              {
                delta: {
                  reasoning_content: 'Read the file first.',
                  tool_calls: [{ index: 0, ...toolCall }],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }
    );
  }
  response.end(local ? '' : 'data: [DONE]\n\n');
});
await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
const providerUrl = `http://127.0.0.1:${providerServer.address().port}`;
process.env.OLLAMA_BASE_URL = providerUrl;
await writeFile(
  path.join(process.env.PLUGINS_DIR, 'deepseek.json'),
  JSON.stringify({
    id: 'deepseek',
    name: 'DeepSeek fixture',
    type: 'completion',
    endpoint: `${providerUrl}/v1/chat/completions`,
    auth: { header: '', prefix: '', key_env: '' },
    model_map: ['remote-tool-model', 'local-tool-model'],
  })
);

const importBuilt = relative =>
  import(pathToFileURL(path.join(backendDir, 'dist', relative)).href);
const { encryptionService } = await importBuilt(
  'services/encryptionService.js'
);
const persistence = await importBuilt('persistence/index.js');
await persistence.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const { userModel } = await importBuilt('models/userModel.js');
const fixtureUser = await userModel.createPublicUser({
  username: 'cordis_provider',
  email: 'cordis-provider@example.test',
  password: 'Cordis-Provider-Test-1!',
  role: 'admin',
  accountStatus: 'active',
});
const { default: pluginService } = await importBuilt(
  'services/pluginService.js'
);
await pluginService.installPlugin(
  JSON.parse(
    await readFile(path.join(process.env.PLUGINS_DIR, 'deepseek.json'), 'utf8')
  ),
  fixtureUser.id
);
await pluginService.activatePlugin('deepseek', fixtureUser.id);

const { Context } = await import('@deepseek-ai/cordis');
const { default: LlmRuntime } = await import('@deepseek-ai/dsh-llm');

const adapterModule = await import(
  pathToFileURL(
    path.join(backendDir, 'dist', 'cordis', 'dsh', 'librewebui-llm-adapter.js')
  ).href
);
const { ROUTE, registerLibreWebUiProvider, apply } = adapterModule;

test.after(async () => {
  registerLibreWebUiProvider(undefined);
  providerServer.closeAllConnections();
  await new Promise(resolve => providerServer.close(resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

/** Mount the real LLM runtime with the adapter registered on its route. */
async function startRuntime() {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  apply(ctx);
  return ctx;
}

/** Install a provider that replays a fixed sequence of increments. */
function providerOf(events, models = []) {
  const calls = [];
  registerLibreWebUiProvider({
    listModels: async () => models,
    resolveModel: async () => models.find(() => true),
    defaultModel: async () => undefined,
    stream: async function* (call) {
      calls.push(call);
      for (const event of events) yield event;
    },
  });
  return calls;
}

/** Collect the engine's own view of one call. */
async function collect(ctx, options) {
  const chunks = [];
  for await (const chunk of ctx.llm.stream({
    provider: ROUTE,
    model: 'test-model',
    messages: [],
    ...options,
  })) {
    chunks.push(chunk);
  }
  return chunks;
}

test('a text-only call emits the grammar the engine requires', async () => {
  providerOf([
    { type: 'text', text: 'Hel' },
    { type: 'text', text: 'lo' },
    { type: 'usage', inputTokens: 7, outputTokens: 2 },
    { type: 'done', reason: 'stop' },
  ]);
  const ctx = await startRuntime();
  try {
    const chunks = await collect(ctx, {});
    assert.deepEqual(
      chunks.map(chunk => chunk.type),
      [
        'block-start',
        'text-delta',
        'text-delta',
        'block-end',
        'usage',
        'finish',
      ]
    );
    assert.equal(chunks[0].blockType, 'text');
    assert.equal(chunks[0].index, 0, 'indexes are assigned in emission order');
    assert.deepEqual(chunks[1].text, 'Hel');
    assert.deepEqual(chunks[3].block, { type: 'text', text: 'Hello' });
    assert.deepEqual(chunks.at(-1)?.reason, { kind: 'stop' });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a tool-call-only call opens no text block and finishes as tool-calls', async () => {
  providerOf([
    {
      type: 'tool-call',
      toolCall: { id: 'call_1', name: 'read', arguments: '{"path":"/tmp"}' },
    },
    { type: 'done', reason: 'tool-calls' },
  ]);
  const ctx = await startRuntime();
  try {
    const chunks = await collect(ctx, {});
    assert.deepEqual(
      chunks.map(chunk => chunk.type),
      ['block-start', 'tool-call-delta', 'block-end', 'finish']
    );
    assert.equal(chunks[0].blockType, 'tool-call');
    // DSH carries the raw JSON string, never a parsed object.
    const block = chunks[2].block;
    assert.equal(block.arguments, '{"path":"/tmp"}');
    assert.equal(block.name, 'read');
    assert.deepEqual(chunks.at(-1)?.reason, { kind: 'tool-calls' });
  } finally {
    await ctx.fiber.dispose();
  }
});

test('empty deltas never open a block', async () => {
  providerOf([
    { type: 'text', text: '' },
    { type: 'text', text: 'ok' },
    { type: 'done', reason: 'stop' },
  ]);
  const ctx = await startRuntime();
  try {
    const chunks = await collect(ctx, {});
    // A block opened for an empty delta would be rejected as an empty response.
    assert.deepEqual(
      chunks.map(chunk => chunk.type),
      ['block-start', 'text-delta', 'block-end', 'finish']
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('text and a tool call interleave on separate indexes', async () => {
  providerOf([
    { type: 'text', text: 'thinking out loud' },
    {
      type: 'tool-call',
      toolCall: { id: 'call_9', name: 'write', arguments: '{}' },
    },
    { type: 'done', reason: 'tool-calls' },
  ]);
  const ctx = await startRuntime();
  try {
    const chunks = await collect(ctx, {});
    const starts = chunks.filter(chunk => chunk.type === 'block-start');
    assert.equal(starts.length, 2, 'one block per content kind');
    assert.notEqual(starts[0].index, starts[1].index, 'indexes are unique');
    // Both blocks close before the finish, which the grammar requires.
    const endIndex = chunks.findIndex(chunk => chunk.type === 'finish');
    const closers = chunks
      .slice(0, endIndex)
      .filter(chunk => chunk.type === 'block-end');
    assert.equal(closers.length, 2);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the call carries flattened messages and the offered tools', async () => {
  const calls = providerOf([{ type: 'done', reason: 'stop' }]);
  const ctx = await startRuntime();
  try {
    await collect(ctx, {
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: [
            { type: 'text', text: 'read ' },
            { type: 'text', text: 'the file' },
          ],
          source: { kind: 'user' },
        },
      ],
      tools: [
        {
          name: 'read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].role, 'user');
    assert.equal(call.messages[0].content, 'read the file');
    assert.deepEqual(
      call.tools.map(tool => tool.name),
      ['read']
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('the handler hands the provider layer wire-ready tool declarations', async () => {
  // The engine normalises tool declarations before the adapter sees them, so
  // the shape this handler produces is only observable at its own boundary.
  // Getting it wrong sent `tools[0].function.name` as undefined and the
  // provider rejected the whole request.
  const { toGenerationOptions } = await import(
    pathToFileURL(
      path.join(backendDir, 'dist', 'cordis', 'dsh', 'provider-handler.js')
    ).href
  );
  const options = toGenerationOptions({
    model: 'test-model',
    messages: [],
    tools: [
      {
        name: 'read',
        description: 'Read a file.',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
  });

  // Libre WebUI's provider layer takes declarations flat and wraps them per
  // protocol itself, so a pre-wrapped entry loses the name.
  assert.deepEqual(options.tools, [
    {
      name: 'read',
      description: 'Read a file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]);

  // The assertion that matches the failure: the payload a provider validates.
  const { toOpenAICompatibleTools } = await import(
    pathToFileURL(
      path.join(backendDir, 'dist', 'utils', 'pluginChatAdapter.js')
    ).href
  );
  const wire = toOpenAICompatibleTools(options.tools);
  assert.equal(wire[0].function.name, 'read');
  assert.equal(typeof wire[0].function.parameters, 'object');
});

test('the adapter advertises the models the provider reports', async () => {
  providerOf(
    [],
    [{ id: 'llama3.1', name: 'Llama 3.1', contextWindow: 131072 }]
  );
  const ctx = await startRuntime();
  try {
    const models = await ctx.llm.listModels(ROUTE);
    assert.deepEqual(
      models.map(model => model.id),
      ['llama3.1']
    );
    // The runtime exposes the route's provider info; model metadata travels
    // through the adapter, which the request path exercises.
    assert.deepEqual(
      ctx.llm.listProviders().map(provider => provider.id),
      [ROUTE]
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

const offeredTools = [
  {
    name: 'read_file',
    description: 'Read a workspace file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

async function installRealHandler() {
  const { libreWebUiProviderHandler } = await importBuilt(
    'cordis/dsh/provider-handler.js'
  );
  registerLibreWebUiProvider({
    ...libreWebUiProviderHandler,
    stream: call =>
      libreWebUiProviderHandler.stream({ ...call, userId: fixtureUser.id }),
  });
  return libreWebUiProviderHandler;
}

for (const model of ['local-tool-model', 'remote-tool-model']) {
  test(`${model} completes a real provider HTTP tool round trip`, async () => {
    await installRealHandler();
    const { BlockAssembler, createUserMessage, createToolResultMessage } =
      await import('@deepseek-ai/dsh-llm');
    const ctx = await startRuntime();
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Read notes.txt' }],
      source: { kind: 'user' },
    });
    try {
      const first = await collect(ctx, {
        model,
        messages: [user],
        tools: offeredTools,
      });
      const assembled = new BlockAssembler();
      for (const chunk of first) assembled.push(chunk);
      assert.equal(assembled.finish.kind, 'tool-calls');
      const toolCall = assembled
        .blocks()
        .find(block => block.type === 'tool-call');
      assert.deepEqual(JSON.parse(toolCall.arguments), { path: 'notes.txt' });
      assert.equal(
        toolCall.id,
        'read-1',
        'a provider-supplied call ID is preserved'
      );
      const assistant = assembled.message({
        kind: 'model',
        provider: ROUTE,
        model,
        replayState: assembled.replayState,
      });
      const result = createToolResultMessage({
        callId: toolCall.id,
        content: [{ type: 'text', text: 'The actual file contents.' }],
        isError: false,
      });
      const second = await collect(ctx, {
        model,
        messages: [user, assistant, result],
        tools: offeredTools,
      });
      assert.equal(
        second
          .filter(chunk => chunk.type === 'text-delta')
          .map(chunk => chunk.text)
          .join(''),
        'Read: The actual file contents.'
      );
      const wire = requests
        .filter(
          request => request.body.model === model && request.body.messages
        )
        .at(-1).body;
      assert.deepEqual(
        wire.messages.map(message => message.role),
        ['user', 'assistant', 'tool']
      );
      assert.equal(wire.messages[2].tool_call_id, toolCall.id);
      assert.equal(wire.messages[2].content, 'The actual file contents.');
      assert.equal(wire.tools[0].function.name, 'read_file');
      assert.equal(wire.options?.tools, undefined);
      if (model.startsWith('local')) {
        assert.deepEqual(wire.messages[1].tool_calls[0].function.arguments, {
          path: 'notes.txt',
        });
        assert.equal(wire.messages[1].thinking, 'Read the file first.');
      } else {
        assert.equal(
          wire.messages[1].reasoning_content,
          'Read the file first.'
        );
      }
    } finally {
      await ctx.fiber.dispose();
    }
  });

  test(`${model} preserves max-token termination`, async () => {
    await installRealHandler();
    const ctx = await startRuntime();
    try {
      const chunks = await collect(ctx, {
        model,
        messages: [
          {
            id: 'truncate',
            role: 'user',
            content: [{ type: 'text', text: 'truncate' }],
            source: { kind: 'user' },
          },
        ],
      });
      assert.equal(chunks.at(-1).reason.kind, 'max-tokens');
    } finally {
      await ctx.fiber.dispose();
    }
  });

  test(`${model} abort closes the provider HTTP request`, async () => {
    const handler = await installRealHandler();
    const controller = new AbortController();
    const closed = new Promise(resolve => {
      pendingResponseClosed = resolve;
    });
    const stream = handler.stream({
      model,
      userId: fixtureUser.id,
      signal: controller.signal,
      messages: [{ role: 'user', content: 'wait for cancellation' }],
    });
    assert.equal((await stream.next()).value.type, 'text');
    controller.abort(new Error('Stopped by test'));
    await assert.rejects(stream.next(), /Stopped by test|abort/i);
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Provider connection was not cancelled')),
          1500
        ).unref()
      ),
    ]);
    pendingResponseClosed = undefined;
  });

  test(`${model} returning the iterator closes the provider request`, async () => {
    const handler = await installRealHandler();
    const closed = new Promise(resolve => {
      pendingResponseClosed = resolve;
    });
    const stream = handler.stream({
      model,
      userId: fixtureUser.id,
      messages: [{ role: 'user', content: 'wait for cancellation' }],
    });
    assert.equal((await stream.next()).value.type, 'text');
    await stream.return();
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Provider iterator leaked its connection')),
          1500
        ).unref()
      ),
    ]);
    pendingResponseClosed = undefined;
  });
}

test('provider metadata survives DSH replay and multiple tool results stay distinct', async () => {
  const metadata = {
    anthropicThinkingBlocks: [
      { type: 'thinking', thinking: 'Reasoning', signature: 'signed-fixture' },
    ],
  };
  const calls = providerOf([
    { type: 'reasoning', text: 'Reasoning' },
    {
      type: 'tool-call',
      toolCall: {
        id: 'one',
        name: 'read_file',
        arguments: '{}',
        providerMetadata: metadata,
      },
    },
    { type: 'done', reason: 'tool-calls' },
  ]);
  const ctx = await startRuntime();
  try {
    const first = await collect(ctx, {});
    const { BlockAssembler } = await import('@deepseek-ai/dsh-llm');
    const assembler = new BlockAssembler();
    first.forEach(chunk => assembler.push(chunk));
    const assistant = assembler.message({
      kind: 'model',
      provider: ROUTE,
      model: 'test-model',
      replayState: assembler.replayState,
    });
    await collect(ctx, {
      messages: [
        assistant,
        {
          id: 'results',
          role: 'user',
          source: { kind: 'user' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'one',
              content: [{ type: 'text', text: 'first result' }],
            },
            {
              type: 'tool-result',
              toolCallId: 'two',
              content: [{ type: 'text', text: 'second result' }],
            },
          ],
        },
      ],
    });
    assert.deepEqual(calls[1].messages[0].providerMetadata, metadata);
    assert.equal(calls[1].messages[0].thinking, 'Reasoning');
    assert.deepEqual(calls[1].messages.slice(1), [
      { role: 'tool', toolCallId: 'one', content: 'first result' },
      { role: 'tool', toolCallId: 'two', content: 'second result' },
    ]);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('reopened text and reasoning blocks do not duplicate earlier content', async () => {
  providerOf([
    { type: 'reasoning', text: 'first thought' },
    { type: 'text', text: 'first answer' },
    { type: 'reasoning', text: 'second thought' },
    { type: 'text', text: 'second answer' },
    { type: 'done', reason: 'stop' },
  ]);
  const ctx = await startRuntime();
  try {
    const chunks = await collect(ctx, {});
    assert.deepEqual(
      chunks
        .filter(chunk => chunk.type === 'block-end')
        .map(chunk => chunk.block.text),
      ['first thought', 'first answer', 'second thought', 'second answer']
    );
  } finally {
    await ctx.fiber.dispose();
  }
});

test('model discovery includes only the requesting account activated providers', async () => {
  const handler = await installRealHandler();
  assert.deepEqual(
    (await handler.listModels(fixtureUser.id)).map(model => model.id),
    [
      'lwui:ollama:local-tool-model',
      'lwui:plugin:deepseek:remote-tool-model',
      'lwui:plugin:deepseek:local-tool-model',
    ]
  );
  assert.deepEqual(
    (await handler.listModels()).map(model => model.id),
    ['lwui:ollama:local-tool-model']
  );
  const { default: preferencesService } = await importBuilt(
    'services/preferencesService.js'
  );
  await preferencesService.setDefaultModel('dsh', fixtureUser.id, {
    providerType: 'agent',
    providerId: 'dsh',
  });
  assert.equal(
    await handler.defaultModel(fixtureUser.id),
    'lwui:ollama:local-tool-model'
  );
  await preferencesService.setDefaultModel(
    'remote-tool-model',
    fixtureUser.id,
    { providerType: 'plugin', providerId: 'deepseek' }
  );
  assert.equal(
    await handler.defaultModel(fixtureUser.id),
    'lwui:plugin:deepseek:remote-tool-model'
  );
  const normalUser = await userModel.createPublicUser({
    username: 'cordis_unprivileged',
    email: 'cordis-user@example.test',
    password: 'Cordis-Provider-Test-1!',
    role: 'user',
    accountStatus: 'active',
  });
  await assert.rejects(
    handler
      .stream({
        model: 'remote-tool-model',
        userId: normalUser.id,
        messages: [],
      })
      .next(),
    /active administrator/
  );
});

test('a default-agent local fallback stays local despite an activated colliding provider', async () => {
  const handler = await installRealHandler();
  const { default: preferencesService } = await importBuilt(
    'services/preferencesService.js'
  );
  await preferencesService.setDefaultModel('dsh', fixtureUser.id, {
    providerType: 'agent',
    providerId: 'dsh',
  });
  const model = await handler.defaultModel(fixtureUser.id);
  assert.equal(model, 'lwui:ollama:local-tool-model');
  const count = url => requests.filter(request => request.url === url).length;
  const remoteBefore = count('/v1/chat/completions');
  const localBefore = count('/api/chat');
  for await (const _chunk of handler.stream({
    model,
    userId: fixtureUser.id,
    messages: [{ role: 'user', content: 'Keep this prompt local.' }],
  })) {
    /* drain */
  }
  assert.equal(count('/api/chat'), localBefore + 1);
  assert.equal(count('/v1/chat/completions'), remoteBefore);

  await preferencesService.setDefaultModel('local-tool-model', fixtureUser.id, {
    providerType: 'plugin',
    providerId: 'deepseek',
  });
  const selectedPlugin = await handler.defaultModel(fixtureUser.id);
  assert.equal(selectedPlugin, 'lwui:plugin:deepseek:local-tool-model');
  for await (const _chunk of handler.stream({
    model: selectedPlugin,
    userId: fixtureUser.id,
    messages: [
      { role: 'user', content: 'Use the explicitly selected provider.' },
    ],
  })) {
    /* drain */
  }
  assert.equal(count('/api/chat'), localBefore + 1);
  assert.equal(count('/v1/chat/completions'), remoteBefore + 1);

  await pluginService.deactivatePlugin('deepseek', fixtureUser.id);
  try {
    await assert.rejects(
      handler.defaultModel(fixtureUser.id),
      /not active|unavailable/
    );
    await assert.rejects(
      handler
        .stream({ model: selectedPlugin, userId: fixtureUser.id, messages: [] })
        .next(),
      /not active|unavailable/
    );
    assert.equal(
      count('/api/chat'),
      localBefore + 1,
      'an unavailable explicit plugin must not fall back to Ollama'
    );
    assert.equal(count('/v1/chat/completions'), remoteBefore + 1);
  } finally {
    await pluginService.activatePlugin('deepseek', fixtureUser.id);
  }
});

test('qualified local selection cannot turn remote after catalog or generation outages', async () => {
  const handler = await installRealHandler();
  const { default: preferencesService } = await importBuilt(
    'services/preferencesService.js'
  );
  await preferencesService.setDefaultModel('dsh', fixtureUser.id, {
    providerType: 'agent',
    providerId: 'dsh',
  });
  const selected = JSON.parse(
    JSON.stringify(await handler.defaultModel(fixtureUser.id))
  );
  assert.equal(selected, 'lwui:ollama:local-tool-model');
  const count = url => requests.filter(request => request.url === url).length;
  const remoteBefore = count('/v1/chat/completions');
  localCatalogUnavailable = true;
  try {
    for await (const _chunk of handler.stream({
      model: selected,
      userId: fixtureUser.id,
      messages: [{ role: 'user', content: 'Continue locally.' }],
    })) {
      /* drain */
    }
    assert.equal(count('/v1/chat/completions'), remoteBefore);
    localGenerationUnavailable = true;
    await assert.rejects(
      handler
        .stream({ model: selected, userId: fixtureUser.id, messages: [] })
        .next(),
      /503|unavailable/
    );
    assert.equal(count('/v1/chat/completions'), remoteBefore);
    // A legacy unqualified name cannot be guessed during a catalog outage.
    await assert.rejects(
      handler
        .stream({
          model: 'local-tool-model',
          userId: fixtureUser.id,
          messages: [],
        })
        .next(),
      /Failed to fetch available models from Ollama/
    );
    assert.equal(count('/v1/chat/completions'), remoteBefore);

    const remote = await handler.defaultModel(fixtureUser.id);
    assert.ok(
      remote.startsWith('lwui:plugin:deepseek:'),
      'remote-only discovery returns an exact plugin route'
    );
    for await (const _chunk of handler.stream({
      model: remote,
      userId: fixtureUser.id,
      messages: [{ role: 'user', content: 'Explicit remote route.' }],
    })) {
      /* drain */
    }
    assert.equal(count('/v1/chat/completions'), remoteBefore + 1);
  } finally {
    localCatalogUnavailable = false;
    localGenerationUnavailable = false;
  }
});

test('two activated providers with the same model retain separate exact routes', async () => {
  await pluginService.installPlugin(
    {
      id: 'second-provider',
      name: 'Second fixture',
      type: 'completion',
      endpoint: `${providerUrl}/second/v1/chat/completions`,
      auth: { header: '', prefix: '', key_env: '' },
      model_map: ['local-tool-model'],
    },
    fixtureUser.id
  );
  await pluginService.activatePlugin('second-provider', fixtureUser.id);
  const handler = await installRealHandler();
  const models = (await handler.listModels(fixtureUser.id)).filter(
    model => model.name === 'local-tool-model'
  );
  assert.deepEqual(
    new Set(models.map(model => model.id)),
    new Set([
      'lwui:ollama:local-tool-model',
      'lwui:plugin:deepseek:local-tool-model',
      'lwui:plugin:second-provider:local-tool-model',
    ])
  );
  const start = requests.length;
  for (const model of [
    'lwui:plugin:deepseek:local-tool-model',
    'lwui:plugin:second-provider:local-tool-model',
  ]) {
    for await (const _chunk of handler.stream({
      model,
      userId: fixtureUser.id,
      messages: [{ role: 'user', content: 'Use this exact route.' }],
    })) {
      /* drain */
    }
  }
  const calls = requests
    .slice(start)
    .filter(request => request.url?.endsWith('/chat/completions'));
  assert.deepEqual(
    calls.map(call => call.url),
    ['/v1/chat/completions', '/second/v1/chat/completions']
  );
  assert.deepEqual(
    calls.map(call => call.body.model),
    ['local-tool-model', 'local-tool-model']
  );
  assert.equal(
    requests.slice(start).some(request => request.url === '/api/chat'),
    false
  );
  await assert.rejects(
    handler
      .stream({
        model: 'lwui:plugin:deepseek:%ZZ',
        userId: fixtureUser.id,
        messages: [],
      })
      .next(),
    /model route is invalid/
  );
});

test('the engine catalog identifies exact providers and ignores Chat persona defaults and prompts', async () => {
  const handler = await installRealHandler();
  const { getCordisModelCatalog } = await importBuilt(
    'cordis/dsh/provider-handler.js'
  );
  const { default: preferencesService } = await importBuilt(
    'services/preferencesService.js'
  );
  await preferencesService.setSystemMessage(
    'PERSONA-INSTRUCTIONS-MUST-NOT-LEAK-INTO-ENGINE',
    fixtureUser.id
  );
  for (const defaultModel of [
    'persona:fixture-persona',
    'agent:pi',
    'codex:gpt-test',
    'dsh',
    'lwui:ollama:persona%3Afixture-persona',
  ]) {
    await preferencesService.setDefaultModel(defaultModel, fixtureUser.id, {
      providerType: 'ollama',
    });
    assert.equal(
      await handler.defaultModel(fixtureUser.id),
      'lwui:ollama:local-tool-model'
    );
  }
  const catalog = await getCordisModelCatalog(fixtureUser.id);
  assert.equal(catalog.defaultModel, 'lwui:ollama:local-tool-model');
  assert.deepEqual(
    catalog.models.find(model => model.id === catalog.defaultModel),
    {
      id: 'lwui:ollama:local-tool-model',
      name: 'local-tool-model',
      providerType: 'ollama',
      providerName: 'Ollama',
    }
  );
  assert.deepEqual(
    catalog.models.find(
      model => model.id === 'lwui:plugin:deepseek:remote-tool-model'
    ),
    {
      id: 'lwui:plugin:deepseek:remote-tool-model',
      name: 'remote-tool-model',
      providerType: 'plugin',
      providerId: 'deepseek',
      providerName: 'DeepSeek fixture',
    }
  );
  const start = requests.length;
  for await (const _chunk of handler.stream({
    model: catalog.defaultModel,
    userId: fixtureUser.id,
    messages: [{ role: 'user', content: 'Use the engine instructions only.' }],
  })) {
    /* drain */
  }
  const wire = requests
    .slice(start)
    .find(request => request.url === '/api/chat').body;
  assert.equal(wire.model, 'local-tool-model');
  assert.deepEqual(
    wire.messages.map(message => ({
      role: message.role,
      content: message.content,
    })),
    [{ role: 'user', content: 'Use the engine instructions only.' }]
  );
  assert.equal(JSON.stringify(wire).includes('PERSONA-INSTRUCTIONS'), false);
});

test('provider catalogs exclude persona and agent pseudo-models even if a provider advertises them', async () => {
  const handler = await installRealHandler();
  includePseudoModels = true;
  try {
    await pluginService.discoverModels('deepseek', fixtureUser.id);
    assert.ok(
      (await pluginService.getActivePlugins(fixtureUser.id))
        .find(plugin => plugin.id === 'deepseek')
        .model_map.includes('persona:fixture-persona'),
      'the fixture really advertised a provider pseudo-model'
    );
    const catalog = await handler.listModels(fixtureUser.id);
    assert.ok(catalog.length >= 3);
    assert.equal(
      catalog.some(model => /^(persona:|agent:|codex:|dsh$)/.test(model.name)),
      false
    );
    assert.equal(
      await handler.defaultModel(fixtureUser.id),
      'lwui:ollama:local-tool-model'
    );
  } finally {
    includePseudoModels = false;
    await pluginService.discoverModels('deepseek', fixtureUser.id);
  }
});

test('pseudo-model and malformed selected routes never reach a provider', async () => {
  const handler = await installRealHandler();
  const start = requests.length;
  for (const model of [
    'persona:fixture-persona',
    'agent:codex',
    'pi',
    'opencode:test',
    'lwui:ollama:persona%3Afixture-persona',
    'lwui:plugin:deepseek:agent%3Api',
    'lwui:ollama:codex%3Agpt-test',
    'lwui:ollama:%20',
    'lwui:ollama:%ZZ',
    'lwui:plugin:deepseek:lwui%3Aollama%3Alocal-tool-model',
  ]) {
    await assert.rejects(
      handler
        .stream({
          model,
          userId: fixtureUser.id,
          messages: [
            { role: 'user', content: 'Do not send an invalid selection.' },
          ],
        })
        .next(),
      /provider chat model|model route is invalid/
    );
  }
  assert.equal(
    requests.length,
    start,
    'validation happens before any provider or catalog HTTP request'
  );
});

test('Ollama calls without IDs remain unique and correlated after a handler restart', async () => {
  const { BlockAssembler, createUserMessage, createToolResultMessage } =
    await import('@deepseek-ai/dsh-llm');
  const model = 'lwui:ollama:local-tool-model';
  const ids = [];
  let history = [];
  omitLocalToolCallIds = true;
  try {
    for (const generation of ['before-restart', 'after-restart']) {
      const providerModule = await import(
        `${pathToFileURL(path.join(backendDir, 'dist', 'cordis', 'dsh', 'provider-handler.js')).href}?instance=${generation}`
      );
      const handler = providerModule.libreWebUiProviderHandler;
      registerLibreWebUiProvider({
        ...handler,
        stream: call => handler.stream({ ...call, userId: fixtureUser.id }),
      });
      const ctx = await startRuntime();
      try {
        history.push(
          createUserMessage({
            source: { kind: 'user' },
            content: [{ type: 'text', text: `Read notes.txt ${generation}` }],
          })
        );
        const initial = new BlockAssembler();
        for (const chunk of await collect(ctx, {
          model,
          messages: history,
          tools: offeredTools,
        }))
          initial.push(chunk);
        const call = initial.blocks().find(block => block.type === 'tool-call');
        assert.ok(call?.id);
        ids.push(call.id);
        history.push(
          initial.message({
            kind: 'model',
            provider: ROUTE,
            model,
            replayState: initial.replayState,
          })
        );
        history.push(
          createToolResultMessage({
            callId: call.id,
            content: [{ type: 'text', text: `File content ${generation}` }],
            isError: false,
          })
        );
        const completed = new BlockAssembler();
        for (const chunk of await collect(ctx, {
          model,
          messages: history,
          tools: offeredTools,
        }))
          completed.push(chunk);
        assert.equal(
          completed.blocks().find(block => block.type === 'text').text,
          `Read: File content ${generation}`
        );
        const wire = requests
          .filter(request => request.url === '/api/chat')
          .at(-1).body;
        assert.equal(wire.messages.at(-1).tool_call_id, call.id);
        assert.equal(wire.messages.at(-2).tool_calls[0].id, call.id);
        history.push(
          completed.message({ kind: 'model', provider: ROUTE, model })
        );
        // Resume from serialized native messages, without retaining module state.
        history = JSON.parse(JSON.stringify(history));
      } finally {
        await ctx.fiber.dispose();
      }
    }
    assert.equal(
      new Set(ids).size,
      2,
      'separate provider instances must not reuse a synthesized call identity'
    );
  } finally {
    omitLocalToolCallIds = false;
  }
});

test('persistently disabling Ollama hides and blocks its DSH routes without probing or rerouting', async () => {
  const handler = await installRealHandler();
  const { getCordisModelCatalog, resolveCordisProviderTarget } =
    await importBuilt('cordis/dsh/provider-handler.js');
  const { getOllamaRuntimeSettings, setOllamaRuntimeSettings } =
    await importBuilt('services/ollamaSettingsService.js');
  const { getSystemSetting } = await importBuilt(
    'services/systemSettingsService.js'
  );
  const { default: preferencesService } = await importBuilt(
    'services/preferencesService.js'
  );
  const previousSettings = await getOllamaRuntimeSettings();
  const previousPreferences = await preferencesService.getPreferences(
    fixtureUser.id
  );
  const local = 'lwui:ollama:local-tool-model';
  assert.equal(localCatalogUnavailable, false);
  assert.equal(localGenerationUnavailable, false);
  assert.ok(
    (await handler.listModels(fixtureUser.id)).some(
      model => model.id === local
    ),
    'the healthy Ollama fixture is available before the administrator disables it'
  );
  const start = requests.length;
  try {
    await setOllamaRuntimeSettings({ enabled: false });
    assert.equal(
      await getSystemSetting('ollama.enabled'),
      'false',
      'the regression uses the persisted administrator setting'
    );
    await preferencesService.setDefaultModel('dsh', fixtureUser.id, {
      providerType: 'agent',
      providerId: 'dsh',
    });
    const catalog = await getCordisModelCatalog(fixtureUser.id);
    assert.ok(
      catalog.models.length > 0,
      'enabled plugin routes remain available'
    );
    assert.ok(catalog.models.every(model => model.providerType === 'plugin'));
    assert.equal(catalog.defaultModel, catalog.models[0].id);
    assert.ok(catalog.defaultModel.startsWith('lwui:plugin:'));
    assert.equal(await handler.resolveModel(local, fixtureUser.id), undefined);
    await assert.rejects(
      handler
        .stream({ model: local, userId: fixtureUser.id, messages: [] })
        .next(),
      /ollama.*disabled|disabled.*ollama/i
    );
    await assert.rejects(
      resolveCordisProviderTarget(local, fixtureUser.id),
      /ollama.*disabled|disabled.*ollama/i
    );

    for (const [model, selection] of [
      ['local-tool-model', { providerType: 'ollama' }],
      [local, undefined],
      ['local-tool-model', undefined],
    ]) {
      await preferencesService.setDefaultModel(
        model,
        fixtureUser.id,
        selection
      );
      await assert.rejects(
        handler.defaultModel(fixtureUser.id),
        /ollama.*disabled|disabled.*ollama/i
      );
      await assert.rejects(
        handler.stream({ model, userId: fixtureUser.id, messages: [] }).next(),
        /ollama.*disabled|disabled.*ollama/i
      );
      await assert.rejects(
        resolveCordisProviderTarget(model, fixtureUser.id),
        /ollama.*disabled|disabled.*ollama/i
      );
    }
    assert.equal(
      requests.length,
      start,
      'catalog/default/denied selections must neither probe Ollama nor silently call a colliding plugin'
    );

    await preferencesService.setDefaultModel(
      'local-tool-model',
      fixtureUser.id,
      { providerType: 'plugin', providerId: 'deepseek' }
    );
    assert.equal(
      await handler.defaultModel(fixtureUser.id),
      'lwui:plugin:deepseek:local-tool-model'
    );
    assert.deepEqual(
      await resolveCordisProviderTarget('local-tool-model', fixtureUser.id),
      {
        model: 'local-tool-model',
        providerType: 'plugin',
        providerId: 'deepseek',
      }
    );
    for (const model of [
      'local-tool-model',
      'lwui:plugin:second-provider:local-tool-model',
    ]) {
      for await (const _chunk of handler.stream({
        model,
        userId: fixtureUser.id,
        messages: [
          {
            role: 'user',
            content:
              'Use the explicitly selected plugin while Ollama is disabled.',
          },
        ],
      })) {
        /* drain */
      }
    }
    const calls = requests.slice(start);
    assert.equal(
      calls.some(request => request.url?.startsWith('/api/')),
      false,
      'the healthy local /api/tags, /api/show and /api/chat endpoints receive no requests while disabled'
    );
    assert.deepEqual(
      calls.map(request => request.url),
      ['/v1/chat/completions', '/second/v1/chat/completions']
    );
    assert.ok(
      calls.every(request => request.body.model === 'local-tool-model')
    );
  } finally {
    await preferencesService.setDefaultModel(
      previousPreferences.defaultModel,
      fixtureUser.id,
      {
        providerType: previousPreferences.defaultProviderType ?? null,
        providerId: previousPreferences.defaultProviderId ?? null,
      }
    );
    await setOllamaRuntimeSettings(previousSettings);
  }
});
