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
 * The bundled Baseten provider: the manifest's routing, credential, and model
 * contract on Baseten's Model APIs, its shipped trust anchor, derived model
 * discovery, reasoning controls, the per-conversation session affinity key on
 * Chat and Work requests, and OpenCode's Baseten login in Work.
 */

import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-baseten-plugin-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const persistence = await distModule('persistence/index.js');
const pluginDefinitionTrust = await distModule(
  'utils/pluginDefinitionTrust.js'
);
const pluginValidation = await distModule('utils/pluginValidation.js');
const chatAdapter = await distModule('utils/pluginChatAdapter.js');
const { buildPluginWorkPayload } = await distModule(
  'services/workModelProviderService.js'
);
const { OpenCodeHostLogin } = await distModule(
  'services/workAgentHostLogins.js'
);

test.after(async () => {
  await persistence.closePersistence();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const plugin = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'baseten.json'), 'utf8')
);

const MODEL_APIS = 'https://inference.baseten.co/v1/chat/completions';
const AFFINITY = 'x-session-affinity';

const message = (role, content, index = 0, extra = {}) => ({
  id: `message-${role}-${index}`,
  role,
  content,
  timestamp: index,
  ...extra,
});

const buildChat = (messages, options = {}, model = 'zai-org/GLM-5.3') =>
  chatAdapter.buildPluginChatPayload(
    plugin,
    model,
    messages,
    options,
    {},
    true,
    'chat_completions'
  );

test('the bundled Baseten manifest routes to Model APIs', () => {
  assert.equal(plugin.id, 'baseten');
  assert.equal(plugin.name, 'Baseten');
  assert.equal(plugin.type, 'completion');
  assert.equal(
    plugin.endpoint,
    MODEL_APIS,
    "the OpenAI-compatible base URL Baseten's quickstart documents"
  );
  assert.deepEqual(plugin.auth, {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'BASETEN_API_KEY',
  });
  assert.ok(
    plugin.model_map.includes('zai-org/GLM-5.3') &&
      plugin.model_map.includes('moonshotai/Kimi-K3') &&
      plugin.model_map.includes('meta-models/muse-spark-open'),
    'Model API slugs exactly as Baseten lists them'
  );
  const endpoint = plugin.variables.find(
    variable => variable.name === 'endpoint'
  );
  assert.equal(endpoint.default, MODEL_APIS);
  assert.equal(
    plugin.variables.some(variable => /penalty/.test(variable.name)),
    false,
    'penalties are model-specific on Baseten, so none are sent by default'
  );
});

test('the Baseten manifest matches its compiled trust anchor', () => {
  assert.equal(
    pluginDefinitionTrust.matchesBundledPluginTrustAnchor(plugin),
    true,
    'a bundled manifest change requires an intentional trust-anchor update'
  );
});

test('Baseten uses Chat Completions semantics and derives its model list', () => {
  const apiConfig = pluginValidation.resolvePluginApiConfig(plugin, {});
  assert.equal(apiConfig.apiMode, 'chat_completions');
  assert.equal(apiConfig.endpoint, MODEL_APIS);
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(plugin.endpoint),
    'https://inference.baseten.co/v1/models',
    'the Model APIs catalog'
  );
  const dedicated =
    'https://model-abc123.api.baseten.co/environments/production/sync/v1/chat/completions';
  assert.equal(
    pluginValidation.resolvePluginApiConfig(plugin, { endpoint: dedicated })
      .endpoint,
    dedicated,
    'a dedicated deployment is reached by overriding the endpoint'
  );
});

test("Baseten's reasoning controls follow the chat's thinking choice", () => {
  const effort = think =>
    buildChat([message('user', 'Is 91 prime?')], { think }).payload
      .reasoning_effort;
  assert.equal(effort(undefined), undefined, "the model's own default");
  assert.equal(effort(false), 'none', 'thinking off is an explicit none');
  assert.equal(effort('low'), 'low');
  assert.equal(effort('high'), 'high');
  assert.equal(
    effort('medium'),
    undefined,
    'GLM, Kimi and DeepSeek on Baseten take no medium; their default stands in'
  );
  assert.equal(effort(true), undefined);

  const work = think =>
    buildPluginWorkPayload(plugin, {
      model: 'moonshotai/Kimi-K3',
      messages: [{ role: 'user', content: 'Fix the build.' }],
      options: { think },
    }).payload.reasoning_effort;
  assert.equal(work(false), 'none');
  assert.equal(work('high'), 'high');
});

test('earlier reasoning is replayed as reasoning_content, as Beam requires', () => {
  const { payload } = buildChat(
    [
      message('user', 'Is 91 prime?'),
      message('assistant', 'No, 91 = 7 x 13.', 1, {
        thinking: '91 / 7 = 13, so it is composite.',
      }),
      message('user', 'And 97?', 2),
    ],
    {},
    'reflection/Beam-1.0'
  );
  assert.equal(
    payload.messages[1].reasoning_content,
    '91 / 7 = 13, so it is composite.'
  );
  assert.equal(payload.messages[1].reasoning, undefined);
});

test('one conversation keeps one session affinity key across turns', () => {
  const first = buildChat([
    message('system', 'Be brief.'),
    message('user', 'What is gradient descent?'),
  ]);
  const key = first.headers?.[AFFINITY];
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(first.headers['Modal-Routing-Affinity-Key'], undefined);

  const later = buildChat([
    message('system', 'Be brief.'),
    message('user', 'What is gradient descent?'),
    message('assistant', 'It follows the slope downhill.', 1),
    message('user', 'And momentum?', 2),
  ]);
  assert.equal(
    later.headers[AFFINITY],
    key,
    'the next turn lands on the replica holding the cached prefix'
  );

  const other = buildChat([message('user', 'Explain monads.')]);
  assert.notEqual(other.headers[AFFINITY], key);

  const openai = chatAdapter.buildPluginChatPayload(
    { ...plugin, id: 'openai' },
    'gpt-5.5',
    [message('user', 'What is gradient descent?')],
    {},
    {},
    true,
    'chat_completions'
  );
  assert.equal(openai.headers?.[AFFINITY], undefined);
});

test('Work runs on Baseten send the same affinity key on every loop step', () => {
  const request = messages => ({
    model: 'zai-org/GLM-5.3',
    messages,
    stream: true,
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          parameters: { type: 'object', properties: {} },
        },
      },
    ],
  });
  const opening = [
    { role: 'system', content: 'Work only in /workspace.' },
    { role: 'user', content: 'Build the landing page.' },
  ];
  const step1 = buildPluginWorkPayload(plugin, request(opening));
  const step2 = buildPluginWorkPayload(
    plugin,
    request([
      ...opening,
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            function: { name: 'read_file', arguments: { path: 'index.html' } },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: '<html></html>' },
    ])
  );
  assert.match(step1.extraHeaders[AFFINITY], /^[0-9a-f]{32}$/);
  assert.equal(step2.extraHeaders[AFFINITY], step1.extraHeaders[AFFINITY]);
  assert.equal(step1.payload.model, 'zai-org/GLM-5.3');
});

test("OpenCode in Work signs in to Baseten with the server's API key", async () => {
  const previous = process.env.BASETEN_API_KEY;
  process.env.BASETEN_API_KEY = 'REAL-BASETEN-KEY';
  try {
    const login = await new OpenCodeHostLogin(() => '/nonexistent').prepare(
      'baseten/zai-org/GLM-5.3'
    );
    assert.deepEqual(Object.keys(login.env), ['BASETEN_API_KEY']);
    assert.equal(login.env.BASETEN_API_KEY, login.credentials[0].placeholder);
    assert.deepEqual(login.credentials[0].hosts, ['inference.baseten.co']);
    assert.doesNotMatch(JSON.stringify(login.env), /REAL/);
  } finally {
    if (previous === undefined) delete process.env.BASETEN_API_KEY;
    else process.env.BASETEN_API_KEY = previous;
  }

  const authDir = mkdtempSync(path.join(tmpdir(), 'libre-baseten-opencode-'));
  try {
    const authFile = path.join(authDir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({ baseten: { type: 'api', key: 'SAVED-BASETEN-KEY' } })
    );
    const saved = await new OpenCodeHostLogin(() => authFile).prepare(
      'baseten/moonshotai/Kimi-K3'
    );
    const entry = JSON.parse(saved.files[0].content).baseten;
    assert.equal(entry.key, saved.credentials[0].placeholder);
    assert.deepEqual(saved.credentials[0].hosts, ['inference.baseten.co']);
    assert.doesNotMatch(saved.files[0].content.toString(), /SAVED/);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});
