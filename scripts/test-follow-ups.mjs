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
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const distModule = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const { FollowUpService } = await distModule('services/followUpService.js');

const exchange = [
  { id: 'u1', role: 'user', content: 'Build me a forest scene', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: 'Here is the scene.', timestamp: 2 },
];

function createHarness(session) {
  const calls = { prepare: [], plugin: [], ollama: [], strands: [] };
  const service = new FollowUpService({
    chatService: { getSession: async () => session },
    chatGenerationService: {
      prepareGenerationTarget: async (model, _userId, options, provider) => {
        calls.prepare.push({ model, provider });
        return {
          actualModelName: model,
          mergedOptions: { ...options },
          activePlugin:
            provider?.providerType === 'plugin'
              ? { id: provider.providerId }
              : null,
          ...provider,
        };
      },
      extractPluginAssistantContent: response =>
        response.choices[0].message.content,
    },
    pluginService: {
      executePluginRequest: async (model, _messages, _options, _user, id) => {
        calls.plugin.push({ model, pluginId: id });
        return {
          choices: [{ message: { content: 'Add a river\nMake it night' } }],
        };
      },
    },
    ollamaService: {
      generateResponse: async request => {
        calls.ollama.push(request.model);
        return { response: 'Add a river' };
      },
    },
    resolveStrandsProviderTarget: async model => {
      calls.strands.push(model);
      return {
        model: 'anthropic.claude-opus-5-5',
        providerType: 'plugin',
        providerId: 'bedrock',
      };
    },
    logger: { error() {} },
  });
  return { service, calls };
}

test('a Strands session asks the engine model, never Ollama', async () => {
  const { service, calls } = createHarness({
    id: 's1',
    model: 'strands:plugin:bedrock:anthropic.claude-opus-5-5',
    providerType: 'agent',
    providerId: 'strands',
    messages: exchange,
  });

  const suggestions = await service.generateFollowUpsForSession('s1', 'u');

  assert.deepEqual(suggestions, ['Add a river', 'Make it night']);
  assert.deepEqual(calls.strands, [
    'strands:plugin:bedrock:anthropic.claude-opus-5-5',
  ]);
  assert.deepEqual(calls.plugin, [
    { model: 'anthropic.claude-opus-5-5', pluginId: 'bedrock' },
  ]);
  assert.deepEqual(calls.ollama, []);
});

test('other agent harnesses get no suggestions and no provider call', async () => {
  const { service, calls } = createHarness({
    id: 's2',
    model: 'codex:gpt-6-sol',
    providerType: 'agent',
    providerId: 'codex',
    messages: exchange,
  });

  assert.deepEqual(await service.generateFollowUpsForSession('s2', 'u'), []);
  assert.deepEqual(calls.prepare, []);
  assert.deepEqual(calls.plugin, []);
  assert.deepEqual(calls.ollama, []);
});

test('a plugin session keeps its own provider', async () => {
  const { service, calls } = createHarness({
    id: 's3',
    model: 'anthropic.claude-opus-5-5',
    providerType: 'plugin',
    providerId: 'bedrock',
    messages: exchange,
  });

  assert.deepEqual(await service.generateFollowUpsForSession('s3', 'u'), [
    'Add a river',
    'Make it night',
  ]);
  assert.deepEqual(calls.strands, []);
  assert.deepEqual(calls.plugin, [
    { model: 'anthropic.claude-opus-5-5', pluginId: 'bedrock' },
  ]);
});
