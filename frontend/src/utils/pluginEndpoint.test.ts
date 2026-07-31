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
  isPluginHttpEndpoint,
  isPluginUrlVariable,
  isValidPluginApiPath,
} from './pluginEndpoint';

test('recognizes every model-discovery connection variable', () => {
  for (const name of [
    'endpoint',
    'api_url',
    'models_endpoint',
    'base_url',
    'api_path',
    'api_mode',
  ]) {
    assert.equal(isPluginConnectionEndpointVariable(name), true);
    assert.equal(hasPluginModelDiscoveryVariable({ [name]: 'value' }), true);
  }

  assert.equal(isPluginConnectionEndpointVariable('image_endpoint'), false);
  assert.equal(
    hasPluginModelDiscoveryVariable({
      temperature: 0.7,
      image_endpoint: 'https://example.test/v1/images/generations',
    }),
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

test('accepts absolute HTTP endpoint URLs for self-hosted gateways', () => {
  const allowed = [
    'http://localhost:8080/v1/chat/completions',
    'http://127.0.0.1:8080/v1/chat/completions',
    'http://[::1]:8080/v1/chat/completions',
    'http://10.0.0.5:8080/v1/chat/completions',
    'http://ai-gateway:8080/v1/chat/completions',
    'http://gateway.internal.example:8080/v1/chat/completions',
  ];

  for (const endpoint of allowed) {
    assert.equal(
      getPluginEndpointValidationError(endpoint),
      null,
      `${endpoint} should be allowed`
    );
  }
});

test('rejects malformed and relative endpoint URLs', () => {
  assert.equal(
    getPluginEndpointValidationError('/v1/chat/completions'),
    'invalid-url'
  );
  assert.equal(getPluginEndpointValidationError('not a URL'), 'invalid-url');
});

test('accepts HTTP hostnames and IPv4 addresses regardless of address range', () => {
  const allowed = [
    'http://10.example.com/v1/chat/completions',
    'http://localhost.example.com/v1/chat/completions',
    'http://172.15.0.1/v1/chat/completions',
    'http://172.32.0.1/v1/chat/completions',
    'http://192.169.0.1/v1/chat/completions',
  ];

  for (const endpoint of allowed) {
    assert.equal(
      getPluginEndpointValidationError(endpoint),
      null,
      `${endpoint} should be allowed`
    );
  }
});

test('rejects protocols other than HTTP and HTTPS', () => {
  assert.equal(
    getPluginEndpointValidationError('ftp://localhost/v1/chat/completions'),
    'insecure-url'
  );
  assert.equal(
    getPluginEndpointValidationError('file:///v1/chat/completions'),
    'insecure-url'
  );
});

test('identifies HTTP endpoints for plaintext transport warnings', () => {
  assert.equal(
    isPluginHttpEndpoint('  http://ai-gateway:8080/v1/responses  '),
    true
  );
  assert.equal(
    isPluginHttpEndpoint('https://provider.example/v1/responses'),
    false
  );
  assert.equal(isPluginHttpEndpoint('/v1/responses'), false);
});

test('rejects query strings and fragments on provider base URLs', () => {
  assert.equal(
    getPluginEndpointValidationError(
      'https://provider.example/v1?tenant=test',
      'base_url'
    ),
    'query-or-fragment'
  );
  assert.equal(
    getPluginEndpointValidationError(
      'https://provider.example/v1#fragment',
      'image_base_url'
    ),
    'query-or-fragment'
  );
});

test('recognizes provider URL fields and validates API paths until decoding is stable', () => {
  assert.equal(isPluginUrlVariable('endpoint'), true);
  assert.equal(isPluginUrlVariable('image_endpoint'), true);
  assert.equal(isPluginUrlVariable('api_path'), false);
  assert.equal(isValidPluginApiPath('/responses'), true);
  assert.equal(isValidPluginApiPath('/%252e%252e/secrets'), false);

  let overEncodedTraversal = '%2e%2e';
  for (let pass = 0; pass < 10; pass += 1) {
    overEncodedTraversal = encodeURIComponent(overEncodedTraversal);
  }
  assert.equal(isValidPluginApiPath(`/${overEncodedTraversal}/secrets`), false);
});
