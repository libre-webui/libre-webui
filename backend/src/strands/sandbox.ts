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

/**
 * The only filesystem a Strands agent can see. The SDK's default environment
 * runs on the host with no isolation, so Libre WebUI replaces it with a
 * sandbox that maps a virtual `/workspace` onto one private directory per
 * account and refuses to execute commands. Paths are checked after symlink
 * resolution, so a link inside the workspace cannot reach the rest of the
 * disk.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Sandbox, type ExecuteOptions } from '@strands-agents/sdk/sandbox';
import type {
  ExecutionResult,
  FileInfo,
  StreamChunk,
} from '@strands-agents/sdk/sandbox';

/** The path the agent sees as its workspace root. */
export const STRANDS_WORKSPACE_ROOT = '/workspace';

/** Largest file an agent may read or write in one call. */
export const STRANDS_MAX_FILE_BYTES = 2 * 1024 * 1024;

export class StrandsSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StrandsSandboxError';
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export class WorkspaceSandbox extends Sandbox {
  private realRoot: string | undefined;

  constructor(private readonly root: string) {
    super();
  }

  /** Resolve a virtual path to a host path inside the workspace. */
  async resolve(virtualPath: string): Promise<string> {
    if (typeof virtualPath !== 'string' || virtualPath.includes('\0')) {
      throw new StrandsSandboxError('The path is invalid.');
    }
    const normalized = path.posix.normalize(
      virtualPath.startsWith('/')
        ? virtualPath
        : `${STRANDS_WORKSPACE_ROOT}/${virtualPath}`
    );
    if (
      normalized !== STRANDS_WORKSPACE_ROOT &&
      !normalized.startsWith(`${STRANDS_WORKSPACE_ROOT}/`)
    ) {
      throw new StrandsSandboxError(
        `Only paths under ${STRANDS_WORKSPACE_ROOT} are available.`
      );
    }
    const relative = normalized.slice(STRANDS_WORKSPACE_ROOT.length);
    const root = await this.ensureRoot();
    const target = path.join(root, ...relative.split('/').filter(Boolean));
    if (!isInside(root, target)) {
      throw new StrandsSandboxError('The path leaves the workspace.');
    }
    // Resolve the deepest existing ancestor so symlinks cannot escape.
    let probe = target;
    for (;;) {
      try {
        const real = await fs.realpath(probe);
        if (!isInside(root, real)) {
          throw new StrandsSandboxError('The path leaves the workspace.');
        }
        break;
      } catch (error) {
        if (error instanceof StrandsSandboxError) throw error;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    return target;
  }

  private async ensureRoot(): Promise<string> {
    if (this.realRoot) return this.realRoot;
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    this.realRoot = await fs.realpath(this.root);
    return this.realRoot;
  }

  // eslint-disable-next-line require-yield
  async *executeStreaming(
    _command: string,
    _options?: ExecuteOptions
  ): AsyncIterable<StreamChunk | ExecutionResult> {
    throw new StrandsSandboxError(
      'Command execution is not available in the Strands workspace.'
    );
  }

  // eslint-disable-next-line require-yield
  async *executeCodeStreaming(
    _code: string,
    _language: string,
    _options?: ExecuteOptions
  ): AsyncIterable<StreamChunk | ExecutionResult> {
    throw new StrandsSandboxError(
      'Code execution is not available in the Strands workspace.'
    );
  }

  async readFile(virtualPath: string): Promise<Uint8Array> {
    const target = await this.resolve(virtualPath);
    const stat = await fs.stat(target).catch(() => undefined);
    if (!stat?.isFile()) {
      throw new StrandsSandboxError(`No file at ${virtualPath}.`);
    }
    if (stat.size > STRANDS_MAX_FILE_BYTES) {
      throw new StrandsSandboxError(`${virtualPath} is too large to read.`);
    }
    return new Uint8Array(await fs.readFile(target));
  }

  async writeFile(virtualPath: string, content: Uint8Array): Promise<void> {
    if (content.byteLength > STRANDS_MAX_FILE_BYTES) {
      throw new StrandsSandboxError('The file is too large to write.');
    }
    const target = await this.resolve(virtualPath);
    const root = await this.ensureRoot();
    if (target === root) {
      throw new StrandsSandboxError('The workspace root is a directory.');
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // Re-check after creating parents in case a concurrent link appeared.
    await this.resolve(virtualPath);
    const existing = await fs.lstat(target).catch(() => undefined);
    if (existing?.isSymbolicLink()) {
      throw new StrandsSandboxError('Writing through a symlink is refused.');
    }
    await fs.writeFile(target, content, { mode: 0o600 });
  }

  async removeFile(virtualPath: string): Promise<void> {
    const target = await this.resolve(virtualPath);
    if (target === (await this.ensureRoot())) {
      throw new StrandsSandboxError('The workspace root cannot be removed.');
    }
    await fs.rm(target, { force: false });
  }

  async listFiles(virtualPath: string): Promise<FileInfo[]> {
    const target = await this.resolve(virtualPath);
    const entries = await fs.readdir(target, { withFileTypes: true });
    return Promise.all(
      entries.map(async entry => {
        const info: FileInfo = entry.isDirectory()
          ? { name: entry.name, isDir: true }
          : {
              name: entry.name,
              isDir: false,
              size: await fs
                .stat(path.join(target, entry.name))
                .then(stat => stat.size)
                .catch(() => undefined),
            };
        return info;
      })
    );
  }
}
