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
 * The bundled DeepSeek provider: the manifest's routing, credential, and
 * model contract, its shipped trust anchor, derived model discovery, and the
 * DeepSeek-specific Chat Completions payload rules — the `thinking` toggle
 * and the `reasoning_content` replay its tool rounds require.
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
  fs.readFileSync(path.join(repoRoot, 'plugins', 'deepseek.json'), 'utf8')
);

const userMessage = {
  id: 'message-1',
  role: 'user',
  content: 'Hello',
  timestamp: 1,
};

const buildPayload = (messages, options = {}, model = 'deepseek-flash') =>
  chatAdapter.buildPluginChatPayload(
    plugin,
    model,
    messages,
    options,
    {},
    false,
    'chat_completions'
  ).payload;

test('the bundled DeepSeek manifest routes to the documented API', () => {
  assert.equal(plugin.id, 'deepseek');
  assert.equal(plugin.name, 'DeepSeek');
  assert.equal(plugin.type, 'completion');
  assert.equal(
    plugin.endpoint,
    'https://api.deepseek.com/chat/completions',
    'the OpenAI-format Chat Completions endpoint from the DeepSeek docs'
  );
  assert.deepEqual(plugin.auth, {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'DEEPSEEK_API_KEY',
  });

  assert.deepEqual(
    [...plugin.model_map].sort(),
    ['deepseek-flash', 'deepseek-v4-pro'],
    'current models plus the legacy names DeepSeek still routes'
  );
  assert.equal(
    plugin.model_map.includes('deepseek-chat'),
    false,
    'the discontinued chat/reasoner aliases must not be offered'
  );
});

test('the DeepSeek manifest matches its compiled trust anchor', () => {
  assert.equal(
    pluginDefinitionTrust.matchesBundledPluginTrustAnchor(plugin),
    true,
    'a bundled manifest change requires an intentional trust-anchor update'
  );
});

test('DeepSeek uses Chat Completions semantics and derives its model list', () => {
  const apiConfig = pluginValidation.resolvePluginApiConfig(plugin, {});
  assert.equal(apiConfig.apiMode, 'chat_completions');
  assert.equal(apiConfig.endpoint, 'https://api.deepseek.com/chat/completions');
  assert.equal(
    pluginValidation.resolvePluginModelsEndpoint(plugin.endpoint),
    'https://api.deepseek.com/models',
    'the documented GET /models listing'
  );
});

test('DeepSeek reasoning defaults to the provider and the toggle is explicit', () => {
  const unspecified = buildPayload([userMessage]);
  assert.equal(
    unspecified.thinking,
    undefined,
    'an unset preference leaves the provider default in place'
  );
  assert.equal(unspecified.reasoning_effort, undefined);

  const disabled = buildPayload([userMessage], { think: false });
  assert.deepEqual(disabled.thinking, { type: 'disabled' });
  assert.equal(disabled.reasoning_effort, undefined);

  const high = buildPayload([userMessage], { think: 'high' });
  assert.deepEqual(high.thinking, { type: 'enabled' });
  assert.equal(high.reasoning_effort, 'high');

  const on = buildPayload([userMessage], { think: true });
  assert.deepEqual(on.thinking, { type: 'enabled' });
  assert.equal(
    on.reasoning_effort,
    undefined,
    'DeepSeek has no medium effort: a plain on preference keeps its default'
  );
});

test('DeepSeek reapplies chain-of-thought beside its replayed tool calls', () => {
  const assistantMessage = {
    id: 'message-2',
    role: 'assistant',
    content: '',
    thinking: 'I should list the models first.',
    timestamp: 2,
    tool_calls: [
      {
        id: 'call-1',
        type: 'function',
        function: { name: 'list_models', arguments: '{}' },
      },
    ],
  };
  const toolMessage = {
    id: 'message-3',
    role: 'tool',
    content: 'ok',
    timestamp: 3,
    tool_call_id: 'call-1',
  };

  const payload = buildPayload([userMessage, assistantMessage, toolMessage]);
  const assistantWire = payload.messages[1];
  assert.equal(
    assistantWire.reasoning_content,
    'I should list the models first.'
  );
  assert.equal(
    'reasoning' in assistantWire,
    false,
    'OpenRouter’s field name is not what DeepSeek requires'
  );
  assert.deepEqual(assistantWire.tool_calls, assistantMessage.tool_calls);

  const otherProvider = chatAdapter.buildPluginChatPayload(
    { ...plugin, id: 'openai' },
    'gpt-test',
    [userMessage, assistantMessage, toolMessage],
    {},
    {},
    false,
    'chat_completions'
  ).payload;
  assert.equal(
    'reasoning_content' in otherProvider.messages[1],
    false,
    'only DeepSeek receives the DeepSeek reasoning field'
  );
  assert.equal('reasoning' in otherProvider.messages[1], false);

  assert.deepEqual(
    chatAdapter.getOpenAICompatibleThinkingParameters({ id: 'openai' }, false),
    {}
  );
  assert.deepEqual(
    chatAdapter.getOpenAICompatibleThinkingParameters(plugin, undefined),
    {}
  );
});
