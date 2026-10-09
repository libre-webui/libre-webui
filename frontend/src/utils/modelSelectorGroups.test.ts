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
import test from 'node:test';
import type { OllamaModel } from '@/types';
import {
  agentRowParts,
  buildModelSources,
  isEmbeddingModel,
  modelMatchesSearch,
  modelVersionRank,
  previewSourceModels,
  SOURCE_PREVIEW_SIZE,
} from './modelSelectorGroups';

const labels = {
  legacy: 'Provider not recorded',
  unavailable: 'Unavailable selections',
  personas: 'Personas',
  ollama: 'Ollama Models',
  plugins: 'Plugin Models',
  agents: 'Agents',
};

const model = (name: string, extra: Partial<OllamaModel> = {}): OllamaModel =>
  ({
    name,
    model: name,
    size: 0,
    digest: '',
    modified_at: '',
    details: {},
    ...extra,
  }) as OllamaModel;

const plugin = (name: string, pluginId: string, pluginName: string) =>
  model(name, { isPlugin: true, pluginId, pluginName });

const agent = (name: string, agentId: string, agentName: string) =>
  model(name, { isAgent: true, agentId, agentName });

test('each plugin and agent harness gets its own source, models before agents', () => {
  const sources = buildModelSources(
    [
      agent('strands', 'strands', 'Strands'),
      agent(
        'strands:plugin:bedrock:mistral.devstral-2-123b',
        'strands',
        'Strands · mistral.devstral-2-123b (Amazon Bedrock)'
      ),
      agent('codex:gpt-6-sol', 'codex', 'Codex · GPT-6 Sol'),
      plugin('openai/gpt-4', 'openrouter', 'OpenRouter'),
      plugin('mistral.devstral-2-123b', 'bedrock', 'Amazon Bedrock'),
      plugin('anthropic.claude-opus-5-5', 'bedrock', 'Amazon Bedrock'),
      model('llama3.2:3b'),
      model('nomic-embed-text'),
      model('persona:abc', { isPersona: true, personaName: 'Ada' }),
      model('gone', { isPlugin: true, isUnavailable: true }),
    ],
    labels
  );

  assert.deepEqual(
    sources.map(source => [source.key, source.label, source.models.length]),
    [
      ['unavailable', 'Unavailable selections', 1],
      ['personas', 'Personas', 1],
      ['ollama', 'Ollama Models', 1],
      ['plugin:openrouter', 'OpenRouter', 1],
      ['plugin:bedrock', 'Amazon Bedrock', 2],
      ['agent:strands', 'Strands', 2],
      ['agent:codex', 'Codex', 1],
    ]
  );
  assert.deepEqual(
    sources[4].models.map(entry => entry.name),
    ['anthropic.claude-opus-5-5', 'mistral.devstral-2-123b'],
    'large catalogs read in name order'
  );
});

test('a harness default entry leads its group and rows drop the harness prefix', () => {
  const [strands] = buildModelSources(
    [
      agent(
        'strands:plugin:openrouter:openai%2Fgpt-4',
        'strands',
        'Strands · openai/gpt-4 (OpenRouter)'
      ),
      agent('strands', 'strands', 'Strands'),
    ],
    labels
  );
  assert.equal(strands.models[0].name, 'strands');
  assert.deepEqual(agentRowParts(strands.models[0], 'Strands'), {
    title: 'Strands',
    isDefault: true,
  });
  assert.deepEqual(agentRowParts(strands.models[1], 'Strands'), {
    title: 'openai/gpt-4',
    provider: 'OpenRouter',
    isDefault: false,
  });
});

test('a harness without a bare entry takes its name from the row prefix', () => {
  const [opencode] = buildModelSources(
    [
      agent(
        'opencode:opencode/big-pickle',
        'opencode',
        'OpenCode · big-pickle'
      ),
    ],
    labels
  );
  assert.equal(opencode.label, 'OpenCode');
  assert.equal(
    agentRowParts(opencode.models[0], 'OpenCode').title,
    'big-pickle'
  );
});

test('search matches every word across names and the source label', () => {
  const opus = plugin('anthropic.claude-opus-5-5', 'bedrock', 'Amazon Bedrock');
  const source = { label: 'Amazon Bedrock' };
  assert.ok(modelMatchesSearch(opus, source, 'bedrock opus'));
  assert.ok(modelMatchesSearch(opus, source, 'opus 5.5'));
  assert.ok(modelMatchesSearch(opus, source, 'claudeopus'));
  assert.ok(modelMatchesSearch(opus, source, '  '));
  assert.ok(!modelMatchesSearch(opus, source, 'openrouter opus'));
  assert.ok(
    modelMatchesSearch(model('gpt-4o'), { label: 'Ollama Models' }, 'gpt4o')
  );
});

test('previews keep small groups whole and always show the selection', () => {
  const small = Array.from({ length: 8 }, (_, i) => model(`m${i}`));
  assert.deepEqual(
    previewSourceModels(small, () => false),
    {
      visible: small,
      hidden: 0,
    }
  );

  const large = Array.from({ length: 40 }, (_, i) => model(`m${i}`));
  const preview = previewSourceModels(large, entry => entry.name === 'm30');
  assert.equal(preview.visible.length, SOURCE_PREVIEW_SIZE);
  assert.equal(preview.hidden, 40 - SOURCE_PREVIEW_SIZE);
  assert.ok(preview.visible.some(entry => entry.name === 'm30'));
});

test('provider and agent previews show the newest models first', () => {
  assert.equal(modelVersionRank('claude-sonnet-5-5'), 505);
  assert.equal(modelVersionRank('global.anthropic.claude-haiku-5-5'), 505);
  assert.equal(modelVersionRank('claude-haiku-4-5-20251001'), 405);
  assert.equal(modelVersionRank('gpt-5.6-sol'), 506);
  assert.equal(modelVersionRank('kiro:claude-sonnet-5.5'), 505);
  assert.equal(modelVersionRank('llama3.1:70b'), 301);
  assert.equal(modelVersionRank('auto'), -1);

  // Bedrock's Sonnet and Haiku 5.5 are global profiles, which sort last.
  const bedrock = [
    'amazon.nova-pro-v1',
    'anthropic.claude-haiku-4-5',
    'anthropic.claude-opus-5-5',
    'anthropic.claude-sonnet-5',
    'deepseek.v3-v1',
    'meta.llama3-3-70b-instruct-v1',
    'mistral.mistral-large-2407-v1',
    'qwen.qwen3-coder-30b-a3b-v1',
    'global.anthropic.claude-haiku-5-5',
    'global.anthropic.claude-sonnet-5-5',
  ].map(name => plugin(name, 'bedrock', 'Amazon Bedrock'));
  const preview = previewSourceModels(bedrock, () => false, {
    newestFirst: true,
  });
  const names = preview.visible.map(entry => entry.name);
  assert.equal(names.length, SOURCE_PREVIEW_SIZE);
  for (const wanted of [
    'anthropic.claude-opus-5-5',
    'global.anthropic.claude-haiku-5-5',
    'global.anthropic.claude-sonnet-5-5',
  ]) {
    assert.ok(names.includes(wanted), wanted);
  }
  // Rows keep the group's own order.
  assert.deepEqual(
    names,
    bedrock.map(entry => entry.name).filter(name => names.includes(name))
  );

  // An agent keeps its default entry, then its newest models.
  const kiro = [
    agent('kiro', 'kiro', 'Kiro'),
    ...[
      'auto',
      'claude-haiku-4.5',
      'claude-opus-4.5',
      'claude-opus-4.6',
      'claude-opus-5',
      'claude-opus-5.5',
      'claude-sonnet-4.6',
      'claude-sonnet-5',
      'claude-sonnet-5.5',
    ].map(id => agent(`kiro:${id}`, 'kiro', `Kiro · ${id}`)),
  ];
  const kiroNames = previewSourceModels(kiro, () => false, {
    newestFirst: true,
  }).visible.map(entry => entry.name);
  assert.equal(kiroNames[0], 'kiro');
  assert.ok(kiroNames.includes('kiro:claude-opus-5.5'));
  assert.ok(kiroNames.includes('kiro:claude-sonnet-5.5'));
});

test('embedding models stay out of the chat list', () => {
  assert.equal(isEmbeddingModel(model('nomic-embed-text:latest')), true);
  assert.equal(
    isEmbeddingModel(
      model('all-minilm:latest', { details: { family: 'bert' } })
    ),
    true
  );
  assert.equal(
    isEmbeddingModel(
      model('bge-m3:latest', { details: { families: ['nomic-bert'] } })
    ),
    true
  );
  assert.equal(
    isEmbeddingModel(model('smollm2:latest', { details: { family: 'llama' } })),
    false
  );
});
