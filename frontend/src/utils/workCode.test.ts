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
import { describe, test } from 'node:test';
import {
  canFormatWorkFile,
  detectWorkLanguage,
  formatWorkCode,
  isWorkCodeFormatSizeSupported,
  WORK_FORMAT_MAX_CHARACTERS,
  WORK_FORMAT_MAX_LINES,
} from './workCode';

describe('detectWorkLanguage', () => {
  test('detects supported workspace file extensions', () => {
    assert.equal(detectWorkLanguage('src/components/App.tsx'), 'tsx');
    assert.equal(detectWorkLanguage('server/index.cjs'), 'javascript');
    assert.equal(detectWorkLanguage('styles/theme.less'), 'css');
    assert.equal(detectWorkLanguage('package.json'), 'json');
    assert.equal(detectWorkLanguage('.github/workflows/ci.yml'), 'yaml');
  });

  test('falls back to text for an unknown extension', () => {
    assert.equal(detectWorkLanguage('assets/data.unknown'), 'text');
  });
});

describe('canFormatWorkFile', () => {
  test('supports the browser formatter languages', () => {
    const supportedPaths = [
      'src/app.js',
      'src/app.ts',
      'src/app.cts',
      'src/App.tsx',
      'data/config.json',
      'styles/app.css',
      'public/index.html',
      'README.md',
      'config/settings.yaml',
    ];

    for (const path of supportedPaths) {
      assert.equal(
        canFormatWorkFile(path),
        true,
        `${path} should be formattable`
      );
    }
  });

  test('rejects unsupported file types', () => {
    assert.equal(canFormatWorkFile('scripts/main.py'), false);
    assert.equal(canFormatWorkFile('notes.txt'), false);
    assert.equal(canFormatWorkFile('assets/data.unknown'), false);
  });
});

describe('formatWorkCode', () => {
  test('returns Prettier-style JavaScript', async () => {
    const formatted = await formatWorkCode(
      'src/config.js',
      'const answer={value:42}'
    );

    assert.equal(formatted, 'const answer = { value: 42 };\n');
  });

  test('formats TypeScript, CSS, HTML, Markdown, and YAML', async () => {
    const cases = [
      {
        path: 'src/greeting.ts',
        source: 'const greeting:string="hello"',
        expected: 'const greeting: string = "hello";\n',
      },
      {
        path: 'styles/card.css',
        source: '.card{color:red}',
        expected: '.card {\n  color: red;\n}\n',
      },
      {
        path: 'public/index.html',
        source: '<main><h1>Hello</h1></main>',
        expected: '<main><h1>Hello</h1></main>\n',
      },
      {
        path: 'README.md',
        source: '# Heading\n\n-   one\n-    two',
        expected: '# Heading\n\n- one\n- two\n',
      },
      {
        path: 'config/settings.yaml',
        source: 'items:\n- one\n- two',
        expected: 'items:\n  - one\n  - two\n',
      },
    ];

    for (const example of cases) {
      assert.equal(
        await formatWorkCode(example.path, example.source),
        example.expected,
        `${example.path} should use its Prettier parser`
      );
    }
  });

  test('formats embedded web code when its parser is needed', async () => {
    assert.equal(
      await formatWorkCode(
        'public/index.html',
        '<script>const value={ready:true}</script><style>.card{color:red}</style>'
      ),
      '<script>\n  const value = { ready: true };\n</script>\n<style>\n  .card {\n    color: red;\n  }\n</style>\n'
    );
    assert.equal(
      await formatWorkCode(
        'README.md',
        '# Example\n\n```js\nconst value={ready:true}\n```'
      ),
      '# Example\n\n```js\nconst value = { ready: true };\n```\n'
    );
    assert.equal(
      await formatWorkCode('component.mdx', '<Component value={{foo:1}}/>'),
      '<Component value={{ foo: 1 }} />\n'
    );
    assert.equal(
      await formatWorkCode(
        'README.md',
        '# Example\n\n```html\n<script>const x={a:1}</script>\n```'
      ),
      '# Example\n\n```html\n<script>\n  const x = { a: 1 };\n</script>\n```\n'
    );
  });

  test('returns consistently indented JSON', async () => {
    const source = {
      name: 'Libre WebUI',
      features: ['work', 'chat'],
      description:
        'A private and extensible local AI workspace for many different models',
    };
    const formatted = await formatWorkCode(
      'config.json',
      JSON.stringify(source)
    );

    assert.deepEqual(JSON.parse(formatted), source);
    assert.match(formatted, /^\{\n {2}"name": "Libre WebUI"/);
    assert.equal(formatted.endsWith('\n'), true);
  });

  test('throws a useful error for invalid input', async () => {
    await assert.rejects(
      () => formatWorkCode('broken.json', '{"missing":}'),
      error =>
        error instanceof Error &&
        /format|invalid|syntax|unexpected|json/i.test(error.message)
    );
  });

  test('rejects source that could block the browser formatter', async () => {
    const oversized = 'x'.repeat(WORK_FORMAT_MAX_CHARACTERS + 1);
    assert.equal(isWorkCodeFormatSizeSupported(oversized), false);
    await assert.rejects(
      () => formatWorkCode('large.ts', oversized),
      /limited|characters|lines/i
    );
  });

  test('accepts the exact character limit', () => {
    const exactCharacterBoundary = 'x'.repeat(WORK_FORMAT_MAX_CHARACTERS);

    assert.equal(exactCharacterBoundary.length, WORK_FORMAT_MAX_CHARACTERS);
    assert.equal(isWorkCodeFormatSizeSupported(exactCharacterBoundary), true);
  });

  test('accepts the exact line limit', () => {
    const exactLineBoundary = Array.from(
      { length: WORK_FORMAT_MAX_LINES },
      () => 'x'
    ).join('\n');

    assert.equal(exactLineBoundary.split('\n').length, WORK_FORMAT_MAX_LINES);
    assert.equal(isWorkCodeFormatSizeSupported(exactLineBoundary), true);
  });

  test('rejects source above the line limit', async () => {
    const tooManyLines = Array.from(
      { length: WORK_FORMAT_MAX_LINES + 1 },
      () => 'x'
    ).join('\n');

    assert.equal(tooManyLines.split('\n').length, WORK_FORMAT_MAX_LINES + 1);
    assert.equal(isWorkCodeFormatSizeSupported(tooManyLines), false);
    await assert.rejects(
      () => formatWorkCode('too-many-lines.ts', tooManyLines),
      /limited|characters|lines/i
    );
  });
});
