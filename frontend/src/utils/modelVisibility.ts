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

import type { OllamaModel } from '@/types';

/**
 * The key an entry uses in the administrator-managed hidden-model set: an
 * Ollama model is keyed by its plain name, a plugin model by
 * `${pluginId}/${modelName}`. Must match the backend's convention.
 */
export function modelVisibilityKey(model: OllamaModel): string {
  return model.isPlugin && model.pluginId
    ? `${model.pluginId}/${model.name}`
    : model.name;
}

/**
 * Applies shared catalog priority without mutating provider results. Starred
 * keys lead in their saved sequence, configured order follows, and anything
 * newly discovered keeps its provider position at the end.
 */
export function orderModelsByCatalogPriority(
  models: readonly OllamaModel[],
  order: readonly string[],
  starred: readonly string[]
): OllamaModel[] {
  const priority = new Map<string, number>();
  for (const key of [...starred, ...order]) {
    if (!priority.has(key)) priority.set(key, priority.size);
  }

  return models
    .map((model, index) => ({
      model,
      index,
      priority:
        priority.get(modelVisibilityKey(model)) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) =>
      left.priority === right.priority
        ? left.index - right.index
        : left.priority - right.priority
    )
    .map(entry => entry.model);
}
