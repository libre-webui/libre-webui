import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const adapter = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'openAIResponsesAdapter.js')
  ).href
);
const workProvider = await import(
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
const chatAdapter = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginChatAdapter.js')
  ).href
);
const streamAdapter = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginStreamAdapter.js')
  ).href
);
const pluginValidation = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'pluginValidation.js')
  ).href
);
const pluginServiceModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'pluginService.js')
  ).href
);
const pluginVariablesServiceModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'pluginVariablesService.js'
    )
  ).href
);
const pluginCredentialsServiceModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'pluginCredentialsService.js'
    )
  ).href
);
const databaseModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);
const pluginRoutesModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'routes', 'plugins.js'))
    .href
);
const { default: axios } = await import('axios');

test('Responses payload is stateless and maps chat fields to Responses fields', () => {
  const payload = adapter.buildOpenAIResponsesPayload(
    'gpt-test',
    [
      { role: 'system', content: 'Be precise.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this.' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,abc123',
              detail: 'high',
            },
          },
        ],
      },
    ],
    {
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a workspace file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
            strict: true,
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 2048,
      temperature: 0.2,
      top_p: 0.8,
      stream: false,
      store: true,
      stop: ['END'],
      frequency_penalty: 1,
    }
  );

  assert.deepEqual(payload.input, [
    { role: 'system', content: 'Be precise.' },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Describe this.' },
        {
          type: 'input_image',
          image_url: 'data:image/png;base64,abc123',
          detail: 'high',
        },
      ],
    },
  ]);
  assert.deepEqual(payload.tools, [
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      strict: true,
    },
  ]);
  assert.equal(payload.store, false);
  assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
  assert.equal(payload.max_output_tokens, 2048);
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.stream, false);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal('messages' in payload, false);
  assert.equal('max_tokens' in payload, false);
  assert.equal('stop' in payload, false);
  assert.equal('frequency_penalty' in payload, false);
});

test('Responses input preserves function-call and tool-result correlation', () => {
  const stateScope = adapter.createOpenAIResponsesStateScope(
    'provider-a',
    'gpt-test',
    'https://gateway.example/v1/responses'
  );
  const reasoningItem = {
    id: 'reasoning-read',
    type: 'reasoning',
    encrypted_content: 'opaque-reasoning',
    summary: [],
  };
  const messageItem = {
    id: 'message-read',
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'I will inspect it.' }],
  };
  const functionItem = {
    id: 'function-read',
    type: 'function_call',
    call_id: 'call-read',
    name: 'read_file',
    arguments: '{"path":"plan.txt"}',
  };
  const history = [
    { role: 'user', content: 'Read the plan.' },
    {
      role: 'assistant',
      content: 'I will inspect it.',
      providerMetadata: {
        [adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: [
          reasoningItem,
          messageItem,
          functionItem,
        ],
        [adapter.OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY]: stateScope,
      },
      tool_calls: [
        {
          id: 'call-read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: { path: 'plan.txt' },
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call-read',
      content: 'Plan contents',
    },
  ];
  const input = adapter.toOpenAIResponsesInput(history, stateScope);

  assert.deepEqual(input, [
    { role: 'user', content: 'Read the plan.' },
    reasoningItem,
    messageItem,
    functionItem,
    {
      type: 'function_call_output',
      call_id: 'call-read',
      output: 'Plan contents',
    },
  ]);
  assert.deepEqual(
    adapter.toOpenAIResponsesInput(history, 'different-provider-scope'),
    [
      { role: 'user', content: 'Read the plan.' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        type: 'function_call',
        call_id: 'call-read',
        name: 'read_file',
        arguments: '{"path":"plan.txt"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call-read',
        output: 'Plan contents',
      },
    ]
  );
});

test('completed Responses objects normalize text, reasoning, calls, and usage', () => {
  const normalized = adapter.normalizeOpenAIResponsesResponse(
    {
      id: 'resp-123',
      object: 'response',
      created_at: 1_750_000_000.9,
      model: 'gpt-test',
      status: 'completed',
      output: [
        {
          id: 'reasoning-1',
          type: 'reasoning',
          encrypted_content: 'encrypted-reasoning',
          summary: [
            { type: 'summary_text', text: 'Inspect the requested file.' },
            { type: 'summary_text', text: 'Then report its contents.' },
          ],
        },
        {
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I need to read the file.' }],
        },
        {
          id: 'function-1',
          type: 'function_call',
          call_id: 'call-read',
          name: 'read_file',
          arguments: '{"path":"plan.txt"}',
        },
      ],
      usage: {
        input_tokens: 42,
        output_tokens: 17,
        total_tokens: 59,
      },
    },
    'fallback-model'
  );

  assert.deepEqual(normalized, {
    id: 'resp-123',
    object: 'chat.completion',
    created: 1_750_000_000,
    model: 'gpt-test',
    providerMetadata: {
      [adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: [
        {
          id: 'reasoning-1',
          type: 'reasoning',
          encrypted_content: 'encrypted-reasoning',
          summary: [
            { type: 'summary_text', text: 'Inspect the requested file.' },
            { type: 'summary_text', text: 'Then report its contents.' },
          ],
        },
        {
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I need to read the file.' }],
        },
        {
          id: 'function-1',
          type: 'function_call',
          call_id: 'call-read',
          name: 'read_file',
          arguments: '{"path":"plan.txt"}',
        },
      ],
    },
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'I need to read the file.',
          reasoning_content:
            'Inspect the requested file.\nThen report its contents.',
          tool_calls: [
            {
              id: 'call-read',
              call_id: 'call-read',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"path":"plan.txt"}',
              },
              providerMetadata: {
                openAIResponsesReasoningItems: [
                  {
                    id: 'reasoning-1',
                    type: 'reasoning',
                    encrypted_content: 'encrypted-reasoning',
                    summary: [
                      {
                        type: 'summary_text',
                        text: 'Inspect the requested file.',
                      },
                      {
                        type: 'summary_text',
                        text: 'Then report its contents.',
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: {
      prompt_tokens: 42,
      completion_tokens: 17,
      total_tokens: 59,
    },
  });
});

test('Responses Work payload and result preserve stateless tool reasoning round trips', () => {
  const plugin = {
    id: 'openai',
    name: 'OpenAI',
    type: 'completion',
    endpoint: 'https://api.openai.com/v1/responses',
    api_mode: 'responses',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'OPENAI_API_KEY',
    },
    model_map: ['gpt-test'],
  };
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
  const reasoningItem = {
    id: 'reasoning-work',
    type: 'reasoning',
    encrypted_content: 'opaque-reasoning',
    summary: [{ type: 'summary_text', text: 'Inspect the file.' }],
  };
  const messageItem = {
    id: 'message-work',
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'Reading now.' }],
  };
  const functionItem = {
    id: 'function-work',
    type: 'function_call',
    call_id: 'call-work',
    name: 'read_file',
    arguments: '{"path":"unterminated"',
  };
  const stateScope = adapter.createOpenAIResponsesStateScope(
    plugin.id,
    'gpt-test',
    plugin.endpoint
  );

  const response = workProvider.normalizePluginWorkResponse(
    plugin,
    {
      id: 'resp-work',
      model: 'gpt-test',
      status: 'completed',
      output: [reasoningItem, messageItem, functionItem],
      usage: {
        input_tokens: 31,
        output_tokens: 9,
        total_tokens: 40,
      },
    },
    'gpt-test',
    'responses',
    stateScope
  );

  assert.equal(response.message.content, 'Reading now.');
  assert.equal(response.message.thinking, 'Inspect the file.');
  assert.equal(response.prompt_eval_count, 31);
  assert.equal(response.eval_count, 9);
  assert.deepEqual(
    response.message.providerMetadata[
      adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY
    ],
    [reasoningItem, messageItem, functionItem]
  );
  assert.equal(
    response.message.providerMetadata[
      adapter.OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY
    ],
    stateScope
  );
  assert.equal(response.message.tool_calls[0].id, 'call-work');
  assert.equal(response.message.tool_calls[0].function.name, 'read_file');
  assert.deepEqual(response.message.tool_calls[0].function.arguments, {});
  assert.deepEqual(
    response.message.tool_calls[0].providerMetadata
      .openAIResponsesReasoningItems,
    [reasoningItem]
  );
  assert.equal(
    response.message.tool_calls[0].providerMetadata.openAIReasoningContent,
    'Inspect the file.'
  );
  assert.equal(
    response.message.tool_calls[0].providerMetadata.libreToolArgumentsError,
    workProvider.WORK_TOOL_ARGUMENTS_ERROR_MESSAGE
  );

  const { payload } = workProvider.buildPluginWorkPayload(
    plugin,
    {
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'Read the plan.' },
        response.message,
        {
          role: 'tool',
          content: 'Plan contents',
          tool_name: 'read_file',
        },
      ],
      tools: [tool],
      stream: false,
    },
    { max_tokens: 4096 },
    'responses',
    stateScope
  );

  assert.equal(payload.store, false);
  assert.equal(payload.max_output_tokens, 4096);
  assert.equal(payload.stream, false);
  assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
  assert.equal('messages' in payload, false);
  assert.equal('max_tokens' in payload, false);
  assert.deepEqual(payload.tools, [
    {
      type: 'function',
      name: 'read_file',
      description: 'Read a workspace file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ]);
  assert.deepEqual(payload.input, [
    { role: 'user', content: 'Read the plan.' },
    reasoningItem,
    messageItem,
    functionItem,
    {
      type: 'function_call_output',
      call_id: 'call-work',
      output: 'Plan contents',
    },
  ]);
});

test('Responses normalization derives token totals and incomplete finish reason', () => {
  const normalized = adapter.normalizeOpenAIResponsesResponse(
    {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'Partial answer',
      usage: {
        input_tokens: 5,
        output_tokens: 7,
      },
    },
    'fallback-model'
  );

  assert.equal(normalized.id, 'response');
  assert.equal(normalized.created, 0);
  assert.equal(normalized.model, 'fallback-model');
  assert.equal(normalized.choices[0].message.content, 'Partial answer');
  assert.equal(normalized.choices[0].finish_reason, 'length');
  assert.deepEqual(normalized.providerMetadata, {
    [adapter.OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY]:
      'max_output_tokens',
  });
  assert.deepEqual(normalized.usage, {
    prompt_tokens: 5,
    completion_tokens: 7,
    total_tokens: 12,
  });

  const workResponse = workProvider.normalizePluginWorkResponse(
    {
      id: 'openai',
      endpoint: 'https://api.openai.com/v1/responses',
      api_mode: 'responses',
    },
    {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        {
          id: 'partial-message',
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'Partial answer' }],
        },
      ],
    },
    'fallback-model',
    'responses'
  );
  assert.equal(workResponse.done_reason, 'incomplete:max_output_tokens');

  assert.throws(
    () =>
      adapter.normalizeOpenAIResponsesResponse(
        {
          status: 'failed',
          error: { message: 'Provider rejected the request' },
        },
        'fallback-model'
      ),
    /Responses API error: Provider rejected the request/
  );
});

test('provider API configuration resolves modes, base URLs, paths, and model discovery', () => {
  const plugin = {
    endpoint: 'https://api.openai.com/v1/chat/completions',
    api_mode: 'chat_completions',
    base_url: 'https://api.openai.com/v1',
  };

  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'responses',
      base_url: 'https://gateway.example/v2',
    }),
    {
      apiMode: 'responses',
      endpoint: 'https://gateway.example/v2/responses',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'responses',
      base_url: 'https://upgraded.example/v1',
      endpoint: plugin.endpoint,
    }),
    {
      apiMode: 'responses',
      endpoint: 'https://upgraded.example/v1/responses',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(
      {
        ...plugin,
        endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
      },
      {
        api_mode: plugin.api_mode,
        base_url: plugin.base_url,
        endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
      }
    ),
    {
      apiMode: 'chat_completions',
      endpoint: 'http://127.0.0.1:8080/v1/chat/completions',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'responses',
      base_url: 'https://gateway.example/v2',
      api_path: '/custom/responses',
    }),
    {
      apiMode: 'responses',
      endpoint: 'https://gateway.example/v2/custom/responses',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(
      {
        ...plugin,
        endpoint: 'https://api.openai.com/v1/responses',
        api_mode: 'responses',
        api_path: '/responses',
      },
      { api_mode: 'chat_completions' }
    ),
    {
      apiMode: 'chat_completions',
      endpoint: 'https://api.openai.com/v1/chat/completions',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(
      {
        ...plugin,
        api_path: '/chat/completions',
      },
      { api_mode: 'responses' }
    ),
    {
      apiMode: 'responses',
      endpoint: 'https://api.openai.com/v1/responses',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'chat_completions',
      base_url: 'https://ignored.example/v1',
      endpoint: 'https://full.example/v1/responses',
    }),
    {
      apiMode: 'responses',
      endpoint: 'https://full.example/v1/responses',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'responses',
      endpoint: 'https://full.example/v1/chat/completions',
    }),
    {
      apiMode: 'chat_completions',
      endpoint: 'https://full.example/v1/chat/completions',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'responses',
      endpoint: 'https://full.example/custom/inference',
    }),
    {
      apiMode: 'responses',
      endpoint: 'https://full.example/custom/inference',
    }
  );
  assert.deepEqual(
    pluginValidation.resolvePluginApiConfig(plugin, {
      api_mode: 'responses',
      base_url: 'https://gateway.example/v2',
      api_path: '/chat/completions',
    }),
    {
      apiMode: 'chat_completions',
      endpoint: 'https://gateway.example/v2/chat/completions',
    }
  );
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(
      'https://gateway.example/v2/responses?ignored=true#fragment'
    ),
    'https://gateway.example/v2/models'
  );
  assert.throws(
    () =>
      pluginValidation.resolvePluginApiConfig(plugin, {
        base_url: 'http://public.example/v1',
      }),
    /Insecure endpoint protocol/
  );
  for (const endpoint of [
    'http://10.example.com/v1',
    'http://172.16.example.com/v1',
    'http://192.168.example.com/v1',
  ]) {
    assert.equal(pluginValidation.isSafePluginEndpoint(endpoint), false);
  }
  for (const endpoint of [
    'http://10.0.0.8/v1',
    'http://172.16.0.8/v1',
    'http://172.31.255.254/v1',
    'http://192.168.1.8/v1',
  ]) {
    assert.equal(pluginValidation.isSafePluginEndpoint(endpoint), true);
  }
  assert.throws(
    () =>
      pluginValidation.resolvePluginApiConfig(plugin, {
        api_path: '/../secrets',
      }),
    /Invalid plugin API path|base URL is required/
  );
  for (const encodedTraversal of [
    '/%2e%2e/secrets',
    '/%2E%2E/secrets',
    '/%252e%252e/secrets',
    '/safe/%2e%2e/secrets',
  ]) {
    assert.throws(
      () =>
        pluginValidation.resolvePluginApiConfig(plugin, {
          base_url: 'https://gateway.example/proxy/v1',
          api_path: encodedTraversal,
        }),
      /Invalid plugin API path/
    );
  }
  let overEncodedTraversal = '%2e%2e';
  for (let pass = 0; pass < 10; pass += 1) {
    overEncodedTraversal = encodeURIComponent(overEncodedTraversal);
  }
  assert.equal(
    pluginValidation.validatePluginApiPath(`/${overEncodedTraversal}/secrets`),
    null
  );
});

test('model discovery rejects an unsafe derived URL before reading credentials', async () => {
  const service = pluginServiceModule.default;
  const originalGetPlugin = service.getPlugin;
  const originalGetPluginVariables = service.getPluginVariables;
  const originalGetApiKey = service.getApiKey;
  const originalAxiosGet = axios.get;
  let credentialsRead = false;
  let requestMade = false;

  try {
    service.getPlugin = () => ({
      id: 'unsafe-provider',
      name: 'Unsafe provider',
      type: 'completion',
      endpoint: 'http://public.example/v1/chat/completions',
      auth: {
        header: 'Authorization',
        prefix: 'Bearer ',
        key_env: 'UNSAFE_PROVIDER_API_KEY',
      },
      model_map: ['fallback-model'],
    });
    service.getPluginVariables = () => ({});
    service.getApiKey = () => {
      credentialsRead = true;
      return 'must-not-be-read';
    };
    axios.get = async () => {
      requestMade = true;
      return { data: { data: [] } };
    };

    await assert.rejects(
      service.discoverModels('unsafe-provider', 'unsafe-user'),
      /Insecure endpoint protocol/
    );
    assert.equal(credentialsRead, false);
    assert.equal(requestMade, false);
  } finally {
    service.getPlugin = originalGetPlugin;
    service.getPluginVariables = originalGetPluginVariables;
    service.getApiKey = originalGetApiKey;
    axios.get = originalAxiosGet;
  }
});

test('Chat adapter sends and normalizes Responses API payloads', () => {
  const plugin = {
    id: 'openai',
    name: 'OpenAI',
    type: 'completion',
    endpoint: 'https://api.openai.com/v1/responses',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'OPENAI_API_KEY',
    },
    model_map: ['gpt-test'],
  };
  const { payload } = chatAdapter.buildPluginChatPayload(
    plugin,
    'gpt-test',
    [
      {
        id: 'message-1',
        role: 'user',
        content: 'Hello',
        timestamp: 1,
      },
    ],
    { temperature: 0.3, num_predict: 512 },
    {},
    false,
    'responses'
  );

  assert.deepEqual(payload, {
    model: 'gpt-test',
    input: [{ role: 'user', content: 'Hello' }],
    store: false,
    include: ['reasoning.encrypted_content'],
    max_output_tokens: 512,
    temperature: 0.3,
    stream: false,
  });

  const stateScope = adapter.createOpenAIResponsesStateScope(
    plugin.id,
    'gpt-test',
    plugin.endpoint
  );
  const converted = chatAdapter.convertProviderResponse(
    plugin,
    {
      id: 'resp-chat',
      model: 'gpt-test',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello back' }],
        },
      ],
    },
    'gpt-test',
    'responses',
    stateScope
  );
  assert.equal(converted.id, 'resp-chat');
  assert.equal(converted.choices[0].message.content, 'Hello back');
  assert.equal(
    converted.providerMetadata[
      adapter.OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY
    ],
    stateScope
  );
});

test('Responses streaming emits typed content, reasoning, one correlated call, and usage', async () => {
  const reasoningItem = {
    id: 'reasoning-stream',
    type: 'reasoning',
    encrypted_content: 'opaque-stream-reasoning',
    summary: [{ type: 'summary_text', text: 'Read the file.' }],
  };
  const functionItem = {
    id: 'function-stream',
    type: 'function_call',
    call_id: 'call-stream',
    name: 'read_file',
    arguments: '{"path":"plan.txt"}',
  };
  const messageItem = {
    id: 'message-stream',
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: 'Working' }],
  };
  const events = [
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...functionItem, arguments: '' },
    },
    {
      type: 'response.reasoning_summary_text.delta',
      item_id: 'reasoning-stream',
      delta: 'Read the file.',
    },
    {
      type: 'response.output_text.delta',
      item_id: 'message-stream',
      delta: 'Working',
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'function-stream',
      output_index: 0,
      delta: '{"path":"plan.txt"}',
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: functionItem,
    },
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [reasoningItem, messageItem, functionItem],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      },
    },
  ];
  const response = new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
  const chunks = [];
  const stateScope = 'stream-state-scope';
  for await (const chunk of streamAdapter.streamOpenAIResponsesResponse(
    response,
    stateScope
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['reasoning', 'content', 'usage', 'tool_call', 'done']
  );
  assert.deepEqual(chunks[2], {
    type: 'usage',
    usage: {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    },
  });
  assert.deepEqual(chunks[3], {
    type: 'tool_call',
    toolCall: {
      id: 'call-stream',
      name: 'read_file',
      arguments: '{"path":"plan.txt"}',
      providerMetadata: {
        openAIResponsesReasoningItems: [reasoningItem],
      },
    },
  });
  assert.deepEqual(chunks[4], {
    type: 'done',
    providerMetadata: {
      [adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: [
        reasoningItem,
        messageItem,
        functionItem,
      ],
      [adapter.OPENAI_RESPONSES_STATE_SCOPE_METADATA_KEY]: stateScope,
    },
  });
});

test('Responses streaming preserves incomplete status and reason', async () => {
  const partialItem = {
    id: 'message-incomplete',
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Partial answer' }],
  };
  const response = new Response(
    `data: ${JSON.stringify({
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [partialItem],
      },
    })}\n\n`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
  const chunks = [];
  for await (const chunk of streamAdapter.streamOpenAIResponsesResponse(
    response
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { type: 'content', content: 'Partial answer' },
    {
      type: 'done',
      doneReason: 'incomplete:max_output_tokens',
      providerMetadata: {
        [adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: [partialItem],
      },
    },
  ]);
});

test('Responses streaming emits refusals once and falls back to terminal refusal content', async () => {
  const refusalItem = {
    id: 'message-refusal',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
  };
  const deltaEvents = [
    {
      type: 'response.refusal.delta',
      item_id: 'message-refusal',
      delta: 'I cannot help with that.',
    },
    {
      type: 'response.refusal.done',
      item_id: 'message-refusal',
      refusal: 'I cannot help with that.',
    },
    {
      type: 'response.completed',
      response: { output: [refusalItem] },
    },
  ];
  const deltaResponse = new Response(
    deltaEvents.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
  const deltaChunks = [];
  for await (const chunk of streamAdapter.streamOpenAIResponsesResponse(
    deltaResponse
  )) {
    deltaChunks.push(chunk);
  }
  assert.deepEqual(deltaChunks, [
    { type: 'content', content: 'I cannot help with that.' },
    {
      type: 'done',
      providerMetadata: {
        [adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: [refusalItem],
      },
    },
  ]);

  const terminalResponse = new Response(
    `data: ${JSON.stringify({
      type: 'response.completed',
      response: { output: [refusalItem] },
    })}\n\n`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }
  );
  const terminalChunks = [];
  for await (const chunk of streamAdapter.streamOpenAIResponsesResponse(
    terminalResponse
  )) {
    terminalChunks.push(chunk);
  }
  assert.deepEqual(terminalChunks, [
    { type: 'content', content: 'I cannot help with that.' },
    {
      type: 'done',
      providerMetadata: {
        [adapter.OPENAI_RESPONSES_OUTPUT_ITEMS_METADATA_KEY]: [refusalItem],
      },
    },
  ]);
});

test('plugin routes and activation keep model discovery scoped to the authenticated user', async () => {
  const pluginService = pluginServiceModule.default;
  const pluginVariablesService = pluginVariablesServiceModule.default;
  const pluginCredentialsService = pluginCredentialsServiceModule.default;
  const plugin = {
    id: 'openai',
    name: 'OpenAI',
    type: 'completion',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'OPENAI_API_KEY',
    },
    model_map: ['gpt-test'],
    variables: [
      {
        name: 'base_url',
        type: 'string',
        label: 'Base URL',
      },
      {
        name: 'api_path',
        type: 'string',
        label: 'API Path',
      },
      {
        name: 'temperature',
        type: 'number',
        label: 'Temperature',
        min: 0,
        max: 2,
      },
    ],
  };

  const originals = {
    activatePlugin: pluginService.activatePlugin,
    clearDiscoveredModels: pluginService.clearDiscoveredModels,
    discoverModels: pluginService.discoverModels,
    getPlugin: pluginService.getPlugin,
    getResolvedVariables: pluginVariablesService.getResolvedVariables,
    deletePluginVariables: pluginVariablesService.deletePluginVariables,
    setVariables: pluginVariablesService.setVariables,
    setApiKey: pluginCredentialsService.setApiKey,
  };

  const findRouteHandler = (routePath, method) => {
    const layer = pluginRoutesModule.default.stack.find(
      candidate =>
        candidate.route?.path === routePath &&
        candidate.route.methods?.[method.toLowerCase()]
    );
    assert.ok(layer, `Expected ${method} ${routePath} route`);
    const routeLayers = layer.route.stack;
    assert.ok(routeLayers.length > 0);
    return routeLayers[routeLayers.length - 1].handle;
  };
  const invokeRoute = async (routePath, method, { body = {}, params = {} }) => {
    let statusCode = 200;
    let payload;
    const response = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(value) {
        payload = value;
        return this;
      },
    };
    await findRouteHandler(routePath, method)(
      {
        body,
        params,
        user: { userId: 'route-user' },
      },
      response
    );
    return { statusCode, payload };
  };

  try {
    pluginService.getPlugin = () => plugin;
    const routeCalls = [];
    pluginService.activatePlugin = pluginId => {
      routeCalls.push({ operation: 'activate', pluginId });
      return true;
    };
    pluginService.clearDiscoveredModels = (pluginId, userId) => {
      routeCalls.push({ operation: 'clear', pluginId, userId });
    };
    pluginService.discoverModels = async (pluginId, userId) => {
      routeCalls.push({ operation: 'discover', pluginId, userId });
      return plugin.model_map;
    };
    pluginVariablesService.getResolvedVariables = () => ({
      base_url: 'https://old.example/v1',
      api_path: '',
      temperature: 0.7,
    });
    pluginVariablesService.setVariables = (
      pluginId,
      variables,
      _schema,
      userId
    ) => {
      routeCalls.push({
        operation: 'save',
        pluginId,
        userId,
        variables,
      });
      return true;
    };
    pluginVariablesService.deletePluginVariables = (pluginId, userId) => {
      routeCalls.push({ operation: 'reset', pluginId, userId });
      return true;
    };
    pluginCredentialsService.setApiKey = (pluginId, _apiKey, userId) => {
      routeCalls.push({ operation: 'credential', pluginId, userId });
      return true;
    };

    assert.equal(
      (
        await invokeRoute('/activate/:id', 'POST', {
          params: { id: 'openai' },
        })
      ).statusCode,
      200
    );
    assert.equal(
      (
        await invokeRoute('/discover/:id', 'POST', {
          params: { id: 'openai' },
        })
      ).statusCode,
      200
    );

    const insecureSave = await invokeRoute('/:id/variables', 'PUT', {
      params: { id: 'openai' },
      body: { variables: { base_url: 'http://public.example/v1' } },
    });
    assert.equal(insecureSave.statusCode, 400);
    assert.match(insecureSave.payload.error, /HTTPS/);

    const traversalSave = await invokeRoute('/:id/variables', 'PUT', {
      params: { id: 'openai' },
      body: { variables: { api_path: '/%2e%2e/admin' } },
    });
    assert.equal(traversalSave.statusCode, 400);
    assert.match(traversalSave.payload.error, /absolute API path/);

    assert.equal(
      (
        await invokeRoute('/:id/variables', 'PUT', {
          params: { id: 'openai' },
          body: {
            variables: { base_url: 'https://gateway.example/v1' },
          },
        })
      ).statusCode,
      200
    );
    assert.equal(
      (
        await invokeRoute('/:id/variables', 'PUT', {
          params: { id: 'openai' },
          body: { variables: { temperature: 0.4 } },
        })
      ).statusCode,
      200
    );
    assert.equal(
      (
        await invokeRoute('/:id/credentials', 'POST', {
          params: { id: 'openai' },
          body: { api_key: 'user-key' },
        })
      ).statusCode,
      200
    );
    assert.equal(
      (
        await invokeRoute('/:id/variables', 'DELETE', {
          params: { id: 'openai' },
        })
      ).statusCode,
      200
    );

    assert.deepEqual(routeCalls, [
      {
        operation: 'activate',
        pluginId: 'openai',
      },
      {
        operation: 'discover',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'save',
        pluginId: 'openai',
        userId: 'route-user',
        variables: { base_url: 'https://gateway.example/v1' },
      },
      {
        operation: 'clear',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'discover',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'save',
        pluginId: 'openai',
        userId: 'route-user',
        variables: { temperature: 0.4 },
      },
      {
        operation: 'credential',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'clear',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'discover',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'reset',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'clear',
        pluginId: 'openai',
        userId: 'route-user',
      },
      {
        operation: 'discover',
        pluginId: 'openai',
        userId: 'route-user',
      },
    ]);
  } finally {
    pluginService.activatePlugin = originals.activatePlugin;
    pluginService.clearDiscoveredModels = originals.clearDiscoveredModels;
    pluginService.discoverModels = originals.discoverModels;
    pluginService.getPlugin = originals.getPlugin;
    pluginVariablesService.getResolvedVariables =
      originals.getResolvedVariables;
    pluginVariablesService.deletePluginVariables =
      originals.deletePluginVariables;
    pluginVariablesService.setVariables = originals.setVariables;
    pluginCredentialsService.setApiKey = originals.setApiKey;
  }
});

test('discovered model maps persist per user without mutating the plugin manifest', async () => {
  const tempDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-webui-discovered-models-')
  );
  const pluginsDirectory = path.join(tempDirectory, 'plugins');
  const previousDataDirectory = process.env.DATA_DIR;
  const previousPluginsDirectory = process.env.PLUGINS_DIR;
  const originalAxiosGet = axios.get;

  process.env.DATA_DIR = tempDirectory;
  process.env.PLUGINS_DIR = pluginsDirectory;

  try {
    const database = databaseModule.getDatabase();
    const now = Date.now();
    const insertUser = database.prepare(`
      INSERT INTO users
        (id, username, email, password_hash, role, created_at, updated_at)
      VALUES (?, ?, NULL, ?, 'user', ?, ?)
    `);
    insertUser.run('model-user-one', 'model-user-one', 'test', now, now);
    insertUser.run('model-user-two', 'model-user-two', 'test', now, now);

    const service = new pluginServiceModule.PluginService();
    service.installPlugin({
      id: 'model-isolation-provider',
      name: 'Model isolation provider',
      type: 'completion',
      endpoint: 'https://fallback.example/v1/chat/completions',
      auth: {
        header: 'Authorization',
        prefix: 'Bearer ',
        key_env: 'MODEL_ISOLATION_API_KEY',
      },
      model_map: ['manifest-model'],
    });
    service.getPluginVariables = (_plugin, userId) => ({
      base_url: `https://${userId}.example/v1`,
    });
    service.getApiKey = (_plugin, userId) => `key-${userId}`;
    axios.get = async url => {
      const host = new URL(url).hostname;
      return {
        data: {
          data: [{ id: `model-${host.split('.')[0]}` }],
        },
      };
    };

    assert.deepEqual(
      await service.discoverModels(
        'model-isolation-provider',
        'model-user-one'
      ),
      ['model-model-user-one']
    );
    assert.deepEqual(
      await service.discoverModels(
        'model-isolation-provider',
        'model-user-two'
      ),
      ['model-model-user-two']
    );
    assert.deepEqual(
      service.getPlugin('model-isolation-provider', 'model-user-one').model_map,
      ['model-model-user-one']
    );
    assert.deepEqual(
      service.getPlugin('model-isolation-provider', 'model-user-two').model_map,
      ['model-model-user-two']
    );
    assert.deepEqual(
      service.getPlugin('model-isolation-provider', 'default').model_map,
      ['manifest-model']
    );

    const reloadedService = new pluginServiceModule.PluginService();
    assert.deepEqual(
      reloadedService.getPlugin('model-isolation-provider', 'model-user-one')
        .model_map,
      ['model-model-user-one']
    );
    assert.deepEqual(
      reloadedService.getPlugin('model-isolation-provider', 'model-user-two')
        .model_map,
      ['model-model-user-two']
    );

    reloadedService.clearDiscoveredModels(
      'model-isolation-provider',
      'model-user-one'
    );
    assert.deepEqual(
      reloadedService.getPlugin('model-isolation-provider', 'model-user-one')
        .model_map,
      ['manifest-model']
    );
    assert.deepEqual(
      reloadedService.getPlugin('model-isolation-provider', 'model-user-two')
        .model_map,
      ['model-model-user-two']
    );
  } finally {
    axios.get = originalAxiosGet;
    databaseModule.closeDatabase();
    if (previousDataDirectory === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = previousDataDirectory;
    }
    if (previousPluginsDirectory === undefined) {
      delete process.env.PLUGINS_DIR;
    } else {
      process.env.PLUGINS_DIR = previousPluginsDirectory;
    }
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});
