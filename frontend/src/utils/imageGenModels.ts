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

export interface ImageGenModel {
  model: string;
  plugin: string;
  config?: {
    sizes?: string[];
    default_size?: string;
    qualities?: string[];
    default_quality?: string;
    styles?: string[];
    default_style?: string;
    max_prompt_length?: number;
  };
}

export function findImageGenModel(
  models: ImageGenModel[],
  model?: string,
  pluginId?: string
): ImageGenModel | undefined {
  if (!model) return undefined;

  return models.find(
    candidate =>
      candidate.model === model && (!pluginId || candidate.plugin === pluginId)
  );
}

export function resolveImageGenModel(
  models: ImageGenModel[],
  model?: string,
  pluginId?: string
): ImageGenModel | undefined {
  return findImageGenModel(models, model, pluginId) || models[0];
}

export function getImageGenModelOptionValue(model: ImageGenModel): string {
  return `${encodeURIComponent(model.plugin)}::${encodeURIComponent(model.model)}`;
}
