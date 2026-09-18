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

/** Local artifact deletion for the pinned JSONL backend's project/session layout. */
import path from 'node:path';
import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { SessionHeader } from '@deepseek-ai/dsh-session';

/**
 * Delete only a bridge-minted session directory after its writer is disposed.
 * The upstream persistence API has no delete operation. Keep its pinned
 * two-directory artifact layout in this one adapter, and refuse links rather
 * than letting an artifact path escape the configured local store.
 */
export async function deleteJsonlSession(
  storePath: string,
  header: SessionHeader
): Promise<void> {
  if (!/^session-[a-f0-9]{8}-\d+(?:-transient)?$/.test(header.id)) {
    throw new Error(
      'Only sessions created by the Libre WebUI bridge can be deleted.'
    );
  }
  const root = await realpath(storePath);
  const matches: string[] = [];
  for (const project of await readdir(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const parent = path.join(root, project.name);
    const target = path.join(parent, header.id);
    const metadata = await lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!metadata) continue;
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (await realpath(parent)) !== parent ||
      (await realpath(target)) !== target
    ) {
      throw new Error('Refusing to delete a linked Cordis session artifact.');
    }
    matches.push(target);
  }
  if (matches.length !== 1)
    throw new Error('The Cordis session artifact is missing or ambiguous.');
  const target = matches[0];
  const tombstone = path.join(path.dirname(target), `.deleted-${randomUUID()}`);
  await rename(target, tombstone);
  await rm(tombstone, { recursive: true, force: false });
}
