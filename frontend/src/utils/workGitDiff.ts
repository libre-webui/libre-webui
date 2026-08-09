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

import {
  workDiffStats,
  type WorkDiffLine,
  type WorkDiffStats,
} from './workDiff';

export type WorkGitFileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface WorkGitFileDiff {
  path: string;
  oldPath?: string;
  status: WorkGitFileStatus;
  binary: boolean;
  lines: WorkDiffLine[];
  stats: WorkDiffStats;
}

// `git diff` quotes paths containing spaces or non-ASCII bytes with C-style
// escapes. Unsupported escapes are kept verbatim rather than dropped.
const unquoteGitPath = (value: string): string => {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
    return value;
  }
  const inner = value.slice(1, -1);
  let result = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== '\\' || index === inner.length - 1) {
      result += char;
      continue;
    }
    index += 1;
    const escape = inner[index];
    if (escape === 'n') result += '\n';
    else if (escape === 't') result += '\t';
    else if (escape === '\\' || escape === '"') result += escape;
    else if (escape >= '0' && escape <= '7') {
      let octal = escape;
      while (
        octal.length < 3 &&
        index + 1 < inner.length &&
        inner[index + 1] >= '0' &&
        inner[index + 1] <= '7'
      ) {
        index += 1;
        octal += inner[index];
      }
      result += String.fromCharCode(parseInt(octal, 8));
    } else result += `\\${escape}`;
  }
  return result;
};

const stripDiffPrefix = (value: string): string => {
  const unquoted = unquoteGitPath(value);
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) {
    return unquoted.slice(2);
  }
  return unquoted;
};

// `diff --git a/old b/new`: paths may be quoted independently, and unquoted
// paths may contain spaces. Splitting on ` b/` after the `a/` segment handles
// every case Git itself produces for text files.
const parseDiffHeaderPaths = (
  header: string
): { oldPath: string; newPath: string } | null => {
  const body = header.slice('diff --git '.length).trim();
  if (body.startsWith('"')) {
    const closing = body.indexOf('" ', 1);
    if (closing === -1) return null;
    return {
      oldPath: stripDiffPrefix(body.slice(0, closing + 1)),
      newPath: stripDiffPrefix(body.slice(closing + 2).trim()),
    };
  }
  const separator = body.lastIndexOf(' b/');
  if (separator === -1) {
    const midpoint = body.indexOf(' ');
    if (midpoint === -1) return null;
    return {
      oldPath: stripDiffPrefix(body.slice(0, midpoint)),
      newPath: stripDiffPrefix(body.slice(midpoint + 1)),
    };
  }
  return {
    oldPath: stripDiffPrefix(body.slice(0, separator)),
    newPath: stripDiffPrefix(body.slice(separator + 1)),
  };
};

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface OpenFile {
  oldPath: string;
  newPath: string;
  status: WorkGitFileStatus;
  binary: boolean;
  lines: WorkDiffLine[];
  beforeLine?: number;
  afterLine?: number;
}

const finishFile = (file: OpenFile): WorkGitFileDiff => {
  const path = file.status === 'deleted' ? file.oldPath : file.newPath;
  return {
    path,
    ...(file.status === 'renamed' && file.oldPath !== file.newPath
      ? { oldPath: file.oldPath }
      : {}),
    status: file.status,
    binary: file.binary,
    lines: file.lines,
    stats: workDiffStats(file.lines),
  };
};

/**
 * Parses a multi-file unified diff as produced by `git diff` into one entry
 * per file. Tolerates truncated patches and +/- lines that appear before any
 * hunk header (those lines simply carry no line numbers).
 */
export const parseUnifiedGitDiff = (patch: string): WorkGitFileDiff[] => {
  const files: WorkGitFileDiff[] = [];
  let current: OpenFile | null = null;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      if (current) files.push(finishFile(current));
      const paths = parseDiffHeaderPaths(raw);
      current = {
        oldPath: paths?.oldPath ?? '',
        newPath: paths?.newPath ?? paths?.oldPath ?? '',
        status: 'modified',
        binary: false,
        lines: [],
      };
      continue;
    }
    if (!current) continue;

    if (raw.startsWith('new file mode')) {
      current.status = 'added';
      continue;
    }
    if (raw.startsWith('deleted file mode')) {
      current.status = 'deleted';
      continue;
    }
    if (raw.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = unquoteGitPath(raw.slice('rename from '.length));
      continue;
    }
    if (raw.startsWith('rename to ')) {
      current.status = 'renamed';
      current.newPath = unquoteGitPath(raw.slice('rename to '.length));
      continue;
    }
    if (raw.startsWith('Binary files ') || raw === 'GIT binary patch') {
      current.binary = true;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const path = raw.slice(4).trim();
      if (path !== '/dev/null' && current.status !== 'renamed') {
        current.oldPath = stripDiffPrefix(path);
      }
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      if (path !== '/dev/null' && current.status !== 'renamed') {
        current.newPath = stripDiffPrefix(path);
      }
      continue;
    }

    const hunk = raw.match(HUNK_HEADER);
    if (hunk) {
      current.beforeLine = parseInt(hunk[1], 10);
      current.afterLine = parseInt(hunk[2], 10);
      continue;
    }
    if (
      raw.startsWith('index ') ||
      raw.startsWith('similarity index') ||
      raw.startsWith('dissimilarity index') ||
      raw.startsWith('old mode') ||
      raw.startsWith('new mode') ||
      raw.startsWith('copy from') ||
      raw.startsWith('copy to') ||
      raw.startsWith('\\')
    ) {
      continue;
    }

    if (raw.startsWith('+')) {
      current.lines.push({
        type: 'added',
        text: raw.slice(1),
        ...(current.afterLine !== undefined
          ? { afterLine: current.afterLine++ }
          : {}),
      });
      continue;
    }
    if (raw.startsWith('-')) {
      current.lines.push({
        type: 'removed',
        text: raw.slice(1),
        ...(current.beforeLine !== undefined
          ? { beforeLine: current.beforeLine++ }
          : {}),
      });
      continue;
    }
    if (raw.startsWith(' ')) {
      current.lines.push({
        type: 'context',
        text: raw.slice(1),
        ...(current.beforeLine !== undefined
          ? { beforeLine: current.beforeLine++ }
          : {}),
        ...(current.afterLine !== undefined
          ? { afterLine: current.afterLine++ }
          : {}),
      });
      continue;
    }
  }
  if (current) files.push(finishFile(current));
  return files;
};

export const workGitDiffTotals = (files: WorkGitFileDiff[]): WorkDiffStats => {
  let added = 0;
  let removed = 0;
  for (const file of files) {
    added += file.stats.added;
    removed += file.stats.removed;
  }
  return { added, removed };
};
