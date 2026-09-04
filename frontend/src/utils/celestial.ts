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

/**
 * The celestial theme: a palette and a sky that follow the real clock.
 *
 * Everything here is a pure function of a moment in time. The sun's
 * altitude drives the colours, so the day is not a fixed schedule: sunrise
 * and sunset move with the date (a mid-latitude day length, DST-aware), so
 * a December afternoon already leans golden while a June one is still full
 * daylight. Consumers re-evaluate every few seconds and let CSS transitions
 * carry the change, which is what makes it feel continuous rather than a
 * theme swap on the hour.
 */

export const CELESTIAL_LATITUDE = 45;
export const CELESTIAL_TICK_MS = 15_000;
export const MINUTES_PER_DAY = 1440;

type Hsl = { h: number; s: number; l: number };

const clamp = (v: number, min: number, max: number) =>
  Math.min(Math.max(v, min), max);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpHue = (a: number, b: number, t: number) => {
  let delta = ((b - a + 540) % 360) - 180;
  if (delta < -180) delta += 360;
  return (a + delta * t + 360) % 360;
};
const mixHsl = (a: Hsl, b: Hsl, t: number): Hsl => ({
  h: lerpHue(a.h, b.h, t),
  s: lerp(a.s, b.s, t),
  l: lerp(a.l, b.l, t),
});
const hsl = (h: number, s: number, l: number): Hsl => ({ h, s, l });

export const hslToHex = ({ h, s, l }: Hsl): string => {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  const chroma = (1 - Math.abs(2 * light - 1)) * sat;
  const hue = ((h % 360) + 360) % 360;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - chroma / 2;
  const [r, g, b] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return `#${[r, g, b]
    .map(c =>
      clamp(Math.round((c + m) * 255), 0, 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
};

export const hslToRgbTriplet = (color: Hsl): string => {
  const hex = hslToHex(color);
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** Minutes since local midnight, fractional. */
export const minutesOfDay = (date: Date): number =>
  date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;

export const formatClock = (minutes: number, hour12 = true): string => {
  const total =
    ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const h24 = Math.floor(total / 60);
  const m = total % 60;
  const mm = String(m).padStart(2, '0');
  if (!hour12) return `${String(h24).padStart(2, '0')}:${mm}`;
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${mm}${h24 < 12 ? 'am' : 'pm'}`;
};

export interface SolarState {
  /** Minutes since local midnight. */
  minutes: number;
  sunrise: number;
  sunset: number;
  solarNoon: number;
  /** -1 (deepest night) .. 1 (solar noon); 0 at the horizon. */
  altitude: number;
  isDay: boolean;
  /** 0..1 through the current day (isDay) or night span. */
  progress: number;
  /** True before solar noon: mornings are cool, evenings are warm. */
  morning: boolean;
  /** 0..1 lunar cycle, 0 = new moon, 0.5 = full. */
  moonPhase: number;
}

const dayOfYear = (date: Date): number => {
  const start = new Date(date.getFullYear(), 0, 0);
  return Math.floor((date.getTime() - start.getTime()) / 86_400_000);
};

const isDaylightSaving = (date: Date): boolean => {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
};

export function getSolarState(
  date: Date,
  latitude: number = CELESTIAL_LATITUDE,
  minutesOverride?: number
): SolarState {
  const rad = Math.PI / 180;
  const declination =
    23.44 * Math.sin(rad * ((360 / 365) * (284 + dayOfYear(date))));
  const cosHourAngle = clamp(
    -Math.tan(rad * latitude) * Math.tan(rad * declination),
    -1,
    1
  );
  const dayLength = ((2 * Math.acos(cosHourAngle)) / rad / 15) * 60; // minutes
  const solarNoon = (isDaylightSaving(date) ? 13 : 12) * 60;
  const sunrise = solarNoon - dayLength / 2;
  const sunset = solarNoon + dayLength / 2;
  const minutes =
    minutesOverride === undefined
      ? minutesOfDay(date)
      : ((minutesOverride % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
        MINUTES_PER_DAY;
  const isDay = minutes >= sunrise && minutes <= sunset;
  let altitude: number;
  let progress: number;
  if (isDay) {
    progress = (minutes - sunrise) / dayLength;
    altitude = Math.sin(Math.PI * progress);
  } else {
    const nightLength = MINUTES_PER_DAY - dayLength;
    const sinceSunset =
      minutes > sunset
        ? minutes - sunset
        : minutes + (MINUTES_PER_DAY - sunset);
    progress = sinceSunset / nightLength;
    altitude = -Math.sin(Math.PI * progress);
  }
  const synodic = 29.530588853;
  const daysSinceNewMoon =
    (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000;
  const moonPhase =
    (((daysSinceNewMoon % synodic) + synodic) % synodic) / synodic;
  return {
    minutes,
    sunrise,
    sunset,
    solarNoon,
    altitude,
    isDay,
    progress,
    morning: minutes < solarNoon,
    moonPhase,
  };
}

type SkyStop = { at: number; top: Hsl; mid: Hsl; horizon: Hsl };

// Keyframes on the altitude axis. Two sets: mornings lean cool and minty,
// evenings lean rose and amber. Deep night and full day are shared.
const MORNING_SKY: SkyStop[] = [
  {
    at: -1,
    top: hsl(228, 46, 8),
    mid: hsl(224, 40, 13),
    horizon: hsl(214, 34, 19),
  },
  {
    at: -0.35,
    top: hsl(229, 44, 11),
    mid: hsl(225, 40, 16),
    horizon: hsl(216, 32, 23),
  },
  {
    at: -0.12,
    top: hsl(228, 44, 16),
    mid: hsl(222, 40, 26),
    horizon: hsl(212, 44, 36),
  },
  {
    at: 0,
    top: hsl(220, 42, 34),
    mid: hsl(24, 62, 62),
    horizon: hsl(42, 88, 70),
  },
  {
    at: 0.22,
    top: hsl(206, 58, 62),
    mid: hsl(196, 54, 74),
    horizon: hsl(46, 70, 82),
  },
  {
    at: 0.6,
    top: hsl(206, 70, 58),
    mid: hsl(194, 58, 75),
    horizon: hsl(178, 40, 85),
  },
  {
    at: 1,
    top: hsl(208, 74, 55),
    mid: hsl(196, 60, 72),
    horizon: hsl(168, 36, 87),
  },
];
const EVENING_SKY: SkyStop[] = [
  {
    at: -1,
    top: hsl(228, 46, 8),
    mid: hsl(224, 40, 13),
    horizon: hsl(214, 34, 19),
  },
  {
    at: -0.35,
    top: hsl(232, 44, 11),
    mid: hsl(236, 38, 16),
    horizon: hsl(252, 30, 23),
  },
  {
    at: -0.12,
    top: hsl(234, 44, 15),
    mid: hsl(258, 40, 26),
    horizon: hsl(300, 34, 34),
  },
  {
    at: 0,
    top: hsl(226, 40, 30),
    mid: hsl(340, 58, 56),
    horizon: hsl(26, 92, 60),
  },
  {
    at: 0.22,
    top: hsl(210, 56, 60),
    mid: hsl(24, 60, 74),
    horizon: hsl(38, 84, 78),
  },
  {
    at: 0.6,
    top: hsl(206, 68, 58),
    mid: hsl(198, 56, 75),
    horizon: hsl(184, 38, 85),
  },
  {
    at: 1,
    top: hsl(208, 74, 55),
    mid: hsl(196, 60, 72),
    horizon: hsl(168, 36, 87),
  },
];

const sampleSky = (stops: SkyStop[], altitude: number) => {
  const a = clamp(altitude, -1, 1);
  let i = 0;
  while (i < stops.length - 2 && a > stops[i + 1].at) i += 1;
  const from = stops[i];
  const to = stops[i + 1];
  const t = clamp((a - from.at) / (to.at - from.at), 0, 1);
  return {
    top: mixHsl(from.top, to.top, t),
    mid: mixHsl(from.mid, to.mid, t),
    horizon: mixHsl(from.horizon, to.horizon, t),
  };
};

/** Interface roles the rest of the theme system already consumes. */
export const CELESTIAL_ROLE_KEYS = [
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
export type CelestialRole = (typeof CELESTIAL_ROLE_KEYS)[number];

const LIGHT_ROLES: Record<CelestialRole, [lightness: number, sat: number]> = {
  canvas: [96, 1],
  sidebar: [94, 1],
  surface: [98, 0.9],
  'surface-subtle': [93, 1],
  'surface-raised': [99, 0.8],
  'surface-overlay': [100, 0],
  'surface-inverse': [10, 0.7],
  ink: [12, 0.45],
  'ink-muted': [38, 0.35],
  'ink-subtle': [54, 0.4],
  'ink-inverse': [98, 0.4],
  line: [86, 0.8],
  'line-strong': [75, 0.65],
};
const DARK_ROLES: Record<CelestialRole, [lightness: number, sat: number]> = {
  canvas: [7, 0.9],
  sidebar: [9, 1],
  surface: [9, 0.9],
  'surface-subtle': [12, 1],
  'surface-raised': [15, 1],
  'surface-overlay': [18, 1],
  'surface-inverse': [96, 0.35],
  ink: [95, 0.3],
  'ink-muted': [68, 0.35],
  'ink-subtle': [50, 0.4],
  'ink-inverse': [8, 0.45],
  line: [20, 0.8],
  'line-strong': [30, 0.65],
};
export const CELESTIAL_SHADE_KEYS = [
  '25',
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
type Shade = (typeof CELESTIAL_SHADE_KEYS)[number];
const LIGHT_SHADES: Record<Shade, number> = {
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
const DARK_SHADES: Record<Shade, number> = {
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

export interface CelestialPalette {
  solar: SolarState;
  /** Below the horizon (with a little grace): the interface goes dark. */
  isDark: boolean;
  sky: { top: string; mid: string; horizon: string };
  /** Accent-ish tint of the moment (sky mid), for glows and selections. */
  glow: string;
  roles: Record<CelestialRole, string>;
  gray: Record<Shade, string>;
  dark: Record<Shade, string>;
  /** 0..1 how much the night sky shows (stars, moon, cursor lamp). */
  night: number;
  /** 0..1 warmth of the horizon (golden hour), for cloud tint. */
  golden: number;
}

export function getCelestialPalette(
  date: Date,
  minutesOverride?: number
): CelestialPalette {
  const solar = getSolarState(date, CELESTIAL_LATITUDE, minutesOverride);
  const stops = solar.morning ? MORNING_SKY : EVENING_SKY;
  const sky = sampleSky(stops, solar.altitude);
  const isDark = solar.altitude < -0.05;
  const night = clamp(-solar.altitude / 0.35, 0, 1);
  const golden = clamp(1 - Math.abs(solar.altitude - 0.08) / 0.3, 0, 1);

  // Interface tint follows the sky, quietly: the hue of the mid sky, with a
  // saturation that grows toward dusk and dawn and fades at noon/deep night.
  const tintHue = sky.mid.h;
  const tintSat = isDark ? 10 + 8 * (1 - night) : 8 + 10 * golden;
  const roleTable = isDark ? DARK_ROLES : LIGHT_ROLES;
  // Daylight surfaces dim a touch toward the horizon; night deepens later.
  const lightnessShift = isDark
    ? -3 * night
    : -3 * clamp(1 - solar.altitude, 0, 1);
  const roles = {} as Record<CelestialRole, string>;
  for (const role of CELESTIAL_ROLE_KEYS) {
    const [l, satFactor] = roleTable[role];
    const shifted =
      role.startsWith('ink') || role === 'surface-inverse'
        ? l
        : clamp(l + lightnessShift, 0, 100);
    roles[role] = hslToHex(hsl(tintHue, tintSat * satFactor, shifted));
  }
  const gray = {} as Record<Shade, string>;
  const dark = {} as Record<Shade, string>;
  for (const shade of CELESTIAL_SHADE_KEYS) {
    gray[shade] = hslToHex(hsl(tintHue, tintSat * 0.8, LIGHT_SHADES[shade]));
    dark[shade] = hslToHex(
      hsl(
        tintHue,
        tintSat * 0.8,
        clamp(DARK_SHADES[shade] + lightnessShift / 2, 0, 100)
      )
    );
  }
  return {
    solar,
    isDark,
    sky: {
      top: hslToHex(sky.top),
      mid: hslToHex(sky.mid),
      horizon: hslToHex(sky.horizon),
    },
    glow: hslToHex(
      hsl(sky.mid.h, clamp(sky.mid.s + 10, 0, 100), isDark ? 62 : 70)
    ),
    roles,
    gray,
    dark,
    night,
    golden,
  };
}

export interface CelestialScene {
  /** Sun position in percent of the sky box; hidden when below the horizon. */
  sun: { x: number; y: number; visible: boolean; warmth: number };
  moon: { x: number; y: number; visible: boolean; phase: number };
  stars: number;
  cloudTint: string;
  cloudOpacity: number;
  haze: number;
}

export function getCelestialScene(palette: CelestialPalette): CelestialScene {
  const { solar, night, golden } = palette;
  const arc = (progress: number, altitude: number) => ({
    x: 8 + 84 * clamp(progress, 0, 1),
    y: 74 - 62 * clamp(Math.abs(altitude), 0, 1),
  });
  const sun = solar.isDay
    ? { ...arc(solar.progress, solar.altitude), visible: true, warmth: golden }
    : { x: 50, y: 100, visible: false, warmth: 0 };
  const moon = solar.isDay
    ? { x: 50, y: 100, visible: false, phase: solar.moonPhase }
    : {
        ...arc(solar.progress, solar.altitude),
        visible: true,
        phase: solar.moonPhase,
      };
  return {
    sun,
    moon,
    stars: night,
    cloudTint: palette.sky.horizon,
    cloudOpacity: solar.isDay ? 0.55 + 0.25 * golden : 0.18,
    haze: clamp(1 - Math.abs(solar.altitude), 0, 1),
  };
}
