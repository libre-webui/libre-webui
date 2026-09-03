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
import { createDefaultTheme, getNextThemeMode, normalizeTheme } from './theme';

test('uses dark mode when no theme preference exists', () => {
  assert.equal(createDefaultTheme().mode, 'dark');
  assert.equal(normalizeTheme().mode, 'dark');
});

test('preserves an explicit light theme preference', () => {
  assert.equal(normalizeTheme({ mode: 'light' }).mode, 'light');
});

test('preserves the amoled mode and collapses unknown modes to dark', () => {
  assert.equal(normalizeTheme({ mode: 'amoled' }).mode, 'amoled');
  assert.equal(
    normalizeTheme({ mode: 'ophelia' as unknown as 'dark' }).mode,
    'dark'
  );
});

test('the toggle cycles light, dark, pure black, then light again', () => {
  assert.equal(getNextThemeMode('light'), 'dark');
  assert.equal(getNextThemeMode('dark'), 'amoled');
  assert.equal(getNextThemeMode('amoled'), 'light');
});
