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
import {
  findImageGenModel,
  findPreferredImagePlugin,
  getImageGenImageFileExtension,
  getImageGenImageSource,
  getImageGenModelOptionValue,
  resolveImageGenOption,
  resolveImageGenModel,
  type ImageGenModel,
} from './imageGenModels';

const models: ImageGenModel[] = [
  { model: 'shared-model', plugin: 'provider-one' },
  { model: 'shared-model', plugin: 'provider-two' },
];

test('finds an image model by both provider and model ID', () => {
  assert.equal(
    findImageGenModel(models, 'shared-model', 'provider-two')?.plugin,
    'provider-two'
  );
});

test('encodes provider-qualified values for duplicate model IDs', () => {
  assert.notEqual(
    getImageGenModelOptionValue(models[0]),
    getImageGenModelOptionValue(models[1])
  );
});

test('fails closed when an explicitly saved provider is unavailable', () => {
  assert.equal(
    resolveImageGenModel(models, 'shared-model', 'removed-provider'),
    undefined
  );
  assert.equal(
    findPreferredImagePlugin(
      [
        { id: 'provider-one', models: ['shared-model'] },
        { id: 'provider-two', models: ['shared-model'] },
      ],
      { model: 'shared-model', pluginId: 'removed-provider' }
    ),
    undefined
  );
});

test('keeps legacy fallback behavior when no provider was saved', () => {
  assert.equal(resolveImageGenModel(models, 'removed-model'), models[0]);
  assert.equal(
    findPreferredImagePlugin(
      [
        { id: 'provider-one', models: ['other-model'] },
        { id: 'provider-two', models: ['shared-model'] },
      ],
      { model: 'shared-model' }
    )?.id,
    'provider-two'
  );
});

test('resolves image options only to advertised values', () => {
  assert.equal(
    resolveImageGenOption(
      ['auto', 'low', 'high'],
      'standard',
      'auto',
      'standard'
    ),
    'auto'
  );
  assert.equal(
    resolveImageGenOption(['low', 'high'], 'standard', 'invalid', 'standard'),
    'low'
  );
  assert.equal(
    resolveImageGenOption(undefined, 'provider-default', undefined, 'fallback'),
    'provider-default'
  );
});

test('preserves safe image MIME types in generated data URLs', () => {
  assert.equal(
    getImageGenImageSource({
      b64_json: 'UklGRg==',
      mime_type: 'image/webp',
    }),
    'data:image/webp;base64,UklGRg=='
  );
  assert.equal(
    getImageGenImageSource({
      b64_json: 'iVBORw0KGgo=',
      mime_type: 'text/html',
    }),
    'data:image/png;base64,iVBORw0KGgo='
  );
  assert.equal(
    getImageGenImageSource({
      url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    }),
    null
  );
  assert.equal(getImageGenImageSource({ url: 'javascript:alert(1)' }), null);
});

test('uses safe download extensions for generated image data URLs', () => {
  assert.equal(
    getImageGenImageFileExtension('data:image/jpeg;base64,/9j/4AAQ'),
    'jpg'
  );
  assert.equal(
    getImageGenImageFileExtension('data:image/webp;base64,UklGRg=='),
    'webp'
  );
  assert.equal(
    getImageGenImageFileExtension('data:text/html;base64,PHNjcmlwdD4='),
    'png'
  );
  assert.equal(
    getImageGenImageFileExtension('https://example.com/generated-image'),
    'png'
  );
});
