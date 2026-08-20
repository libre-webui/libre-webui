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

export interface NoteDiffRow {
  type: 'context' | 'added' | 'removed';
  text: string;
}

/**
 * Line-level diff via longest-common-subsequence, for previewing note
 * revisions and AI edit proposals. Notes are size-capped well below the
 * point where the quadratic table matters; a hard guard falls back to a
 * whole-document replacement rendering rather than an expensive diff.
 */
const MAX_DIFF_LINES = 4000;

export const diffNoteLines = (before: string, after: string): NoteDiffRow[] => {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    return [
      ...left.map(text => ({ type: 'removed' as const, text })),
      ...right.map(text => ({ type: 'added' as const, text })),
    ];
  }
  // lengths[i][j] = LCS length of left[i..] and right[j..]
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        left[i] === right[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const rows: NoteDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ type: 'context', text: left[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      rows.push({ type: 'removed', text: left[i] });
      i += 1;
    } else {
      rows.push({ type: 'added', text: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ type: 'removed', text: left[i] });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ type: 'added', text: right[j] });
    j += 1;
  }
  return rows;
};

/** True when the diff contains any change at all. */
export const noteDiffHasChanges = (rows: readonly NoteDiffRow[]): boolean =>
  rows.some(row => row.type !== 'context');
