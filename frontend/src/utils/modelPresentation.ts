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

import type { TFunction } from 'i18next';
import type { OllamaModel } from '@/types';

export function modelDisplayName(model: OllamaModel): string {
  if (model.isLegacySelection) return model.name;
  if (model.isPersona) return model.personaName || model.name;
  if (model.isAgent) return model.agentName || model.name;
  return model.name;
}

/** Agent entries share the catalog but are not Ollama models. */
export function modelProviderLabel(model: OllamaModel, t: TFunction): string {
  if (model.isLegacySelection) return t('modelSelector.legacyProvider');
  if (model.isPersona) return t('settings.model.persona');
  if (model.isAgent) return t('common.agent');
  if (model.isPlugin)
    return model.pluginName || model.pluginId || t('common.provider');
  return 'Ollama';
}

export function modelOptionLabel(
  model: OllamaModel,
  t: TFunction,
  style: 'parentheses' | 'separator' = 'parentheses'
): string {
  const name = modelDisplayName(model);
  const provider = modelProviderLabel(model, t);
  const unavailable = model.isUnavailable ? t('modelSelector.unavailable') : '';
  return style === 'separator'
    ? `${name} · ${provider}${unavailable ? ` (${unavailable})` : ''}`
    : `${name} (${provider}${unavailable ? `, ${unavailable}` : ''})`;
}
