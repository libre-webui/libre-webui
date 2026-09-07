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
import { normalizeBackgroundSettings } from './backgroundSettings';

test('legacy wallpaper gains dither without changing the uploaded source or zero values', () => {
  const imageUrl = 'data:image/png;base64,original-source==';
  assert.deepEqual(
    normalizeBackgroundSettings({
      enabled: true,
      imageUrl,
      blurAmount: 0,
      opacity: 0,
    }),
    { enabled: true, imageUrl, blurAmount: 0, opacity: 0, effect: 'dither' }
  );
});

test('wallpaper normalization bounds effects and rejects non-finite rendering values', () => {
  assert.deepEqual(normalizeBackgroundSettings(), {
    enabled: false,
    imageUrl: '',
    blurAmount: 10,
    opacity: 0.6,
    effect: 'dither',
  });
  const bounded = normalizeBackgroundSettings({ blurAmount: 90, opacity: -1 });
  assert.equal(bounded.blurAmount, 30);
  assert.equal(bounded.opacity, 0);
  const nonFinite = normalizeBackgroundSettings({
    blurAmount: Number.POSITIVE_INFINITY,
    opacity: Number.NaN,
  });
  assert.equal(nonFinite.blurAmount, 10);
  assert.equal(nonFinite.opacity, 0.6);
  const malformed = normalizeBackgroundSettings(
    JSON.parse('{"enabled":"true","imageUrl":17,"effect":"unknown"}')
  );
  assert.equal(malformed.enabled, false);
  assert.equal(malformed.imageUrl, '');
  assert.equal(malformed.effect, 'dither');
  for (const effect of ['dither', 'original', 'blur'] as const) {
    assert.equal(normalizeBackgroundSettings({ effect }).effect, effect);
  }
});
