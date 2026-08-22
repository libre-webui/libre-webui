import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-provider-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const persistenceModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'index.js')
  ).href
);
const providerModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'workModelProviderService.js'
    )
  ).href
);

test.after(async () => {
  await persistenceModule.closePersistence();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});
const validationModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginValidation.js')
  ).href
);

const {
  buildPluginWorkPayload,
  normalizePluginWorkResponse,
  toOpenAIWorkMessages,
  WorkModelProviderService,
} = providerModule;
const { pluginRequiresApiKey } = validationModule;

const tool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a workspace file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
};

const messages = [
  { role: 'system', content: 'Work only in /workspace.' },
  { role: 'user', content: 'Read the plan.' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call-read',
        function: {
          name: 'read_file',
          arguments: { path: 'plan.txt' },
        },
      },
    ],
  },
  {
    role: 'tool',
    content: 'local plan contents',
    tool_name: 'read_file',
  },
];

const plugin = id => ({
  id,
  name: id,
  type: 'completion',
  endpoint: 'https://example.invalid/chat',
  auth: {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'TEST_KEY',
  },
  model_map: ['test-model'],
});

const streamingService = remotePlugin =>
  new WorkModelProviderService({
    ollama: {
      isHealthy: async () => false,
      showModel: async () => ({ capabilities: [] }),
      generateChatResponse: async () => {
        throw new Error('Unexpected local request');
      },
    },
    plugins: {
      getActivePlugins: () => [remotePlugin],
      getPlugin: id => (id === remotePlugin.id ? remotePlugin : null),
      getApiKey: () => 'test-key',
      getPluginVariables: () => ({ max_tokens: 4096 }),
    },
    post: async () => {
      throw new Error('Streaming should use fetch');
    },
  });

test('auth-free local plugins are available without a fake API key', async () => {
  const localPlugin = {
    ...plugin('mlx-lm'),
    active: true,
    endpoint: 'http://127.0.0.1:8081/v1/chat/completions',
    auth: {
      header: '',
      prefix: '',
      key_env: '',
    },
  };
  const requests = [];
  const usageEvents = [];
  const service = new WorkModelProviderService({
    ollama: {
      isHealthy: async () => false,
      showModel: async () => ({ capabilities: [] }),
      generateChatResponse: async () => {
        throw new Error('Unexpected local request');
      },
    },
    plugins: {
      getActivePlugins: () => [localPlugin],
      getPlugin: id => (id === localPlugin.id ? localPlugin : null),
      getApiKey: () => null,
      getPluginVariables: () => ({ max_tokens: 262144 }),
    },
    post: async (endpoint, payload, config) => {
      requests.push({ endpoint, payload, config });
      return {
        data: {
          usage: {
            prompt_tokens: 24,
            completion_tokens: 8,
            total_tokens: 32,
          },
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Local MLX response',
              },
            },
          ],
        },
      };
    },
    recordPluginUsage: usage => usageEvents.push(usage),
  });

  assert.equal(pluginRequiresApiKey(localPlugin), false);
  assert.equal(pluginRequiresApiKey(plugin('openai')), true);
  assert.deepEqual(await service.availability('test-user'), {
    ollamaAvailable: false,
    pluginAvailable: true,
  });
  await service.assertModelSupportsTools(
    'test-model',
    { providerType: 'plugin', providerId: localPlugin.id },
    'test-user'
  );
  const response = await service.generateChatResponse(
    {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello locally.' }],
      stream: false,
    },
    { providerType: 'plugin', providerId: localPlugin.id },
    'test-user'
  );

  assert.equal(response.message.content, 'Local MLX response');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].config.headers.Authorization, undefined);
  assert.equal(requests[0].config.headers['Content-Type'], 'application/json');
  assert.deepEqual(usageEvents, [
    {
      userId: 'test-user',
      pluginId: 'mlx-lm',
      pluginName: 'mlx-lm',
      capability: 'chat',
      model: 'test-model',
      status: 'success',
      durationMs: usageEvents[0].durationMs,
      tokens: {
        promptTokens: 24,
        completionTokens: 8,
        totalTokens: 32,
      },
    },
  ]);
});

test('OpenAI-compatible Work payload preserves tool-call correlation', () => {
  const converted = toOpenAIWorkMessages(messages);
  assert.equal(converted[2].tool_calls[0].id, 'call-read');
  assert.equal(
    converted[2].tool_calls[0].function.arguments,
    '{"path":"plan.txt"}'
  );
  assert.equal(converted[3].tool_call_id, 'call-read');

  const { payload } = buildPluginWorkPayload(
    plugin('openai'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: false,
    },
    { max_tokens: 2048 }
  );
  assert.deepEqual(payload.tools, [tool]);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(payload.stream, false);

  const response = normalizePluginWorkResponse(
    plugin('openai'),
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'Reading now.',
            tool_calls: [
              {
                id: 'remote-call',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"remote.txt"}',
                },
              },
            ],
          },
        },
      ],
    },
    'test-model'
  );
  assert.equal(response.message.content, 'Reading now.');
  assert.equal(response.message.tool_calls[0].id, 'remote-call');
  assert.equal(
    response.message.tool_calls[0].function.arguments,
    '{"path":"remote.txt"}'
  );

  const { payload: streamingPayload } = buildPluginWorkPayload(
    plugin('openai'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: true,
    },
    { max_tokens: 2048 }
  );
  assert.equal(streamingPayload.stream, true);
});

test('Kimi Work omits fixed sampling and preserves tool-call reasoning', () => {
  const kimiPlugin = plugin('kimi-code');
  const { payload } = buildPluginWorkPayload(
    kimiPlugin,
    {
      model: 'test-model',
      messages: messages.slice(0, 2),
      tools: [tool],
      stream: false,
      options: {
        temperature: 0.2,
        top_p: 0.4,
      },
    },
    {
      max_tokens: 4096,
      temperature: 0.3,
      top_p: 0.8,
      frequency_penalty: 1,
      presence_penalty: 1,
    }
  );
  assert.equal('temperature' in payload, false);
  assert.equal('top_p' in payload, false);
  assert.equal('frequency_penalty' in payload, false);
  assert.equal('presence_penalty' in payload, false);
  assert.equal(payload.max_tokens, 4096);

  const response = normalizePluginWorkResponse(
    kimiPlugin,
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'opaque Kimi reasoning',
            tool_calls: [
              {
                id: 'kimi-call',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: '{"path":"kimi.txt"}',
                },
              },
            ],
          },
        },
      ],
    },
    'test-model'
  );
  assert.equal(
    response.message.tool_calls[0].providerMetadata.openAIReasoningContent,
    'opaque Kimi reasoning'
  );

  const { payload: roundTripPayload } = buildPluginWorkPayload(
    kimiPlugin,
    {
      model: 'test-model',
      messages: [
        messages[0],
        messages[1],
        {
          role: 'assistant',
          content: response.message.content,
          tool_calls: response.message.tool_calls,
        },
        {
          role: 'tool',
          content: 'Kimi file contents',
          tool_name: 'read_file',
        },
      ],
      tools: [tool],
      stream: false,
    },
    { max_tokens: 4096 }
  );
  assert.equal(
    roundTripPayload.messages[2].reasoning_content,
    'opaque Kimi reasoning'
  );
  assert.equal(
    'providerMetadata' in roundTripPayload.messages[2].tool_calls[0],
    false
  );
});

test('Anthropic Work payload and response use native tool blocks', () => {
  const { payload, extraHeaders } = buildPluginWorkPayload(
    plugin('anthropic'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: false,
    },
    { max_tokens: 4096 }
  );
  assert.equal(extraHeaders['anthropic-version'], '2023-06-01');
  assert.equal(payload.system, 'Work only in /workspace.');
  assert.equal(payload.tools[0].name, 'read_file');
  assert.deepEqual(payload.tools[0].input_schema, tool.function.parameters);
  assert.equal(payload.messages[1].content[0].type, 'tool_use');
  assert.equal(payload.messages[2].content[0].tool_use_id, 'call-read');

  const response = normalizePluginWorkResponse(
    plugin('anthropic'),
    {
      content: [
        {
          type: 'thinking',
          thinking: 'opaque reasoning',
          signature: 'anthropic-thinking-signature',
        },
        { type: 'text', text: 'I will inspect it.' },
        {
          type: 'tool_use',
          id: 'anthropic-call',
          name: 'read_file',
          input: { path: 'anthropic.txt' },
        },
      ],
    },
    'test-model'
  );
  assert.equal(response.message.content, 'I will inspect it.');
  assert.deepEqual(response.message.tool_calls[0], {
    id: 'anthropic-call',
    providerMetadata: {
      anthropicThinkingBlocks: [
        {
          type: 'thinking',
          thinking: 'opaque reasoning',
          signature: 'anthropic-thinking-signature',
        },
      ],
    },
    function: {
      name: 'read_file',
      arguments: { path: 'anthropic.txt' },
    },
  });

  const roundTripMessages = [
    messages[0],
    messages[1],
    {
      role: 'assistant',
      content: response.message.content,
      tool_calls: response.message.tool_calls,
    },
    messages[3],
  ];
  const { payload: roundTripPayload } = buildPluginWorkPayload(
    plugin('anthropic'),
    {
      model: 'test-model',
      messages: roundTripMessages,
      tools: [tool],
      stream: false,
    },
    { max_tokens: 4096 }
  );
  assert.deepEqual(roundTripPayload.messages[1].content[0], {
    type: 'thinking',
    thinking: 'opaque reasoning',
    signature: 'anthropic-thinking-signature',
  });
  assert.equal(roundTripPayload.messages[1].content[2].type, 'tool_use');

  const { payload: streamingPayload } = buildPluginWorkPayload(
    plugin('anthropic'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: true,
    },
    { max_tokens: 4096 }
  );
  assert.equal(streamingPayload.stream, true);
});

test('Work streams OpenAI-compatible reasoning, text, usage, and tools', async () => {
  const remotePlugin = {
    ...plugin('kimi-code'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.stream, true);
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"Inspecting "}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"Done."}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-live","function":{"name":"read_file","arguments":"{\\"path\\":\\"live"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".txt\\"}"}}]}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const content = [];
  const reasoning = [];
  const usage = [];
  try {
    const response = await service.generateChatStreamResponse(
      {
        model: 'test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      { providerType: 'plugin', providerId: remotePlugin.id },
      'test-user',
      {
        onContent: chunk => content.push(chunk),
        onReasoning: chunk => reasoning.push(chunk),
        onUsage: value => usage.push(value),
      }
    );
    assert.equal(content.join(''), 'Done.');
    assert.equal(reasoning.join(''), 'Inspecting ');
    assert.equal(response.message.content, 'Done.');
    assert.equal(response.message.thinking, 'Inspecting ');
    assert.deepEqual(response.message.tool_calls[0], {
      id: 'call-live',
      providerMetadata: {
        openAIReasoningContent: 'Inspecting ',
      },
      function: {
        name: 'read_file',
        arguments: { path: 'live.txt' },
      },
    });
    assert.deepEqual(usage.at(-1), {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work marks truncated OpenAI-compatible tool arguments for safe recovery', async () => {
  const remotePlugin = {
    ...plugin('kimi-code'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-truncated","function":{"name":"write_file","arguments":"{\\\"path\\\":\\\"app.js\\\",\\\"content\\\":\\\"unterminated"}}]}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const response = await service.generateChatStreamResponse(
      {
        model: 'test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      { providerType: 'plugin', providerId: remotePlugin.id },
      'test-user',
      {}
    );
    const call = response.message.tool_calls[0];
    assert.deepEqual(call.function.arguments, {});
    assert.match(
      call.providerMetadata.libreToolArgumentsError,
      /incomplete or invalid JSON/
    );
    assert.match(
      call.providerMetadata.libreToolArgumentsError,
      /smaller payload/
    );
    assert.equal(
      'unterminated' in call.providerMetadata,
      false,
      'raw provider arguments must not be retained'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work streams Anthropic reasoning, text, usage, and signed tools', async () => {
  const remotePlugin = {
    ...plugin('anthropic'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.stream, true);
    const body = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}',
      '',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Inspecting "}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"anthropic-stream-signature"}}',
      '',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Ready."}}',
      '',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu-live","name":"read_file","input":{}}}',
      '',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"anthropic.txt\\"}"}}',
      '',
      'data: {"type":"content_block_stop","index":2}',
      '',
      'data: {"type":"message_delta","usage":{"output_tokens":4}}',
      '',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const content = [];
  const reasoning = [];
  const usage = [];
  try {
    const response = await service.generateChatStreamResponse(
      {
        model: 'test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      { providerType: 'plugin', providerId: remotePlugin.id },
      'test-user',
      {
        onContent: chunk => content.push(chunk),
        onReasoning: chunk => reasoning.push(chunk),
        onUsage: value => usage.push(value),
      }
    );

    assert.equal(content.join(''), 'Ready.');
    assert.equal(reasoning.join(''), 'Inspecting ');
    assert.equal(response.message.content, 'Ready.');
    assert.equal(response.message.thinking, 'Inspecting ');
    assert.deepEqual(response.message.tool_calls[0], {
      id: 'toolu-live',
      providerMetadata: {
        anthropicThinkingBlocks: [
          {
            type: 'thinking',
            thinking: 'Inspecting ',
            signature: 'anthropic-stream-signature',
          },
        ],
      },
      function: {
        name: 'read_file',
        arguments: { path: 'anthropic.txt' },
      },
    });
    assert.deepEqual(usage.at(-1), {
      promptTokens: 9,
      completionTokens: 4,
      totalTokens: 13,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work streams Gemini reasoning, text, usage, and signed tools', async () => {
  const remotePlugin = {
    ...plugin('gemini'),
    endpoint: 'https://example.invalid/v1beta/models/{model}:generateContent',
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /test-model:streamGenerateContent\?alt=sse$/);
    const payload = JSON.parse(init.body);
    assert.equal(payload.contents[0].parts[0].text, 'Read the plan.');
    const body = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Considering ","thought":true}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"Ready."},{"thoughtSignature":"gemini-stream-signature","functionCall":{"id":"gemini-live","name":"read_file","args":{"path":"gemini.txt"}}}]}}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":5,"totalTokenCount":12}}',
      '',
    ].join('\n');
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const content = [];
  const reasoning = [];
  const usage = [];
  try {
    const response = await service.generateChatStreamResponse(
      {
        model: 'test-model',
        messages: messages.slice(0, 2),
        tools: [tool],
        stream: true,
      },
      { providerType: 'plugin', providerId: remotePlugin.id },
      'test-user',
      {
        onContent: chunk => content.push(chunk),
        onReasoning: chunk => reasoning.push(chunk),
        onUsage: value => usage.push(value),
      }
    );

    assert.equal(content.join(''), 'Ready.');
    assert.equal(reasoning.join(''), 'Considering ');
    assert.equal(response.message.content, 'Ready.');
    assert.equal(response.message.thinking, 'Considering ');
    assert.equal(response.message.tool_calls[0].id, 'gemini-live');
    assert.equal(
      response.message.tool_calls[0].thoughtSignature,
      'gemini-stream-signature'
    );
    assert.deepEqual(response.message.tool_calls[0].function, {
      name: 'read_file',
      arguments: { path: 'gemini.txt' },
    });
    assert.deepEqual(usage.at(-1), {
      promptTokens: 7,
      completionTokens: 5,
      totalTokens: 12,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work rejects HTTP-200 OpenAI-compatible SSE error events', async () => {
  const remotePlugin = {
    ...plugin('openai'),
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"error":{"message":"quota exhausted"}}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );

  try {
    await assert.rejects(
      service.generateChatStreamResponse(
        {
          model: 'test-model',
          messages: messages.slice(0, 2),
          tools: [tool],
          stream: true,
        },
        { providerType: 'plugin', providerId: remotePlugin.id },
        'test-user',
        {}
      ),
      /quota exhausted/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work rejects HTTP-200 Gemini SSE error events', async () => {
  const remotePlugin = {
    ...plugin('gemini'),
    endpoint: 'https://example.invalid/v1beta/models/{model}:generateContent',
    active: true,
  };
  const service = streamingService(remotePlugin);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      'data: {"error":{"message":"billing disabled"}}\n\ndata: {"candidates":[]}\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    );

  try {
    await assert.rejects(
      service.generateChatStreamResponse(
        {
          model: 'test-model',
          messages: messages.slice(0, 2),
          tools: [tool],
          stream: true,
        },
        { providerType: 'plugin', providerId: remotePlugin.id },
        'test-user',
        {}
      ),
      /billing disabled/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Work aggregates Ollama thinking and content chunks', async () => {
  let recordedUsageActor;
  const service = new WorkModelProviderService({
    ollama: {
      isHealthy: async () => true,
      showModel: async () => ({ capabilities: ['tools'] }),
      generateChatResponse: async () => {
        throw new Error('Buffered request was not expected');
      },
      generateChatStreamResponse: async (
        request,
        onChunk,
        _onError,
        onComplete,
        _signal,
        usage
      ) => {
        recordedUsageActor = usage?.userId;
        onChunk({
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            thinking: 'Checking ',
          },
          done: false,
        });
        onChunk({
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: 'Ready.',
          },
          done: true,
          prompt_eval_count: 5,
          eval_count: 3,
        });
        onComplete();
      },
    },
    plugins: {
      getActivePlugins: () => [],
      getPlugin: () => null,
      getApiKey: () => null,
      getPluginVariables: () => ({}),
    },
    post: async () => {
      throw new Error('Unexpected plugin request');
    },
  });
  const content = [];
  const reasoning = [];
  const usage = [];
  const response = await service.generateChatStreamResponse(
    {
      model: 'local-tools',
      messages: [{ role: 'user', content: 'Check it.' }],
      tools: [tool],
      stream: true,
    },
    { providerType: 'ollama' },
    'test-user',
    {
      onContent: chunk => content.push(chunk),
      onReasoning: chunk => reasoning.push(chunk),
      onUsage: value => usage.push(value),
    }
  );

  assert.equal(content.join(''), 'Ready.');
  assert.equal(reasoning.join(''), 'Checking ');
  assert.equal(response.message.content, 'Ready.');
  assert.equal(response.message.thinking, 'Checking ');
  assert.equal(recordedUsageActor, 'test-user');
  assert.deepEqual(usage.at(-1), {
    promptTokens: 5,
    completionTokens: 3,
    totalTokens: 8,
  });
});

test('Gemini Work payload and response preserve function calls', () => {
  const { payload } = buildPluginWorkPayload(
    plugin('gemini'),
    {
      model: 'test-model',
      messages,
      tools: [tool],
      stream: false,
    },
    { max_tokens: 1024 }
  );
  assert.equal(payload.tools[0].functionDeclarations[0].name, 'read_file');
  assert.equal(payload.contents[2].parts[0].functionResponse.name, 'read_file');

  const response = normalizePluginWorkResponse(
    plugin('gemini'),
    {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Checking.' },
              {
                thoughtSignature: 'gemini-signature-v1',
                functionCall: {
                  id: 'gemini-call',
                  name: 'read_file',
                  args: { path: 'gemini.txt' },
                },
              },
            ],
          },
        },
      ],
    },
    'test-model'
  );
  assert.equal(response.message.content, 'Checking.');
  assert.deepEqual(response.message.tool_calls[0], {
    id: 'gemini-call',
    thoughtSignature: 'gemini-signature-v1',
    function: {
      name: 'read_file',
      arguments: { path: 'gemini.txt' },
    },
  });

  const roundTripMessages = [
    messages[0],
    messages[1],
    {
      role: 'assistant',
      content: response.message.content,
      tool_calls: response.message.tool_calls,
    },
    messages[3],
  ];
  const { payload: roundTripPayload } = buildPluginWorkPayload(
    plugin('gemini'),
    {
      model: 'test-model',
      messages: roundTripMessages,
      tools: [tool],
      stream: false,
    },
    { max_tokens: 1024 }
  );
  assert.equal(
    roundTripPayload.contents[1].parts[1].thoughtSignature,
    'gemini-signature-v1'
  );
  assert.equal(
    roundTripPayload.contents[1].parts[1].functionCall.id,
    'gemini-call'
  );

  const { payload: noToolsPayload } = buildPluginWorkPayload(
    plugin('gemini'),
    {
      model: 'test-model',
      messages: messages.slice(0, 2),
      tools: [],
      stream: true,
    },
    { max_tokens: 1024 }
  );
  assert.equal('tools' in noToolsPayload, false);
});

test('provider identity keeps colliding local and plugin model routes separate', async () => {
  const collidingPlugin = {
    ...plugin('remote-collision'),
    active: true,
    model_map: ['shared-model'],
  };
  const ollamaRequests = [];
  const pluginRequests = [];
  const service = new WorkModelProviderService({
    ollama: {
      isHealthy: async () => true,
      showModel: async modelName => {
        ollamaRequests.push({ operation: 'show', modelName });
        return { capabilities: ['completion', 'tools'] };
      },
      generateChatResponse: async request => {
        ollamaRequests.push({ operation: 'chat', modelName: request.model });
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: 'local route' },
          done: true,
        };
      },
    },
    plugins: {
      getActivePlugins: () => [collidingPlugin],
      getPlugin: id => (id === collidingPlugin.id ? collidingPlugin : null),
      getApiKey: candidate =>
        candidate.id === collidingPlugin.id ? 'test-key' : null,
      getPluginVariables: () => ({}),
    },
    post: async (endpoint, payload) => {
      pluginRequests.push({ endpoint, payload });
      return {
        data: {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'plugin route',
              },
            },
          ],
        },
      };
    },
  });
  const request = {
    model: 'shared-model',
    messages: [{ role: 'user', content: 'Which route?' }],
    tools: [tool],
    stream: false,
  };

  await service.assertModelSupportsTools(
    request.model,
    { providerType: 'ollama' },
    'test-user'
  );
  const local = await service.generateChatResponse(
    request,
    { providerType: 'ollama' },
    'test-user'
  );
  assert.equal(local.message.content, 'local route');
  assert.deepEqual(ollamaRequests, [
    { operation: 'show', modelName: 'shared-model' },
    { operation: 'chat', modelName: 'shared-model' },
  ]);
  assert.equal(pluginRequests.length, 0);

  await service.assertModelSupportsTools(
    request.model,
    { providerType: 'plugin', providerId: collidingPlugin.id },
    'test-user'
  );
  const remote = await service.generateChatResponse(
    request,
    { providerType: 'plugin', providerId: collidingPlugin.id },
    'test-user'
  );
  assert.equal(remote.message.content, 'plugin route');
  assert.equal(pluginRequests.length, 1);
  assert.equal(ollamaRequests.length, 2);

  await assert.rejects(
    service.generateChatResponse(
      request,
      { providerType: 'plugin', providerId: 'different-plugin' },
      'test-user'
    ),
    error =>
      error?.code === 'WORK_PLUGIN_UNAVAILABLE' &&
      /different-plugin/.test(error.message)
  );
});

// Replayed Work history stores tool-call arguments as JSON strings (the
// OpenAI-compatible shape). Ollama's native /api/chat rejects that with a
// 400, so the ollama transport must convert them to objects on the way out.
const { normalizeChatMessagesForOllama } = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'ollamaService.js')
  ).href
);

test('replayed tool calls reach native Ollama with object arguments', () => {
  const messages = [
    { role: 'user', content: 'create a duck with a tiny hat' },
    {
      role: 'assistant',
      content: '',
      providerMetadata: { internal: true },
      tool_calls: [
        {
          id: 'call_oia64moe',
          type: 'function',
          function: { name: 'list_files', arguments: '{"path":""}' },
        },
      ],
    },
    {
      role: 'tool',
      content: '[]',
      tool_name: 'list_files',
      tool_call_id: 'call_oia64moe',
    },
    { role: 'user', content: 'add a gun to it' },
  ];

  const wire = normalizeChatMessagesForOllama(messages);

  assert.deepEqual(wire[1].tool_calls[0].function.arguments, { path: '' });
  assert.equal(wire[1].tool_calls[0].id, 'call_oia64moe');
  assert.equal('providerMetadata' in wire[1], false);
  // Untouched messages come through structurally identical.
  assert.deepEqual(wire[0], messages[0]);
  assert.deepEqual(wire[2], messages[2]);
  // The input is not mutated.
  assert.equal(typeof messages[1].tool_calls[0].function.arguments, 'string');
});

test('unparseable or non-object tool arguments degrade to an empty object', () => {
  const wire = normalizeChatMessagesForOllama([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'a', arguments: '{"broken":' } },
        { function: { name: 'b', arguments: '"just a string"' } },
        { function: { name: 'c', arguments: '' } },
        { function: { name: 'd', arguments: { already: 'object' } } },
      ],
    },
  ]);

  const calls = wire[0].tool_calls;
  assert.deepEqual(calls[0].function.arguments, {});
  assert.deepEqual(calls[1].function.arguments, {});
  assert.deepEqual(calls[2].function.arguments, {});
  assert.deepEqual(calls[3].function.arguments, { already: 'object' });
});

test('Work screenshots reach every provider payload as image parts', () => {
  const screenshot = Buffer.from('screenshot-bytes').toString('base64');
  const screenshotMessages = [
    { role: 'system', content: 'Work only in /workspace.' },
    { role: 'user', content: 'Open the dashboard.' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-observe',
          function: { name: 'computer_observe', arguments: {} },
        },
        {
          id: 'call-list',
          function: { name: 'list_files', arguments: { path: '.' } },
        },
      ],
    },
    {
      role: 'tool',
      content: 'Screen 1280x800, cursor at 10,20.',
      tool_name: 'computer_observe',
      tool_call_id: 'call-observe',
      images: [screenshot],
    },
    {
      role: 'tool',
      content: '[]',
      tool_name: 'list_files',
      tool_call_id: 'call-list',
    },
  ];
  const request = {
    model: 'test-model',
    messages: screenshotMessages,
    tools: [tool],
    stream: false,
  };
  const dataUrl = `data:image/png;base64,${screenshot}`;

  // OpenAI-compatible chat: tool messages stay text-only and the screenshot
  // follows the whole tool-result run as one user message.
  const converted = toOpenAIWorkMessages(screenshotMessages);
  assert.equal(converted.length, 6);
  assert.equal(converted[3].role, 'tool');
  assert.equal(typeof converted[3].content, 'string');
  assert.equal(converted[4].role, 'tool');
  const imageMessage = converted[5];
  assert.equal(imageMessage.role, 'user');
  assert.equal(imageMessage.content[0].type, 'text');
  assert.deepEqual(imageMessage.content[1], {
    type: 'image_url',
    image_url: { url: dataUrl },
  });

  // Responses mode: the screenshot lands as an input_image user item after
  // both function_call_output items.
  const { payload: responsesPayload } = buildPluginWorkPayload(
    plugin('openai'),
    request,
    {},
    'responses'
  );
  const responseImage = responsesPayload.input.at(-1);
  assert.equal(responseImage.role, 'user');
  assert.equal(responseImage.content[0].type, 'input_text');
  assert.deepEqual(responseImage.content[1], {
    type: 'input_image',
    image_url: dataUrl,
  });

  // Anthropic: native image blocks inside the tool_result.
  const { payload: anthropicPayload } = buildPluginWorkPayload(
    plugin('anthropic'),
    request
  );
  const anthropicToolTurn = anthropicPayload.messages.at(-1);
  assert.equal(anthropicToolTurn.role, 'user');
  const observeResult = anthropicToolTurn.content.find(
    block => block.tool_use_id === 'call-observe'
  );
  assert.equal(observeResult.content[0].type, 'text');
  assert.deepEqual(observeResult.content[1], {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: screenshot },
  });
  const listResult = anthropicToolTurn.content.find(
    block => block.tool_use_id === 'call-list'
  );
  assert.equal(typeof listResult.content, 'string');

  // Gemini: an inlineData part right after the functionResponse part.
  const { payload: geminiPayload } = buildPluginWorkPayload(
    plugin('gemini'),
    request
  );
  const geminiUserTurn = geminiPayload.contents.at(-1);
  assert.equal(geminiUserTurn.role, 'user');
  const responseIndex = geminiUserTurn.parts.findIndex(
    part => part.functionResponse?.id === 'call-observe'
  );
  assert.ok(responseIndex >= 0);
  assert.deepEqual(geminiUserTurn.parts[responseIndex + 1], {
    inlineData: { mimeType: 'image/png', data: screenshot },
  });
});
