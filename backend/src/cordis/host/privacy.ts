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
 * Prevent configured DSH data-upload plugins from activating in LWUI's host.
 * This guards Loader imports, not arbitrary code inside trusted plugins.
 */
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';

const UPLOAD_PACKAGES = [
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
];

/** Recognize the known uploader packages and their normal module paths. */
export function isDshUploadPackage(specifier: string): boolean {
  let normalized = specifier;
  if (specifier.startsWith('file:')) {
    try {
      normalized = fileURLToPath(specifier);
    } catch {
      // Leave invalid active specifiers to the Loader. Disabled rows are inert.
      return false;
    }
  }
  normalized = normalized.replace(/\\/g, '/');
  return UPLOAD_PACKAGES.some(
    name =>
      normalized === name ||
      normalized.startsWith(`${name}/`) ||
      normalized.includes(`/node_modules/${name}/`)
  );
}

/** Check direct host imports as well as imports initiated through the Loader. */
export function assertDshModuleAllowed(specifier: string): void {
  if (isDshUploadPackage(specifier)) {
    throw new Error(
      `Libre WebUI disables DSH data-upload plugin "${specifier}". Set its Loader row to disabled: true.`
    );
  }
}

function requirePrivateEntry(
  options: Partial<EntryOptions>,
  allowDisabled = true
): void {
  if (
    typeof options.name !== 'string' ||
    (allowDisabled && options.disabled === true && !options.group)
  )
    return;
  assertDshModuleAllowed(options.name);
}

/** Install before mounting any entries, including nested Include trees. */
export function enforceDshPrivacy(context: Context): void {
  context.on('loader/entry-init', entry => {
    // Name changes on active entries import directly from update(), while
    // refresh() uses init(). Guard both public entry lifecycle methods.
    const update = entry.update.bind(entry);
    entry.update = async (options, create, force) => {
      requirePrivateEntry(create ? options : { ...entry.options, ...options });
      await update(options, create, force);
    };
    const init = entry.init.bind(entry);
    entry.init = async () => {
      requirePrivateEntry(entry.options, false);
      await init();
    };
  });
}
