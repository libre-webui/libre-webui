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

import { chatModelSelectionFromKey } from '@/utils/chatModelSelection';
import type { OllamaModel } from '@/types';

export const MAX_COMPARE_MODELS = 3;

export interface CompareTarget {
  model: string;
  providerType?: string | null;
  providerId?: string | null;
}

export const compareTargetsFromKeys = (
  models: OllamaModel[],
  keys: string[]
): CompareTarget[] => {
  const targets: CompareTarget[] = [];
  for (const key of keys) {
    const selection = chatModelSelectionFromKey(models, key);
    if (!selection) continue;
    targets.push({
      model: selection.model,
      providerType: selection.providerType ?? null,
      providerId: selection.providerId ?? null,
    });
  }
  return targets;
};
