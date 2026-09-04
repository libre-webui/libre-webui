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
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';

/**
 * Instance-wide default theme. Chosen by an administrator, it paints the
 * sign-in page (where no user preference exists yet), seeds the theme of
 * every newly created account, and is what a browser without an explicit
 * choice falls back to. A user's own saved theme always wins over it.
 */

export type ThemePreference = UserPreferences['theme'];

export const DEFAULT_THEME_KEY = 'default_theme';

export const THEME_MODES = ['light', 'dark', 'amoled', 'celestial'] as const;
export const THEME_ACCENTS = [
  'violet',
  'blue',
  'cyan',
  'teal',
  'emerald',
  'amber',
  'rose',
  'slate',
  'custom',
] as const;

export const FALLBACK_DEFAULT_THEME: ThemePreference = {
  mode: 'dark',
  adaptToAccent: false,
  accent: 'blue',
  customAccent: '#4176e6',
};

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validate a theme payload. Returns null when it is not an object or any
 * provided field is out of range; missing fields fall back to the defaults.
 */
export function normalizeThemeInput(input: unknown): ThemePreference | null {
  if (!isRecord(input)) return null;

  const { mode, accent, customAccent, adaptToAccent } = input;
  if (
    mode !== undefined &&
    !THEME_MODES.includes(mode as (typeof THEME_MODES)[number])
  ) {
    return null;
  }
  if (
    accent !== undefined &&
    !THEME_ACCENTS.includes(accent as (typeof THEME_ACCENTS)[number])
  ) {
    return null;
  }
  if (
    customAccent !== undefined &&
    (typeof customAccent !== 'string' || !HEX_COLOR.test(customAccent))
  ) {
    return null;
  }
  if (adaptToAccent !== undefined && typeof adaptToAccent !== 'boolean') {
    return null;
  }

  return {
    mode: (mode as ThemePreference['mode']) ?? FALLBACK_DEFAULT_THEME.mode,
    adaptToAccent: adaptToAccent === true,
    accent:
      (accent as ThemePreference['accent']) ?? FALLBACK_DEFAULT_THEME.accent,
    customAccent:
      typeof customAccent === 'string'
        ? customAccent.toLowerCase()
        : FALLBACK_DEFAULT_THEME.customAccent,
  };
}

export async function getDefaultTheme(): Promise<ThemePreference> {
  try {
    const stored = await getSystemSetting(DEFAULT_THEME_KEY);
    if (!stored) return { ...FALLBACK_DEFAULT_THEME };
    return (
      normalizeThemeInput(JSON.parse(stored)) ?? { ...FALLBACK_DEFAULT_THEME }
    );
  } catch {
    // No database (or a corrupt value) means the built-in default.
    return { ...FALLBACK_DEFAULT_THEME };
  }
}

export async function setDefaultTheme(
  theme: ThemePreference
): Promise<ThemePreference> {
  const normalized = normalizeThemeInput(theme);
  if (!normalized) {
    throw new Error('Invalid theme.');
  }
  await setSystemSetting(DEFAULT_THEME_KEY, JSON.stringify(normalized));
  return normalized;
}
