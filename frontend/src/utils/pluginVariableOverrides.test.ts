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
import type { PluginVariableDefinition } from '@/types';
import {
  buildPluginVariableUpdate,
  getInheritedPluginVariableValue,
  initializePluginVariableInputs,
  isConnectionPluginVariable,
  splitPluginVariableDefinitions,
} from './pluginVariableOverrides';

const definitions: PluginVariableDefinition[] = [
  {
    name: 'endpoint',
    type: 'string',
    label: 'Endpoint',
    default: 'https://provider.example/v1/chat/completions',
  },
  {
    name: 'temperature',
    type: 'number',
    label: 'Temperature',
    default: 0.7,
  },
  {
    name: 'stream',
    type: 'boolean',
    label: 'Stream',
    default: true,
  },
  {
    name: 'secret_header',
    type: 'string',
    label: 'Secret header',
    sensitive: true,
  },
];

test('separates connection fields from advanced provider parameters', () => {
  assert.equal(isConnectionPluginVariable('endpoint'), true);
  assert.equal(isConnectionPluginVariable('api_mode'), true);
  assert.equal(isConnectionPluginVariable('api_path'), true);
  assert.equal(isConnectionPluginVariable('models_endpoint'), true);
  assert.equal(isConnectionPluginVariable('temperature'), false);

  const sections = splitPluginVariableDefinitions(definitions);
  assert.deepEqual(
    sections.connection.map(definition => definition.name),
    ['endpoint']
  );
  assert.deepEqual(
    sections.advanced.map(definition => definition.name),
    ['temperature', 'stream', 'secret_header']
  );
});

test('shows inherited fields as blank instead of copying manifest defaults', () => {
  assert.deepEqual(initializePluginVariableInputs(definitions, {}), {
    endpoint: '',
    temperature: '',
    stream: '',
    secret_header: '',
  });

  assert.deepEqual(
    initializePluginVariableInputs(definitions, {
      temperature: {
        value: 0.25,
        is_sensitive: false,
        has_value: true,
      },
      secret_header: {
        value: '••••••••',
        is_sensitive: true,
        has_value: true,
      },
    }),
    {
      endpoint: '',
      temperature: 0.25,
      stream: '',
      secret_header: '',
    }
  );
});

test('uses the top-level plugin endpoint as an inherited endpoint fallback', () => {
  assert.equal(
    getInheritedPluginVariableValue(
      {
        name: 'endpoint',
        type: 'string',
        label: 'Endpoint',
        required: true,
      },
      'https://provider.example/v1/chat/completions'
    ),
    'https://provider.example/v1/chat/completions'
  );
  assert.equal(
    getInheritedPluginVariableValue(
      {
        name: 'temperature',
        type: 'number',
        label: 'Temperature',
        default: 0.7,
      },
      'https://provider.example/v1/chat/completions'
    ),
    0.7
  );
});

test('saves only changed overrides and unsets cleared non-sensitive values', () => {
  const update = buildPluginVariableUpdate(
    definitions,
    {
      endpoint: '',
      temperature: 0,
      stream: false,
      secret_header: '',
    },
    new Set(['endpoint', 'temperature', 'stream', 'secret_header']),
    {
      endpoint: {
        value: 'https://custom.example/v1',
        is_sensitive: false,
        has_value: true,
      },
      secret_header: {
        value: '••••••••',
        is_sensitive: true,
        has_value: true,
      },
    }
  );

  assert.deepEqual(update, {
    variables: {
      temperature: 0,
      stream: false,
    },
    unset: ['endpoint'],
  });
});
