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
import { parseUnifiedGitDiff, workGitDiffTotals } from './workGitDiff';

test('parses a modified file with hunk line numbers', () => {
  const patch = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1,4 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 20;',
    ' const c = 3;',
    '',
  ].join('\n');

  const files = parseUnifiedGitDiff(patch);
  assert.equal(files.length, 1);
  const file = files[0];
  assert.equal(file.path, 'src/app.ts');
  assert.equal(file.status, 'modified');
  assert.equal(file.binary, false);
  assert.deepEqual(file.stats, { added: 1, removed: 1 });
  assert.deepEqual(file.lines[0], {
    type: 'context',
    text: 'const a = 1;',
    beforeLine: 1,
    afterLine: 1,
  });
  assert.deepEqual(file.lines[1], {
    type: 'removed',
    text: 'const b = 2;',
    beforeLine: 2,
  });
  assert.deepEqual(file.lines[2], {
    type: 'added',
    text: 'const b = 20;',
    afterLine: 2,
  });
});

test('splits a multi-file patch and reports totals', () => {
  const patch = [
    'diff --git a/one.txt b/one.txt',
    '--- a/one.txt',
    '+++ b/one.txt',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    ' same',
    'diff --git a/two.txt b/two.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/two.txt',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
    '',
  ].join('\n');

  const files = parseUnifiedGitDiff(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'one.txt');
  assert.equal(files[1].path, 'two.txt');
  assert.equal(files[1].status, 'added');
  assert.deepEqual(files[1].lines[0], {
    type: 'added',
    text: 'first',
    afterLine: 1,
  });
  assert.deepEqual(workGitDiffTotals(files), { added: 3, removed: 1 });
});

test('recognizes deletions, renames, and binary files', () => {
  const patch = [
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1,1 +0,0 @@',
    '-goodbye',
    'diff --git a/old-name.ts b/new-name.ts',
    'similarity index 96%',
    'rename from old-name.ts',
    'rename to new-name.ts',
    'diff --git a/logo.png b/logo.png',
    'index 3333333..4444444 100644',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');

  const files = parseUnifiedGitDiff(patch);
  assert.equal(files.length, 3);
  assert.equal(files[0].status, 'deleted');
  assert.equal(files[0].path, 'gone.txt');
  assert.equal(files[1].status, 'renamed');
  assert.equal(files[1].path, 'new-name.ts');
  assert.equal(files[1].oldPath, 'old-name.ts');
  assert.equal(files[2].binary, true);
  assert.deepEqual(files[2].stats, { added: 0, removed: 0 });
});

test('tolerates change lines without a hunk header', () => {
  const patch =
    'diff --git a/src/app.ts b/src/app.ts\n+export const ready = true;\n';
  const files = parseUnifiedGitDiff(patch);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].lines, [
    { type: 'added', text: 'export const ready = true;' },
  ]);
  assert.deepEqual(files[0].stats, { added: 1, removed: 0 });
});

test('unquotes escaped paths', () => {
  const patch = [
    'diff --git "a/sp ace/\\303\\251.txt" "b/sp ace/\\303\\251.txt"',
    '--- "a/sp ace/\\303\\251.txt"',
    '+++ "b/sp ace/\\303\\251.txt"',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');

  const files = parseUnifiedGitDiff(patch);
  assert.equal(files.length, 1);
  // Octal escapes decode byte-wise; the exact characters matter less than the
  // path being stable and the space surviving.
  assert.ok(files[0].path.startsWith('sp ace/'));
});

test('skips the no-newline marker without emitting a line', () => {
  const patch = [
    'diff --git a/a.txt b/a.txt',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,1 +1,1 @@',
    '-old',
    '\\ No newline at end of file',
    '+new',
    '\\ No newline at end of file',
    '',
  ].join('\n');

  const files = parseUnifiedGitDiff(patch);
  assert.deepEqual(files[0].stats, { added: 1, removed: 1 });
  assert.equal(files[0].lines.length, 2);
});

test('returns an empty list for an empty patch', () => {
  assert.deepEqual(parseUnifiedGitDiff(''), []);
});
