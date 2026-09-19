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

import type { Context } from '@deepseek-ai/cordis';
import type { FileSystem } from '@deepseek-ai/dsh-fs';
import type {
  ToolDispatchExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools';

const FILESYSTEM_TOOLS = new Set(['read', 'read_image', 'write', 'edit']);

/**
 * Check using the filesystem provider's canonical identities, including symlink
 * ancestors and physical `..` traversal, exactly as its tool implementation does.
 */
export async function assertWorkspaceToolPath(
  fs: FileSystem,
  workspacePath: string,
  cwd: string,
  requestedPath: string,
  signal?: AbortSignal
): Promise<void> {
  const root = await fs.resolve(workspacePath, { signal });
  const directory = await fs.resolve(cwd, { signal });
  const target = await fs.resolve(requestedPath, { cwd, signal });
  if (!fs.contains(root, directory) || !fs.contains(root, target)) {
    throw new Error(
      'Filesystem tools are restricted to the configured Cordis workspace.'
    );
  }
}

/** Add read confinement to the shipped filesystem backend's mutation policy. */
export function installWorkspaceToolPolicy(
  ctx: Context,
  workspacePath: string
): void {
  ctx.on(
    'tools/execute',
    async (
      exec: ToolDispatchExecution,
      next: () => Promise<ToolExecutionResult>
    ) => {
      if (!FILESYSTEM_TOOLS.has(exec.name)) return next();
      const fs = ctx.get('fs') as FileSystem | undefined;
      const args = exec.arguments as { file_path?: unknown } | null;
      if (!fs || typeof args?.file_path !== 'string') {
        throw new Error(
          'A filesystem tool requires a valid path and filesystem provider.'
        );
      }
      await assertWorkspaceToolPath(
        fs,
        workspacePath,
        exec.agent?.session.header.cwd ?? workspacePath,
        args.file_path,
        exec.signal
      );
      return next();
    }
  );
}
