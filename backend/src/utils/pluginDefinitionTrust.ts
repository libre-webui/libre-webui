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
  anthropic: '4ba7c2344e8404ed78f6d6f622f24307fcc8f5451047d45ee427bb0ab4d1aecf',
  'codex-oauth':
    '6abe60d6c6ba6d617204783533070f042d7e7025b313580756235c6f924f2406',
  comfyui: 'eaefe81897b58bffdf92bae8f0d0b675a062af276d5379e43147d6a0adaf0f47',
  elevenlabs:
    'de6afcbd123600f484a078227618b5c9687bc56f6e2637b57514349fbcea63d6',
  gemini: '400de79b1d5b4b876c5ed14d177bd01b7eecbf9d6ce856ae031d98b1c7c8a5ce',
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
    'cb29e46330199af61f0ee677b7c72d6026f7141bacdb4423588f05ecd29f46ca',
  'longcat-audiodit':
    'ac898aaad95181722b4f53303edd4939a9f9b0fcd0c5a8126f39fa80e45cba25',
  mistral: 'a8a188cc75799a4b0a4c8fa4b448a8601b5ed72babc358ee460683459a75fbed',
  'mlx-lm': 'c5aad700fd557216a1e1eda361c0d67f92d51d1fe46d9c2028354f8ca8f25503',
  'openai-tts':
    'ebc3677f4f0ef2ec1628408d59a9e273059cc50d2f9d462e7a3b7f0c4eefe843',
  openai: '992eac06973a3fb5565adc693ded077858b1aa37de327218727a93a6f8aa1ba8',
  openrouter:
    '83cd1e5918d6c3176bb2929fbed6e325677e5d2e0c1ceda2da7a75f64df8365f',
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

export function matchesBundledPluginTrustAnchor(plugin: Plugin): boolean {
  return (
    BUNDLED_PLUGIN_DEFINITION_FINGERPRINTS[plugin.id] ===
    getPluginDefinitionFingerprint(plugin)
  );
}
