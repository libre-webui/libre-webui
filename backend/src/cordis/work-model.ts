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

/** Engine selection stored alongside the model in existing Work records. */
export const WORK_DSH_MODEL_PREFIX = 'dsh:';

/** Whether Work should use its isolated DSH driver for this model selection. */
export function isWorkDshModel(model: string): boolean {
  return model.trim().startsWith(WORK_DSH_MODEL_PREFIX);
}

/** Recover the provider's exact model id without changing provider identity. */
export function workProviderModel(model: string): string {
  const selected = model.trim();
  return isWorkDshModel(selected)
    ? selected.slice(WORK_DSH_MODEL_PREFIX.length).trim()
    : selected;
}
