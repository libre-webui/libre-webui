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

export function normalizeImageGenerationCount(
  value: unknown
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 10
  ) {
    throw new RangeError('n must be an integer between 1 and 10');
  }

  return value;
}

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

export function normalizeImageMediaType(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  const normalized = IMAGE_MEDIA_TYPE_ALIASES[mediaType] || mediaType;
  return SAFE_IMAGE_MEDIA_TYPES.has(normalized) ? normalized : undefined;
}
