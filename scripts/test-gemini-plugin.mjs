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

/*
 * The bundled Gemini provider: the model list and its trust anchor, the
 * generateContent request Chat builds (whole conversation, system
 * instruction, images, tools, thought signatures), thinking levels against
 * budgets, and the streamGenerateContent reader Chat and Work share.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const pluginDefinitionTrust = await distModule(
  'utils/pluginDefinitionTrust.js'
);
const chatAdapter = await distModule('utils/pluginChatAdapter.js');
const gemini = await distModule('utils/geminiProtocol.js');
const pluginModelCatalog = await distModule('utils/pluginModelCatalog.js');

const plugin = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'gemini.json'), 'utf8')
);

const message = (role, content, extra = {}) => ({
  id: `${role}-${content.length}`,
  role,
  content,
  timestamp: 1,
  ...extra,
});

const build = (model, messages, options = {}, variables = {}) =>
  chatAdapter.buildPluginChatPayload(
    plugin,
    model,
    messages,
    options,
    variables,
    true
  ).payload;

const sse = events =>
  new Response(
    events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  );

const collect = async chunks => {
  const out = [];
  for await (const chunk of chunks) out.push(chunk);
  return out;
};

test('the Gemini manifest lists the current models and matches its trust anchor', () => {
  for (const model of [
    'gemini-4-hydrogen',
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
  ]) {
    assert.ok(plugin.model_map.includes(model), `${model} is listed`);
  }
  // Google routes gemini-3.5-flash to 3.6 Flash and no longer offers it.
  assert.equal(plugin.model_map.includes('gemini-3.5-flash'), false);
  assert.equal(new Set(plugin.model_map).size, plugin.model_map.length);
  assert.equal(
    pluginDefinitionTrust.getPluginDefinitionFingerprint(plugin),
    pluginDefinitionTrust.BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS.gemini
  );
  for (const model of plugin.model_map) {
    assert.equal(
      pluginModelCatalog.inferReasoningFromModelId(model),
      model === 'gemini-flash-latest' ? undefined : true,
      `${model} reasons`
    );
  }
});

test('Chat sends Gemini the whole conversation with its system prompt and images', () => {
  const payload = build('gemini-4-hydrogen', [
    message('system', 'Answer in French.'),
    message('user', 'What is in this picture?', {
      images: ['data:image/png;base64,iVBORw0KGgo='],
    }),
    message('assistant', 'Un chat.'),
    message('system', '[Conversation summary] The user likes cats.'),
    message('user', 'And its color?'),
  ]);

  assert.deepEqual(payload.systemInstruction, {
    parts: [
      {
        text: 'Answer in French.\n[Conversation summary] The user likes cats.',
      },
    ],
  });
  assert.deepEqual(payload.contents, [
    {
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } },
        { text: 'What is in this picture?' },
      ],
    },
    { role: 'model', parts: [{ text: 'Un chat.' }] },
    { role: 'user', parts: [{ text: 'And its color?' }] },
  ]);
  // Streaming is a different method, never a body field.
  assert.equal('stream' in payload, false);
  assert.equal('stream_options' in payload, false);
});

test('Gemini 3.6 and later get no sampling parameters; earlier models keep them', () => {
  const variables = { temperature: 0.3, top_p: 0.8 };
  for (const model of [
    'gemini-4-hydrogen',
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
  ]) {
    const config = build(
      model,
      [message('user', 'Hi')],
      {},
      variables
    ).generationConfig;
    assert.equal('temperature' in config, false, model);
    assert.equal('topP' in config, false, model);
  }
  for (const model of ['gemini-3.5-flash-lite', 'gemini-2.5-pro']) {
    const config = build(
      model,
      [message('user', 'Hi')],
      {},
      variables
    ).generationConfig;
    assert.equal(config.temperature, 0.3, model);
    assert.equal(config.topP, 0.8, model);
  }
});

test('Gemini 3 and later take a thinking level; Gemini 2.5 keeps its budget', () => {
  const config = (model, think, extra = {}) =>
    build(model, [message('user', 'Plan it.')], { think, ...extra })
      .generationConfig;

  assert.deepEqual(config('gemini-4-hydrogen', 'high').thinkingConfig, {
    thinkingLevel: 'HIGH',
    includeThoughts: true,
  });
  assert.deepEqual(config('gemini-3.8-flash', 'low').thinkingConfig, {
    thinkingLevel: 'LOW',
    includeThoughts: true,
  });
  // On without a level leaves the model at its own default level.
  assert.deepEqual(config('gemini-4-carbon', true).thinkingConfig, {
    includeThoughts: true,
  });
  // Off is the near-off `minimal` level where it exists...
  assert.deepEqual(config('gemini-3.6-flash', false).thinkingConfig, {
    thinkingLevel: 'MINIMAL',
  });
  // ...and nothing on the models that reject it.
  assert.equal('thinkingConfig' in config('gemini-4-hydrogen', false), false);
  assert.equal('thinkingConfig' in config('gemini-3.8-flash', false), false);
  assert.equal('thinkingConfig' in config('gemini-4-argon', undefined), false);

  // A level has no size: the ceiling is what was asked for, capped at the
  // model's 65,536-token output, or the model's own when nothing was.
  assert.equal(
    config('gemini-4-hydrogen', 'high', { num_predict: 4096 }).maxOutputTokens,
    4096
  );
  assert.equal(
    config('gemini-4-hydrogen', 'high', { num_predict: 200000 })
      .maxOutputTokens,
    65536
  );
  assert.equal('maxOutputTokens' in config('gemini-4-hydrogen', 'high'), false);

  assert.deepEqual(config('gemini-2.5-flash', 'low').thinkingConfig, {
    thinkingBudget: 2048,
    includeThoughts: true,
  });
  assert.equal(config('gemini-2.5-flash', 'low').maxOutputTokens, 3072);
});

test('a Gemini tool round goes back with its signatures, and only to the model that made them', () => {
  const signatures = {
    geminiThoughtSignatures: {
      model: 'gemini-4-hydrogen',
      text: 'text-signature',
      calls: { 'call-1': 'call-signature' },
    },
  };
  const history = [
    message('user', 'Read the plan.'),
    message('assistant', 'Reading it.', {
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"plan.md"}' },
        },
        {
          id: 'gemini-call-0',
          type: 'function',
          function: { name: 'list_files', arguments: '{}' },
        },
      ],
      providerMetadata: signatures,
    }),
    message('tool', 'The plan.', { tool_call_id: 'call-1' }),
    message('tool', 'plan.md', { tool_call_id: 'gemini-call-0' }),
  ];
  const tools = [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  ];

  const payload = build('gemini-4-hydrogen', history, { tools });
  assert.deepEqual(payload.tools, [
    {
      functionDeclarations: [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: tools[0].parameters,
        },
      ],
    },
  ]);
  assert.deepEqual(payload.contents[1], {
    role: 'model',
    parts: [
      { text: 'Reading it.', thoughtSignature: 'text-signature' },
      {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { path: 'plan.md' },
        },
        thoughtSignature: 'call-signature',
      },
      // Gemini never issued this id, so it is not sent back.
      { functionCall: { name: 'list_files', args: {} } },
    ],
  });
  assert.deepEqual(payload.contents[2], {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: { result: 'The plan.' },
        },
      },
      {
        functionResponse: {
          name: 'list_files',
          response: { result: 'plan.md' },
        },
      },
    ],
  });

  const otherModel = build('gemini-3.8-flash', history, { tools });
  assert.equal(
    JSON.stringify(otherModel.contents).includes('signature'),
    false,
    'another model never receives these signatures'
  );
});

test('the Gemini stream yields thoughts, text, signed calls, usage, and the finish reason', async () => {
  const chunks = await collect(
    gemini.streamGeminiResponse(
      sse([
        {
          candidates: [
            { content: { parts: [{ text: 'Thinking ', thought: true }] } },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Reading.' },
                  {
                    thoughtSignature: 'call-signature',
                    functionCall: {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: 'plan.md' },
                    },
                  },
                  { functionCall: { name: 'list_files', args: {} } },
                ],
              },
            },
          ],
        },
        {
          candidates: [
            {
              content: {
                parts: [{ text: '', thoughtSignature: 'text-signature' }],
              },
              finishReason: 'MAX_TOKENS',
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 6,
            totalTokenCount: 20,
          },
        },
      ]),
      'gemini-4-hydrogen'
    )
  );

  assert.deepEqual(chunks, [
    { type: 'reasoning', content: 'Thinking ' },
    { type: 'content', content: 'Reading.' },
    {
      type: 'tool_call',
      toolCall: {
        id: 'call-1',
        name: 'read_file',
        arguments: '{"path":"plan.md"}',
        providerMetadata: { geminiThoughtSignature: 'call-signature' },
      },
    },
    {
      type: 'tool_call',
      toolCall: { id: 'gemini-call-0', name: 'list_files', arguments: '{}' },
    },
    {
      type: 'usage',
      // Thinking is billed as output, so it counts toward completion.
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
    },
    {
      type: 'done',
      doneReason: 'length',
      providerMetadata: {
        geminiThoughtSignatures: {
          model: 'gemini-4-hydrogen',
          text: 'text-signature',
          calls: { 'call-1': 'call-signature' },
        },
      },
    },
  ]);
});

test('the Gemini stream reads plain JSON replies and reports provider errors', async () => {
  const json = await collect(
    gemini.streamGeminiResponse(
      new Response(
        JSON.stringify([
          { candidates: [{ content: { parts: [{ text: 'Hello ' }] } }] },
          {
            candidates: [
              {
                content: { parts: [{ text: 'there' }] },
                finishReason: 'STOP',
              },
            ],
          },
        ]),
        { headers: { 'content-type': 'application/json' } }
      ),
      'gemini-3.8-flash'
    )
  );
  assert.deepEqual(json, [
    { type: 'content', content: 'Hello ' },
    { type: 'content', content: 'there' },
    { type: 'done', doneReason: 'stop' },
  ]);

  await assert.rejects(
    collect(
      gemini.streamGeminiResponse(
        sse([{ promptFeedback: { blockReason: 'SAFETY' } }]),
        'gemini-3.8-flash'
      )
    ),
    /Gemini blocked the prompt \(SAFETY\)/
  );
  await assert.rejects(
    collect(
      gemini.streamGeminiResponse(
        new Response('{"error":{"message":"API key not valid"}}', {
          status: 400,
        }),
        'gemini-3.8-flash'
      )
    ),
    /Plugin API error: 400 - .*API key not valid/
  );
});

test('a whole Gemini reply keeps its signatures for the next turn', () => {
  const response = chatAdapter.convertProviderResponse(
    plugin,
    {
      candidates: [
        {
          content: {
            parts: [
              { text: 'Weighing it. ', thought: true },
              { text: 'Done.', thoughtSignature: 'text-signature' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
    },
    'gemini-4-carbon'
  );
  assert.equal(response.choices[0].message.content, 'Done.');
  assert.equal(response.choices[0].message.reasoning_content, 'Weighing it. ');
  assert.equal(response.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.providerMetadata, {
    geminiThoughtSignatures: {
      model: 'gemini-4-carbon',
      text: 'text-signature',
    },
  });
  assert.deepEqual(response.usage, {
    prompt_tokens: 2,
    completion_tokens: 3,
    total_tokens: 5,
  });

  const next = build('gemini-4-carbon', [
    message('user', 'Go.'),
    message('assistant', 'Done.', {
      providerMetadata: response.providerMetadata,
    }),
    message('user', 'Again.'),
  ]);
  assert.deepEqual(next.contents[1].parts, [
    { text: 'Done.', thoughtSignature: 'text-signature' },
  ]);
});

test('the streaming endpoint is streamGenerateContent with server-sent events', () => {
  assert.equal(
    gemini.geminiStreamingEndpoint(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent'
    ),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse'
  );
});

test('extra high is XHIGH on Gemini 4 Hydrogen and HIGH or the largest budget elsewhere', () => {
  const config = model =>
    build(model, [message('user', 'Plan it.')], { think: 'xhigh' })
      .generationConfig;
  assert.deepEqual(config('gemini-4-hydrogen').thinkingConfig, {
    thinkingLevel: 'XHIGH',
    includeThoughts: true,
  });
  for (const model of [
    'gemini-4-carbon',
    'gemini-4-argon',
    'gemini-3.8-flash',
  ]) {
    assert.equal(config(model).thinkingConfig.thinkingLevel, 'HIGH', model);
  }
  // Gemini 2.5 Flash tops out at a 24,576-token budget.
  assert.equal(config('gemini-2.5-flash').thinkingConfig.thinkingBudget, 24576);
});

test('models.list becomes the chat models, with their windows and thinking', async () => {
  const pages = {
    '': {
      models: [
        {
          name: 'models/gemini-4-hydrogen',
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ['generateContent', 'countTokens'],
          thinking: true,
        },
        {
          name: 'models/gemini-2.0-flash',
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ['generateContent'],
          thinking: false,
        },
        {
          name: 'models/gemini-3.8-flash-tts',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-nano-banana-2.1',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-embedding-2',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemma-3-27b-it',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-decision-1',
          supportedGenerationMethods: ['decide'],
        },
        {
          name: 'models/gemini-flash-latest',
          supportedActions: ['generateContent'],
        },
      ],
      nextPageToken: 'page-2',
    },
    'page-2': {
      models: [
        {
          name: 'models/gemini-4-carbon',
          inputTokenLimit: 1048576,
          supportedGenerationMethods: ['generateContent'],
          thinking: true,
        },
        // Pages repeat nothing, but a repeat is not listed twice.
        {
          name: 'models/gemini-4-hydrogen',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    },
  };
  const urls = [];
  const entries = await gemini.listGeminiModels(
    'https://generativelanguage.googleapis.com/v1beta/models',
    async url => {
      urls.push(url);
      return pages[new URL(url).searchParams.get('pageToken') ?? ''];
    }
  );

  assert.deepEqual(urls, [
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
    'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&pageToken=page-2',
  ]);
  assert.deepEqual(
    entries.map(entry => entry.id),
    [
      'gemini-2.0-flash',
      'gemini-4-carbon',
      'gemini-4-hydrogen',
      'gemini-flash-latest',
    ]
  );
  assert.deepEqual(pluginModelCatalog.readModelContextMap(entries), {
    'gemini-2.0-flash': 1048576,
    'gemini-4-carbon': 1048576,
    'gemini-4-hydrogen': 1048576,
  });
  // Google's own thinking flag wins over the name.
  assert.deepEqual(pluginModelCatalog.readModelReasoningMap(entries), {
    'gemini-2.0-flash': false,
    'gemini-4-carbon': true,
    'gemini-4-hydrogen': true,
  });
});

test('the models collection is found from the generateContent endpoint', async () => {
  const pluginValidation = await distModule('utils/pluginValidation.js');
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(plugin.endpoint),
    'https://generativelanguage.googleapis.com/v1beta/models'
  );
});
