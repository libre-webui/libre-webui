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

/** Dependency-free validation for provider model identities in engine history. */
const AGENT_SELECTORS = ['claude-code', 'dsh', 'codex', 'opencode', 'pi'];

function plainIdentifier(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    ![...value].some(
      character =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  );
}

function providerModel(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    plainIdentifier(value) &&
    !normalized.startsWith('lwui:') &&
    !normalized.startsWith('native:') &&
    !normalized.startsWith('persona:') &&
    !normalized.startsWith('agent:') &&
    !AGENT_SELECTORS.some(
      selector =>
        normalized === selector || normalized.startsWith(`${selector}:`)
    )
  );
}

/**
 * Classify syntax and pseudo-model selectors only. Never consult availability:
 * an offline but valid selected provider must remain pinned to that provider.
 */
export function isProviderModelIdentity(value: unknown): value is string {
  if (typeof value !== 'string' || !plainIdentifier(value)) return false;
  if (value.startsWith('native:')) {
    try {
      return parseNativeDshModelId(value) !== undefined;
    } catch {
      return false;
    }
  }
  if (!value.toLowerCase().startsWith('lwui:')) return providerModel(value);
  const parts = value.split(':');
  try {
    if (parts[0] !== 'lwui') return false;
    if (parts[1] === 'ollama' && parts.length === 3)
      return providerModel(decodeURIComponent(parts[2]));
    if (parts[1] === 'plugin' && parts.length === 4) {
      return (
        plainIdentifier(decodeURIComponent(parts[2])) &&
        providerModel(decodeURIComponent(parts[3]))
      );
    }
  } catch {
    return false;
  }
  return false;
}

/** Native routes retain the owning DSH provider independently of LWUI plugins. */
export function nativeDshModelId(providerId: string, model: string): string {
  return `native:${encodeURIComponent(providerId)}:${encodeURIComponent(model)}`;
}

export function parseNativeDshModelId(
  value: string
): { providerId: string; model: string } | undefined {
  if (!value.startsWith('native:')) return undefined;
  const parts = value.split(':');
  try {
    if (parts.length !== 3 || value.length > 2048) throw new Error();
    const providerId = decodeURIComponent(parts[1]);
    const model = decodeURIComponent(parts[2]);
    if (!plainIdentifier(providerId) || !plainIdentifier(model))
      throw new Error();
    return { providerId, model };
  } catch {
    throw new Error('Invalid native DSH model selection.');
  }
}
