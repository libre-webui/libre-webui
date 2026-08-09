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

export interface WorkDiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
  beforeLine?: number;
  afterLine?: number;
}

export interface WorkDiffStats {
  added: number;
  removed: number;
}

// Beyond this budget the quadratic LCS pass is skipped and the changed middle
// is reported as a plain remove-then-add block, which stays correct but is no
// longer minimal.
const LCS_CELL_BUDGET = 4_000_000;

const splitLines = (value: string): string[] => {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
};

export const diffWorkLines = (
  before: string,
  after: string
): WorkDiffLine[] => {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);

  const result: WorkDiffLine[] = [];
  for (let index = 0; index < prefix; index += 1) {
    result.push({
      type: 'context',
      text: beforeLines[index],
      beforeLine: index + 1,
      afterLine: index + 1,
    });
  }

  const middle = diffMiddle(beforeMiddle, afterMiddle);
  for (const line of middle) {
    const shifted: WorkDiffLine = { type: line.type, text: line.text };
    if (line.beforeLine !== undefined)
      shifted.beforeLine = line.beforeLine + prefix;
    if (line.afterLine !== undefined)
      shifted.afterLine = line.afterLine + prefix;
    result.push(shifted);
  }

  for (let index = 0; index < suffix; index += 1) {
    const beforeLine = beforeLines.length - suffix + index;
    const afterLine = afterLines.length - suffix + index;
    result.push({
      type: 'context',
      text: beforeLines[beforeLine],
      beforeLine: beforeLine + 1,
      afterLine: afterLine + 1,
    });
  }

  return result;
};

const diffMiddle = (
  beforeLines: string[],
  afterLines: string[]
): WorkDiffLine[] => {
  if (beforeLines.length === 0 && afterLines.length === 0) return [];
  if (
    beforeLines.length > 0 &&
    afterLines.length > 0 &&
    beforeLines.length * afterLines.length > LCS_CELL_BUDGET
  ) {
    return [
      ...beforeLines.map((text, index) => ({
        type: 'removed' as const,
        text,
        beforeLine: index + 1,
      })),
      ...afterLines.map((text, index) => ({
        type: 'added' as const,
        text,
        afterLine: index + 1,
      })),
    ];
  }

  // Longest-common-subsequence table over the trimmed middle.
  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let column = afterLines.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        beforeLines[row] === afterLines[column]
          ? table[(row + 1) * columns + column + 1] + 1
          : Math.max(
              table[(row + 1) * columns + column],
              table[row * columns + column + 1]
            );
    }
  }

  const result: WorkDiffLine[] = [];
  let row = 0;
  let column = 0;
  while (row < beforeLines.length && column < afterLines.length) {
    if (beforeLines[row] === afterLines[column]) {
      result.push({
        type: 'context',
        text: beforeLines[row],
        beforeLine: row + 1,
        afterLine: column + 1,
      });
      row += 1;
      column += 1;
    } else if (
      table[(row + 1) * columns + column] >= table[row * columns + column + 1]
    ) {
      result.push({
        type: 'removed',
        text: beforeLines[row],
        beforeLine: row + 1,
      });
      row += 1;
    } else {
      result.push({
        type: 'added',
        text: afterLines[column],
        afterLine: column + 1,
      });
      column += 1;
    }
  }
  while (row < beforeLines.length) {
    result.push({
      type: 'removed',
      text: beforeLines[row],
      beforeLine: row + 1,
    });
    row += 1;
  }
  while (column < afterLines.length) {
    result.push({
      type: 'added',
      text: afterLines[column],
      afterLine: column + 1,
    });
    column += 1;
  }
  return result;
};

export const workDiffStats = (lines: WorkDiffLine[]): WorkDiffStats => {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'added') added += 1;
    if (line.type === 'removed') removed += 1;
  }
  return { added, removed };
};

export type WorkDiffRow =
  | { type: 'line'; line: WorkDiffLine }
  | { type: 'fold'; count: number; lines: WorkDiffLine[] };

const FOLD_CONTEXT_LINES = 3;

// Keeps a few context lines around every change and folds long unchanged runs
// so the diff reads like a review, not a full file dump. Fold rows carry the
// hidden lines so a viewer can expand them in place.
export const foldWorkDiff = (lines: WorkDiffLine[]): WorkDiffRow[] => {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].type === 'context') continue;
    const start = Math.max(0, index - FOLD_CONTEXT_LINES);
    const end = Math.min(lines.length - 1, index + FOLD_CONTEXT_LINES);
    for (let nearby = start; nearby <= end; nearby += 1) keep[nearby] = true;
  }

  const rows: WorkDiffRow[] = [];
  let folded: WorkDiffLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!keep[index]) {
      folded.push(lines[index]);
      continue;
    }
    if (folded.length > 0) {
      rows.push({ type: 'fold', count: folded.length, lines: folded });
      folded = [];
    }
    rows.push({ type: 'line', line: lines[index] });
  }
  if (folded.length > 0) {
    rows.push({ type: 'fold', count: folded.length, lines: folded });
  }
  return rows;
};
