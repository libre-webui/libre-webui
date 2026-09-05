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

import { useMemo, type CSSProperties } from 'react';
import { Clock3, Moon, Sun, Sunrise, Sunset } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCelestialStore } from '@/store/celestialStore';
import { formatClock, getCelestialPalette } from '@/utils/celestial';
import { previewCelestialMinutes } from '@/utils/theme';

const wrapMinutes = (minutes: number) =>
  ((Math.round(minutes) % 1440) + 1440) % 1440;

export const CelestialDayPreview = () => {
  const { t } = useTranslation();
  const palette = useCelestialStore(state => state.palette);
  const previewMinutes = useCelestialStore(state => state.previewMinutes);
  const location = useCelestialStore(state => state.location);
  const weather = useCelestialStore(state => state.weather);
  const weatherEnabled = useCelestialStore(state => state.weatherEnabled);
  const dayStamp = new Date().setHours(0, 0, 0, 0);
  const matchedWeather = weatherEnabled && location ? weather : null;
  const dayGradient = useMemo(() => {
    const date = new Date(dayStamp);
    const stops = Array.from({ length: 17 }, (_, index) => {
      const minutes = Math.min((index * 1440) / 16, 1439);
      const sample = getCelestialPalette(date, minutes, {
        location,
        weather: matchedWeather,
      });
      return `${sample.sky.mid} ${(index * 100) / 16}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [dayStamp, location, matchedWeather]);

  if (!palette) return null;

  const minutes = wrapMinutes(previewMinutes ?? palette.solar.minutes);
  const clock = formatClock(minutes);
  const Orb = palette.solar.isDay ? Sun : Moon;
  const shortcuts = [
    { key: 'sunrise', minutes: palette.solar.sunrise, Icon: Sunrise },
    { key: 'sunset', minutes: palette.solar.sunset, Icon: Sunset },
  ] as const;

  return (
    <div
      className='celestial-day-preview flex min-w-0 flex-col gap-3'
      style={
        {
          '--celestial-day-gradient': dayGradient,
          '--celestial-preview-sky': `linear-gradient(${palette.sky.top}, ${palette.sky.mid} 65%, ${palette.sky.horizon})`,
          '--celestial-preview-glow': palette.glow,
        } as CSSProperties
      }
    >
      <div className='flex items-center justify-between gap-3'>
        <h4 className='text-sm text-ink'>
          {t('settings.appearance.celestial.title')}
        </h4>
        <span
          className='shrink-0 text-xl font-medium tabular-nums tracking-tight text-ink'
          data-testid='celestial-preview-clock'
        >
          {clock}
        </span>
      </div>
      <p className='text-xs leading-5 text-ink-muted'>
        {t('settings.appearance.celestial.description')}
      </p>
      <div
        className='celestial-day-preview__scene'
        aria-hidden='true'
        dir='ltr'
      >
        <div className='celestial-day-preview__horizon' />
        <div
          className='celestial-day-preview__orb'
          data-day={palette.solar.isDay}
          style={{
            left: `clamp(22px, ${(minutes / 1439) * 100}%, calc(100% - 22px))`,
            bottom: `${20 + Math.abs(palette.solar.altitude) * 45}%`,
          }}
        >
          <Orb className='h-5 w-5' strokeWidth={1.5} />
        </div>
      </div>
      <input
        type='range'
        min={0}
        max={1439}
        step={1}
        value={minutes}
        onChange={event => previewCelestialMinutes(Number(event.target.value))}
        aria-label={t('settings.appearance.celestial.title')}
        aria-valuetext={clock}
        data-testid='celestial-scrubber'
        className='celestial-day-preview__range w-full rounded-full outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-surface'
        dir='ltr'
      />
      <div className='grid grid-cols-2 gap-2'>
        {shortcuts.map(({ key, minutes: eventMinutes, Icon }) => (
          <button
            key={key}
            type='button'
            onClick={() => previewCelestialMinutes(wrapMinutes(eventMinutes))}
            data-testid={`celestial-preview-${key}`}
            className='flex min-w-0 items-center gap-2 rounded-xl border border-line px-3 py-2 text-start text-ink hover:bg-interactive-hover outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60'
          >
            <Icon className='h-4 w-4 shrink-0' aria-hidden='true' />
            <span className='min-w-0'>
              <span className='block truncate text-[11px] text-ink-muted'>
                {t(`settings.appearance.celestial.${key}`)}
              </span>
              <span className='block text-xs tabular-nums'>
                {formatClock(eventMinutes)}
              </span>
            </span>
          </button>
        ))}
      </div>
      <button
        type='button'
        onClick={() => previewCelestialMinutes(null)}
        disabled={previewMinutes === null}
        data-testid='celestial-follow-clock'
        className='flex items-center justify-center gap-2 rounded-xl border border-line px-3 py-2 text-xs text-ink hover:bg-interactive-hover disabled:cursor-default disabled:opacity-60 outline-none focus-visible:ring-2 focus-visible:ring-primary-500/60'
      >
        <Clock3 className='h-3.5 w-3.5' aria-hidden='true' />
        {t('settings.appearance.celestial.followClock')}
      </button>
    </div>
  );
};
