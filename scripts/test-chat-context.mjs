import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');

const chatContext = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'chatContext.js')).href
);
const pluginResponse = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginResponse.js')).href
);
const assistantBranching = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'assistantBranching.js')).href
);
const websocketMessages = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'websocketMessages.js')).href
);
const pluginChatContext = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginChatContext.js')).href
);
const pluginStreaming = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginStreaming.js')).href
);
const pluginChatAdapter = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginChatAdapter.js')).href
);
const pluginValidation = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginValidation.js')).href
);
const pluginStreamAdapter = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'pluginStreamAdapter.js')).href
);
const ollamaStreaming = await import(
  pathToFileURL(path.join(distRoot, 'utils', 'ollamaStreaming.js')).href
);

function withEnv(overrides, run) {
  const previous = {};

  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

test('replaceLatestUserMessageContent updates the latest user message without appending', () => {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'first prompt' },
    { role: 'assistant', content: 'first answer' },
    { role: 'user', content: 'latest prompt' },
  ];

  const result = chatContext.replaceLatestUserMessageContent(
    messages,
    'context wrapped latest prompt'
  );

  assert.equal(result.length, messages.length);
  assert.equal(result[1].content, 'first prompt');
  assert.equal(result[3].content, 'context wrapped latest prompt');
  assert.equal(messages[3].content, 'latest prompt');
});

test('toOllamaMessages replaces latest user content and normalizes image payloads', () => {
  const result = chatContext.toOllamaMessages(
    [
      {
        role: 'user',
        content: 'see this',
        images: ['data:image/png;base64,abc123', 'raw456'],
      },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'now answer' },
    ],
    { latestUserContent: 'answer with document context' }
  );

  assert.deepEqual(result, [
    {
      role: 'user',
      content: 'see this',
      images: ['abc123', 'raw456'],
    },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'answer with document context' },
  ]);
});

test('withSystemPrompt replaces stale system messages with the persona prompt', () => {
  const result = chatContext.withSystemPrompt(
    [
      { role: 'system', content: 'old system' },
      { role: 'user', content: 'hello' },
    ],
    '  persona system  '
  );

  assert.deepEqual(result, [
    { role: 'system', content: 'persona system' },
    { role: 'user', content: 'hello' },
  ]);
});

test('extractPluginAssistantContent converts multimodal blocks and tool calls', () => {
  const result = pluginResponse.extractPluginAssistantContent({
    id: 'response-1',
    object: 'chat.completion',
    created: Date.now(),
    model: 'plugin-model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Here is the image' },
            {
              type: 'image_url',
              image_url: { url: 'https://example.test/image.png' },
            },
          ],
          tool_calls: [
            {
              id: 'call-1',
              function: {
                name: 'render',
                arguments: '{"ok":true}',
              },
            },
          ],
        },
        finish_reason: 'stop',
      },
    ],
  });

  assert.equal(
    result,
    'Here is the image\n\n![image](https://example.test/image.png)\n\n---\n**🔧 Tool Calls:**\n\n**render** (`call-1`)\n```json\n{\n  "ok": true\n}\n```\n'
  );
});

test('assistant completion branch fields target the original parent group', () => {
  const session = {
    id: 'session-1',
    title: 'Branch test',
    model: 'test-model',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      {
        id: 'root-answer',
        role: 'assistant',
        content: 'first',
        timestamp: Date.now(),
      },
      {
        id: 'existing-variant',
        role: 'assistant',
        content: 'variant',
        timestamp: Date.now(),
        parentId: 'root-answer',
        branchIndex: 1,
      },
    ],
  };

  assert.deepEqual(
    assistantBranching.buildAssistantBranchingFields(
      session,
      true,
      'existing-variant'
    ),
    {
      parentId: 'root-answer',
      branchIndex: 2,
      isActive: true,
    }
  );
});

test('buildAssistantFakeStreamChunks batches non-streaming output like chat streaming', () => {
  const chunks = websocketMessages.buildAssistantFakeStreamChunks(
    'alpha beta gamma delta',
    'assistant-1'
  );

  assert.deepEqual(chunks, [
    {
      content: 'alpha beta gamma ',
      total: 'alpha beta gamma',
      done: false,
      messageId: 'assistant-1',
    },
    {
      content: 'delta',
      total: 'alpha beta gamma delta',
      done: true,
      messageId: 'assistant-1',
    },
  ]);
});

test('preparePluginChatContext adds the current private user message unless regenerating', () => {
  const history = [
    { role: 'user', content: 'old prompt' },
    { role: 'assistant', content: 'old answer' },
  ];

  const normal = pluginChatContext.preparePluginChatContext({
    isPrivate: true,
    persistedMessages: [],
    messageHistory: history,
    content: 'new prompt',
    images: ['image-1'],
  });

  assert.equal(normal.messages.length, 3);
  assert.equal(normal.messages[2].role, 'user');
  assert.equal(normal.messages[2].content, 'new prompt');
  assert.deepEqual(normal.messages[2].images, ['image-1']);

  const regenerated = pluginChatContext.preparePluginChatContext({
    isPrivate: true,
    persistedMessages: [],
    messageHistory: history,
    regenerate: true,
    content: 'ignored prompt',
  });

  assert.equal(regenerated.messages.length, 2);
  assert.equal(regenerated.messages[1].content, 'old answer');
});

test('preparePluginChatContext replaces the latest user message with RAG content', () => {
  const result = pluginChatContext.preparePluginChatContext({
    isPrivate: false,
    persistedMessages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'first',
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'answer',
        timestamp: 2,
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'latest',
        timestamp: 3,
      },
    ],
    content: 'latest',
    hasRelevantContext: true,
    enhancedContent: 'context wrapped latest',
  });

  assert.equal(result.messages.length, 3);
  assert.equal(result.messages[0].content, 'first');
  assert.equal(result.messages[2].content, 'context wrapped latest');
});

test('preparePluginChatContext prepends plugin identity and resolves stream flag', () => {
  const result = pluginChatContext.preparePluginChatContext({
    isPrivate: false,
    persistedMessages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ],
    content: 'hello',
    pluginVariables: {
      system_prompt_prefix: 'You are Libre',
      user_name: 'Robin',
      stream: 'true',
    },
    now: () => 123,
  });

  assert.equal(result.shouldStream, true);
  assert.deepEqual(result.messages[0], {
    id: 'system-identity',
    role: 'system',
    content: "You are Libre\n\nThe user's name is: Robin",
    timestamp: 123,
  });
  assert.equal(
    pluginChatContext.resolvePluginStreamFlag('false'),
    false,
    'string false should not enable streaming'
  );
});

test('streamPluginResponse emits chunks and appends formatted tool calls', async () => {
  const sent = [];
  const ws = {
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };

  async function* chunks() {
    yield { type: 'content', content: 'Hel' };
    yield { type: 'content', content: 'lo' };
    yield {
      type: 'tool_call',
      toolCall: {
        id: 'call-1',
        name: 'render',
        arguments: '{"ok":true}',
      },
    };
    yield { type: 'done' };
  }

  const content = await pluginStreaming.streamPluginResponse({
    ws,
    chunks: chunks(),
    messageId: 'assistant-1',
    pauseThresholdMs: 60000,
  });

  assert.equal(
    content,
    'Hello\n\n---\n**🔧 Tool Calls:**\n\n**render** (`call-1`)\n```json\n{\n  "ok": true\n}\n```\n'
  );
  assert.deepEqual(
    sent.map(message => message.type),
    [
      'assistant_chunk',
      'assistant_chunk',
      'tool_status',
      'tool_status',
      'assistant_chunk',
    ]
  );
  assert.deepEqual(sent[0].data, {
    content: 'Hel',
    total: 'Hel',
    done: false,
    messageId: 'assistant-1',
  });
  assert.deepEqual(sent[2].data, {
    toolCallId: 'tool-activity',
    name: 'render',
    phase: 'running',
  });
  assert.equal(sent[4].data.done, true);
  assert.equal(sent[4].data.total, content);
});

test('plugin model routing requires an active plugin and the current user credentials', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-plugin-route-'));
  const pluginsDir = path.join(tempDir, 'plugins');
  const dataDir = path.join(tempDir, 'data');
  const previousCwd = process.cwd();

  const writePlugin = plugin => {
    fs.writeFileSync(
      path.join(pluginsDir, `${plugin.id}.json`),
      JSON.stringify(plugin, null, 2)
    );
  };

  fs.mkdirSync(pluginsDir, { recursive: true });
  writePlugin({
    id: 'active-plugin',
    name: 'Active Plugin',
    type: 'completion',
    endpoint: 'https://example.invalid/v1/chat/completions',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'ACTIVE_PLUGIN_TEST_KEY',
    },
    model_map: ['shared-model'],
  });
  writePlugin({
    id: 'inactive-plugin',
    name: 'Inactive Plugin',
    type: 'completion',
    endpoint: 'https://example.invalid/v1/chat/completions',
    auth: {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'INACTIVE_PLUGIN_TEST_KEY',
    },
    model_map: ['shared-model', 'inactive-only-model'],
  });
  fs.writeFileSync(
    path.join(pluginsDir, '.status.json'),
    JSON.stringify({ activePlugins: ['active-plugin'] }, null, 2)
  );

  try {
    await withEnv(
      {
        ACTIVE_PLUGIN_TEST_KEY: undefined,
        INACTIVE_PLUGIN_TEST_KEY: undefined,
        DATA_DIR: dataDir,
        ENCRYPTION_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      async () => {
        process.chdir(tempDir);

        const { getDatabaseSafe } = await import(
          pathToFileURL(path.join(distRoot, 'db.js')).href
        );
        const db = getDatabaseSafe();

        try {
          assert.ok(db, 'test database should be available');

          const now = Date.now();
          db.prepare(
            `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run('alice', 'alice', 'test-hash', 'user', now, now);

          const credentialsService = (
            await import(
              pathToFileURL(
                path.join(distRoot, 'services', 'pluginCredentialsService.js')
              ).href
            )
          ).default;
          const chatGenerationService = (
            await import(
              `${pathToFileURL(path.join(distRoot, 'services', 'chatGenerationService.js')).href}?generationRouteTest=${Date.now()}`
            )
          ).default;

          assert.equal(
            credentialsService.setApiKey('active-plugin', 'alice-key', 'alice'),
            true
          );

          const aliceTarget =
            await chatGenerationService.prepareGenerationTarget(
              'shared-model',
              'alice',
              { temperature: 0.2 }
            );
          assert.equal(aliceTarget.actualModelName, 'shared-model');
          assert.equal(aliceTarget.mergedOptions.temperature, 0.2);
          assert.equal(aliceTarget.activePlugin?.id, 'active-plugin');

          assert.equal(
            (
              await chatGenerationService.prepareGenerationTarget(
                'shared-model',
                'bob'
              )
            ).activePlugin,
            null
          );
          assert.equal(
            (
              await chatGenerationService.prepareGenerationTarget(
                'inactive-only-model',
                'alice'
              )
            ).activePlugin,
            null
          );
        } finally {
          db?.close();
          process.chdir(previousCwd);
        }
      }
    );
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('plugin validation rejects unsafe models and remote HTTP endpoints', () => {
  assert.doesNotThrow(() =>
    pluginValidation.validatePluginModel('kimi-k2.7-code:cloud')
  );
  assert.throws(
    () => pluginValidation.validatePluginModel('../secret'),
    /invalid patterns/
  );
  assert.throws(
    () => pluginValidation.assertSafePluginEndpoint('http://example.com/v1'),
    /Insecure endpoint protocol/
  );
  assert.doesNotThrow(() =>
    pluginValidation.assertSafePluginEndpoint(
      'http://127.0.0.1:11434/v1/chat/completions'
    )
  );
});

test('OpenClaw session routing uses HTTP session headers', () => {
  const headers = {};
  pluginValidation.addOpenClawSessionHeader(
    { id: 'openclaw-agent' },
    { session_key: 'research' },
    headers
  );
  assert.equal(headers['x-openclaw-session-key'], 'research');

  const disabledHeaders = {};
  pluginValidation.addOpenClawSessionHeader(
    { id: 'openclaw-agent' },
    { session_key: 'research', session_mode: false },
    disabledHeaders
  );
  assert.deepEqual(disabledHeaders, {});
});

test('buildPluginChatPayload adapts Anthropic multimodal chat requests', () => {
  const { payload, headers } = pluginChatAdapter.buildPluginChatPayload(
    { id: 'anthropic' },
    'claude-test',
    [
      { role: 'system', content: 'Be concise.' },
      {
        role: 'user',
        content: 'describe',
        images: ['data:image/png;base64,aGVsbG8='],
      },
    ],
    { temperature: 0.2, num_predict: 128, stop: ['END'] },
    { top_p: 0.8 }
  );

  assert.deepEqual(headers, { 'anthropic-version': '2023-06-01' });
  assert.equal(payload.system, 'Be concise.');
  assert.equal(payload.model, 'claude-test');
  assert.equal(payload.max_tokens, 128);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.stop_sequences[0], 'END');
  assert.equal(payload.messages.length, 1);
  assert.equal(payload.messages[0].content[0].type, 'image');
  assert.equal(payload.messages[0].content[0].source.media_type, 'image/png');
  assert.equal(payload.messages[0].content[0].source.data, 'aGVsbG8=');
  assert.deepEqual(payload.messages[0].content[1], {
    type: 'text',
    text: 'describe',
  });
});

test('convertProviderResponse normalizes Gemini responses', () => {
  const response = pluginChatAdapter.convertProviderResponse(
    { id: 'gemini' },
    {
      candidates: [
        {
          content: {
            parts: [{ text: 'Hello ' }, { text: 'there' }],
          },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 4,
      },
    },
    'gemini-test'
  );

  assert.equal(response.model, 'gemini-test');
  assert.equal(response.choices[0].message.content, 'Hello there');
  assert.equal(response.choices[0].finish_reason, 'length');
  assert.deepEqual(response.usage, {
    prompt_tokens: 3,
    completion_tokens: 4,
    total_tokens: 7,
  });
});

test('streamOpenAICompatibleResponse parses content and tool call deltas', async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"lo"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"render","arguments":"{\\"ok\\""}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":true}"}}]}}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');

  const chunks = [];
  for await (const chunk of pluginStreamAdapter.streamOpenAICompatibleResponse(
    new Response(body)
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { type: 'content', content: 'Hel' },
    { type: 'content', content: 'lo' },
    {
      type: 'tool_call',
      toolCall: {
        id: 'call-1',
        name: 'render',
        arguments: '{"ok":true}',
      },
    },
    { type: 'done' },
  ]);
});

test('streamOllamaChatResponse streams chunks, extracts stats, and completes once', async () => {
  const sent = [];
  const ws = {
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  let completeCallbackCalls = 0;
  const streamSource = {
    async generateChatStreamResponse(_request, onChunk, onError, onComplete) {
      onChunk({
        model: 'llama-test',
        created_at: '2026-06-21T00:00:00Z',
        message: { role: 'assistant', content: 'Hel' },
        done: false,
      });
      onChunk({
        model: 'llama-test',
        created_at: '2026-06-21T00:00:01Z',
        message: { role: 'assistant', content: 'lo' },
        done: true,
        total_duration: 100,
        eval_count: 10,
        eval_duration: 2_000_000_000,
      });
      completeCallbackCalls += 2;
      onComplete();
      onComplete();
      onError(new Error('late error'));
    },
  };

  const result = await ollamaStreaming.streamOllamaChatResponse({
    ws,
    request: {
      model: 'llama-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
    streamSource,
    messageId: 'assistant-1',
  });

  assert.equal(result.completed, true);
  assert.equal(result.content, 'Hello');
  assert.equal(result.statistics.model, 'llama-test');
  assert.equal(result.statistics.total_duration, 100);
  assert.equal(result.statistics.tokens_per_second, 5);
  assert.equal(completeCallbackCalls, 2);
  assert.deepEqual(
    sent.map(message => message.type),
    ['assistant_chunk', 'assistant_chunk']
  );
  assert.deepEqual(sent[1].data, {
    content: 'lo',
    total: 'Hello',
    done: true,
    messageId: 'assistant-1',
  });
});

test('streamOllamaChatResponse sends errors without completing', async () => {
  const sent = [];
  const ws = {
    send(payload) {
      sent.push(JSON.parse(payload));
    },
  };
  const streamSource = {
    async generateChatStreamResponse(_request, _onChunk, onError) {
      onError(new Error('model unavailable'));
    },
  };

  const result = await ollamaStreaming.streamOllamaChatResponse({
    ws,
    request: {
      model: 'llama-test',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
    streamSource,
  });

  assert.equal(result.completed, false);
  assert.equal(result.content, '');
  assert.equal(result.error.message, 'model unavailable');
  assert.deepEqual(sent, [
    { type: 'error', data: { error: 'model unavailable' } },
  ]);
});
