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

import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Host folder workspaces let a Work task operate on a real directory instead of
 * an isolated Docker volume. That trades away part of the sandbox, so it is
 * opt-in per deployment and confined to an explicit allowlist of roots.
 */
export class WorkHostWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkHostWorkspaceError';
  }
}

// Directories that must never be handed to an agent, even inside an allowed
// root: credentials, keys, and shell profiles that could grant lasting access.
const DENIED_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.config',
  '.kube',
  '.docker',
  '.libre-webui',
  '.claude',
  'node_modules',
]);

const enabled = (): boolean =>
  process.env.WORK_HOST_WORKSPACES_ENABLED === 'true';

const configuredRoots = (): string[] => {
  const raw = process.env.WORK_HOST_WORKSPACE_ROOTS?.trim();
  const roots = raw
    ? raw
        .split(path.delimiter)
        .map(entry => entry.trim())
        .filter(Boolean)
    : [os.homedir()];
  return roots.map(root => path.resolve(root));
};

const realPath = (target: string): string => {
  try {
    return fs.realpathSync(target);
  } catch {
    throw new WorkHostWorkspaceError(`No folder exists at ${target}.`);
  }
};

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
};

export class WorkHostWorkspaceService {
  isEnabled(): boolean {
    return enabled();
  }

  /** Roots the UI may offer; empty when the feature is disabled. */
  listRoots(): string[] {
    if (!enabled()) return [];
    return configuredRoots().filter(root => {
      try {
        return fs.statSync(root).isDirectory();
      } catch {
        return false;
      }
    });
  }

  /**
   * Resolves a requested host folder to a canonical path, or throws with a
   * user-facing reason. Symlinks are resolved before the allowlist check so a
   * link inside an allowed root cannot escape it.
   */
  resolveWorkspacePath(requested: string): string {
    if (!enabled()) {
      throw new WorkHostWorkspaceError(
        'Host folder workspaces are disabled on this server.'
      );
    }

    const trimmed = String(requested || '').trim();
    if (!trimmed) {
      throw new WorkHostWorkspaceError('A folder path is required.');
    }
    if (trimmed.includes('\0')) {
      throw new WorkHostWorkspaceError('The folder path is invalid.');
    }

    const expanded = trimmed.startsWith('~')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
    if (!path.isAbsolute(expanded)) {
      throw new WorkHostWorkspaceError('The folder path must be absolute.');
    }

    const resolved = realPath(path.resolve(expanded));
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      throw new WorkHostWorkspaceError(`${resolved} is not a folder.`);
    }

    const roots = configuredRoots().map(root => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    });
    if (!roots.some(root => isInside(root, resolved))) {
      throw new WorkHostWorkspaceError(
        `${resolved} is outside the folders this server allows for Work.`
      );
    }

    if (
      roots.some(root => root === resolved && root === path.parse(root).root)
    ) {
      throw new WorkHostWorkspaceError(
        'The filesystem root cannot be used as a workspace.'
      );
    }

    for (const segment of resolved.split(path.sep)) {
      if (DENIED_SEGMENTS.has(segment)) {
        throw new WorkHostWorkspaceError(
          `Folders named "${segment}" cannot be used as a workspace.`
        );
      }
    }

    return resolved;
  }
}

const workHostWorkspaceService = new WorkHostWorkspaceService();
export default workHostWorkspaceService;
