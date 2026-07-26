import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
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

const {
  buildPluginWorkPayload,
  normalizePluginWorkResponse,
  toOpenAIWorkMessages,
  WorkModelProviderService,
} = providerModule;

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
