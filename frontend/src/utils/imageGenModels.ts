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

export interface ImageGenImage {
  url?: string;
  b64_json?: string;
  mime_type?: string;
  revised_prompt?: string;
}

interface ImageGenPluginDescriptor {
  id: string;
  models: string[];
}

interface PreferredImageGenSelection {
  model?: string;
  pluginId?: string;
}

const IMAGE_DATA_URL_PATTERN =
  /^data:image\/[a-z0-9][a-z0-9.+-]*(?:;[a-z0-9!#$&^_.+-]+=[^;,]*)*;base64,[a-z0-9+/]+={0,2}$/i;
const IMAGE_DATA_URL_MEDIA_TYPE_PATTERN =
  /^data:(image\/[a-z0-9][a-z0-9.+-]*)(?:;[a-z0-9!#$&^_.+-]+=[^;,]*)*;base64,/i;
const IMAGE_MEDIA_TYPE_ALIASES: Readonly<Record<string, string>> = {
  'image/jpg': 'image/jpeg',
  'image/x-png': 'image/png',
};
const SAFE_IMAGE_MEDIA_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/vnd.microsoft.icon',
  'image/webp',
  'image/x-icon',
]);

function normalizeImageMediaType(value: string | undefined): string | null {
  if (!value) return null;

  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  const normalized = IMAGE_MEDIA_TYPE_ALIASES[mediaType] || mediaType;
  return SAFE_IMAGE_MEDIA_TYPES.has(normalized) ? normalized : null;
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
  const configuredModel = findImageGenModel(models, model, pluginId);
  if (configuredModel || pluginId) {
    return configuredModel;
  }

  return models[0];
}

export function findPreferredImagePlugin<T extends ImageGenPluginDescriptor>(
  plugins: T[],
  settings: PreferredImageGenSelection | undefined
): T | undefined {
  if (settings?.pluginId) {
    return plugins.find(plugin => plugin.id === settings.pluginId);
  }

  const legacyModelPlugin = settings?.model
    ? plugins.find(plugin => plugin.models.includes(settings.model!))
    : undefined;
  return legacyModelPlugin || plugins[0];
}

export function getImageGenImageSource(image: ImageGenImage): string | null {
  const base64Image = image.b64_json?.trim();
  if (base64Image) {
    const safeMediaType =
      normalizeImageMediaType(image.mime_type) || 'image/png';
    return `data:${safeMediaType};base64,${base64Image}`;
  }

  const imageUrl = image.url?.trim();
  if (!imageUrl) {
    return null;
  }

  const dataUrlMediaType =
    IMAGE_DATA_URL_MEDIA_TYPE_PATTERN.exec(imageUrl)?.[1];
  if (
    IMAGE_DATA_URL_PATTERN.test(imageUrl) &&
    normalizeImageMediaType(dataUrlMediaType)
  ) {
    return imageUrl;
  }

  try {
    const parsedUrl = new URL(imageUrl);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
      ? imageUrl
      : null;
  } catch {
    return null;
  }
}

export function getImageGenImageFileExtension(imageSource: string): string {
  const mediaType = IMAGE_DATA_URL_MEDIA_TYPE_PATTERN.exec(
    imageSource.trim()
  )?.[1].toLowerCase();

  switch (mediaType) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    case 'image/avif':
      return 'avif';
    default:
      return 'png';
  }
}

export function getImageGenModelOptionValue(model: ImageGenModel): string {
  return `${encodeURIComponent(model.plugin)}::${encodeURIComponent(model.model)}`;
}

export function resolveImageGenOption(
  options: readonly string[] | undefined,
  preferredValue: string | undefined,
  defaultValue: string | undefined,
  fallbackValue: string
): string {
  const advertisedOptions = (options ?? []).filter(Boolean);

  if (advertisedOptions.length === 0) {
    return preferredValue || defaultValue || fallbackValue;
  }

  if (preferredValue && advertisedOptions.includes(preferredValue)) {
    return preferredValue;
  }

  if (defaultValue && advertisedOptions.includes(defaultValue)) {
    return defaultValue;
  }

  return advertisedOptions[0];
}
