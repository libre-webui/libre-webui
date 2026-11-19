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
import en from '../i18n/locales/en.json';
import {
  THINKING_CHOICES,
  thinkingChoiceOf,
  thinkingPreferenceOf,
} from './thinking';

test('every thinking choice round-trips through the stored preference', () => {
  assert.deepEqual(THINKING_CHOICES, [
    'default',
    'off',
    'on',
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
  for (const choice of THINKING_CHOICES) {
    assert.equal(thinkingChoiceOf(thinkingPreferenceOf(choice)), choice);
  }
  assert.equal(thinkingPreferenceOf('xhigh'), 'xhigh');
  assert.equal(thinkingPreferenceOf('max'), null);
});

test('every thinking choice has a label', () => {
  const labels = en.settings.generation.thinkingLevels as Record<
    string,
    string
  >;
  for (const choice of THINKING_CHOICES) {
    assert.ok(labels[choice], `${choice} has a label`);
  }
  assert.equal(labels.xhigh, 'Extra high');
});
