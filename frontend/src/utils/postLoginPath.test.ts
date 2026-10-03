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
  clearExplicitLogout,
  noteExplicitLogout,
  resolvePostLoginPath,
} from './postLoginPath';

test('returns home when there is no redirect state', () => {
  assert.equal(resolvePostLoginPath(undefined), '/');
  assert.equal(resolvePostLoginPath(null), '/');
  assert.equal(resolvePostLoginPath({}), '/');
});

test('restores the pathname, search and hash of a same-app location', () => {
  assert.equal(
    resolvePostLoginPath({
      from: { pathname: '/c/abc', search: '?x=1', hash: '#m2' },
    }),
    '/c/abc?x=1#m2'
  );
  assert.equal(resolvePostLoginPath({ from: { pathname: '/work' } }), '/work');
});

test('rejects external, protocol-relative and malformed targets', () => {
  for (const pathname of [
    'https://evil.example/x',
    '//evil.example',
    '/\\evil.example',
    'relative/path',
    '',
    42,
  ]) {
    assert.equal(resolvePostLoginPath({ from: { pathname } }), '/');
  }
});

test('never loops back to the login page', () => {
  assert.equal(resolvePostLoginPath({ from: { pathname: '/login' } }), '/');
});

test('an explicit sign-out discards the previous destination', () => {
  const state = { from: { pathname: '/work/private-task' } };
  noteExplicitLogout();
  assert.equal(resolvePostLoginPath(state), '/');
  clearExplicitLogout();
  assert.equal(resolvePostLoginPath(state), '/work/private-task');
});
