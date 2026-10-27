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
 * The bundled Modal provider: the manifest's routing, credential, and model
 * contract on Modal's shared inference router, its shipped trust anchor,
 * derived model discovery, the per-conversation routing affinity key on Chat
 * and Work requests, and OpenCode's Modal login in Work.
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
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-modal-plugin-'));
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
const pluginModelCatalog = await distModule('utils/pluginModelCatalog.js');
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
  fs.readFileSync(path.join(repoRoot, 'plugins', 'modal.json'), 'utf8')
);

const ROUTER = 'https://inference.us-west.modal.direct/v1/chat/completions';
const AFFINITY = 'Modal-Routing-Affinity-Key';

const message = (role, content, index = 0) => ({
  id: `message-${role}-${index}`,
  role,
  content,
  timestamp: index,
});

const buildChat = (messages, options = {}, model = 'moonshotai/Kimi-K3') =>
  chatAdapter.buildPluginChatPayload(
    plugin,
    model,
    messages,
    options,
    {},
    true,
    'chat_completions'
  );

test('the bundled Modal manifest routes to the shared inference router', () => {
  assert.equal(plugin.id, 'modal');
  assert.equal(plugin.name, 'Modal');
  assert.equal(plugin.type, 'completion');
  assert.equal(
    plugin.endpoint,
    ROUTER,
    "the OpenAI-compatible router Modal's integration guide documents"
  );
  assert.deepEqual(plugin.auth, {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'MODAL_PROXY_TOKEN',
  });
  assert.ok(
    plugin.model_map.includes('moonshotai/Kimi-K3') &&
      plugin.model_map.includes('meta-models/Muse-Spark-Open-816B-A42B'),
    "the shared models Modal bills per token, until discovery lists the workspace's own"
  );
  const endpoint = plugin.variables.find(
    variable => variable.name === 'endpoint'
  );
  assert.equal(endpoint.default, ROUTER);
});

test('the Modal manifest matches its compiled trust anchor', () => {
  assert.equal(
    pluginDefinitionTrust.matchesBundledPluginTrustAnchor(plugin),
    true,
    'a bundled manifest change requires an intentional trust-anchor update'
  );
});

test('Modal uses Chat Completions semantics and derives its model list', () => {
  const apiConfig = pluginValidation.resolvePluginApiConfig(plugin, {});
  assert.equal(apiConfig.apiMode, 'chat_completions');
  assert.equal(apiConfig.endpoint, ROUTER);
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(plugin.endpoint),
    'https://inference.us-west.modal.direct/v1/models',
    'the listing of every Shared Endpoint the proxy token can reach'
  );
  const dedicated = pluginValidation.resolvePluginApiConfig(plugin, {
    endpoint: 'https://acme--support-chat.modal.run/v1/chat/completions',
  });
  assert.equal(
    dedicated.endpoint,
    'https://acme--support-chat.modal.run/v1/chat/completions',
    'a Dedicated Endpoint is reached by overriding the endpoint'
  );
});

test("a vLLM-style listing reports each model's window", () => {
  const entries = [
    {
      id: 'kimi-chat.us-west.modal.direct',
      object: 'model',
      owned_by: 'modal',
      max_model_len: 1048576,
    },
  ];
  assert.deepEqual(pluginModelCatalog.readModelContextMap(entries), {
    'kimi-chat.us-west.modal.direct': 1048576,
  });
});

test('Modal chat requests are plain Chat Completions', () => {
  const { payload } = buildChat([message('user', 'Hello')], {
    stop: ['\n\nUser:'],
  });
  assert.equal(payload.model, 'moonshotai/Kimi-K3');
  assert.deepEqual(payload.stop, ['\n\nUser:']);
  assert.equal(payload.stream, true);
  assert.equal(payload.reasoning_effort, undefined);
  assert.equal(
    buildChat([message('user', 'Hello')], { think: 'high' }).payload
      .reasoning_effort,
    'high'
  );
});

test('one conversation keeps one routing affinity key across turns', () => {
  const first = buildChat([
    message('system', 'Be brief.'),
    message('user', 'Plan a trip to Lisbon.'),
  ]);
  const key = first.headers?.[AFFINITY];
  assert.match(key, /^[0-9a-f]{32}$/);

  const later = buildChat([
    message('system', 'Be brief.'),
    message('user', 'Plan a trip to Lisbon.'),
    message('assistant', 'Three days: Alfama, Belém, Sintra.', 1),
    message('user', 'Add a day trip.', 2),
  ]);
  assert.equal(
    later.headers[AFFINITY],
    key,
    'the next turn lands where the earlier prefix is cached'
  );

  const other = buildChat([message('user', 'Explain monads.')]);
  assert.notEqual(other.headers[AFFINITY], key);

  const otherModel = buildChat(
    [message('user', 'Plan a trip to Lisbon.')],
    {},
    'zai-org/GLM-5.3'
  );
  assert.notEqual(otherModel.headers[AFFINITY], key);

  const compacted = buildChat([
    message('system', 'Summary of the earlier conversation: a Lisbon trip.'),
    message('user', 'Add a day trip.', 2),
  ]);
  assert.notEqual(
    compacted.headers[AFFINITY],
    key,
    'a rewritten prefix takes a new key, as Modal advises after compaction'
  );
});

test('only Modal requests carry a routing affinity key', () => {
  const openai = chatAdapter.buildPluginChatPayload(
    { ...plugin, id: 'openai' },
    'gpt-5.5',
    [message('user', 'Hello')],
    {},
    {},
    true,
    'chat_completions'
  );
  assert.equal(openai.headers?.[AFFINITY], undefined);
  assert.deepEqual(
    chatAdapter.providerRoutingHeaders(plugin, 'moonshotai/Kimi-K3', [
      { role: 'system', content: 'Be brief.' },
    ]),
    {},
    'nothing to key on before the first user message'
  );
});

test('Work runs on Modal send the same affinity key on every loop step', () => {
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

  const openai = buildPluginWorkPayload(
    { ...plugin, id: 'openai' },
    request(opening)
  );
  assert.equal(openai.extraHeaders[AFFINITY], undefined);
});

test("OpenCode in Work signs in to Modal with the server's proxy token", async () => {
  const previous = process.env.MODAL_PROXY_TOKEN;
  process.env.MODAL_PROXY_TOKEN = 'wk-REAL.ws-REAL';
  try {
    const login = await new OpenCodeHostLogin(() => '/nonexistent').prepare(
      'modal/moonshotai/Kimi-K3'
    );
    assert.deepEqual(Object.keys(login.env), ['MODAL_PROXY_TOKEN']);
    assert.equal(login.env.MODAL_PROXY_TOKEN, login.credentials[0].placeholder);
    assert.deepEqual(login.credentials[0].hosts, [
      'inference.us-west.modal.direct',
    ]);
    assert.doesNotMatch(JSON.stringify(login.env), /REAL/);
  } finally {
    if (previous === undefined) delete process.env.MODAL_PROXY_TOKEN;
    else process.env.MODAL_PROXY_TOKEN = previous;
  }

  const authDir = mkdtempSync(path.join(tmpdir(), 'libre-modal-opencode-'));
  try {
    const authFile = path.join(authDir, 'auth.json');
    fs.writeFileSync(
      authFile,
      JSON.stringify({ modal: { type: 'api', key: 'wk-SAVED.ws-SAVED' } })
    );
    const saved = await new OpenCodeHostLogin(() => authFile).prepare(
      'modal/zai-org/GLM-5.3'
    );
    const entry = JSON.parse(saved.files[0].content).modal;
    assert.equal(entry.key, saved.credentials[0].placeholder);
    assert.deepEqual(saved.credentials[0].hosts, [
      'inference.us-west.modal.direct',
    ]);
    assert.doesNotMatch(saved.files[0].content.toString(), /SAVED/);
  } finally {
    rmSync(authDir, { recursive: true, force: true });
  }
});
