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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, beforeEach } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The Work provider module opens the database on import; keep it disposable.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-bedrock-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
after(() => {
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const trust = await distModule('utils/pluginDefinitionTrust.js');
const validation = await distModule('utils/pluginValidation.js');
const chatAdapter = await distModule('utils/pluginChatAdapter.js');
const bedrock = await distModule('utils/bedrockMantle.js');
const work = await distModule('services/workModelProviderService.js');

const plugin = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'plugins', 'bedrock.json'), 'utf8')
);
const mantle = region =>
  `https://bedrock-mantle.${region}.api.aws/v1/chat/completions`;
const defaultEndpoint = mantle('us-east-1');

const userMessage = {
  id: 'message-1',
  role: 'user',
  content: 'Hello',
  timestamp: 1,
};

beforeEach(() => bedrock.resetBedrockRoutes());

test('the bundled Bedrock manifest routes a Bedrock API key to Mantle', () => {
  assert.equal(plugin.id, 'bedrock');
  assert.equal(plugin.name, 'Amazon Bedrock');
  assert.equal(plugin.type, 'completion');
  assert.equal(plugin.endpoint, defaultEndpoint);
  assert.deepEqual(plugin.auth, {
    header: 'Authorization',
    prefix: 'Bearer ',
    key_env: 'AWS_BEARER_TOKEN_BEDROCK',
  });
  assert.equal(
    trust.matchesBundledPluginTrustAnchor(plugin),
    true,
    'the compiled trust anchor must cover the shipped manifest'
  );
  const region = plugin.variables.find(variable => variable.name === 'region');
  assert.equal(region.type, 'select');
  assert.equal(region.default, bedrock.BEDROCK_DEFAULT_REGION);
  assert.deepEqual(region.options, [...bedrock.BEDROCK_MANTLE_REGIONS]);
  assert.equal(
    plugin.variables.some(variable => variable.name === 'endpoint'),
    false,
    'the Region select is the only routing control, so the key stays on AWS'
  );
});

test('the Region picks the Mantle host and discovery lists that Region', () => {
  const resolved = validation.resolvePluginApiConfig(plugin, {
    region: 'eu-central-1',
  });
  assert.equal(resolved.endpoint, mantle('eu-central-1'));
  assert.equal(resolved.apiMode, 'chat_completions');
  assert.equal(
    validation.resolvePluginModelsEndpoint(resolved.endpoint),
    'https://bedrock-mantle.eu-central-1.api.aws/v1/models'
  );
  assert.equal(
    validation.resolvePluginApiConfig(plugin, {}).endpoint,
    defaultEndpoint
  );
});

test('a Region value can never move the key off a Mantle host', () => {
  for (const region of [
    'us-west-1',
    'evil.example.com',
    'us-east-1.evil.example.com#',
    '../us-east-1',
    '',
    42,
  ]) {
    assert.equal(
      validation.resolvePluginApiConfig(plugin, { region }).endpoint,
      defaultEndpoint,
      `region ${JSON.stringify(region)} must be ignored`
    );
  }
  assert.equal(
    bedrock.applyBedrockRegion(
      'https://proxy.example.com/v1/chat/completions',
      'eu-west-1'
    ),
    'https://proxy.example.com/v1/chat/completions',
    'only Mantle hosts are rewritten'
  );
  assert.equal(
    validation.resolvePluginApiConfig(
      { ...plugin, id: 'openai' },
      { region: 'eu-west-1' }
    ).endpoint,
    defaultEndpoint,
    'the Region variable means nothing to other plugins'
  );
});

test('Claude uses the Messages route and other models use Chat Completions', () => {
  const endpoint = mantle('us-west-2');
  assert.equal(
    bedrock.pluginChatEndpoint(plugin, endpoint, 'anthropic.claude-opus-5'),
    'https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages'
  );
  assert.equal(
    bedrock.pluginChatEndpoint(plugin, endpoint, 'openai.gpt-oss-120b'),
    'https://bedrock-mantle.us-west-2.api.aws/v1/chat/completions'
  );
  assert.equal(
    bedrock.pluginChatEndpoint(plugin, endpoint, 'xai.grok-4.3'),
    'https://bedrock-mantle.us-west-2.api.aws/openai/v1/chat/completions',
    'families Mantle only serves on /openai/v1 go there first'
  );
  assert.equal(
    bedrock.pluginChatEndpoint(
      { id: 'openrouter' },
      'https://openrouter.ai/api/v1/chat/completions',
      'anthropic.claude-opus-5'
    ),
    'https://openrouter.ai/api/v1/chat/completions',
    'other plugins keep their endpoint'
  );
  assert.equal(
    bedrock.pluginChatProtocol(plugin, 'anthropic.claude-haiku-4-5'),
    'anthropic'
  );
  assert.equal(bedrock.pluginChatProtocol(plugin, 'deepseek.v3.2'), 'openai');
  assert.equal(
    bedrock.pluginChatProtocol({ id: 'openrouter' }, 'anthropic.claude-x'),
    'openai'
  );
});

test('Claude on Bedrock gets an Anthropic Messages payload', () => {
  const { payload, headers } = chatAdapter.buildPluginChatPayload(
    plugin,
    'anthropic.claude-haiku-4-5',
    [
      { ...userMessage, id: 'system', role: 'system', content: 'Be brief.' },
      userMessage,
    ],
    {
      tools: [
        {
          name: 'get_time',
          description: 'Get the time',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    { max_tokens: 500000, temperature: 0.2 },
    true,
    'chat_completions'
  );
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(payload.model, 'anthropic.claude-haiku-4-5');
  assert.equal(payload.system, 'Be brief.');
  assert.equal(payload.max_tokens, 64000, 'the Claude ceiling still applies');
  assert.equal(payload.stream, true);
  assert.equal(payload.tools[0].name, 'get_time');
  assert.ok(payload.tools[0].input_schema);
  assert.equal(
    payload.temperature,
    0.2,
    'Haiku 4.5 is matched without its Bedrock prefix and still takes sampling'
  );
  const current = chatAdapter.buildPluginChatPayload(
    plugin,
    'anthropic.claude-opus-5',
    [userMessage],
    {},
    { temperature: 0.2 },
    true,
    'chat_completions'
  ).payload;
  assert.equal('temperature' in current, false, 'current Claude omits it');

  const response = chatAdapter.convertProviderResponse(
    plugin,
    {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi there.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    'anthropic.claude-haiku-4-5'
  );
  assert.equal(response.choices[0].message.content, 'Hi there.');
  assert.equal(response.usage.total_tokens, 8);
});

test('other Bedrock models get an OpenAI-compatible payload', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    plugin,
    'openai.gpt-oss-20b',
    [userMessage],
    {},
    { max_tokens: 64 },
    false,
    'chat_completions'
  );
  assert.equal(payload.model, 'openai.gpt-oss-20b');
  assert.equal(payload.max_tokens, 64);
  assert.equal(payload.messages[0].content, 'Hello');
  assert.equal('system' in payload, false);
});

test('Work sends Claude on Bedrock the Messages payload', () => {
  const { payload, extraHeaders } = work.buildPluginWorkPayload(plugin, {
    model: 'anthropic.claude-sonnet-5',
    messages: [{ role: 'user', content: 'Hello' }],
    stream: true,
  });
  assert.equal(extraHeaders['anthropic-version'], '2023-06-01');
  assert.equal(payload.model, 'anthropic.claude-sonnet-5');
  assert.equal(typeof payload.max_tokens, 'number');
  assert.equal(
    work.buildPluginWorkPayload(plugin, {
      model: 'zai.glm-5',
      messages: [{ role: 'user', content: 'Hello' }],
    }).payload.messages[0].content,
    'Hello'
  );
});

const mismatch = model =>
  new Response(
    JSON.stringify({
      error: {
        code: 'validation_error',
        message: `model \`${model}\` isn't supported on this route`,
        type: 'invalid_request_error',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } }
  );

test('a model on the other Chat Completions route is retried there once and remembered', async () => {
  const calls = [];
  const inits = [];
  const fetchImpl = async (url, requestInit) => {
    calls.push(url);
    inits.push(requestInit);
    return url.includes('/openai/v1/')
      ? new Response('{"ok":true}', { status: 200 })
      : mismatch('new.model');
  };
  const init = {
    method: 'POST',
    body: '{"model":"new.model"}',
    redirect: 'error',
  };

  const first = await bedrock.fetchPluginChat(
    plugin,
    defaultEndpoint,
    'new.model',
    init,
    fetchImpl
  );
  assert.equal(first.status, 200);
  assert.deepEqual(calls, [
    'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions',
    'https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions',
  ]);
  assert.ok(
    inits.every(requestInit => requestInit === init),
    'the retry keeps the body, headers, signal, and redirect refusal'
  );

  calls.length = 0;
  await bedrock.fetchPluginChat(
    plugin,
    defaultEndpoint,
    'new.model',
    init,
    fetchImpl
  );
  assert.deepEqual(
    calls,
    ['https://bedrock-mantle.us-east-1.api.aws/openai/v1/chat/completions'],
    'the working route is used directly next time'
  );

  calls.length = 0;
  await bedrock.fetchPluginChat(
    plugin,
    mantle('eu-west-1'),
    'new.model',
    init,
    fetchImpl
  );
  assert.equal(calls.length, 2, 'routes are remembered per Region');
});

test('other errors are returned untouched and never retried', async () => {
  const calls = [];
  const denied = await bedrock.fetchPluginChat(
    plugin,
    defaultEndpoint,
    'openai.gpt-oss-20b',
    { method: 'POST', body: '{}' },
    async url => {
      calls.push(url);
      return new Response('{"error":{"message":"Invalid API key"}}', {
        status: 400,
      });
    }
  );
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /Invalid API key/);
  assert.equal(calls.length, 1);

  calls.length = 0;
  const other = await bedrock.fetchPluginChat(
    { id: 'openrouter' },
    'https://openrouter.ai/api/v1/chat/completions',
    'x',
    { method: 'POST', body: '{}' },
    async url => {
      calls.push(url);
      return mismatch('x');
    }
  );
  assert.equal(other.status, 400);
  assert.equal(calls.length, 1, 'only Bedrock falls back');

  calls.length = 0;
  await bedrock.fetchPluginChat(
    plugin,
    defaultEndpoint,
    'anthropic.claude-opus-5',
    { method: 'POST', body: '{}' },
    async url => {
      calls.push(url);
      return mismatch('anthropic.claude-opus-5');
    }
  );
  assert.deepEqual(calls, [
    'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages',
  ]);
});

test('clients that throw on a 400 fall back the same way', async () => {
  const calls = [];
  const result = await bedrock.requestPluginChat(
    plugin,
    defaultEndpoint,
    'google.gemma-3-27b-it',
    async url => {
      calls.push(url);
      if (url.includes('/v1/chat/completions') && !url.includes('/openai/')) {
        const error = new Error('Request failed with status code 400');
        error.response = {
          status: 400,
          data: {
            error: { message: "model `x` isn't supported on this route" },
          },
        };
        throw error;
      }
      return { data: { ok: true } };
    }
  );
  assert.deepEqual(result, { data: { ok: true } });
  assert.equal(calls.length, 2);

  await assert.rejects(
    bedrock.requestPluginChat(plugin, defaultEndpoint, 'qwen.qwen3-32b', () =>
      Promise.reject(
        Object.assign(new Error('throttled'), {
          response: { status: 429, data: 'Too many requests' },
        })
      )
    ),
    /throttled/
  );
});
