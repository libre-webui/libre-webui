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
import type { OllamaModel } from '@/types';
import {
  chatModelOptionKey,
  chatModelSelectionFromKey,
  chatModelSelectionKeyForModels,
  findChatModelForSelection,
  isAvailableOllamaModel,
  isChatModelSelectionAvailable,
  withUnavailableChatModel,
} from './chatModelSelection';

const model = (
  name: string,
  pluginId?: string,
  extra: Partial<OllamaModel> = {}
): OllamaModel => ({
  name,
  model: name,
  size: 0,
  digest: '',
  modified_at: '',
  details: {},
  isPlugin: Boolean(pluginId),
  pluginId,
  pluginName: pluginId,
  ...extra,
});

test('uses unique provider-qualified keys for duplicate raw model IDs', () => {
  const options = [
    model('shared/model:latest'),
    model('shared/model:latest', 'gateway/one'),
    model('shared/model:latest', 'gateway:two'),
  ];
  const keys = options.map(chatModelOptionKey);

  assert.equal(new Set(keys).size, 3);
  assert.deepEqual(keys, [
    'ollama:shared%2Fmodel%3Alatest',
    'plugin:gateway%2Fone:shared%2Fmodel%3Alatest',
    'plugin:gateway%3Atwo:shared%2Fmodel%3Alatest',
  ]);
});

test('round-trips encoded plugin selections while retaining the raw API model', () => {
  const options = [model('org/model:v2', 'provider/with:delimiter')];
  const key = chatModelOptionKey(options[0]);

  assert.deepEqual(chatModelSelectionFromKey(options, key), {
    model: 'org/model:v2',
    providerType: 'plugin',
    providerId: 'provider/with:delimiter',
  });
});

test('resolves explicit providers exactly and keeps legacy records visibly unqualified', () => {
  const options = [
    model('duplicate'),
    model('duplicate', 'plugin-a'),
    model('duplicate', 'plugin-b'),
  ];

  assert.equal(
    findChatModelForSelection(options, {
      model: 'duplicate',
      providerType: 'plugin',
      providerId: 'plugin-b',
    })?.pluginId,
    'plugin-b'
  );
  assert.equal(
    findChatModelForSelection(options, {
      model: 'duplicate',
      providerType: null,
      providerId: null,
    }),
    options[0]
  );
  assert.equal(
    chatModelSelectionKeyForModels(options, {
      model: 'duplicate',
      providerType: null,
      providerId: null,
    }),
    'legacy:duplicate'
  );

  const selectorOptions = withUnavailableChatModel(options, {
    model: 'duplicate',
    providerType: null,
    providerId: null,
  });
  assert.equal(selectorOptions.length, 4);
  assert.equal(selectorOptions[3].isLegacySelection, true);
  assert.equal(selectorOptions[3].isUnavailable, false);
  assert.equal(chatModelOptionKey(selectorOptions[3]), 'legacy:duplicate');
  assert.deepEqual(
    chatModelSelectionFromKey(selectorOptions, 'legacy:duplicate'),
    {
      model: 'duplicate',
      providerType: null,
      providerId: null,
    }
  );
  assert.equal(
    findChatModelForSelection(selectorOptions, {
      model: 'duplicate',
      providerType: null,
      providerId: null,
    })?.isLegacySelection,
    true
  );
});

test('keeps persona UI keys stable and records new persona selections as Ollama-backed', () => {
  const persona = model('persona:research/team', undefined, {
    isPersona: true,
    personaName: 'Research',
  });
  const key = chatModelOptionKey(persona);

  assert.equal(key, 'persona:research%2Fteam');
  assert.deepEqual(chatModelSelectionFromKey([persona], key), {
    model: 'persona:research/team',
    providerType: 'ollama',
    providerId: null,
  });

  const legacyPersonaOptions = withUnavailableChatModel([persona], {
    model: 'persona:research/team',
    providerType: null,
    providerId: null,
  });
  assert.equal(
    chatModelOptionKey(legacyPersonaOptions[1]),
    'legacy:persona%3Aresearch%2Fteam'
  );
  assert.deepEqual(
    chatModelSelectionFromKey(
      legacyPersonaOptions,
      'legacy:persona%3Aresearch%2Fteam'
    ),
    {
      model: 'persona:research/team',
      providerType: null,
      providerId: null,
    }
  );
});

test('adds an unavailable placeholder without changing an explicit selection', () => {
  const options = withUnavailableChatModel([model('other')], {
    model: 'duplicate',
    providerType: 'plugin',
    providerId: 'removed-plugin',
  });

  assert.equal(options.length, 2);
  assert.equal(options[1].isUnavailable, true);
  assert.equal(options[1].pluginId, 'removed-plugin');
  assert.equal(
    chatModelOptionKey(options[1]),
    'plugin:removed-plugin:duplicate'
  );
});

test('does not substitute a same-named provider for an unavailable explicit selection', () => {
  const concreteOptions = [model('duplicate', 'available-plugin')];
  const selection = {
    model: 'duplicate',
    providerType: 'ollama' as const,
    providerId: null,
  };

  assert.equal(
    findChatModelForSelection(concreteOptions, selection),
    undefined
  );
  assert.equal(
    isChatModelSelectionAvailable(concreteOptions, selection),
    false
  );

  const selectorOptions = withUnavailableChatModel(concreteOptions, selection);
  assert.equal(selectorOptions[1].isUnavailable, true);
  assert.equal(chatModelOptionKey(selectorOptions[1]), 'ollama:duplicate');
});

test('allows legacy routing only while a concrete raw-name match exists', () => {
  const selection = {
    model: 'duplicate',
    providerType: null,
    providerId: null,
  };
  const concreteOptions = [model('duplicate', 'plugin-a')];
  const syntheticOnly = [
    model('duplicate', undefined, {
      isLegacySelection: true,
      isUnavailable: true,
    }),
  ];

  assert.equal(isChatModelSelectionAvailable(concreteOptions, selection), true);
  assert.equal(isChatModelSelectionAvailable(syntheticOnly, selection), false);
});

test('only concrete available Ollama entries count as installed models', () => {
  assert.equal(isAvailableOllamaModel(model('installed')), true);
  assert.equal(isAvailableOllamaModel(model('plugin-only', 'plugin-a')), false);
  assert.equal(
    isAvailableOllamaModel(
      model('legacy', undefined, { isLegacySelection: true })
    ),
    false
  );
  assert.equal(
    isAvailableOllamaModel(
      model('removed', undefined, { isUnavailable: true })
    ),
    false
  );
  assert.equal(
    isAvailableOllamaModel(
      model('persona:one', undefined, { isPersona: true })
    ),
    false
  );
});
