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

/** Engine selection stored alongside the model in Work records. */
export const WORK_STRANDS_MODEL_PREFIX = 'strands:';

/**
 * Work records written before the Strands engine replaced the DeepSeek
 * Harness used this prefix. They run on the Strands driver now, so stored
 * tasks keep working without a data migration.
 */
const LEGACY_ENGINE_MODEL_PREFIXES = ['dsh:'] as const;

function enginePrefix(model: string): string | undefined {
  const selected = model.trim();
  if (selected.startsWith(WORK_STRANDS_MODEL_PREFIX)) {
    return WORK_STRANDS_MODEL_PREFIX;
  }
  return LEGACY_ENGINE_MODEL_PREFIXES.find(prefix =>
    selected.startsWith(prefix)
  );
}

/** Whether Work should use the Strands driver for this model selection. */
export function isWorkStrandsModel(model: string): boolean {
  return enginePrefix(model) !== undefined;
}

/** Recover the provider's exact model id without changing provider identity. */
export function workProviderModel(model: string): string {
  const selected = model.trim();
  const prefix = enginePrefix(selected);
  return prefix ? selected.slice(prefix.length).trim() : selected;
}
