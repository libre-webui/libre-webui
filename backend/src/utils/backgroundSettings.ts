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

import type { UserPreferences } from '../types/index.js';

type BackgroundSettings = NonNullable<UserPreferences['backgroundSettings']>;

export type NormalizedBackgroundSettings = Required<BackgroundSettings>;

export const DEFAULT_BACKGROUND_SETTINGS: NormalizedBackgroundSettings = {
  enabled: false,
  imageUrl: '',
  blurAmount: 10,
  opacity: 0.6,
  effect: 'dither',
};

const finiteRange = (value: unknown, fallback: number, maximum: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, value))
    : fallback;

export function normalizeBackgroundSettings(
  settings?: Partial<BackgroundSettings> | null
): NormalizedBackgroundSettings {
  return {
    enabled: settings?.enabled === true,
    // Keep the uploaded source intact; effects are derived only for display.
    imageUrl: typeof settings?.imageUrl === 'string' ? settings.imageUrl : '',
    blurAmount: finiteRange(settings?.blurAmount, 10, 30),
    opacity: finiteRange(settings?.opacity, 0.6, 1),
    effect:
      settings?.effect === 'original' || settings?.effect === 'blur'
        ? settings.effect
        : 'dither',
  };
}
