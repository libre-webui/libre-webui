/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
import { workModelSelectionKey, type WorkModelOption } from '../types/work';
import {
  baseWorkModel,
  selectWorkEngine,
  workModelEngine,
  workModelFromChatStrands,
  workModelSupportsEngine,
} from './workModels';

const selections = [
  { model: 'hf.co/team/model', providerType: 'ollama' as const, remote: false },
  {
    model: 'same-model',
    providerType: 'plugin' as const,
    providerId: 'provider-a',
    remote: true,
  },
  {
    model: 'same-model',
    providerType: 'plugin' as const,
    providerId: 'provider-b',
    remote: true,
  },
];
const models: WorkModelOption[] = selections.map(selection => ({
  ...selection,
  key: workModelSelectionKey(selection),
  label: selection.model,
}));

test('selecting an engine preserves the model catalogue, names and provider identity', () => {
  const original = structuredClone(models);
  const options = models.map(model => selectWorkEngine(model, 'strands'));
  assert.deepEqual(models, original);
  for (const [index, engine] of options.entries()) {
    const model = models[index];
    assert.equal(engine.model, `strands:${model.model}`);
    assert.equal(engine.providerType, model.providerType);
    assert.equal(engine.providerId, model.providerId);
    assert.equal(engine.remote, model.remote);
    assert.equal(engine.label, model.label);
    assert.notEqual(engine.key, model.key);
    assert.deepEqual(selectWorkEngine(engine, 'libre'), model);
    assert.deepEqual(selectWorkEngine(engine, 'strands'), engine);
  }
  assert.equal(new Set(options.map(option => option.key)).size, options.length);
});

test('engine detection reads the Strands prefix and the legacy DSH prefix', () => {
  assert.equal(workModelEngine('llama3'), 'libre');
  assert.equal(workModelEngine('strands:llama3'), 'strands');
  assert.equal(workModelEngine('dsh:llama3'), 'strands');
  assert.equal(baseWorkModel('strands:llama3'), 'llama3');
  assert.equal(baseWorkModel('dsh:llama3'), 'llama3');
  assert.equal(baseWorkModel('llama3'), 'llama3');
  for (const model of models) {
    assert.equal(workModelSupportsEngine(model, 'strands'), true);
    assert.equal(workModelSupportsEngine(model, 'libre'), true);
  }
});

test('a Chat Strands selection maps to the same Work provider model', () => {
  const ollama = workModelFromChatStrands(
    {
      model: `strands:ollama:${encodeURIComponent('hf.co/team/model')}`,
      providerType: 'agent',
      providerId: 'strands',
    },
    models
  );
  assert.equal(ollama?.available, true);
  assert.deepEqual(ollama?.option, selectWorkEngine(models[0], 'strands'));

  const plugin = workModelFromChatStrands(
    {
      model: 'strands:plugin:provider-b:same-model',
      providerType: 'agent',
      providerId: 'strands',
    },
    models
  );
  assert.equal(plugin?.available, true);
  assert.equal(plugin?.option.providerId, 'provider-b');
  assert.equal(plugin?.option.model, 'strands:same-model');
});

test('an unknown Chat Strands model is reported unavailable, never swapped', () => {
  const result = workModelFromChatStrands(
    {
      model: 'strands:plugin:provider-c:missing',
      providerType: 'agent',
      providerId: 'strands',
    },
    models
  );
  assert.equal(result?.available, false);
  assert.equal(result?.option.providerId, 'provider-c');
  assert.equal(result?.option.remote, true);
});

test('only explicit Strands chat selections are translated', () => {
  for (const selection of [
    { model: 'strands', providerType: 'agent', providerId: 'strands' },
    { model: 'strands:ollama:llama3', providerType: 'ollama' },
    { model: 'strands:ollama:llama3', providerType: 'agent', providerId: 'pi' },
    {
      model: 'strands:ollama:agent%3Api',
      providerType: 'agent',
      providerId: 'strands',
    },
    {
      model: 'strands:ollama:%E0%A4%A',
      providerType: 'agent',
      providerId: 'strands',
    },
    {
      model: 'strands:plugin::model',
      providerType: 'agent',
      providerId: 'strands',
    },
    {
      model: 'dsh:lwui:ollama:llama3',
      providerType: 'agent',
      providerId: 'dsh',
    },
  ]) {
    assert.equal(workModelFromChatStrands(selection, models), undefined);
  }
});
