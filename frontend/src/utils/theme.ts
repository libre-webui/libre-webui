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

import { Theme } from '@/types';
import {
  CELESTIAL_ROLE_KEYS,
  CELESTIAL_SHADE_KEYS,
  CELESTIAL_TICK_MS,
} from '@/utils/celestial';
import { useCelestialStore } from '@/store/celestialStore';

export const DEFAULT_THEME_MODE: Theme['mode'] = 'dark';
export const DEFAULT_ACCENT = 'blue';
export const DEFAULT_CUSTOM_ACCENT = '#4176e6';

export const ACCENT_OPTIONS = [
  {
    id: 'violet',
    label: 'Violet',
    color: '#7c3aed',
    foreground: '#ffffff',
  },
  {
    id: 'blue',
    label: 'Blue',
    color: '#4176e6',
    foreground: '#ffffff',
  },
  {
    id: 'cyan',
    label: 'Cyan',
    color: '#0e7490',
    foreground: '#ffffff',
  },
  {
    id: 'teal',
    label: 'Teal',
    color: '#0f766e',
    foreground: '#ffffff',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    color: '#15803d',
    foreground: '#ffffff',
  },
  {
    // Keep the legacy id so existing saved themes migrate without data loss.
    id: 'amber',
    label: 'Coral',
    color: '#ff7b52',
    foreground: '#3d120c',
  },
  {
    id: 'rose',
    label: 'Rose',
    color: '#e11d48',
    foreground: '#ffffff',
  },
  {
    id: 'slate',
    label: 'Slate',
    color: '#475569',
    foreground: '#ffffff',
  },
] as const;

const SHADE_KEYS = [
  '50',
  '100',
  '200',
  '300',
  '400',
  '500',
  '600',
  '700',
  '800',
  '900',
  '950',
] as const;

const NEUTRAL_SHADE_KEYS = ['25', ...SHADE_KEYS] as const;
const INTERFACE_ROLE_KEYS = [
  'canvas',
  'sidebar',
  'surface',
  'surface-subtle',
  'surface-raised',
  'surface-overlay',
  'surface-inverse',
  'ink',
  'ink-muted',
  'ink-subtle',
  'ink-inverse',
  'line',
  'line-strong',
] as const;

type AccentId = (typeof ACCENT_OPTIONS)[number]['id'];
type AccentShade = (typeof SHADE_KEYS)[number];
type AccentPalette = Record<AccentShade, string>;
type NeutralShade = (typeof NEUTRAL_SHADE_KEYS)[number];
type NeutralPalette = Record<NeutralShade, string>;
type InterfaceRole = (typeof INTERFACE_ROLE_KEYS)[number];
type InterfaceRoleDefinition = {
  lightness: number;
  saturationFactor: number;
};
type InterfaceSaturationProfile = {
  multiplier: number;
  minimum: number;
  maximum: number;
};

const DEFAULT_INTERFACE_SATURATION: InterfaceSaturationProfile = {
  multiplier: 0.24,
  minimum: 6,
  maximum: 24,
};

const LIGHT_INTERFACE_SATURATION: InterfaceSaturationProfile = {
  multiplier: 0.36,
  minimum: 6,
  maximum: 32,
};

const LIGHT_NEUTRAL_LIGHTNESS: Record<NeutralShade, number> = {
  25: 99,
  50: 97,
  100: 94,
  200: 88,
  300: 80,
  400: 66,
  500: 48,
  600: 36,
  700: 27,
  800: 18,
  900: 11,
  950: 6,
};

const DARK_NEUTRAL_LIGHTNESS: Record<NeutralShade, number> = {
  25: 13,
  50: 4,
  100: 7,
  200: 10,
  300: 16,
  400: 27,
  500: 46,
  600: 65,
  700: 82,
  800: 89,
  900: 95,
  950: 99,
};

// True-black variant of the dark ladder: surfaces drop to (or near) zero
// lightness for OLED displays; text rungs match the grey dark theme.
const AMOLED_NEUTRAL_LIGHTNESS: Record<NeutralShade, number> = {
  25: 6,
  50: 0,
  100: 3,
  200: 6,
  300: 12,
  400: 24,
  500: 46,
  600: 65,
  700: 82,
  800: 89,
  900: 95,
  950: 99,
};

const LIGHT_INTERFACE_ROLES: Record<InterfaceRole, InterfaceRoleDefinition> = {
  canvas: { lightness: 96, saturationFactor: 1 },
  sidebar: { lightness: 94, saturationFactor: 1 },
  surface: { lightness: 98, saturationFactor: 0.9 },
  'surface-subtle': { lightness: 93, saturationFactor: 1 },
  'surface-raised': { lightness: 99, saturationFactor: 0.8 },
  'surface-overlay': { lightness: 100, saturationFactor: 0 },
  'surface-inverse': { lightness: 10, saturationFactor: 0.7 },
  ink: { lightness: 10, saturationFactor: 0.45 },
  'ink-muted': { lightness: 38, saturationFactor: 0.35 },
  'ink-subtle': { lightness: 54, saturationFactor: 0.4 },
  'ink-inverse': { lightness: 98, saturationFactor: 0.4 },
  line: { lightness: 86, saturationFactor: 0.8 },
  'line-strong': { lightness: 75, saturationFactor: 0.65 },
};

const DARK_INTERFACE_ROLES: Record<InterfaceRole, InterfaceRoleDefinition> = {
  canvas: { lightness: 5, saturationFactor: 0.9 },
  sidebar: { lightness: 8, saturationFactor: 1 },
  surface: { lightness: 7, saturationFactor: 0.9 },
  'surface-subtle': { lightness: 9, saturationFactor: 1 },
  'surface-raised': { lightness: 11, saturationFactor: 1 },
  'surface-overlay': { lightness: 13, saturationFactor: 1 },
  'surface-inverse': { lightness: 96, saturationFactor: 0.35 },
  ink: { lightness: 96, saturationFactor: 0.3 },
  'ink-muted': { lightness: 67, saturationFactor: 0.35 },
  'ink-subtle': { lightness: 48, saturationFactor: 0.4 },
  'ink-inverse': { lightness: 7, saturationFactor: 0.45 },
  line: { lightness: 18, saturationFactor: 0.8 },
  'line-strong': { lightness: 28, saturationFactor: 0.65 },
};

const AMOLED_INTERFACE_ROLES: Record<InterfaceRole, InterfaceRoleDefinition> = {
  canvas: { lightness: 0, saturationFactor: 0 },
  sidebar: { lightness: 0, saturationFactor: 0 },
  surface: { lightness: 0, saturationFactor: 0 },
  'surface-subtle': { lightness: 4, saturationFactor: 1 },
  'surface-raised': { lightness: 7, saturationFactor: 1 },
  'surface-overlay': { lightness: 10, saturationFactor: 1 },
  'surface-inverse': { lightness: 96, saturationFactor: 0.35 },
  ink: { lightness: 96, saturationFactor: 0.3 },
  'ink-muted': { lightness: 67, saturationFactor: 0.35 },
  'ink-subtle': { lightness: 48, saturationFactor: 0.4 },
  'ink-inverse': { lightness: 0, saturationFactor: 0 },
  line: { lightness: 11, saturationFactor: 0.8 },
  'line-strong': { lightness: 20, saturationFactor: 0.65 },
};

const ACCENT_PALETTES: Record<AccentId, AccentPalette> = {
  violet: {
    50: '#f5f3ff',
    100: '#ede9fe',
    200: '#ddd6fe',
    300: '#c4b5fd',
    400: '#a78bfa',
    500: '#7c3aed',
    600: '#6d28d9',
    700: '#5b21b6',
    800: '#4c1d95',
    900: '#3b0764',
    950: '#2e1065',
  },
  blue: {
    50: '#edf3fe',
    100: '#e4edfd',
    200: '#d3e2ff',
    300: '#b7c8fe',
    400: '#679efe',
    500: '#4176e6',
    600: '#4868b2',
    700: '#2f4c8f',
    800: '#34415b',
    900: '#283142',
    950: '#1e2635',
  },
  cyan: {
    50: '#ecfeff',
    100: '#cffafe',
    200: '#a5f3fc',
    300: '#67e8f9',
    400: '#22d3ee',
    500: '#0e7490',
    600: '#155e75',
    700: '#164e63',
    800: '#083344',
    900: '#092f3f',
    950: '#062634',
  },
  teal: {
    50: '#f0fdfa',
    100: '#ccfbf1',
    200: '#99f6e4',
    300: '#5eead4',
    400: '#2dd4bf',
    500: '#0f766e',
    600: '#0f625d',
    700: '#115e59',
    800: '#134e4a',
    900: '#042f2e',
    950: '#022c22',
  },
  emerald: {
    50: '#ecfdf5',
    100: '#d1fae5',
    200: '#a7f3d0',
    300: '#6ee7b7',
    400: '#34d399',
    500: '#15803d',
    600: '#166534',
    700: '#14532d',
    800: '#064e3b',
    900: '#052e16',
    950: '#022c22',
  },
  amber: {
    50: '#fff5f1',
    100: '#ffe8df',
    200: '#ffd0c2',
    300: '#ffae96',
    400: '#ff9273',
    500: '#ff7b52',
    600: '#c94a27',
    700: '#a83a1f',
    800: '#87301f',
    900: '#70291e',
    950: '#3d120c',
  },
  rose: {
    50: '#fff1f2',
    100: '#ffe4e6',
    200: '#fecdd3',
    300: '#fda4af',
    400: '#fb7185',
    500: '#e11d48',
    600: '#be123c',
    700: '#9f1239',
    800: '#881337',
    900: '#4c0519',
    950: '#2d0714',
  },
  slate: {
    50: '#f8fafc',
    100: '#f1f5f9',
    200: '#e2e8f0',
    300: '#cbd5e1',
    400: '#94a3b8',
    500: '#475569',
    600: '#334155',
    700: '#1e293b',
    800: '#0f172a',
    900: '#020617',
    950: '#010313',
  },
};

const CUSTOM_LIGHTNESS: Record<AccentShade, number> = {
  50: 97,
  100: 94,
  200: 88,
  300: 76,
  400: 64,
  500: 42,
  600: 34,
  700: 27,
  800: 21,
  900: 16,
  950: 10,
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const normalizeHexColor = (value?: string): string | null => {
  if (!value) return null;

  const trimmed = value.trim();
  const match = trimmed.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;

  const raw = match[1];
  const hex =
    raw.length === 3
      ? raw
          .split('')
          .map(char => `${char}${char}`)
          .join('')
      : raw;

  return `#${hex.toLowerCase()}`;
};

const hexToRgb = (hex: string) => {
  const normalized = normalizeHexColor(hex) || DEFAULT_CUSTOM_ACCENT;
  const value = parseInt(normalized.slice(1), 16);

  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
};

const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b]
    .map(channel =>
      clamp(Math.round(channel), 0, 255).toString(16).padStart(2, '0')
    )
    .join('')}`;

const rgbToHsl = (r: number, g: number, b: number) => {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: lightness * 100 };
  }

  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === red) {
    hue = (green - blue) / delta + (green < blue ? 6 : 0);
  } else if (max === green) {
    hue = (blue - red) / delta + 2;
  } else {
    hue = (red - green) / delta + 4;
  }

  return { h: hue * 60, s: saturation * 100, l: lightness * 100 };
};

const hslToHex = (h: number, s: number, l: number) => {
  const saturation = clamp(s, 0, 100) / 100;
  const lightness = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hue = ((h % 360) + 360) % 360;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) {
    red = chroma;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = chroma;
  } else if (hue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  return rgbToHex(
    (red + match) * 255,
    (green + match) * 255,
    (blue + match) * 255
  );
};

const getRelativeLuminance = (hex: string) => {
  const { r, g, b } = hexToRgb(hex);
  const channels = [r, g, b].map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  });

  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};

const getContrastRatio = (foreground: string, background: string) => {
  const foregroundLum = getRelativeLuminance(foreground);
  const backgroundLum = getRelativeLuminance(background);
  const lighter = Math.max(foregroundLum, backgroundLum);
  const darker = Math.min(foregroundLum, backgroundLum);

  return (lighter + 0.05) / (darker + 0.05);
};

const ensureWhiteTextContrast = (h: number, s: number, l: number) => {
  let lightness = l;
  let hex = hslToHex(h, s, lightness);

  while (getContrastRatio('#ffffff', hex) < 4.5 && lightness > 12) {
    lightness -= 2;
    hex = hslToHex(h, s, lightness);
  }

  return hex;
};

const createCustomPalette = (customAccent?: string): AccentPalette => {
  const base = normalizeHexColor(customAccent) || DEFAULT_CUSTOM_ACCENT;
  const { r, g, b } = hexToRgb(base);
  const { h, s } = rgbToHsl(r, g, b);
  const saturation = s < 8 ? s : clamp(s, 42, 88);

  return SHADE_KEYS.reduce((palette, shade) => {
    const lightness = CUSTOM_LIGHTNESS[shade];
    const shadeSaturation =
      Number(shade) < 300 ? saturation * 0.72 : saturation;
    const nextColor =
      shade === '500' || shade === '600'
        ? ensureWhiteTextContrast(h, shadeSaturation, lightness)
        : hslToHex(h, shadeSaturation, lightness);

    palette[shade] = nextColor;
    return palette;
  }, {} as AccentPalette);
};

export const normalizeTheme = (theme?: Partial<Theme> | null): Theme => {
  const mode =
    theme?.mode === 'light'
      ? 'light'
      : theme?.mode === 'amoled'
        ? 'amoled'
        : theme?.mode === 'celestial'
          ? 'celestial'
          : DEFAULT_THEME_MODE;
  const accent = theme?.accent === 'custom' ? 'custom' : theme?.accent;
  const presetAccent = ACCENT_OPTIONS.some(option => option.id === accent)
    ? accent
    : DEFAULT_ACCENT;
  const customAccent =
    normalizeHexColor(theme?.customAccent) || DEFAULT_CUSTOM_ACCENT;

  return {
    mode,
    adaptToAccent: theme?.adaptToAccent === true,
    accent: accent === 'custom' ? 'custom' : presetAccent,
    customAccent,
  };
};

export const createDefaultTheme = (): Theme =>
  normalizeTheme({ mode: DEFAULT_THEME_MODE });

/** The toggle walks light -> dark -> pure black -> light. */
export const THEME_MODE_CYCLE: readonly Theme['mode'][] = [
  'light',
  'dark',
  'amoled',
  'celestial',
];

export const getNextThemeMode = (mode: Theme['mode']): Theme['mode'] => {
  const index = THEME_MODE_CYCLE.indexOf(mode);
  return THEME_MODE_CYCLE[(index + 1) % THEME_MODE_CYCLE.length];
};

/**
 * The administrator's instance-wide default theme is cached locally so the
 * boot script in index.html can paint it before the first render, instead
 * of flashing the built-in dark theme until /auth/system-info answers.
 */
export const INSTANCE_THEME_STORAGE_KEY = 'libre-webui-instance-theme';

export const readCachedInstanceTheme = (): Theme | null => {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(INSTANCE_THEME_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Theme> | null;
    return parsed && typeof parsed === 'object' ? normalizeTheme(parsed) : null;
  } catch {
    return null;
  }
};

export const cacheInstanceTheme = (theme: Theme): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      INSTANCE_THEME_STORAGE_KEY,
      JSON.stringify(normalizeTheme(theme))
    );
  } catch {
    // Storage may be full or disabled; the theme still applies this session.
  }
};

/** The instance default when known, else the built-in default. */
export const createInstanceDefaultTheme = (): Theme =>
  readCachedInstanceTheme() ?? createDefaultTheme();

export const getAccentPalette = (theme?: Partial<Theme> | null) => {
  const normalizedTheme = normalizeTheme(theme);

  if (normalizedTheme.accent === 'custom') {
    return createCustomPalette(normalizedTheme.customAccent);
  }

  return ACCENT_PALETTES[normalizedTheme.accent || DEFAULT_ACCENT];
};

export const getThemeAccentColor = (theme?: Partial<Theme> | null) => {
  const normalizedTheme = normalizeTheme(theme);

  if (normalizedTheme.accent === 'custom') {
    return normalizedTheme.customAccent || DEFAULT_CUSTOM_ACCENT;
  }

  return (
    ACCENT_OPTIONS.find(option => option.id === normalizedTheme.accent)
      ?.color || DEFAULT_CUSTOM_ACCENT
  );
};

const getInterfaceSaturation = (
  accentSaturation: number,
  factor: number,
  profile: InterfaceSaturationProfile
) => {
  if (factor === 0 || accentSaturation < 8) {
    return accentSaturation * factor;
  }

  return clamp(
    accentSaturation * profile.multiplier * factor,
    profile.minimum * factor,
    profile.maximum * factor
  );
};

const createNeutralPalette = (
  hue: number,
  saturation: number,
  lightness: Record<NeutralShade, number>,
  profile: InterfaceSaturationProfile
): NeutralPalette =>
  NEUTRAL_SHADE_KEYS.reduce((palette, shade) => {
    palette[shade] = hslToHex(
      hue,
      getInterfaceSaturation(saturation, 1, profile),
      lightness[shade]
    );
    return palette;
  }, {} as NeutralPalette);

const createInterfaceRoles = (
  hue: number,
  saturation: number,
  definitions: Record<InterfaceRole, InterfaceRoleDefinition>,
  profile: InterfaceSaturationProfile
) =>
  INTERFACE_ROLE_KEYS.reduce(
    (roles, role) => {
      const definition = definitions[role];
      roles[role] = hslToHex(
        hue,
        getInterfaceSaturation(
          saturation,
          definition.saturationFactor,
          profile
        ),
        definition.lightness
      );
      return roles;
    },
    {} as Record<InterfaceRole, string>
  );

const setRgbVariable = (root: HTMLElement, variable: string, hex: string) => {
  const { r, g, b } = hexToRgb(hex);
  root.style.setProperty(variable, `${r} ${g} ${b}`);
};

const clearAdaptiveInterfaceVariables = (root: HTMLElement) => {
  for (const shade of NEUTRAL_SHADE_KEYS) {
    root.style.removeProperty(`--color-gray-${shade}`);
    root.style.removeProperty(`--color-dark-${shade}`);
  }

  for (const role of INTERFACE_ROLE_KEYS) {
    root.style.removeProperty(`--color-${role}`);
  }
};

const applyAdaptiveInterfaceVariables = (root: HTMLElement, theme: Theme) => {
  const accent = getThemeAccentColor(theme);
  const { r, g, b } = hexToRgb(accent);
  const { h, s } = rgbToHsl(r, g, b);
  const activeProfile =
    theme.mode === 'light'
      ? LIGHT_INTERFACE_SATURATION
      : DEFAULT_INTERFACE_SATURATION;
  const grayPalette = createNeutralPalette(
    h,
    s,
    LIGHT_NEUTRAL_LIGHTNESS,
    activeProfile
  );
  const darkPalette = createNeutralPalette(
    h,
    s,
    theme.mode === 'amoled' ? AMOLED_NEUTRAL_LIGHTNESS : DARK_NEUTRAL_LIGHTNESS,
    DEFAULT_INTERFACE_SATURATION
  );
  const roles = createInterfaceRoles(
    h,
    s,
    theme.mode === 'light'
      ? LIGHT_INTERFACE_ROLES
      : theme.mode === 'amoled'
        ? AMOLED_INTERFACE_ROLES
        : DARK_INTERFACE_ROLES,
    activeProfile
  );

  for (const shade of NEUTRAL_SHADE_KEYS) {
    setRgbVariable(root, `--color-gray-${shade}`, grayPalette[shade]);
    setRgbVariable(root, `--color-dark-${shade}`, darkPalette[shade]);
  }

  for (const role of INTERFACE_ROLE_KEYS) {
    setRgbVariable(root, `--color-${role}`, roles[role]);
  }
};

let celestialTimer: ReturnType<typeof setInterval> | null = null;
let lastAppliedMode: Theme['mode'] | null = null;
let sweepFrame: number | null = null;

/**
 * Choosing Celestial plays the last six hours into the present in a few
 * seconds, so the sky arrives with a sense of where the day has been.
 */
const sweepCelestialIntoNow = () => {
  if (typeof window === 'undefined') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  const now = new Date();
  const target = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const span = 6 * 60;
  const duration = 3200;
  const started = performance.now();
  if (sweepFrame) cancelAnimationFrame(sweepFrame);
  root.setAttribute('data-sweep', 'true');
  const step = (time: number) => {
    const t = Math.min(1, (time - started) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    useCelestialStore
      .getState()
      .setPreviewMinutes(
        (((target - span * (1 - eased)) % 1440) + 1440) % 1440
      );
    paintCelestial();
    if (t < 1) {
      sweepFrame = requestAnimationFrame(step);
    } else {
      sweepFrame = null;
      useCelestialStore.getState().setPreviewMinutes(null);
      paintCelestial();
      root.removeAttribute('data-sweep');
    }
  };
  sweepFrame = requestAnimationFrame(step);
};

const stopCelestialClock = () => {
  if (celestialTimer) {
    clearInterval(celestialTimer);
    celestialTimer = null;
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onCelestialVisibility);
  }
  useCelestialStore.getState().clear();
};

function onCelestialVisibility() {
  if (document.visibilityState === 'visible') paintCelestial();
}

/**
 * Paint the celestial palette for this moment (or the previewed minute).
 * The palette flips the `dark` class as the sun sets, so every dark:
 * utility follows; the CSS transitions on large surfaces make it glide.
 */
export const paintCelestial = () => {
  if (typeof document === 'undefined') return;
  const store = useCelestialStore.getState();
  void store.maybeRefreshWeather();
  store.refresh();
  const palette = useCelestialStore.getState().palette;
  if (!palette) return;
  const root = document.documentElement;
  root.classList.toggle('dark', palette.isDark);
  root.style.colorScheme = palette.isDark ? 'dark' : 'light';
  for (const role of CELESTIAL_ROLE_KEYS) {
    setRgbVariable(root, `--color-${role}`, palette.roles[role]);
  }
  for (const shade of CELESTIAL_SHADE_KEYS) {
    setRgbVariable(root, `--color-gray-${shade}`, palette.gray[shade]);
    setRgbVariable(root, `--color-dark-${shade}`, palette.dark[shade]);
  }
  root.style.setProperty('--celestial-sky-top', palette.sky.top);
  root.style.setProperty('--celestial-sky-mid', palette.sky.mid);
  root.style.setProperty('--celestial-sky-horizon', palette.sky.horizon);
  root.style.setProperty('--celestial-glow', palette.glow);
  root.style.setProperty('--celestial-night', String(palette.night));
};

const startCelestialClock = () => {
  if (typeof document === 'undefined') return;
  paintCelestial();
  if (!celestialTimer) {
    celestialTimer = setInterval(paintCelestial, CELESTIAL_TICK_MS);
    document.addEventListener('visibilitychange', onCelestialVisibility);
  }
};

/** Preview a minute of the day (null = follow the clock again). */
export const previewCelestialMinutes = (minutes: number | null) => {
  // A hand on the scrubber outranks the arrival sweep.
  if (sweepFrame && typeof document !== 'undefined') {
    cancelAnimationFrame(sweepFrame);
    sweepFrame = null;
    document.documentElement.removeAttribute('data-sweep');
  }
  useCelestialStore.getState().setPreviewMinutes(minutes);
  if (celestialTimer) paintCelestial();
};

export const applyThemeToDocument = (theme?: Partial<Theme> | null) => {
  if (typeof document === 'undefined') return;

  const normalizedTheme = normalizeTheme(theme);
  const root = document.documentElement;
  const palette = getAccentPalette(normalizedTheme);

  root.classList.remove('dark', 'amoled', 'ophelia', 'celestial');
  if (
    normalizedTheme.mode !== 'light' &&
    normalizedTheme.mode !== 'celestial'
  ) {
    root.classList.add('dark');
  }
  if (normalizedTheme.mode === 'amoled') {
    root.classList.add('amoled');
  }
  if (normalizedTheme.mode === 'celestial') {
    root.classList.add('celestial');
  }

  root.style.colorScheme = normalizedTheme.mode === 'light' ? 'light' : 'dark';
  root.dataset.accent = normalizedTheme.accent || DEFAULT_ACCENT;
  root.dataset.themeStyle = normalizedTheme.adaptToAccent
    ? 'accent'
    : 'default';

  for (const shade of SHADE_KEYS) {
    const { r, g, b } = hexToRgb(palette[shade]);
    const rgb = `${r} ${g} ${b}`;
    root.style.setProperty(`--color-primary-${shade}`, rgb);
    root.style.setProperty(`--color-accent-${shade}`, rgb);
  }

  const enteringCelestial =
    normalizedTheme.mode === 'celestial' &&
    lastAppliedMode !== null &&
    lastAppliedMode !== 'celestial';
  lastAppliedMode = normalizedTheme.mode;
  if (normalizedTheme.mode === 'celestial') {
    // The sky owns the neutrals; the accent still owns primary/accent.
    startCelestialClock();
    if (enteringCelestial) sweepCelestialIntoNow();
    return;
  }
  if (sweepFrame) {
    cancelAnimationFrame(sweepFrame);
    sweepFrame = null;
    root.removeAttribute('data-sweep');
  }
  stopCelestialClock();
  for (const name of [
    '--celestial-sky-top',
    '--celestial-sky-mid',
    '--celestial-sky-horizon',
    '--celestial-glow',
    '--celestial-night',
  ]) {
    root.style.removeProperty(name);
  }

  if (normalizedTheme.adaptToAccent) {
    applyAdaptiveInterfaceVariables(root, normalizedTheme);
  } else {
    clearAdaptiveInterfaceVariables(root);
  }
};
