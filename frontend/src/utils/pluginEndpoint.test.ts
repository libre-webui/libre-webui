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
import {
  getPluginEndpointValidationError,
  hasPluginModelDiscoveryVariable,
  isPluginConnectionEndpointVariable,
} from './pluginEndpoint';

test('recognizes canonical and legacy model-discovery connection variables', () => {
  for (const name of ['endpoint', 'api_url', 'models_endpoint']) {
    assert.equal(isPluginConnectionEndpointVariable(name), true);
    assert.equal(hasPluginModelDiscoveryVariable({ [name]: 'value' }), true);
  }

  assert.equal(isPluginConnectionEndpointVariable('image_endpoint'), false);
  assert.equal(
    hasPluginModelDiscoveryVariable({ temperature: 0.7, api_path: '/v1' }),
    false
  );
});

test('accepts blank overrides and trims endpoint input', () => {
  assert.equal(getPluginEndpointValidationError('   '), null);
  assert.equal(
    getPluginEndpointValidationError(
      '  https://provider.example/v1/chat/completions  '
    ),
    null
  );
});

test('accepts full HTTPS API endpoint URLs', () => {
  assert.equal(
    getPluginEndpointValidationError(
      'https://provider.example/v1/chat/completions'
    ),
    null
  );
  assert.equal(
    getPluginEndpointValidationError(
      'https://gateway.example/models/{model}:generateContent'
    ),
    null
  );
});

test('accepts HTTP only for exact loopback hosts and private IPv4 literals', () => {
  const allowed = [
    'http://localhost:8080/v1/chat/completions',
    'http://127.0.0.1:8080/v1/chat/completions',
    'http://[::1]:8080/v1/chat/completions',
    'http://10.0.0.5:8080/v1/chat/completions',
    'http://172.16.0.5:8080/v1/chat/completions',
    'http://172.31.255.254:8080/v1/chat/completions',
    'http://192.168.1.5:8080/v1/chat/completions',
  ];

  for (const endpoint of allowed) {
    assert.equal(
      getPluginEndpointValidationError(endpoint),
      null,
      `${endpoint} should be allowed`
    );
  }
});

test('rejects malformed, relative, and remote HTTP endpoint URLs', () => {
  assert.equal(
    getPluginEndpointValidationError('/v1/chat/completions'),
    'invalid-url'
  );
  assert.equal(getPluginEndpointValidationError('not a URL'), 'invalid-url');
  assert.equal(
    getPluginEndpointValidationError(
      'http://provider.example/v1/chat/completions'
    ),
    'insecure-url'
  );
});

test('does not mistake private-looking hostnames or adjacent ranges for private IPv4 literals', () => {
  const rejected = [
    'http://10.example.com/v1/chat/completions',
    'http://localhost.example.com/v1/chat/completions',
    'http://172.15.0.1/v1/chat/completions',
    'http://172.32.0.1/v1/chat/completions',
    'http://192.169.0.1/v1/chat/completions',
  ];

  for (const endpoint of rejected) {
    assert.equal(
      getPluginEndpointValidationError(endpoint),
      'insecure-url',
      `${endpoint} should be rejected`
    );
  }
});

test('rejects non-HTTP protocols even for local endpoints', () => {
  assert.equal(
    getPluginEndpointValidationError('ftp://localhost/v1/chat/completions'),
    'insecure-url'
  );
  assert.equal(
    getPluginEndpointValidationError('file:///v1/chat/completions'),
    'insecure-url'
  );
});
