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
const chatRequestService = await import(
  pathToFileURL(path.join(distRoot, 'services', 'chatRequestService.js')).href
);
const titleGeneration = await import(
  pathToFileURL(path.join(distRoot, 'services', 'titleGenerationService.js'))
    .href
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

function createTitleGenerationHarness(overrides = {}) {
  const session = {
    id: 'session-1',
    title: 'New Chat',
    model: 'persona:researcher',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
  };
  const updates = [];
  const calls = {
    resolveActualModelName: [],
    prepareGenerationTarget: [],
    executePluginRequest: [],
    generateResponse: [],
  };

  const chatService = {
    getSession: overrides.getSession || (() => session),
    async updateSession(sessionId, update, userId) {
      updates.push({ sessionId, update, userId });
      return {
        ...session,
        ...update,
        updatedAt: 3,
      };
    },
  };

  const chatGenerationService = {
    async resolveActualModelName(sessionModel, userId) {
      calls.resolveActualModelName.push({ sessionModel, userId });
      return overrides.actualModelName || 'resolved-current-model';
    },
    async prepareGenerationTarget(model, userId, options) {
      calls.prepareGenerationTarget.push({ model, userId, options });
      return {
        actualModelName: model,
        mergedOptions: options,
        activePlugin: overrides.activePlugin || null,
        pluginVariables: {},
      };
    },
    extractPluginAssistantContent(response) {
      if (overrides.extractPluginAssistantContent) {
        return overrides.extractPluginAssistantContent(response);
      }
      return response.choices[0].message.content;
    },
  };

  const pluginService = {
    async executePluginRequest(model, messages, options, userId) {
      calls.executePluginRequest.push({ model, messages, options, userId });
      if (overrides.pluginError) {
        throw overrides.pluginError;
      }
      return (
        overrides.pluginResponse || {
          id: 'plugin-title',
          object: 'chat.completion',
          created: 1,
          model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '"Plugin Roadmap!"',
              },
              finish_reason: 'stop',
            },
          ],
        }
      );
    },
  };

  const ollamaService = {
    async generateResponse(request) {
      calls.generateResponse.push(request);
      if (overrides.ollamaError) {
        throw overrides.ollamaError;
      }
      return {
        model: request.model,
        created_at: '2026-06-21T00:00:00Z',
        response: overrides.ollamaResponse || '"Ollama Roadmap."',
        done: true,
      };
    },
  };

  const service = new titleGeneration.TitleGenerationService({
    chatService,
    chatGenerationService,
    pluginService,
    ollamaService,
    now: () => 123,
    logger: { error() {} },
  });

  return {
    service,
    session,
    updates,
    calls,
  };
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

test('buildDocumentEnhancedContent wraps retrieved chunks for generation only', () => {
  assert.equal(
    chatRequestService.buildDocumentEnhancedContent('plain question', []),
    'plain question'
  );
  assert.equal(
    chatRequestService.buildDocumentEnhancedContent('What matters?', [
      'alpha facts',
      'beta facts',
    ]),
    'Context from uploaded documents:\n\nalpha facts\n\n---\n\nbeta facts\n\n---\n\nUser question: What matters?'
  );
});

test('prepareGenerationMessages shares RAG replacement across Ollama and plugin contexts', () => {
  const result = chatRequestService.prepareGenerationMessages({
    isPrivate: false,
    persistedMessages: [
      {
        id: 'system-1',
        role: 'system',
        content: 'old system',
        timestamp: 1,
      },
      {
        id: 'user-1',
        role: 'user',
        content: 'first',
        timestamp: 2,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'answer',
        timestamp: 3,
      },
      {
        id: 'user-2',
        role: 'user',
        content: 'latest',
        timestamp: 4,
      },
    ],
    content: 'latest',
    hasRelevantContext: true,
    enhancedContent: 'context wrapped latest',
    personaSystemPrompt: '  persona prompt  ',
    pluginVariables: {
      system_prompt_prefix: 'Plugin identity',
      stream: 'true',
    },
    now: () => 999,
  });

  assert.equal(result.hasRelevantContext, true);
  assert.equal(result.shouldStreamPlugin, true);
  assert.deepEqual(result.ollamaMessages, [
    { role: 'system', content: 'persona prompt' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'context wrapped latest' },
  ]);
  assert.equal(result.pluginMessages[0].role, 'system');
  assert.equal(result.pluginMessages[0].content, 'Plugin identity');
  assert.equal(result.pluginMessages[0].timestamp, 999);
  assert.equal(
    result.pluginMessages[result.pluginMessages.length - 1].content,
    'context wrapped latest'
  );
});

test('prepareGenerationMessages appends private current messages once', () => {
  const history = [
    { role: 'user', content: 'old prompt' },
    { role: 'assistant', content: 'old answer' },
  ];

  const normal = chatRequestService.prepareGenerationMessages({
    isPrivate: true,
    persistedMessages: [],
    messageHistory: history,
    content: 'new prompt',
    images: ['data:image/png;base64,abc123'],
    hasRelevantContext: true,
    enhancedContent: 'context wrapped new prompt',
  });

  assert.equal(normal.contextMessages.length, 3);
  assert.equal(normal.contextMessages[2].content, 'new prompt');
  assert.equal(normal.ollamaMessages[2].content, 'context wrapped new prompt');
  assert.deepEqual(normal.ollamaMessages[2].images, ['abc123']);
  assert.equal(normal.pluginMessages[2].content, 'context wrapped new prompt');

  const regenerated = chatRequestService.prepareGenerationMessages({
    isPrivate: true,
    persistedMessages: [],
    messageHistory: history,
    regenerate: true,
    content: 'ignored prompt',
  });

  assert.equal(regenerated.contextMessages.length, 2);
  assert.equal(regenerated.contextMessages[1].content, 'old answer');
});

test('ChatRequestService prepares target, persona prompt, and shared messages', async () => {
  const calls = {
    prepareGenerationTarget: [],
    getPersonaById: [],
  };
  const service = new chatRequestService.ChatRequestService({
    chatGenerationService: {
      async prepareGenerationTarget(model, userId, options) {
        calls.prepareGenerationTarget.push({ model, userId, options });
        return {
          actualModelName: 'resolved-model',
          mergedOptions: options,
          activePlugin: null,
          pluginVariables: {
            stream: false,
          },
        };
      },
    },
    personaService: {
      async getPersonaById(id, userId) {
        calls.getPersonaById.push({ id, userId });
        return {
          parameters: {
            system_prompt: 'Persona system',
          },
        };
      },
    },
  });

  const result = await service.prepareGenerationRequest({
    session: {
      model: 'persona:researcher',
      personaId: 'researcher',
    },
    userId: 'alice',
    options: {
      temperature: 0.4,
    },
    persistedMessages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ],
    content: 'hello',
  });

  assert.deepEqual(calls.prepareGenerationTarget, [
    {
      model: 'persona:researcher',
      userId: 'alice',
      options: {
        temperature: 0.4,
      },
    },
  ]);
  assert.deepEqual(calls.getPersonaById, [
    {
      id: 'researcher',
      userId: 'alice',
    },
  ]);
  assert.equal(result.target.actualModelName, 'resolved-model');
  assert.equal(result.actualModelName, 'resolved-model');
  assert.deepEqual(result.ollamaMessages, [
    { role: 'system', content: 'Persona system' },
    { role: 'user', content: 'hello' },
  ]);
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
          db.prepare(
            `INSERT INTO users (id, username, password_hash, role, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            'plugin-fixture-admin',
            'plugin-fixture-admin',
            'test-hash',
            'admin',
            now,
            now
          );

          const credentialsService = (
            await import(
              pathToFileURL(
                path.join(distRoot, 'services', 'pluginCredentialsService.js')
              ).href
            )
          ).default;
          const pluginService = (
            await import(
              pathToFileURL(
                path.join(distRoot, 'services', 'pluginService.js')
              ).href
            )
          ).default;
          const chatGenerationService = (
            await import(
              `${pathToFileURL(path.join(distRoot, 'services', 'chatGenerationService.js')).href}?generationRouteTest=${Date.now()}`
            )
          ).default;

          for (const pluginId of ['active-plugin', 'inactive-plugin']) {
            pluginService.installPlugin(
              JSON.parse(
                fs.readFileSync(
                  path.join(pluginsDir, `${pluginId}.json`),
                  'utf8'
                )
              ),
              'plugin-fixture-admin'
            );
          }
          assert.equal(
            await pluginService.activatePlugin('active-plugin', 'alice'),
            true
          );
          assert.equal(
            credentialsService.setApiKey(
              'active-plugin',
              'alice-key',
              'alice',
              pluginService.getCredentialRoutingAuthFingerprint(
                pluginService.getPlugin('active-plugin', 'alice'),
                'alice'
              )
            ),
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
  assert.doesNotThrow(() =>
    pluginValidation.validatePluginModel('~openai/gpt-latest')
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

test('plugin model discovery resolves Anthropic Messages endpoints', () => {
  const anthropicPlugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'anthropic.json'), 'utf8')
  );

  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(
      'https://api.anthropic.com/v1/messages'
    ),
    'https://api.anthropic.com/v1/models'
  );
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(
      'https://api.example.com/v1/chat/completions?preview=true'
    ),
    'https://api.example.com/v1/models'
  );
  assert.deepEqual(
    pluginValidation.buildPluginModelDiscoveryHeaders(
      anthropicPlugin,
      'test-anthropic-key'
    ),
    {
      Accept: 'application/json',
      'x-api-key': 'test-anthropic-key',
      'anthropic-version': '2023-06-01',
    }
  );
});

test('Kimi Code plugin omits model-fixed sampling parameters', () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'kimi-code.json'), 'utf8')
  );
  const headers = pluginValidation.buildPluginAuthHeaders(
    plugin,
    'test-kimi-key'
  );
  const { payload } = pluginChatAdapter.buildPluginChatPayload(
    plugin,
    'k3',
    [
      {
        role: 'system',
        content: 'Be precise.',
      },
      {
        role: 'user',
        content: 'Review this function.',
      },
    ],
    { temperature: 0.2, top_p: 0.4, num_predict: 8192 },
    {
      stream: true,
      temperature: 0.3,
      top_p: 0.8,
      frequency_penalty: 1,
      presence_penalty: 1,
    }
  );

  assert.deepEqual(headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-kimi-key',
  });
  assert.equal(
    plugin.endpoint,
    'https://api.kimi.com/coding/v1/chat/completions'
  );
  assert.equal(payload.model, 'k3');
  assert.equal('temperature' in payload, false);
  assert.equal('top_p' in payload, false);
  assert.equal('frequency_penalty' in payload, false);
  assert.equal('presence_penalty' in payload, false);
  assert.equal(payload.max_tokens, 8192);
  assert.equal(payload.stream, true);
  assert.deepEqual(payload.messages, [
    { role: 'system', content: 'Be precise.' },
    { role: 'user', content: 'Review this function.' },
  ]);
  assert.equal('reasoning_effort' in payload, false);
});

test('non-stream plugin payloads override a persisted streaming preference', () => {
  const plugin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', 'kimi-code.json'), 'utf8')
  );
  const { payload } = pluginChatAdapter.buildPluginChatPayload(
    plugin,
    'k3',
    [{ role: 'user', content: 'Generate a title.' }],
    { num_predict: 20 },
    { stream: true },
    false
  );

  assert.equal(payload.stream, false);
});

test('Kimi Code policy hides obsolete sampling controls after upgrades', () => {
  const existingPlugin = {
    id: 'kimi-code',
    variables: [
      { name: 'endpoint' },
      { name: 'temperature' },
      { name: 'max_tokens' },
      { name: 'top_p' },
      { name: 'frequency_penalty' },
      { name: 'presence_penalty' },
      { name: 'stream' },
    ],
  };
  const normalized =
    pluginChatAdapter.applyPluginDefinitionPolicy(existingPlugin);

  assert.deepEqual(
    normalized.variables.map(variable => variable.name),
    ['endpoint', 'max_tokens', 'stream']
  );
  assert.equal(existingPlugin.variables.length, 7);

  const otherPlugin = { ...existingPlugin, id: 'openai' };
  assert.equal(
    pluginChatAdapter.applyPluginDefinitionPolicy(otherPlugin),
    otherPlugin
  );
});

test('buildPluginChatPayload adapts Anthropic multimodal chat requests', () => {
  const { payload, headers } = pluginChatAdapter.buildPluginChatPayload(
    { id: 'anthropic' },
    'claude-opus-4-6',
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
  assert.equal(payload.model, 'claude-opus-4-6');
  assert.equal(payload.max_tokens, 128);
  assert.equal(payload.top_p, 0.8);
  assert.equal('temperature' in payload, false);
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

test('buildPluginChatPayload uses Anthropic defaults for Claude Opus 5', () => {
  const { payload, headers } = pluginChatAdapter.buildPluginChatPayload(
    { id: 'anthropic' },
    'claude-opus-5',
    [{ role: 'user', content: 'Review this change.' }],
    { temperature: 0.2, num_predict: 128 },
    { top_p: 0.8 },
    true
  );

  assert.deepEqual(headers, { 'anthropic-version': '2023-06-01' });
  assert.equal(payload.model, 'claude-opus-5');
  assert.equal(payload.max_tokens, 128);
  assert.equal(payload.stream, true);
  assert.equal('temperature' in payload, false);
  assert.equal('top_p' in payload, false);
  assert.equal('frequency_penalty' in payload, false);
  assert.equal('presence_penalty' in payload, false);
  assert.deepEqual(payload.messages, [
    { role: 'user', content: 'Review this change.' },
  ]);
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

test('streamAnthropicResponse parses text and tool call events', async () => {
  const body = [
    'event: message_start',
    'data: {"type":"message_start","message":{"content":[]}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private reasoning"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"render","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"ok\\":"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"true}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":2}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');

  const chunks = [];
  for await (const chunk of pluginStreamAdapter.streamAnthropicResponse(
    new Response(body)
  )) {
    chunks.push(chunk);
  }

  assert.deepEqual(chunks, [
    { type: 'reasoning', content: 'private reasoning' },
    { type: 'content', content: 'Hello' },
    {
      type: 'tool_call',
      toolCall: {
        id: 'toolu_1',
        name: 'render',
        arguments: '{"ok":true}',
        providerMetadata: {
          anthropicThinkingBlocks: [
            {
              type: 'thinking',
              thinking: 'private reasoning',
              signature: '',
            },
          ],
        },
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

test('title generation resolves the current running model sentinel', async () => {
  const { service, session, calls } = createTitleGenerationHarness({
    actualModelName: 'qwen3:latest',
  });

  const currentModel = await service.resolveTitleGenerationModel(
    titleGeneration.AUTO_TITLE_CURRENT_MODEL,
    session,
    'alice'
  );
  const explicitModel = await service.resolveTitleGenerationModel(
    'llama3.3:latest',
    session,
    'alice'
  );

  assert.equal(currentModel, 'qwen3:latest');
  assert.equal(explicitModel, 'llama3.3:latest');
  assert.deepEqual(calls.resolveActualModelName, [
    {
      sessionModel: 'persona:researcher',
      userId: 'alice',
    },
  ]);
});

test('title generation uses plugin providers and stores sanitized titles', async () => {
  const { service, updates, calls } = createTitleGenerationHarness({
    activePlugin: { id: 'plugin-title-provider' },
  });

  const result = await service.generateTitleForSession({
    sessionId: 'session-1',
    requestedModel: 'plugin-model',
    message: 'Plan a secure product roadmap with milestones',
    userId: 'alice',
  });

  assert.equal(result.title, 'Plugin Roadmap');
  assert.equal(result.model, 'plugin-model');
  assert.equal(result.source, 'plugin');
  assert.equal(calls.generateResponse.length, 0);
  assert.equal(calls.executePluginRequest.length, 1);
  assert.equal(calls.executePluginRequest[0].model, 'plugin-model');
  assert.equal(calls.executePluginRequest[0].messages[0].id, 'title-session-1');
  assert.match(
    calls.executePluginRequest[0].messages[0].content,
    /Plan a secure product roadmap/
  );
  assert.deepEqual(updates[0], {
    sessionId: 'session-1',
    update: { title: 'Plugin Roadmap' },
    userId: 'alice',
  });
});

test('title generation falls back to Ollama when no plugin is active', async () => {
  const { service, updates, calls } = createTitleGenerationHarness({
    ollamaResponse: "'Ollama Planning?'",
  });

  const result = await service.generateTitleForSession({
    sessionId: 'session-1',
    requestedModel: 'llama3.3:latest',
    message: 'Explain how to harden a Linux server',
    userId: 'alice',
  });

  assert.equal(result.title, 'Ollama Planning');
  assert.equal(result.source, 'ollama');
  assert.equal(result.session.updatedAt, 3);
  assert.equal(calls.executePluginRequest.length, 0);
  assert.equal(calls.generateResponse.length, 1);
  assert.equal(calls.generateResponse[0].model, 'llama3.3:latest');
  assert.equal(calls.generateResponse[0].think, false);
  assert.equal(
    Object.hasOwn(calls.generateResponse[0].options, 'think'),
    false
  );
  assert.deepEqual(calls.generateResponse[0].options.stop, [
    '\n',
    '.',
    '!',
    '?',
  ]);
  assert.equal(calls.generateResponse[0].options.temperature, 0.3);
  assert.equal(calls.generateResponse[0].options.num_predict, 20);
  assert.deepEqual(updates[0].update, { title: 'Ollama Planning' });
});

test('title generation falls back to the message when providers fail', async () => {
  const { service, updates } = createTitleGenerationHarness({
    ollamaError: new Error('offline'),
  });

  const result = await service.generateTitleForSession({
    sessionId: 'session-1',
    requestedModel: 'llama3.3:latest',
    message: 'This message is long enough to become a fallback title',
    userId: 'alice',
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.title, 'This message is long enough to...');
  assert.deepEqual(updates[0].update, {
    title: 'This message is long enough to...',
  });
});

test('title generation labels empty provider output as fallback', async () => {
  const { service, updates } = createTitleGenerationHarness({
    ollamaResponse: '   ',
  });

  const result = await service.generateTitleForSession({
    sessionId: 'session-1',
    requestedModel: 'llama3.3:latest',
    message: 'Explain the deployment architecture',
    userId: 'alice',
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.title, 'Explain the deployment archite...');
  assert.deepEqual(updates[0].update, {
    title: 'Explain the deployment archite...',
  });
});

test('sanitizeGeneratedTitle strips wrappers and preserves verbose generated titles', () => {
  assert.equal(
    titleGeneration.sanitizeGeneratedTitle(
      '  `"Title: Mars Transfer Simulator!!!"`  ',
      'fallback message'
    ),
    'Mars Transfer Simulator'
  );

  const verboseTitle = titleGeneration.sanitizeGeneratedTitleResult(
    'This generated title is far too long for the sidebar and should never be used directly',
    'Use this user message as the title instead'
  );
  assert.equal(verboseTitle.usedFallback, false);
  assert.match(verboseTitle.title, /^This generated title/);
  assert.ok(verboseTitle.title.length <= 50);
  assert.notEqual(verboseTitle.title, 'Use this user message as the t...');

  assert.deepEqual(
    titleGeneration.sanitizeGeneratedTitleResult('', 'short prompt'),
    {
      title: 'short prompt',
      usedFallback: true,
    }
  );
});
