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

// Decision models: the System One, OpenAI, and Gemini wire formats, the
// chat turn rules, the service that lists and calls them, and the manifest
// changes that bring them to five bundled providers.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const protocol = await distModule('utils/decisionProtocol.js');
const service = await distModule('services/decisionService.js');
const trust = await distModule('utils/pluginDefinitionTrust.js');
const catalog = await distModule('utils/pluginModelCatalog.js');
const library = await distModule('utils/ollamaLibrary.js');

const manifest = id =>
  JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins', `${id}.json`), 'utf8')
  );

// 1x1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const questions = {
  refund: { type: 'noul', instructions: 'Is a refund being requested?' },
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Payments and refunds', technical: null },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['Routine', 'Soon', 'Immediate'],
  },
};

test('System One requests carry images the way each server reads them', () => {
  const input = protocol.parseDecisionInput({
    state: 'Charged twice.',
    images: [`data:image/png;base64,${PNG}`],
    questions,
  });
  assert.equal(input.images[0].mimeType, 'image/png');

  const ollama = protocol.buildDecisionRequestBody(
    'systemone',
    'images',
    'nimble',
    input
  );
  assert.deepEqual(ollama.images, [PNG], 'Ollama takes bare base64');
  assert.equal(ollama.state, 'Charged twice.');
  assert.deepEqual(ollama.questions, questions);

  const llamaCpp = protocol.buildDecisionRequestBody(
    'systemone',
    'images-data-url',
    'openjev',
    input
  );
  assert.deepEqual(llamaCpp.images, [`data:image/png;base64,${PNG}`]);

  const baseten = protocol.buildDecisionRequestBody(
    'systemone',
    'state-messages',
    'decision-models/baseten-elephant-9b-latest',
    input
  );
  assert.equal(baseten.images, undefined);
  assert.deepEqual(baseten.state, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Charged twice.' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG}` },
          },
        ],
      },
    ],
  });

  const openrouter = protocol.buildDecisionRequestBody(
    'systemone',
    'state-parts',
    'cloudflare/clef-flash',
    input
  );
  assert.deepEqual(openrouter.state, [
    'Charged twice.',
    { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
  ]);

  assert.throws(
    () => protocol.buildDecisionRequestBody('systemone', 'none', 'm', input),
    protocol.DecisionValidationError
  );
  const textOnly = protocol.parseDecisionInput({
    state: { ticket: 'Charged twice.' },
    questions,
  });
  assert.deepEqual(
    protocol.buildDecisionRequestBody('systemone', 'none', 'm', textOnly).state,
    { ticket: 'Charged twice.' },
    'structured state goes as JSON, rendered by the server'
  );
});

test('OpenAI and Gemini decisions translate to and from their own shapes', () => {
  const input = protocol.parseDecisionInput({
    state: 'Charged twice.',
    questions: {
      ...questions,
      refund: {
        ...questions.refund,
        criteria: { true: 'A refund is asked for' },
      },
    },
  });

  const openai = protocol.buildDecisionRequestBody(
    'openai',
    'none',
    'gpt-6-luna',
    input
  );
  assert.equal(openai.input, 'Charged twice.');
  assert.deepEqual(openai.questions, [
    {
      type: 'predicate',
      name: 'refund',
      instructions:
        'Is a refund being requested?\nTrue means: A refund is asked for',
    },
    {
      type: 'choice',
      name: 'team',
      instructions: 'Which team should handle this?',
      choices: [
        { value: 'billing', description: 'Payments and refunds' },
        { value: 'technical' },
      ],
    },
    {
      type: 'score',
      name: 'urgency',
      instructions: 'How urgent is this?',
      levels: [{ label: 'Routine' }, { label: 'Soon' }, { label: 'Immediate' }],
    },
  ]);
  const openaiResult = protocol.parseDecisionResponse(
    'openai',
    {
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'refund', probability: 0.97 },
        {
          type: 'choice',
          name: 'team',
          choice: 'billing',
          probabilities: [
            { value: 'billing', probability: 0.9 },
            { value: 'technical', probability: 0.1 },
          ],
          confidence: 0.53,
        },
        { type: 'refusal', name: 'urgency' },
      ],
      usage: {
        input_tokens: 120,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 40, cache_write_tokens: 0 },
      },
    },
    input.questions,
    'gpt-6-luna'
  );
  assert.deepEqual(openaiResult.answers, {
    refund: { type: 'noul', noul: 0.97 },
    team: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.1 },
      confidence: 0.53,
    },
    urgency: { type: 'refusal' },
  });
  assert.deepEqual(openaiResult.usage, {
    inputTokens: 120,
    outputTokens: 0,
    cachedTokens: 40,
  });

  const gemini = protocol.buildDecisionRequestBody(
    'gemini',
    'none',
    'gemini-decision-1',
    protocol.parseDecisionInput({
      state: 'Charged twice.',
      images: [PNG],
      questions: input.questions,
    })
  );
  assert.deepEqual(gemini.input, [
    { type: 'text', text: 'Charged twice.' },
    { type: 'image', data: PNG, mime_type: 'image/png' },
  ]);
  assert.deepEqual(gemini.questions.refund, {
    type: 'noul',
    instructions: 'Is a refund being requested?',
    criteria: { true_description: 'A refund is asked for' },
  });
  assert.deepEqual(gemini.questions.team.criteria, {
    billing: 'Payments and refunds',
    technical: 'technical',
  });
  const geminiResult = protocol.parseDecisionResponse(
    'gemini',
    {
      answers: {
        refund: { type: 'noul', noul: 0.97, confidence: 0.97 },
        team: {
          type: 'choice',
          choice: 'billing',
          confidence: 0.9,
          probabilities: { billing: 0.95, technical: 0.05 },
        },
        urgency: {
          type: 'score',
          score: 1.9,
          confidence: 0.9,
          legend: { 0: 'Routine', 1: 'Soon', 2: 'Immediate' },
          probabilities: { 0: 0.01, 1: 0.08, 2: 0.91 },
        },
      },
      usage: { total_input_tokens: 152, total_output_tokens: 0 },
    },
    input.questions,
    'gemini-decision-1'
  );
  assert.equal(geminiResult.model, 'gemini-decision-1');
  assert.deepEqual(geminiResult.usage, { inputTokens: 152, outputTokens: 0 });
  assert.throws(
    () =>
      protocol.parseDecisionResponse(
        'gemini',
        { answers: {}, prompt_feedback: { block_reason: 'SAFETY' } },
        input.questions,
        'gemini-decision-1'
      ),
    /blocked this request \(SAFETY\)/
  );
  assert.throws(
    () =>
      protocol.parseDecisionResponse(
        'systemone',
        { answers: { refund: { type: 'noul', noul: 0.5 } } },
        input.questions,
        'nimble'
      ),
    /did not answer: team, urgency/
  );
});

test('decision input is checked before any provider sees it', () => {
  const bad = (raw, pattern) =>
    assert.throws(
      () => protocol.parseDecisionInput(raw),
      error =>
        error instanceof protocol.DecisionValidationError &&
        pattern.test(error.message)
    );
  bad({ state: '  ', questions }, /state must not be empty/);
  bad({ state: 42, questions }, /text, a JSON object, or a JSON array/);
  bad({ state: 'x', questions: {} }, /at least one question/);
  bad(
    { state: 'x', questions: { 'bad name': questions.refund } },
    /Question names use letters/
  );
  bad(
    {
      state: 'x',
      questions: {
        q: { type: 'choice', instructions: 'Pick', criteria: { a: null } },
      },
    },
    /2 to 255 options/
  );
  bad(
    {
      state: 'x',
      questions: {
        q: { type: 'score', instructions: 'Rate', criteria: ['only'] },
      },
    },
    /2 to 10 levels/
  );
  bad(
    {
      state: 'x',
      questions: {
        q: { type: 'noul', instructions: 'Ok?', criteria: { maybe: 'x' } },
      },
    },
    /only "true" and "false"/
  );
  bad(
    { state: 'x', images: ['R0lGODlhAQABAAAAACw='], questions },
    /PNG, JPEG, or WebP/
  );
  bad(
    { state: 'x', images: [PNG, PNG, PNG, PNG, PNG], questions },
    /at most 4 images/
  );
  assert.deepEqual(
    protocol.parseDecisionQuestions({
      q: { type: 'yesno', instructions: 'Ok?' },
    }),
    { q: { type: 'noul', instructions: 'Ok?' } },
    'yesno is read as the noul type it names'
  );
});

test('a decision chat follows ollama run: state first, then yes/no lines, /clear starts over', () => {
  const user = (content, images) => ({ role: 'user', content, images });
  const assistant = content => ({ role: 'assistant', content });

  assert.deepEqual(
    protocol.resolveDecisionChatTurn([
      { role: 'system', content: 'ignored' },
      user('I was charged twice.'),
    ]),
    { kind: 'state' }
  );
  const asked = protocol.resolveDecisionChatTurn([
    user('I was charged twice.'),
    assistant('Saved as the state.'),
    user('Is a refund requested?\n\nIs the customer angry?'),
  ]);
  assert.equal(asked.kind, 'decide');
  assert.equal(asked.mode, 'interactive');
  assert.equal(asked.input.state, 'I was charged twice.');
  assert.deepEqual(asked.input.questions, {
    q1: { type: 'noul', instructions: 'Is a refund requested?' },
    q2: { type: 'noul', instructions: 'Is the customer angry?' },
  });

  assert.deepEqual(
    protocol.resolveDecisionChatTurn([
      user('First state'),
      user('Question?'),
      user('/clear'),
    ]),
    { kind: 'cleared' }
  );
  const restarted = protocol.resolveDecisionChatTurn([
    user('First state'),
    user('Question?'),
    user('/clear'),
    user('Second state'),
    user('New question?'),
  ]);
  assert.equal(restarted.input.state, 'Second state');

  const saved = protocol.resolveDecisionChatTurn(
    [user('Old message'), user('My order arrived broken', [PNG])],
    questions
  );
  assert.equal(saved.mode, 'questions');
  assert.equal(saved.input.state, 'My order arrived broken');
  assert.equal(saved.input.images.length, 1);
  assert.equal(saved.input.questions, questions);

  const table = protocol.renderDecisionMarkdown(questions, {
    model: 'nimble',
    usage: {},
    answers: {
      refund: { type: 'noul', noul: 0.97 },
      team: {
        type: 'choice',
        choice: 'billing',
        probabilities: { billing: 0.91, technical: 0.09 },
      },
      urgency: {
        type: 'score',
        score: 1.2,
        legend: { 0: 'Routine', 1: 'Soon', 2: 'Immediate' },
        probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
      },
    },
  });
  assert.match(table, /\| Is a refund being requested\? \| yes \| 97\.0% \|/);
  assert.match(
    table,
    /\| Which team should handle this\? \| billing \| 91\.0% \|/
  );
  assert.match(
    table,
    /\| How urgent is this\? \| Soon \(1\.20 of 2\) \| 60\.0% \|/
  );
});

function stubDeps(overrides = {}) {
  const calls = { requests: [], usage: [], systemOne: [] };
  const plugins = overrides.plugins ?? [
    { ...manifest('baseten'), active: true },
    { ...manifest('openai'), active: true },
    { ...manifest('llama-cpp'), active: true },
  ];
  const deps = {
    getActivePlugins: async () => plugins,
    getApiKey: async plugin =>
      plugin.id === 'llama-cpp' ? null : `key-${plugin.id}`,
    getPluginVariables: async plugin => overrides.variables?.[plugin.id] ?? {},
    ollama: {
      isEnabled: () => true,
      getModels: async () => [{ name: 'llama3.2' }, { name: 'nimble' }],
      getCapabilities: async model =>
        model === 'nimble'
          ? ['completion', 'decision', 'tools']
          : ['completion'],
      systemOne: async body => {
        calls.systemOne.push(body);
        return {
          model: 'nimble',
          answers: { refund: { type: 'noul', noul: 0.9 } },
          usage: { input_tokens: 50, output_tokens: 1 },
        };
      },
    },
    request: async options => {
      calls.requests.push(options);
      if (options.method === 'GET') {
        if (options.url.startsWith('https://inference.baseten.co')) {
          return {
            status: 200,
            data: {
              data: [
                { id: 'zai-org/GLM-5.3' },
                { id: 'decision-models/baseten-elephant-9b-latest' },
              ],
            },
          };
        }
        return {
          status: 200,
          data: {
            data: [
              {
                id: 'openjev',
                architecture: {
                  input_modalities: ['text', 'image'],
                  output_modalities: ['decisions'],
                },
              },
            ],
          },
        };
      }
      return {
        status: 200,
        data: options.url.endsWith('/v1/decisions')
          ? {
              model: 'gpt-6-luna',
              answers: [
                { type: 'predicate', name: 'refund', probability: 0.8 },
              ],
              usage: { input_tokens: 30, output_tokens: 0 },
            }
          : {
              model: 'backend-elephant',
              answers: { refund: { type: 'noul', noul: 0.99 } },
              usage: { input_tokens: 231, output_tokens: 1 },
            },
      };
    },
    canUse: async userId => userId !== 'blocked',
    recordUsage: usage => calls.usage.push(usage),
  };
  return { deps, calls };
}

const refundOnly = { refund: questions.refund };

test('the decision service lists, routes, meters, and gates decision models', async () => {
  const { deps, calls } = stubDeps({
    variables: { 'llama-cpp': { base_url: 'http://gpu-box:9931/v1' } },
  });
  const decisions = new service.DecisionService(deps);

  const listed = await decisions.listModels('user-1');
  assert.deepEqual(
    listed.map(entry => [
      entry.providerType,
      entry.providerId ?? null,
      entry.id,
    ]),
    [
      ['ollama', null, 'nimble'],
      ['plugin', 'baseten', 'decision-models/baseten-elephant-9b-latest'],
      ['plugin', 'baseten', 'decision-models/baseten-mammoth-27b-latest'],
      ['plugin', 'baseten', 'decision-models/baseten-joey-2b-latest'],
      ['plugin', 'openai', 'gpt-6-luna-decisions'],
      ['plugin', 'llama-cpp', 'openjev'],
    ],
    'Ollama by capability, Baseten by its namespace, llama.cpp by output modality'
  );
  assert.ok(
    calls.requests.some(
      request => request.url === 'http://gpu-box:9931/v1/models'
    ),
    'a changed llama.cpp Base URL moves its decision listing too'
  );

  const input = protocol.parseDecisionInput({
    state: 'Charged twice.',
    questions: refundOnly,
  });

  const viaOllama = await decisions.decide('user-1', {
    model: 'nimble',
    input,
  });
  assert.equal(viaOllama.provider.name, 'Ollama');
  assert.deepEqual(calls.systemOne[0], {
    model: 'nimble',
    state: 'Charged twice.',
    questions: refundOnly,
  });

  const viaBaseten = await decisions.decide('user-1', {
    model: 'decision-models/baseten-elephant-9b-latest',
    providerType: 'plugin',
    providerId: 'baseten',
    input,
  });
  assert.equal(viaBaseten.answers.refund.noul, 0.99);
  const basetenCall = calls.requests.at(-1);
  assert.equal(basetenCall.url, 'https://inference.baseten.co/v1/systemone');
  assert.equal(basetenCall.headers.Authorization, 'Bearer key-baseten');
  assert.deepEqual(calls.usage.at(-1), {
    userId: 'user-1',
    pluginId: 'baseten',
    pluginName: 'Baseten',
    capability: 'chat',
    model: 'decision-models/baseten-elephant-9b-latest',
    status: 'success',
    durationMs: calls.usage.at(-1).durationMs,
    inputUnits: 1,
    unitKind: 'inputs',
    tokens: { promptTokens: 231, completionTokens: 1, totalTokens: 232 },
  });

  await decisions.decide('user-1', {
    model: 'gpt-6-luna-decisions',
    providerType: 'plugin',
    providerId: 'openai',
    input,
  });
  const openaiCall = calls.requests.at(-1);
  assert.equal(openaiCall.url, 'https://api.openai.com/v1/decisions');
  assert.equal(
    openaiCall.json.model,
    'gpt-6-luna',
    'the alias keeps the chat model gpt-6-luna a chat model in Libre'
  );

  await decisions.decide('user-1', {
    model: 'openjev',
    providerType: 'plugin',
    providerId: 'llama-cpp',
    input,
  });
  assert.equal(calls.requests.at(-1).url, 'http://gpu-box:9931/v1/systemone');

  await assert.rejects(
    decisions.decide('blocked', { model: 'nimble', input }),
    service.DecisionAccessError
  );
  await assert.rejects(
    decisions.decide('user-1', { model: 'llama3.2', input }),
    service.DecisionModelNotFoundError,
    'a chat model is never sent to a decision API'
  );
  assert.equal(
    await decisions.resolveTarget('llama3.2', { providerType: 'ollama' }),
    null
  );
  assert.equal(
    await decisions.resolveTarget('nimble', {
      providerType: 'agent',
      providerId: 'x',
    }),
    null
  );
});

test('a decision chat turn answers in the stream shape every chat path reads', async () => {
  const { deps } = stubDeps();
  const decisions = new service.DecisionService(deps);
  const target = await decisions.resolveTarget('nimble', {
    providerType: 'ollama',
  });
  assert.deepEqual(target, { providerType: 'ollama', model: 'nimble' });

  const chunks = [];
  for await (const chunk of decisions.streamChatTurn(
    target,
    [{ role: 'user', content: 'Charged twice.' }],
    'user-1',
    { questions: refundOnly }
  )) {
    chunks.push(chunk);
  }
  assert.deepEqual(
    chunks.map(chunk => chunk.type),
    ['content', 'usage', 'done']
  );
  assert.match(
    chunks[0].content,
    /\| Is a refund being requested\? \| yes \| 90\.0% \|/
  );
  assert.deepEqual(chunks[1].usage, { promptTokens: 50, completionTokens: 1 });
  assert.deepEqual(chunks[2].providerMetadata.decision.answers, {
    refund: { type: 'noul', noul: 0.9 },
  });
  assert.equal(chunks[2].providerMetadata.decision.mode, 'questions');

  const stateOnly = [];
  for await (const chunk of decisions.streamChatTurn(
    target,
    [{ role: 'user', content: 'A state' }],
    'user-1'
  )) {
    stateOnly.push(chunk);
  }
  assert.deepEqual(stateOnly.at(-1).providerMetadata, {
    decision: { kind: 'state' },
  });

  await assert.rejects(async () => {
    for await (const _chunk of decisions.streamChatTurn(
      target,
      [{ role: 'user', content: 'A state' }],
      'blocked'
    )) {
      // drain
    }
  }, service.DecisionAccessError);
});

test('adding a decision capability keeps every saved provider key', () => {
  for (const id of ['baseten', 'openrouter', 'openai', 'gemini', 'llama-cpp']) {
    const plugin = manifest(id);
    assert.ok(plugin.capabilities?.decision, `${id} declares decision models`);
    const withoutDecision = structuredClone(plugin);
    delete withoutDecision.capabilities.decision;
    if (Object.keys(withoutDecision.capabilities).length === 0) {
      delete withoutDecision.capabilities;
    }
    assert.equal(
      trust.getCredentialBindingDefinitionFingerprint(plugin),
      trust.getCredentialBindingDefinitionFingerprint(withoutDecision),
      `${id}: a decision route on the chat origin binds no new destination`
    );
    assert.equal(
      trust.BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS[id],
      trust.getPluginDefinitionFingerprint(plugin),
      `${id}: the trust anchor follows the manifest`
    );
  }

  const elsewhere = structuredClone(manifest('baseten'));
  delete elsewhere.capabilities.decision.config.path;
  elsewhere.capabilities.decision.endpoint =
    'https://elsewhere.example/v1/systemone';
  assert.notEqual(
    trust.getCredentialBindingDefinitionFingerprint(elsewhere),
    trust.getCredentialBindingDefinitionFingerprint(manifest('baseten')),
    'a decision endpoint on another host would send the key somewhere new'
  );
  const absolutePath = structuredClone(manifest('baseten'));
  absolutePath.capabilities.decision.config.path =
    'https://elsewhere.example/x';
  assert.notEqual(
    trust.getCredentialBindingDefinitionFingerprint(absolutePath),
    trust.getCredentialBindingDefinitionFingerprint(manifest('baseten'))
  );
});

test('chat listings leave decision-only models to the decision list', () => {
  assert.equal(
    catalog.isCallableListedModel('llama-cpp', {
      id: 'clef',
      architecture: { output_modalities: ['decisions'] },
    }),
    false
  );
  assert.equal(
    catalog.isCallableListedModel('llama-cpp', {
      id: 'granite-switch',
      architecture: { output_modalities: ['text', 'decisions'] },
    }),
    true,
    'a model that also writes text stays a chat model'
  );
  assert.deepEqual(
    service.readDecisionModelListing(
      { api: 'systemone', discovery: 'output-modality' },
      {
        data: [
          { id: 'chat-model', architecture: { output_modalities: ['text'] } },
          {
            id: 'cloudflare/clef-flash',
            architecture: {
              input_modalities: ['text', 'image'],
              output_modalities: ['decisions'],
            },
          },
        ],
      }
    ),
    [{ id: 'cloudflare/clef-flash', images: true }]
  );

  const card = name => `
    <a href="/library/${name}">
      <div class="flex flex-wrap">
        <span class="text-blue-600">9b</span>
        <span class="text-indigo-600">tools</span>
        <span class="text-indigo-600">decision</span>
      </div>
      <p class="text-neutral-800">A decision model.</p>
    </a>`;
  const [parsed] = library.parseOllamaSearchHtml(card('nimble'));
  assert.equal(
    parsed.category,
    'decision',
    'Ollama library cards file decision models under Decision'
  );
  assert.deepEqual(parsed.sizes, ['9b']);
});
