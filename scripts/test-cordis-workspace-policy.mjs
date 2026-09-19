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
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import { assertWorkspaceToolPath } from '../backend/dist/cordis/dsh/workspace-policy.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-paths-'));
const workspace = path.join(root, 'workspace');
const outside = path.join(root, 'private');
await mkdir(workspace);
await mkdir(outside);
await mkdir(path.join(workspace, 'nested'));
await writeFile(path.join(workspace, 'allowed.txt'), 'fixture');
await writeFile(path.join(outside, 'private.txt'), 'outside fixture');
await symlink(outside, path.join(workspace, 'escape'));
const ctx = new Context();
await ctx.plugin(LocalFileSystem, { cwd: workspace });
const fs = ctx.get('fs');
test.after(async () => {
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
});

test('filesystem tools permit workspace reads and new nested files', async () => {
  await assertWorkspaceToolPath(fs, workspace, workspace, 'allowed.txt');
  await assertWorkspaceToolPath(
    fs,
    workspace,
    path.join(workspace, 'nested'),
    '../allowed.txt'
  );
  await assertWorkspaceToolPath(fs, workspace, workspace, 'new/child/file.txt');
});

test('filesystem tools reject outside paths, symlink reads and symlink writes', async () => {
  for (const target of [
    path.join(outside, 'private.txt'),
    '../private/private.txt',
    'escape/private.txt',
    'escape/new/file.txt',
    'escape/../private/private.txt',
  ]) {
    await assert.rejects(
      assertWorkspaceToolPath(fs, workspace, workspace, target),
      /restricted/
    );
  }
  await assert.rejects(
    assertWorkspaceToolPath(
      fs,
      workspace,
      outside,
      path.join(workspace, 'allowed.txt')
    ),
    /restricted/
  );
});

test('cancelled filesystem resolution cannot dispatch a tool', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    assertWorkspaceToolPath(
      fs,
      workspace,
      workspace,
      'allowed.txt',
      controller.signal
    ),
    /aborted/
  );
});
