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

import {
  workModelSelectionKey,
  type WorkModelOption,
  type WorkProviderType,
} from '../types/work';

const STRANDS_PREFIX = 'strands:';
/** Work records from before Strands replaced the DeepSeek Harness. */
const LEGACY_ENGINE_PREFIXES = ['dsh:'] as const;

export type WorkEngine = 'libre' | 'strands';

const enginePrefix = (model: string): string | undefined =>
  model.startsWith(STRANDS_PREFIX)
    ? STRANDS_PREFIX
    : LEGACY_ENGINE_PREFIXES.find(prefix => model.startsWith(prefix));

export const workModelEngine = (
  model: string,
  _providerType?: WorkProviderType
): WorkEngine => (enginePrefix(model) ? 'strands' : 'libre');

export const baseWorkModel = (
  model: string,
  _providerType?: WorkProviderType
): string => {
  const prefix = enginePrefix(model);
  return prefix ? model.slice(prefix.length) : model;
};

/** Every provider model can run on either engine. */
export const workModelSupportsEngine = (
  _option: WorkModelOption,
  _engine: WorkEngine
): boolean => true;

/** The engine choice never changes the selected provider or remote disclosure. */
export const selectWorkEngine = (
  option: WorkModelOption,
  engine: WorkEngine
): WorkModelOption => {
  const selection = {
    ...option,
    model: `${engine === 'strands' ? STRANDS_PREFIX : ''}${baseWorkModel(option.model)}`,
  };
  return { ...selection, key: workModelSelectionKey(selection) };
};

export interface ChatWorkModelSelection {
  model: string;
  providerType?: string | null;
  providerId?: string | null;
}

function validSelectionPart(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    ![...value].some(
      character =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  );
}

function providerModelName(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    validSelectionPart(value) &&
    !['persona:', 'agent:', 'lwui:'].some(prefix =>
      normalized.startsWith(prefix)
    ) &&
    !['strands', 'dsh', 'claude-code', 'codex', 'opencode', 'pi'].some(
      selector =>
        normalized === selector || normalized.startsWith(`${selector}:`)
    )
  );
}

/** Translate only an explicitly identified Chat Strands selection, retaining its provider. */
export function workModelFromChatStrands(
  selection: ChatWorkModelSelection,
  models: readonly WorkModelOption[]
): { option: WorkModelOption; available: boolean } | undefined {
  if (selection.providerType !== 'agent' || selection.providerId !== 'strands')
    return undefined;
  const parts = selection.model.split(':');
  if (parts[0] !== 'strands') return undefined;
  let model: string;
  let providerType: WorkProviderType;
  let providerId: string | undefined;
  try {
    if (parts[1] === 'ollama' && parts.length === 3) {
      providerType = 'ollama';
      model = decodeURIComponent(parts[2]);
    } else if (parts[1] === 'plugin' && parts.length === 4) {
      providerType = 'plugin';
      providerId = decodeURIComponent(parts[2]);
      model = decodeURIComponent(parts[3]);
      if (!validSelectionPart(providerId)) return undefined;
    } else return undefined;
  } catch {
    return undefined;
  }
  if (!providerModelName(model)) return undefined;
  const target = { model, providerType, ...(providerId ? { providerId } : {}) };
  const key = workModelSelectionKey(target);
  const available = models.find(option => option.key === key);
  const option = available ?? {
    ...target,
    key,
    label: providerId ? `${model} · ${providerId}` : model,
    remote: providerType !== 'ollama' || /(?::cloud|-cloud)$/i.test(model),
  };
  return {
    option: selectWorkEngine(option, 'strands'),
    available: available !== undefined,
  };
}
