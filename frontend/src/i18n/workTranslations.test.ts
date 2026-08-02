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
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isRTL, supportedLanguages } from './index';

type Messages = Record<string, unknown>;

const localeDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  'locales'
);

const flattenMessages = (
  messages: Messages,
  prefix = '',
  flattened: Record<string, string> = {}
): Record<string, string> => {
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      flattened[path] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenMessages(value as Messages, path, flattened);
    }
  }

  return flattened;
};

const interpolationNames = (message: string): string[] =>
  Array.from(
    message.matchAll(/{{\s*([^},\s]+)[^}]*}}/g),
    match => match[1]
  ).sort();

test('every shipped locale completely translates the English catalog', async () => {
  const localeFiles = (await readdir(localeDirectory))
    .filter(file => file.endsWith('.json'))
    .sort();
  const english = flattenMessages(
    JSON.parse(
      await readFile(join(localeDirectory, 'en.json'), 'utf8')
    ) as Messages
  );
  const englishKeys = Object.keys(english).sort();

  for (const localeFile of localeFiles) {
    const locale = flattenMessages(
      JSON.parse(
        await readFile(join(localeDirectory, localeFile), 'utf8')
      ) as Messages
    );

    assert.deepEqual(
      Object.keys(locale).sort(),
      englishKeys,
      `${localeFile} must contain exactly the English translation keys`
    );

    for (const key of englishKeys) {
      assert.ok(locale[key].trim(), `${localeFile}: ${key} must not be empty`);
      assert.deepEqual(
        interpolationNames(locale[key]),
        interpolationNames(english[key]),
        `${localeFile}: ${key} must preserve interpolation variables`
      );
    }
  }
});

test('every shipped locale completely translates the Work interface', async () => {
  const localeFiles = (await readdir(localeDirectory))
    .filter(file => file.endsWith('.json'))
    .sort();
  const expectedFiles = supportedLanguages
    .map(language => `${language.code}.json`)
    .sort();
  assert.deepEqual(localeFiles, expectedFiles);

  const english = JSON.parse(
    await readFile(join(localeDirectory, 'en.json'), 'utf8')
  ) as Messages;
  const englishWork = flattenMessages(english.work as Messages);
  const englishKeys = Object.keys(englishWork).sort();

  for (const localeFile of localeFiles) {
    const locale = JSON.parse(
      await readFile(join(localeDirectory, localeFile), 'utf8')
    ) as Messages;
    const work = flattenMessages(locale.work as Messages);
    const workModeLabel = (locale.chat as Messages)?.session as Messages;
    const sidebarNavigation = (locale.sidebar as Messages)
      ?.navigation as Messages;

    assert.deepEqual(
      Object.keys(work).sort(),
      englishKeys,
      `${localeFile} must contain every Work translation key`
    );

    for (const key of englishKeys) {
      assert.ok(
        work[key].trim(),
        `${localeFile}: work.${key} must not be empty`
      );
      assert.deepEqual(
        interpolationNames(work[key]),
        interpolationNames(englishWork[key]),
        `${localeFile}: work.${key} must preserve interpolation variables`
      );
    }

    assert.equal(
      work.title,
      workModeLabel.work,
      `${localeFile}: work.title must match the existing Work mode label`
    );
    assert.equal(
      sidebarNavigation.work,
      workModeLabel.work,
      `${localeFile}: sidebar.navigation.work must translate the Work mode label`
    );
  }
});

test('Arabic is the shipped right-to-left locale', () => {
  assert.equal(
    supportedLanguages.find(language => language.code === 'ar')?.dir,
    'rtl'
  );
  assert.equal(isRTL('ar'), true);
  assert.equal(isRTL('ar-SA'), true);
  assert.equal(isRTL('en'), false);
});
