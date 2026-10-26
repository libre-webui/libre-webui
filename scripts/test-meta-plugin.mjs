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
 * The bundled Meta provider: the manifest's routing, credential, and model
 * contract on the Meta Model API, its shipped trust anchor, derived model
 * discovery, and the Muse-specific Chat Completions payload rules (no stop
 * sequences, named reasoning levels only).
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
const pluginValidation = await distModule('utils/pluginValidation.js');
const chatAdapter = await distModule('utils/pluginChatAdapter.js');

const plugin = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'meta.json'), 'utf8')
);

const userMessage = {
  id: 'message-1',
  role: 'user',
  content: 'Hello',
  timestamp: 1,
};

const buildPayload = (messages, options = {}, model = 'muse-spark-1.3') =>
  chatAdapter.buildPluginChatPayload(
    plugin,
    model,
    messages,
    options,
    {},
    false,
    'chat_completions'
  ).payload;

test('the bundled Meta manifest routes to the Meta Model API', () => {
  assert.equal(plugin.id, 'meta');
  assert.equal(plugin.name, 'Meta');
  assert.equal(plugin.type, 'completion');
  assert.equal(
    plugin.endpoint,
    'https://api.meta.ai/v1/chat/completions',
    'the OpenAI-compatible Chat Completions endpoint from the Meta docs'
  );
  assert.deepEqual(plugin.auth, {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'META_API_KEY',
  });
  assert.deepEqual(plugin.model_map, [
    'muse-spark-1.3',
    'muse-spark-1.3-contributor',
    'muse-wonder-1.0',
  ]);
  const maxTokens = plugin.variables.find(
    variable => variable.name === 'max_tokens'
  );
  assert.equal(
    maxTokens.max,
    131072,
    "Muse's documented output ceiling, reasoning included"
  );
});

test('the Meta manifest matches its compiled trust anchor', () => {
  assert.equal(
    pluginDefinitionTrust.matchesBundledPluginTrustAnchor(plugin),
    true,
    'a bundled manifest change requires an intentional trust-anchor update'
  );
});

test('Meta uses Chat Completions semantics and derives its model list', () => {
  const apiConfig = pluginValidation.resolvePluginApiConfig(plugin, {});
  assert.equal(apiConfig.apiMode, 'chat_completions');
  assert.equal(apiConfig.endpoint, 'https://api.meta.ai/v1/chat/completions');
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(plugin.endpoint),
    'https://api.meta.ai/v1/models',
    'the documented GET /v1/models listing'
  );
});

test('Meta never receives stop sequences, which its reasoning models reject', () => {
  const payload = buildPayload([userMessage], { stop: ['\n\nUser:'] });
  assert.equal(payload.stop, undefined);
  const other = chatAdapter.buildPluginChatPayload(
    { ...plugin, id: 'openai' },
    'gpt-5.5',
    [userMessage],
    { stop: ['\n\nUser:'] },
    {},
    false,
    'chat_completions'
  ).payload;
  assert.deepEqual(
    other.stop,
    ['\n\nUser:'],
    'other providers keep the stop sequences they were given'
  );
});

test('Meta reasoning sends a named level only when one is chosen', () => {
  assert.equal(buildPayload([userMessage]).reasoning_effort, undefined);
  assert.equal(
    buildPayload([userMessage], { think: false }).reasoning_effort,
    undefined,
    'Muse cannot turn reasoning off and rejects "none": nothing is sent'
  );
  assert.equal(
    buildPayload([userMessage], { think: true }).reasoning_effort,
    'medium'
  );
  assert.equal(
    buildPayload([userMessage], { think: 'high' }).reasoning_effort,
    'high'
  );
  assert.equal(buildPayload([userMessage]).thinking, undefined);
});
