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

const DSH_PREFIX = 'dsh:';

export type WorkEngine = 'libre' | 'dsh';

export const workModelEngine = (
  model: string,
  providerType?: WorkProviderType
): WorkEngine =>
  providerType === 'dsh' || model.startsWith(DSH_PREFIX) ? 'dsh' : 'libre';

export const baseWorkModel = (
  model: string,
  providerType?: WorkProviderType
): string =>
  providerType !== 'dsh' && model.startsWith(DSH_PREFIX)
    ? model.slice(DSH_PREFIX.length)
    : model;

export const workModelSupportsEngine = (
  option: WorkModelOption,
  engine: WorkEngine
): boolean => engine === 'dsh' || option.providerType !== 'dsh';

/** The engine choice never changes the selected provider or remote disclosure. */
export const selectWorkEngine = (
  option: WorkModelOption,
  engine: WorkEngine
): WorkModelOption => {
  // Native provider identity already fixes the engine; its raw model is never
  // an engine prefix. Callers must handle incompatible engine switches first.
  if (option.providerType === 'dsh')
    return { ...option, key: workModelSelectionKey(option) };
  const selection = {
    ...option,
    model: `${engine === 'dsh' ? DSH_PREFIX : ''}${baseWorkModel(option.model)}`,
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
    !['dsh', 'claude-code', 'codex', 'opencode', 'pi'].some(
      selector =>
        normalized === selector || normalized.startsWith(`${selector}:`)
    )
  );
}

/** Translate only an explicitly identified Chat agent selection, retaining its provider. */
export function workModelFromChatDsh(
  selection: ChatWorkModelSelection,
  models: readonly WorkModelOption[]
): { option: WorkModelOption; available: boolean } | undefined {
  if (selection.providerType !== 'agent' || selection.providerId !== 'dsh')
    return undefined;
  const parts = selection.model.split(':');
  if (parts[0] !== 'dsh' || !['lwui', 'native'].includes(parts[1]))
    return undefined;
  let model: string;
  let providerType: WorkProviderType;
  let providerId: string | undefined;
  try {
    if (parts[1] === 'native' && parts.length === 4) {
      providerType = 'dsh';
      providerId = decodeURIComponent(parts[2]);
      model = decodeURIComponent(parts[3]);
      if (!validSelectionPart(providerId) || !validSelectionPart(model))
        return undefined;
    } else if (
      parts[1] === 'lwui' &&
      parts[2] === 'ollama' &&
      parts.length === 4
    ) {
      providerType = 'ollama';
      model = decodeURIComponent(parts[3]);
    } else if (
      parts[1] === 'lwui' &&
      parts[2] === 'plugin' &&
      parts.length === 5
    ) {
      providerType = 'plugin';
      providerId = decodeURIComponent(parts[3]);
      model = decodeURIComponent(parts[4]);
      if (!validSelectionPart(providerId)) return undefined;
    } else return undefined;
  } catch {
    return undefined;
  }
  if (providerType !== 'dsh' && !providerModelName(model)) return undefined;
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
    option: selectWorkEngine(option, 'dsh'),
    available: available !== undefined,
  };
}
