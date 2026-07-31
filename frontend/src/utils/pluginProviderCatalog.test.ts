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
import type { Plugin } from '@/types';
import {
  buildPluginProviderCatalog,
  pluginMatchesProviderSearch,
  pluginSupportsModelRefresh,
} from './pluginProviderCatalog';

const plugin: Plugin = {
  id: 'multi-provider',
  name: 'Multi Provider',
  type: 'completion',
  endpoint: 'https://provider.example/v1/chat/completions',
  base_url: 'https://provider.example/v1',
  auth: {
    header: 'Authorization',
    key_env: 'MULTI_PROVIDER_API_KEY',
  },
  model_map: ['shared-model', 'chat-model', ' shared-model ', ''],
  capabilities: {
    completion: {
      endpoint: 'https://provider.example/v1/chat/completions',
      model_map: ['shared-model'],
    },
    image: {
      endpoint: 'https://provider.example/v1/images/generations',
      model_map: ['shared-model', 'image-model'],
    },
    tts: {
      endpoint: 'https://provider.example/v1/audio/speech',
      model_map: ['shared-model', 'speech-model'],
    },
    stt: {
      endpoint: 'https://provider.example/v1/audio/transcriptions',
      model_map: ['transcription-model'],
    },
    embedding: {
      endpoint: 'https://provider.example/v1/embeddings',
      model_map: ['embedding-model'],
    },
  },
};

test('builds a deduplicated catalog with only declared capabilities', () => {
  assert.deepEqual(buildPluginProviderCatalog(plugin), [
    {
      id: 'shared-model',
      capabilities: ['Chat', 'Image', 'Speech'],
    },
    { id: 'chat-model', capabilities: ['Chat'] },
    { id: 'image-model', capabilities: ['Image'] },
    { id: 'speech-model', capabilities: ['Speech'] },
    { id: 'transcription-model', capabilities: ['Transcription'] },
    { id: 'embedding-model', capabilities: ['Embedding'] },
  ]);
});

test('limits live model refresh to primary chat providers', () => {
  assert.equal(pluginSupportsModelRefresh(plugin), true);
  assert.equal(pluginSupportsModelRefresh({ ...plugin, type: 'chat' }), true);
  assert.equal(pluginSupportsModelRefresh({ ...plugin, type: 'image' }), false);
  assert.deepEqual(
    buildPluginProviderCatalog({
      ...plugin,
      type: 'stt',
      model_map: ['transcription-only'],
      capabilities: undefined,
    }),
    [
      {
        id: 'transcription-only',
        capabilities: ['Transcription'],
      },
    ]
  );
});

test('searches provider identity and configured model ids', () => {
  assert.equal(pluginMatchesProviderSearch(plugin, 'multi provider'), true);
  assert.equal(pluginMatchesProviderSearch(plugin, 'multi-provider'), true);
  assert.equal(pluginMatchesProviderSearch(plugin, 'image-model'), true);
  assert.equal(pluginMatchesProviderSearch(plugin, 'missing'), false);
  assert.equal(pluginMatchesProviderSearch(plugin, '   '), true);
});
