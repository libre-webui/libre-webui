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
import { diffWorkLines, foldWorkDiff, workDiffStats } from './workDiff';

test('reports added and removed lines with stable line numbers', () => {
  const before = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
  const after = 'const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n';

  const lines = diffWorkLines(before, after);

  assert.deepEqual(lines, [
    { type: 'context', text: 'const a = 1;', beforeLine: 1, afterLine: 1 },
    { type: 'removed', text: 'const b = 2;', beforeLine: 2 },
    { type: 'added', text: 'const b = 20;', afterLine: 2 },
    { type: 'context', text: 'const c = 3;', beforeLine: 3, afterLine: 3 },
    { type: 'added', text: 'const d = 4;', afterLine: 4 },
  ]);
  assert.deepEqual(workDiffStats(lines), { added: 2, removed: 1 });
});

test('treats a brand-new file as fully added', () => {
  const lines = diffWorkLines('', 'first\nsecond\n');

  assert.deepEqual(lines, [
    { type: 'added', text: 'first', afterLine: 1 },
    { type: 'added', text: 'second', afterLine: 2 },
  ]);
});

test('returns an empty diff for identical content', () => {
  const content = 'same\nlines\n';
  const lines = diffWorkLines(content, content);
  assert.deepEqual(workDiffStats(lines), { added: 0, removed: 0 });
  assert.ok(lines.every(line => line.type === 'context'));
});

test('finds a minimal diff when a line moves inside surrounding context', () => {
  const before = 'a\nb\nc\nd\n';
  const after = 'a\nc\nb\nd\n';
  const lines = diffWorkLines(before, after);
  const stats = workDiffStats(lines);
  assert.equal(stats.added, 1);
  assert.equal(stats.removed, 1);
});

test('stays correct beyond the quadratic budget with a block fallback', () => {
  const before = Array.from({ length: 2100 }, (_, i) => `left-${i}`).join('\n');
  const after = Array.from({ length: 2100 }, (_, i) => `right-${i}`).join('\n');

  const lines = diffWorkLines(before, after);
  const stats = workDiffStats(lines);

  assert.equal(stats.removed, 2100);
  assert.equal(stats.added, 2100);
});

test('folds long unchanged runs and keeps context around changes', () => {
  const contextLines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
  const before = contextLines.join('\n');
  const after = [
    ...contextLines.slice(0, 20),
    'inserted',
    ...contextLines.slice(20),
  ].join('\n');

  const rows = foldWorkDiff(diffWorkLines(before, after));

  const folds = rows.filter(row => row.type === 'fold');
  assert.equal(folds.length, 2);
  const shownLines = rows.filter(row => row.type === 'line');
  assert.equal(shownLines.length, 7);
  assert.equal(
    folds.reduce(
      (sum, fold) => sum + (fold.type === 'fold' ? fold.count : 0),
      0
    ) + shownLines.length,
    41
  );
});
