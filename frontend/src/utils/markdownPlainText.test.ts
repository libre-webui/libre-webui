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
import { markdownToPlainText } from './markdownPlainText.ts';
const options = { codeBlockLabel: 'code block' };
const plain = (markdown: string, maxLength?: number) =>
  markdownToPlainText(markdown, { ...options, maxLength });
test('strips emphasis, headings, lists, quotes and links', () => {
  assert.equal(
    plain(
      '# Title\n\nSome **bold**, _italic_ and ~~gone~~ text.\n\n- one\n- two\n1. three\n\n> quoted\n\nSee [the docs](https://example.com/x) now.'
    ),
    'Title Some bold, italic and gone text. one two three quoted See the docs now.'
  );
});
test('speaks image alt text and inline code without syntax', () => {
  assert.equal(
    plain('![A cat](https://e.co/cat.png) uses `npm test` daily'),
    'A cat uses npm test daily'
  );
});
test('replaces fenced code blocks with the localized phrase', () => {
  assert.equal(
    plain('Run this:\n\n```bash\nnpm install\nnpm test\n```\n\nThen relax.'),
    'Run this: code block. Then relax.'
  );
  assert.equal(plain('A\n~~~\nx\n~~~\nB', undefined), 'A code block. B');
});
test('treats an unterminated fence as code through the end', () => {
  assert.equal(
    plain('Here it is\n```js\nconst a = 1;\nconst b = 2;'),
    'Here it is code block.'
  );
});
test('does not let a longer fence close on a shorter one', () => {
  assert.equal(plain('x\n````md\n```\ninner\n```\n````\ny'), 'x code block. y');
});
test('flattens tables and drops the separator row', () => {
  const spoken = plain('| Name | Age |\n| --- | --- |\n| Ann | 30 |');
  assert.ok(!spoken.includes('---'));
  assert.ok(!spoken.includes('|'));
  assert.ok(spoken.includes('Name'));
  assert.ok(spoken.includes('Ann'));
});
test('removes raw html and comments but keeps their text', () => {
  assert.equal(
    plain('<b>Hi</b> there<!-- hidden --> <br/>friend'),
    'Hi there friend'
  );
});
test('keeps literal characters that are not markdown', () => {
  assert.equal(
    plain('2 * 3 = 6 and snake_case_name'),
    '2 * 3 = 6 and snake_case_name'
  );
});
test('returns an empty string for syntax-only input', () => {
  assert.equal(plain('---\n\n'), '');
  assert.equal(plain(''), '');
});
test('caps long replies with an ellipsis within the limit', () => {
  const long = 'word '.repeat(400);
  const spoken = plain(long, 600);
  assert.ok(Array.from(spoken).length <= 600);
  assert.ok(spoken.endsWith('…'));
  assert.ok(!spoken.endsWith(' …'));
});
test('leaves text at or under the limit untouched', () => {
  const exact = 'a'.repeat(600);
  assert.equal(plain(exact, 600), exact);
});
test('never splits a surrogate pair when truncating', () => {
  const spoken = plain('😀'.repeat(50), 10);
  assert.equal(Array.from(spoken).length, 10);
  assert.ok(spoken.endsWith('…'));
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(spoken));
});
