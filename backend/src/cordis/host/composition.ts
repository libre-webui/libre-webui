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
 * Parsing for Cordis composition documents.
 *
 * The Cordis `Include` tree carrier reads a composition file as a **top-level
 * YAML array of entries** and rejects anything else, so the entry list and the
 * host's own settings cannot share one document. They are therefore two files
 * with one job each:
 *
 * - `cordis.patch.yml` — the entry array that mounts the engine. The Cordis
 *   loader owns this file and may write it back when an entry changes.
 * - `cordis.config.yml` — Libre WebUI's settings for the same engine (provider,
 *   routes, feature flags). The host owns this file and never rewrites it.
 *
 * `!!js` is supported inside entry `config` values and preserved as the loader's
 * own `{ __jsExpr }` marker rather than evaluated here. The loader evaluates
 * those expressions later, in the owning entry's fiber, which is what lets a row
 * read `process.env` at activation time rather than at file-read time. The
 * settings document does not support `!!js` because the host evaluates it
 * before any fiber exists; settings use environment variables instead.
 *
 * @module cordis/host/composition
 */

import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_SCHEMA, Type, dump, load } from 'js-yaml';

const JS_TAG = 'tag:yaml.org,2002:js';

/**
 * YAML schema that maps `!!js <expr>` onto the loader's expression marker.
 *
 * This mirrors `@deepseek-ai/cordis-plugin-include`'s own tag, so a composition
 * parses identically whether the host or the Include plugin reads it. It
 * extends the default schema rather than replacing it: a fresh `Schema` holding
 * only this tag silently loses every core YAML type, which surfaces as
 * "unacceptable kind of an object to dump [object Boolean]" the moment the host
 * writes a composed document back out.
 *
 * The `represent` hook keeps the tag intact on that write. Without it the
 * marker would be emitted as an ordinary nested mapping, which then fails to
 * parse back into a marker.
 */
const LOADER_SCHEMA = DEFAULT_SCHEMA.extend([
  new Type(JS_TAG, {
    kind: 'scalar',
    resolve: (data: unknown) => typeof data === 'string',
    construct: (data: string) => ({ __jsExpr: data }),
    predicate: (data: unknown) =>
      typeof data === 'object' &&
      data !== null &&
      typeof (data as Record<string, unknown>).__jsExpr === 'string',
    represent: (data: unknown) =>
      (data as Record<string, unknown>).__jsExpr as string,
  }),
]);

/** One raw loader entry from a composition document. */
export interface CompositionEntry {
  /** Stable id addressed by `loader.update` and `loader.remove`. */
  readonly id: string;
  /** Module specifier the loader imports; always a literal string. */
  readonly name: string;
  /** Config passed to the plugin; may contain `!!js` markers. */
  readonly config?: unknown;
  /** Whether the row starts disabled. */
  readonly disabled?: unknown;
  /** Required services or service intercept config for this row. */
  readonly inject?: unknown;
}

/**
 * Parse a settings document (`cordis.config.yml`).
 * @param source - the document text.
 * @returns the settings mapping, or an empty mapping for an empty document.
 * @throws when the document is not a mapping.
 */
export function parseSettings(source: string): Record<string, unknown> {
  const parsed = load(source);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'cordis host: the settings document must be a YAML mapping of keys such as ' +
        '`enabled`, `model`, and `features`'
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse a composition document (`cordis.patch.yml`).
 * @param source - the document text.
 * @returns the validated entry list.
 * @throws when the document is not a list, or an entry lacks a literal `name`.
 */
export function parseComposition(source: string): CompositionEntry[] {
  const parsed = load(source, { schema: LOADER_SCHEMA });
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(
      'cordis host: the composition document must be a top-level YAML array of ' +
        'loader entries (the Cordis Include carrier rejects any other shape)'
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`cordis host: plugin entry #${index} must be a mapping`);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new Error(
        `cordis host: plugin entry #${index} needs a literal string \`name\`; ` +
          'the loader imports `name` directly, so it cannot be a !!js expression'
      );
    }
    const id =
      typeof record.id === 'string' && record.id.trim() !== ''
        ? record.id
        : // A stable, position-derived id keeps `update` and `remove` usable
          // even for a row an operator forgot to label.
          `${record.name}#${index}`;
    return {
      id,
      name: record.name,
      ...(record.config === undefined ? {} : { config: record.config }),
      ...(record.disabled === undefined ? {} : { disabled: record.disabled }),
      ...(record.inject === undefined ? {} : { inject: record.inject }),
    };
  });
}

/**
 * Read the settings document from disk.
 *
 * A missing file yields empty settings so that "unconfigured" stays
 * distinguishable from a misconfiguration: the first uses defaults, the second is
 * a hard error. A present file that cannot be parsed is always the latter.
 * @param settingsPath - absolute path of the settings document.
 * @returns the settings mapping, empty when the file is absent.
 * @throws when the file exists but is not a valid settings mapping.
 */
export function readSettingsFile(
  settingsPath: string
): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  const raw = readFileSync(settingsPath, 'utf8');
  try {
    return parseSettings(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cordis host: ${settingsPath} is not usable: ${detail}`);
  }
}

/**
 * Serialize a composition entry list back to YAML.
 *
 * `!!js` markers are re-emitted as tags rather than expanded, because the host
 * must not evaluate an expression that belongs to the owning entry's fiber. A
 * plain `js-yaml` dump would otherwise emit the marker as an ordinary nested
 * mapping and the loader would hand that mapping to the plugin as config.
 *
 * @param entries - the entry list to serialize.
 * @returns the YAML document body, ending in a newline.
 */
export function stringifyComposition(
  entries: readonly CompositionEntry[]
): string {
  return dump(entries, { schema: LOADER_SCHEMA, noRefs: true, lineWidth: 100 });
}

/**
 * Read the composition document from disk.
 * @param configPath - absolute path of the composition document.
 * @returns the validated entry list, empty when the file is absent.
 * @throws when the file exists but is not a valid composition document.
 */
export function readCompositionFile(configPath: string): CompositionEntry[] {
  if (!existsSync(configPath)) return [];
  const raw = readFileSync(configPath, 'utf8');
  try {
    return parseComposition(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`cordis host: ${configPath} is not usable: ${detail}`);
  }
}

/**
 * Apply host-owned defaults to the engine bridge row.
 *
 * The bridge cannot learn the model route from its own document because the
 * route is a host setting, and an agent with no provider pinned silently
 * produces turns with no assistant response. The host therefore supplies those
 * values to the row it names, while leaving every other row untouched so the
 * composition stays the operator's document.
 *
 * @param entries - the composition's entry list.
 * @param bridgeEntryId - id of the row that mounts the Libre WebUI bridge.
 * @param defaults - values the host injects into that row's config.
 * @returns a detached entry list with the bridge row's config merged.
 */
export function applyHostDefaults(
  entries: readonly CompositionEntry[],
  bridgeEntryId: string,
  defaults: Record<string, unknown>
): CompositionEntry[] {
  return entries.map(entry => {
    if (entry.id !== bridgeEntryId) return entry;
    const existing =
      entry.config !== null &&
      typeof entry.config === 'object' &&
      !Array.isArray(entry.config)
        ? (entry.config as Record<string, unknown>)
        : {};
    // The document wins over the host default: an operator who pinned a
    // provider on the row meant it.
    return {
      ...entry,
      config: { ...defaults, ...existing },
    };
  });
}
