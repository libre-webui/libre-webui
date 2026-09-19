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
  workModelFromChatDsh,
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
  const options = models.map(model => selectWorkEngine(model, 'dsh'));
  assert.deepEqual(
    models,
    original,
    'engine selection never adds entries to the model catalogue'
  );
  for (const [index, engine] of options.entries()) {
    const model = models[index];
    assert.equal(engine.model, `dsh:${model.model}`);
    assert.equal(engine.providerType, model.providerType);
    assert.equal(engine.providerId, model.providerId);
    assert.equal(engine.remote, model.remote);
    assert.equal(baseWorkModel(engine.model), model.model);
    assert.equal(
      engine.label,
      model.label,
      'display names never acquire an engine prefix'
    );
  }
  assert.equal(new Set(options.map(option => option.key)).size, options.length);
  assert.equal(options[0].key, 'ollama:dsh%3Ahf.co%2Fteam%2Fmodel');
});

test('saved engine selections round-trip without stacking serialization prefixes', () => {
  for (const model of models) {
    const engine = selectWorkEngine(model, 'dsh');
    assert.equal(workModelEngine(engine.model), 'dsh');
    assert.deepEqual(selectWorkEngine(engine, 'dsh'), engine);
    assert.deepEqual(selectWorkEngine(engine, 'libre'), model);
    assert.equal(workModelEngine(model.model), 'libre');
  }
});

test('a qualified Chat DSH plugin choice becomes the same Work engine/model/provider tuple', () => {
  const raw = 'lab/model:latest';
  const providerId = 'provider/team';
  const options: WorkModelOption[] = [
    { model: raw, providerType: 'ollama' as const, remote: false, label: raw },
    {
      model: raw,
      providerType: 'plugin' as const,
      providerId: 'other-provider',
      remote: true,
      label: 'Other provider',
    },
    {
      model: raw,
      providerType: 'plugin' as const,
      providerId,
      remote: true,
      label: 'Preferred gateway',
    },
  ].map(option => ({ ...option, key: workModelSelectionKey(option) }));
  const selection = workModelFromChatDsh(
    {
      model: `dsh:lwui:plugin:${encodeURIComponent(providerId)}:${encodeURIComponent(raw)}`,
      providerType: 'agent',
      providerId: 'dsh',
    },
    options
  );
  assert.deepEqual(selection, {
    option: selectWorkEngine(options[2], 'dsh'),
    available: true,
  });
  assert.equal(selection?.option.model, 'dsh:lab/model:latest');
  assert.equal(selection?.option.providerId, providerId);
  assert.equal(selection?.option.label, 'Preferred gateway');
  assert.equal(baseWorkModel(selection!.option.model), raw);
});

test('qualified local Chat DSH choices preserve their exact model and cloud disclosure', () => {
  const local: WorkModelOption = {
    model: 'local-model:cloud',
    providerType: 'ollama',
    remote: true,
    label: 'Local model',
    key: 'ollama:local-model%3Acloud',
  };
  assert.deepEqual(
    workModelFromChatDsh(
      {
        model: 'dsh:lwui:ollama:local-model%3Acloud',
        providerType: 'agent',
        providerId: 'dsh',
      },
      [local]
    ),
    { option: selectWorkEngine(local, 'dsh'), available: true }
  );
});

test('an unavailable Chat DSH provider remains selected instead of falling back to a same-named provider', () => {
  const chosen = {
    model: 'dsh:lwui:plugin:offline-provider:same-model',
    providerType: 'agent',
    providerId: 'dsh',
  };
  const result = workModelFromChatDsh(chosen, models);
  assert.equal(result?.available, false);
  assert.equal(result?.option.model, 'dsh:same-model');
  assert.equal(result?.option.providerType, 'plugin');
  assert.equal(result?.option.providerId, 'offline-provider');
  assert.equal(result?.option.remote, true);
  assert.equal(result?.option.key, 'plugin:offline-provider:dsh%3Asame-model');
  assert.ok(!models.some(model => model.key === result?.option.key));
});

test('the handoff requires explicit agent identity and never interprets an ordinary model name as DSH', () => {
  const qualified = 'dsh:lwui:plugin:provider-a:same-model';
  for (const identity of [
    { providerType: 'ollama', providerId: null },
    { providerType: 'plugin', providerId: 'dsh' },
    { providerType: 'agent', providerId: 'codex' },
    { providerType: 'agent', providerId: null },
    { providerType: null, providerId: null },
  ])
    assert.equal(
      workModelFromChatDsh({ model: qualified, ...identity }, models),
      undefined
    );
  assert.equal(
    workModelFromChatDsh({ model: 'dsh', providerType: 'ollama' }, models),
    undefined
  );
  assert.equal(
    workModelFromChatDsh(
      { model: 'dsh', providerType: 'agent', providerId: 'dsh' },
      models
    ),
    undefined,
    'the base profile keeps existing default-model behavior'
  );
});

test('malformed qualified and pseudo Chat model identities never become Work provider model IDs', () => {
  for (const model of [
    'dsh:lwui:ollama:%',
    'dsh:lwui:ollama:',
    'dsh:lwui:ollama:unescaped:tag',
    'dsh:lwui:plugin::same-model',
    'dsh:lwui:plugin:provider-a:persona%3Aexample',
    'dsh:lwui:ollama:agent%3Acodex',
    'dsh:lwui:ollama:dsh',
    'dsh:lwui:ollama:lwui%3Aollama%3Anested',
    'dsh:lwui:ollama:%00model',
  ])
    assert.equal(
      workModelFromChatDsh(
        { model, providerType: 'agent', providerId: 'dsh' },
        models
      ),
      undefined,
      model
    );
});

test('native DSH identity uses its provider and preserves the raw model verbatim', () => {
  const native: WorkModelOption = {
    model: 'dsh:lab/model:latest',
    providerType: 'dsh',
    providerId: 'team/provider',
    key: 'dsh:team%2Fprovider:dsh%3Alab%2Fmodel%3Alatest',
    label: 'Pro · Native provider',
    remote: true,
  };
  assert.equal(workModelSelectionKey(native), native.key);
  assert.equal(workModelEngine(native.model, native.providerType), 'dsh');
  assert.equal(baseWorkModel(native.model, native.providerType), native.model);
  assert.deepEqual(selectWorkEngine(native, 'dsh'), native);
  assert.equal(workModelSupportsEngine(native, 'libre'), false);
  assert.equal(workModelSupportsEngine(native, 'dsh'), true);
});

test('native Chat aliases match only their exact native Work provider and model', () => {
  const native: WorkModelOption = {
    model: 'deepseek-v4-flash',
    providerType: 'dsh',
    providerId: 'deepseek',
    label: 'Flash · DeepSeek',
    remote: true,
    key: 'dsh:deepseek:deepseek-v4-flash',
  };
  const selection = {
    model: 'dsh:native:deepseek:deepseek-v4-flash',
    providerType: 'agent',
    providerId: 'dsh',
  };
  const candidates = [
    {
      ...native,
      providerType: 'plugin' as const,
      key: 'plugin:deepseek:deepseek-v4-flash',
    },
    {
      ...native,
      providerId: 'other-native',
      key: 'dsh:other-native:deepseek-v4-flash',
    },
    native,
  ];
  assert.deepEqual(workModelFromChatDsh(selection, candidates), {
    option: native,
    available: true,
  });
  const absent = workModelFromChatDsh(selection, candidates.slice(0, 2));
  assert.equal(absent?.available, false);
  assert.equal(absent?.option.providerType, 'dsh');
  assert.equal(absent?.option.providerId, 'deepseek');
  assert.equal(absent?.option.model, native.model);
  assert.equal(absent?.option.remote, true);
});

test('native Chat aliases decode once and reject incomplete identities', () => {
  const model = 'dsh:native-route/model:pro';
  const provider = 'provider/team';
  const selected = workModelFromChatDsh(
    {
      model: `dsh:native:${encodeURIComponent(provider)}:${encodeURIComponent(model)}`,
      providerType: 'agent',
      providerId: 'dsh',
    },
    []
  );
  assert.equal(selected?.option.model, model);
  assert.equal(selected?.option.providerId, provider);
  for (const model of [
    'dsh:native::flash',
    'dsh:native:provider:',
    'dsh:native:%:flash',
    'dsh:native:provider:unescaped:tag',
    'dsh:native:provider:%00flash',
  ]) {
    assert.equal(
      workModelFromChatDsh(
        { model, providerType: 'agent', providerId: 'dsh' },
        []
      ),
      undefined
    );
  }
});
