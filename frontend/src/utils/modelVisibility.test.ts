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
import { orderModelsByCatalogPriority } from './modelVisibility';

const model = (name: string, pluginId?: string): OllamaModel => ({
  name,
  size: 0,
  digest: '',
  modified_at: '',
  isPlugin: Boolean(pluginId),
  pluginId,
});

test('puts starred models first in their saved sequence', () => {
  const models = [
    model('local-a'),
    model('cloud-a', 'provider'),
    model('local-b'),
    model('new-model'),
  ];

  assert.deepEqual(
    orderModelsByCatalogPriority(
      models,
      ['provider/cloud-a', 'local-b', 'local-a'],
      ['local-a', 'local-b']
    ).map(entry => entry.name),
    ['local-a', 'local-b', 'cloud-a', 'new-model']
  );
});

test('falls back to manual and provider order when stars are removed', () => {
  const models = [model('new-model'), model('local-a'), model('local-b')];

  assert.deepEqual(
    orderModelsByCatalogPriority(
      models,
      ['local-b', 'local-a'],
      ['missing-model']
    ).map(entry => entry.name),
    ['local-b', 'local-a', 'new-model']
  );
});

test('preserves models that share a catalog key', () => {
  const models = [model('duplicate'), model('duplicate')];
  assert.equal(
    orderModelsByCatalogPriority(models, ['duplicate'], []).length,
    2
  );
});
