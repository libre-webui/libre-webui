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

const CURRENT_FORMAT = 'libre-webui-user-data';
const LEGACY_FORMAT = 'libre-webui-export';
const CURRENT_VERSION = 3;
const MIGRATABLE_VERSIONS = new Set([2, CURRENT_VERSION]);

type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

export async function computePortableArchiveDigest(
  archive: Record<string, unknown>
): Promise<string> {
  const { integrity: _integrity, ...payload } = archive;
  const jsonSafe = JSON.parse(JSON.stringify(payload)) as JsonValue;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalJson(jsonSafe))
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

export function parsePortableArchiveJson(
  text: string
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Portable archive is not valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Portable archive must contain a JSON object.');
  }
  const archive = value as Record<string, unknown>;
  if (archive.format === CURRENT_FORMAT) {
    if (!MIGRATABLE_VERSIONS.has(archive.version as number)) {
      throw new Error(
        `Unsupported portable archive version ${String(archive.version)}.`
      );
    }
    return archive;
  }
  if (archive.format === LEGACY_FORMAT) return archive;
  throw new Error('This file is not a Libre WebUI portable archive.');
}
