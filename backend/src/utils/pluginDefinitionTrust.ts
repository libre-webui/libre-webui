/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createHash } from 'crypto';
import { Plugin } from '../types/index.js';

/**
 * These hashes are a build-shipped trust anchor outside writable plugin JSON.
 * Update the matching entry intentionally whenever a bundled manifest changes.
 */
export const BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS: Readonly<
  Record<string, string>
> = Object.freeze({
  anthropic: '22dd38869e2a3fc71bc906a9cef5055ee45458c1f948ac54e4fe3e8f0df10bb2',
  baseten: 'd0486c8c44a5f2ca7bdb5407869f411fe3ca7ba0ee2b2a30d1cd5f96a18cfc35',
  bedrock: '3cfcf2c3728f621b4b9f22ecb8f6d30cb4aec2164302a3fb65268bdc2f6eca64',
  'codex-oauth':
    '82f39cd30da614cbdba5fc504962947e59d616592b334abb8afa6e498a81a216',
  comfyui: 'eaefe81897b58bffdf92bae8f0d0b675a062af276d5379e43147d6a0adaf0f47',
  deepseek: '32cc8662939e304869f9e02ef3b7c8ced6ffe14c333bea9230bfabe2f2350181',
  elevenlabs:
    'de6afcbd123600f484a078227618b5c9687bc56f6e2637b57514349fbcea63d6',
  gemini: '63e90a03067a11768a32fbc67456d0ebfaf0e22ebac652847ced046eeb49ca0f',
  github: '482f22da003d73fe0d6684572dc2d959b46d7f8dbecf0f92205c2b4ef2f03817',
  groq: 'd03908e9caddae5ad838de9967fdc0b5dfb249d13f24391af1c9822fcf28e823',
  huggingface:
    'be7e0840746816d6adaf6638a36d1339b7a557f7a2b0994c1574782977578a24',
  'kimi-code':
    '0b861caf086e5fdeeb029b6053447e673f2f8e121246d79b8102b157c109b557',
  'kyutai-tts-1.6b':
    'd280ba89d43d23c1554c524cbccf4da4a40f9be5672d3e925c87484719d56d2f',
  'kyutai-tts':
    '22b48b58b8d7d3021e6c0163771830e2e4e4d973466e700def41fe85ec90644f',
  'llama-cpp':
    '3f33346f01c22fd051c342a2dad66497c8b1a5562cab731f96bd646d04e21101',
  'longcat-audiodit':
    'ac898aaad95181722b4f53303edd4939a9f9b0fcd0c5a8126f39fa80e45cba25',
  meta: '4e3a7061dd82562ff9978d98aedf25e9e247dd73b5f3df2b60cf8e5afa14a270',
  mistral: 'a8a188cc75799a4b0a4c8fa4b448a8601b5ed72babc358ee460683459a75fbed',
  'mlx-lm': 'c5aad700fd557216a1e1eda361c0d67f92d51d1fe46d9c2028354f8ca8f25503',
  modal: '1090d56f1358d0bfeaea52db7551d2a0e10ce19898a4999b754a2cb801c67189',
  'openai-tts':
    'ebc3677f4f0ef2ec1628408d59a9e273059cc50d2f9d462e7a3b7f0c4eefe843',
  openai: 'b09166167dabcce34818526331dd128b07f9995ef192f85ee9dbaeb98841ac57',
  openrouter:
    '52e400545e141c4e021ebc600966ce83665c37b1e0b877308dc6782bd449fe54',
  'qwen-tts':
    '3a663efb46a9a228a78f850996b8006e886a67c32b52d0e31627586f856a9ba9',
});

const RUNTIME_DEFINITION_FIELDS = new Set([
  'active',
  'created_at',
  'updated_at',
]);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [
          key,
          canonicalize((value as Record<string, unknown>)[key]),
        ])
    );
  }
  return value;
}

export function getPluginDefinitionFingerprint(plugin: Plugin): string {
  const definition = Object.fromEntries(
    Object.entries(plugin as unknown as Record<string, unknown>).filter(
      ([key]) => !RUNTIME_DEFINITION_FIELDS.has(key)
    )
  );
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex');
}

const MODEL_PLACEHOLDER = '{model}';

/** True when every `{model}` sits after the host of an absolute URL. */
function modelPlaceholderStaysInPath(value: string): boolean {
  let index = value.indexOf(MODEL_PLACEHOLDER);
  while (index !== -1) {
    if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#]*[/?#]/i.test(value.slice(0, index))) {
      return false;
    }
    index = value.indexOf(MODEL_PLACEHOLDER, index + MODEL_PLACEHOLDER.length);
  }
  return true;
}

function someString(
  value: unknown,
  predicate: (text: string) => boolean
): boolean {
  if (typeof value === 'string') return predicate(value);
  if (Array.isArray(value)) {
    return value.some(item => someString(item, predicate));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => someString(item, predicate));
  }
  return false;
}

/** Model catalog fields: which models exist, never where a request goes. */
const MODEL_CATALOG_FIELDS = ['model_map', 'model_context', 'model_reasoning'];

const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function originOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return new URL(value.replace(/\{model\}/g, 'model')).origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether a decision capability sends the key nowhere the chat route does
 * not already go: a relative path under the provider's own API root, or an
 * endpoint on the chat endpoint's origin. Such a capability adds a request
 * shape, not a destination, so it does not change what a saved key is
 * bound to, and adding one to a provider keeps every saved key.
 */
function decisionStaysOnChatOrigin(
  plugin: Record<string, unknown>,
  capability: unknown
): boolean {
  if (!capability || typeof capability !== 'object') return false;
  const { endpoint, config } = capability as {
    endpoint?: unknown;
    config?: { path?: unknown; models_path?: unknown };
  };
  for (const relative of [config?.path, config?.models_path]) {
    if (relative === undefined) continue;
    if (typeof relative !== 'string' || ABSOLUTE_URL.test(relative.trim())) {
      return false;
    }
  }
  if (typeof config?.path === 'string') return true;
  const chatOrigin = originOf(plugin.endpoint);
  return chatOrigin !== undefined && originOf(endpoint) === chatOrigin;
}

/**
 * Definition fingerprint that binds a saved credential. The model catalogs,
 * top-level and per capability, are left out so adding a model does not
 * strand every saved key. When a `{model}` placeholder could pick the
 * destination host, the catalog is routing and stays bound.
 */
export function getCredentialBindingDefinitionFingerprint(
  plugin: Plugin,
  connectionValues: unknown = []
): string {
  if (
    someString(
      [plugin, connectionValues],
      text => !modelPlaceholderStaysInPath(text)
    )
  ) {
    return getPluginDefinitionFingerprint(plugin);
  }
  const withoutCatalog = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(
        ([key]) => !MODEL_CATALOG_FIELDS.includes(key)
      )
    );
  const definition = withoutCatalog(
    plugin as unknown as Record<string, unknown>
  );
  const capabilities = definition.capabilities;
  if (capabilities && typeof capabilities === 'object') {
    const bound = Object.entries(capabilities as Record<string, unknown>)
      .filter(
        ([name, capability]) =>
          !(
            name === 'decision' &&
            decisionStaysOnChatOrigin(definition, capability)
          )
      )
      .map(([name, capability]) => [
        name,
        capability && typeof capability === 'object'
          ? withoutCatalog(capability as Record<string, unknown>)
          : capability,
      ]);
    if (bound.length > 0 || Object.keys(capabilities).length === 0) {
      definition.capabilities = Object.fromEntries(bound);
    } else {
      // Only the unbound decision capability was there: hash as before it.
      delete definition.capabilities;
    }
  }
  return getPluginDefinitionFingerprint(definition as unknown as Plugin);
}

export function matchesBundledPluginTrustAnchor(plugin: Plugin): boolean {
  return (
    BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS[plugin.id] ===
    getPluginDefinitionFingerprint(plugin)
  );
}
