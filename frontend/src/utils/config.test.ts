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

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'http:',
      origin: 'http://localhost:5173',
      hostname: 'localhost',
    },
  },
});

const { resolveApiBaseUrl } = await import('./config');

test('uses the browser origin for development API proxying', () => {
  assert.equal(
    resolveApiBaseUrl({
      protocol: 'http:',
      origin: 'http://192.168.1.20:8080',
    }),
    'http://192.168.1.20:8080/api'
  );
});

test('preserves explicit API and Electron overrides', () => {
  assert.equal(
    resolveApiBaseUrl({
      protocol: 'http:',
      origin: 'http://localhost:5173',
      apiBaseUrl: 'http://api.example.test/api',
    }),
    'http://api.example.test/api'
  );
  assert.equal(
    resolveApiBaseUrl({ protocol: 'file:', origin: 'null' }),
    'http://localhost:3001/api'
  );
});
