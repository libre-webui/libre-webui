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

import path from 'node:path';
import { WorkGitChange, WorkGitCommit, WorkGitStatus } from '../types/work.js';

const WORKSPACE_ROOT = '/workspace';

/**
 * Git always runs as an argv array inside the task sandbox. These settings
 * remove host/global configuration, prompts, hooks, credential helpers and
 * protocols from the local-only UI surface.
 */
export function buildWorkGitCommand(args: string[]): string[] {
  return [
    'env',
    'HOME=/tmp',
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_CONFIG_GLOBAL=/dev/null',
    'GIT_TERMINAL_PROMPT=0',
    'GIT_ASKPASS=/bin/false',
    'SSH_ASKPASS=/bin/false',
    'git',
    '--no-pager',
    '--literal-pathspecs',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'commit.gpgSign=false',
    '-c',
    'gc.auto=0',
    '-c',
    'maintenance.auto=false',
    '-c',
    'submodule.recurse=false',
    '-c',
    'protocol.allow=never',
    ...args,
  ];
}

/** Reject repositories whose worktree or Git metadata escapes the sandbox. */
export function validateWorkGitRepositoryPaths(output: string): void {
  const values = output.trimEnd().split('\n');
  if (values.length !== 3 || values.some(hasControlCharacter)) {
    throw new Error('Git returned an invalid repository layout.');
  }
  const [worktree, gitDirectory, commonDirectory] = values;
  if (worktree !== WORKSPACE_ROOT) {
    throw new Error('The Git worktree must be exactly /workspace.');
  }
  if (!isInsideWorkspace(gitDirectory) || !isInsideWorkspace(commonDirectory)) {
    throw new Error('Git metadata must stay inside /workspace.');
  }
}

export function validateWorkGitBranchName(value: string): string {
  if (
    value.length < 1 ||
    value.length > 200 ||
    value !== value.trim() ||
    value.startsWith('-') ||
    hasControlCharacter(value)
  ) {
    throw new Error('Branch name is invalid.');
  }
  return value;
}

export function parseWorkGitStatus(output: string): WorkGitStatus {
  const status: WorkGitStatus = {
    initialized: true,
    detached: false,
    ahead: 0,
    behind: 0,
    changes: [],
    branches: [],
    commits: [],
  };
  const records = output.split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) {
      const oid = record.slice('# branch.oid '.length);
      if (oid !== '(initial)') status.head = oid;
      continue;
    }
    if (record.startsWith('# branch.head ')) {
      const branch = record.slice('# branch.head '.length);
      if (branch === '(detached)') status.detached = true;
      else status.branch = branch;
      continue;
    }
    if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice('# branch.upstream '.length);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
      continue;
    }

    let change: WorkGitChange | undefined;
    if (record.startsWith('1 ')) {
      change = parseTrackedChange(record, 8);
    } else if (record.startsWith('2 ')) {
      change = parseTrackedChange(record, 9);
      const originalPath = records[index + 1];
      if (change && originalPath !== undefined) {
        change.originalPath = originalPath;
        index += 1;
      }
    } else if (record.startsWith('u ')) {
      change = parseTrackedChange(record, 10);
    } else if (record.startsWith('? ')) {
      change = {
        path: record.slice(2),
        indexStatus: '?',
        workingTreeStatus: '?',
        staged: false,
      };
    }
    if (change) status.changes.push(change);
  }
  status.changes.sort((left, right) => left.path.localeCompare(right.path));
  return status;
}

export function parseWorkGitLog(output: string): WorkGitCommit[] {
  const fields = output.split('\0');
  const commits: WorkGitCommit[] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash, shortHash, author, authoredAt, subject] = fields.slice(
      index,
      index + 5
    );
    if (!hash) continue;
    commits.push({ hash, shortHash, author, authoredAt, subject });
  }
  return commits;
}

export function parseWorkGitBranches(output: string): string[] {
  return output
    .split('\n')
    .map(value => value.trim())
    .filter(value => value && !hasControlCharacter(value))
    .sort((left, right) => left.localeCompare(right));
}

function parseTrackedChange(
  record: string,
  prefixFieldCount: number
): WorkGitChange | undefined {
  const fields = splitPrefixFields(record, prefixFieldCount);
  const xy = fields[1];
  const filePath = fields[prefixFieldCount];
  if (!xy || xy.length !== 2 || !filePath) return undefined;
  return {
    path: filePath,
    indexStatus: xy[0],
    workingTreeStatus: xy[1],
    staged: xy[0] !== '.' && xy[0] !== '?',
  };
}

function splitPrefixFields(value: string, count: number): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const separator = value.indexOf(' ', start);
    if (separator < 0) return [];
    fields.push(value.slice(start, separator));
    start = separator + 1;
  }
  fields.push(value.slice(start));
  return fields;
}

function isInsideWorkspace(value: string): boolean {
  if (!path.posix.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return (
    normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)
  );
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
