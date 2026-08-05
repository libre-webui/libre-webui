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
 * Loads the vendored artifact runtime.
 *
 * The application page does this, never the sandbox frame. A sandboxed frame
 * has an opaque origin, so the browser treats its requests as cross-site and
 * withholds session cookies; behind an authenticating proxy those requests
 * come back as a redirect to a login page, which the sandbox policy then
 * refuses to load. Fetching here — authenticated, same-origin — and passing
 * the source into the frame sidesteps that entirely.
 */

import { ARTIFACT_RUNTIME_PATH } from '@/artifact-runtime/manifest';
import { ARTIFACT_RUNTIME_ORIGIN } from '@/utils/artifactSandbox';

/**
 * Stamped into the request so an intermediary cache — Cloudflare sits in front
 * of many deployments — cannot serve a runtime bundle from before an update.
 */
const RUNTIME_VERSION = encodeURIComponent(
  import.meta.env.VITE_APP_VERSION || 'dev'
);

const bundles = new Map<string, Promise<string>>();

/** Source of one runtime bundle. Each is fetched once per page load. */
export function loadArtifactBundle(name: string): Promise<string> {
  const cached = bundles.get(name);
  if (cached) return cached;

  const pending = fetch(
    `${ARTIFACT_RUNTIME_ORIGIN}${ARTIFACT_RUNTIME_PATH}/${name}.js?v=${RUNTIME_VERSION}`,
    { credentials: 'same-origin' }
  ).then(response => {
    if (!response.ok) {
      throw new Error(
        `The artifact runtime bundle "${name}" is unavailable (HTTP ${response.status}).`
      );
    }
    return response.text();
  });

  // A failed load must not be cached, or the preview never recovers.
  pending.catch(() => bundles.delete(name));
  bundles.set(name, pending);
  return pending;
}

/** Sources for the named bundles, keyed by name, loaded in parallel. */
export async function loadArtifactBundles(
  names: string[]
): Promise<Record<string, string>> {
  const sources = await Promise.all(names.map(loadArtifactBundle));
  return Object.fromEntries(names.map((name, index) => [name, sources[index]]));
}
