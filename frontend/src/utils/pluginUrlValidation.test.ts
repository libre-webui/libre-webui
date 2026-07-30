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
import { isSafePluginUrl } from './pluginUrlValidation';

test('permits HTTP only for literal local and private-network hosts', () => {
  for (const url of [
    'http://localhost:11434/v1',
    'http://127.0.0.1:8080/v1',
    'http://10.0.0.8/v1',
    'http://172.16.0.8/v1',
    'http://172.31.255.254/v1',
    'http://192.168.1.8/v1',
  ]) {
    assert.equal(isSafePluginUrl(url, 'base_url'), true, url);
  }

  for (const url of [
    'http://10.example.com/v1',
    'http://172.16.example.com/v1',
    'http://192.168.example.com/v1',
    'http://public.example/v1',
  ]) {
    assert.equal(isSafePluginUrl(url, 'base_url'), false, url);
  }

  assert.equal(isSafePluginUrl('https://10.example.com/v1', 'base_url'), true);
});
