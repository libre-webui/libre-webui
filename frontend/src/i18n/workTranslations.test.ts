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

const toastTranslationSources = [
  // Model-management toasts (#187).
  'components/ModelManager.tsx',
  'components/ModelSelector.tsx',
  'components/ModelTools.tsx',
  'components/HuggingFaceModelBrowser.tsx',
  // Chat-surface toasts (#188).
  'App.tsx',
  'components/ChatInput.tsx',
  'hooks/useChat.ts',
  'store/chatStore.ts',
  // Settings and upload toasts (#189).
  'components/SettingsModal.tsx',
  'components/BackgroundUpload.tsx',
  'components/MediaUpload.tsx',
  'hooks/useInitializeApp.ts',
] as const;

const hasEnglishText = (value: string): boolean => /[A-Za-z]/.test(value);

const findClosingParenthesis = (
  source: string,
  openingIndex: number
): number => {
  let depth = 0;
  let quote = '';

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')' && --depth === 0) {
      return index;
    }
  }

  return -1;
};

const removeTranslationCalls = (expression: string): string => {
  const translationCall = /\bt\s*\(/g;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = translationCall.exec(expression))) {
    const openingIndex = expression.indexOf('(', match.index);
    const closingIndex = findClosingParenthesis(expression, openingIndex);
    if (closingIndex === -1) break;
    result += expression.slice(cursor, match.index);
    cursor = closingIndex + 1;
    translationCall.lastIndex = cursor;
  }

  return result + expression.slice(cursor);
};

const containsHardcodedText = (expression: string): boolean => {
  const withoutTranslations = removeTranslationCalls(expression);
  const stringLiteral = /(["'`])(?:\\.|(?!\1)[\s\S])*\1/g;

  return Array.from(withoutTranslations.matchAll(stringLiteral)).some(match => {
    const content = match[0].slice(1, -1).replace(/\$\{[\s\S]*?\}/g, '');
    return hasEnglishText(content);
  });
};

const firstArgument = (argumentsText: string): string => {
  let quote = '';
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;

  for (let index = 0; index < argumentsText.length; index += 1) {
    const character = argumentsText[index];
    if (quote) {
      if (character === '\\') {
        index += 1;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
    } else if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      parentheses -= 1;
    } else if (character === '[') {
      brackets += 1;
    } else if (character === ']') {
      brackets -= 1;
    } else if (character === '{') {
      braces += 1;
    } else if (character === '}') {
      braces -= 1;
    } else if (
      character === ',' &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return argumentsText.slice(0, index).trim();
    }
  }

  return argumentsText.trim();
};

const resolveLocalInitializer = (
  identifier: string,
  sourceBeforeToast: string
): string => {
  const declaration = new RegExp(`\\bconst\\s+${identifier}\\s*=`, 'g');
  let initializerStart = -1;

  while (declaration.exec(sourceBeforeToast)) {
    initializerStart = declaration.lastIndex;
  }

  if (initializerStart === -1) return identifier;
  const initializerEnd = sourceBeforeToast.indexOf(';', initializerStart);
  return sourceBeforeToast.slice(
    initializerStart,
    initializerEnd === -1 ? undefined : initializerEnd
  );
};

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

test('scoped toasts use translation keys', async () => {
  const sourceDirectory = join(localeDirectory, '..', '..');
  const settingsSources = (
    await readdir(join(sourceDirectory, 'components', 'settings'))
  )
    .filter(file => file.endsWith('.ts') || file.endsWith('.tsx'))
    .map(file => join('components', 'settings', file));
  const failures: string[] = [];

  for (const sourcePath of [...toastTranslationSources, ...settingsSources]) {
    const sourceText = await readFile(
      join(sourceDirectory, sourcePath),
      'utf8'
    );
    const toastCall = /\btoast\.(?:success|error)\s*\(/g;
    let match: RegExpExecArray | null;

    while ((match = toastCall.exec(sourceText))) {
      const openingIndex = sourceText.indexOf('(', match.index);
      const closingIndex = findClosingParenthesis(sourceText, openingIndex);
      assert.notEqual(
        closingIndex,
        -1,
        `${sourcePath} has an invalid toast call`
      );

      const argument = firstArgument(
        sourceText.slice(openingIndex + 1, closingIndex)
      );
      const expression = /^[A-Za-z_$][\w$]*$/.test(argument)
        ? resolveLocalInitializer(argument, sourceText.slice(0, match.index))
        : argument;

      if (containsHardcodedText(expression)) {
        const line = sourceText.slice(0, match.index).split('\n').length;
        failures.push(`${sourcePath}:${line}`);
      }
      toastCall.lastIndex = closingIndex + 1;
    }
  }

  assert.deepEqual(
    failures,
    [],
    `toast messages must use t(...): ${failures.join(', ')}`
  );
});

test('toast scanner distinguishes translated and literal fallbacks', () => {
  assert.equal(containsHardcodedText("t('settings.saved')"), false);
  assert.equal(containsHardcodedText("i18n.t('chat.saved')"), false);
  assert.equal(containsHardcodedText('response.error'), false);
  assert.equal(
    containsHardcodedText("response.error || 'Failed to save settings'"),
    true
  );
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
