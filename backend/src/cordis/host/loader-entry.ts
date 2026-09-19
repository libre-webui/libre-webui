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
 * Loader entry helpers.
 *
 * @module cordis/host/loader-entry
 */

import type Loader from '@deepseek-ai/cordis-plugin-loader';

/** One loader entry the host wants to create. */
export interface LoaderEntryInput {
  /** Stable id, used later to resolve, update, or remove the entry. */
  readonly id: string;
  /** Module specifier the loader imports. */
  readonly name: string;
  /** Config passed to the plugin. */
  readonly config?: unknown;
}

/**
 * Create a loader entry.
 *
 * The published Loader types declare `create(options: Omit<EntryOptions, 'id'>)`
 * while `EntryOptions` requires `id` and the implementation reads it, so the
 * declared parameter type contradicts both the documented usage and the code.
 * This helper carries the one cast that bridges the discrepancy, so the
 * workaround lives in a single documented place rather than at every call site.
 * It is also what keeps the host and the model-adapter controller from
 * importing each other just to share the cast.
 *
 * @param loader - the Loader service reached from the host context.
 * @param entry - the entry to create, including its stable id.
 */
export async function createLoaderEntry(
  loader: Loader,
  entry: LoaderEntryInput
): Promise<void> {
  const create = loader.create.bind(loader) as unknown as (
    options: LoaderEntryInput
  ) => Promise<unknown>;
  await create(entry);
}

/**
 * Test whether a loader entry exists.
 *
 * `Loader.resolve()` throws for an unknown id instead of returning undefined,
 * so a plain truthiness check on its result is not a safe existence test.
 * @param loader - the Loader service reached from the host context.
 * @param id - the entry id to look for.
 * @returns true when an entry with that id is mounted.
 */
export function hasLoaderEntry(loader: Loader, id: string): boolean {
  try {
    return loader.resolve(id) !== undefined;
  } catch {
    return false;
  }
}
