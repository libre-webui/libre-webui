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

import { useEffect, useId, useState, type ReactNode } from 'react';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { Check, Moon, MoonStar, Palette, Sun, Sunrise } from 'lucide-react';
import { useCelestialStore } from '@/store/celestialStore';
import { CelestialDayPreview } from '@/components/CelestialDayPreview';
import { useTranslation } from 'react-i18next';
import { BackgroundUpload } from '@/components/BackgroundUpload';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import type { Theme, UserPreferences } from '@/types';
import { cn } from '@/utils';
import { isValidLocation } from '@/utils/celestialWeather';
import {
  ACCENT_OPTIONS,
  DEFAULT_ACCENT,
  DEFAULT_CUSTOM_ACCENT,
  getThemeAccentColor,
  previewCelestialMinutes,
} from '@/utils/theme';

interface SettingsAppearanceTabProps {
  theme: Theme;
  preferences: UserPreferences;
  onThemeChange: (mode: Theme['mode']) => void;
  onAccentChange: (accent: NonNullable<Theme['accent']>) => void;
  onCustomAccentChange: (customAccent: string) => void;
  onAdaptToAccentChange: (adaptToAccent: boolean) => void;
  onShowUsernameChange: (showUsername: boolean) => void;
  onShowFollowUpsChange: (showFollowUpSuggestions: boolean) => void;
  onAutoOpenArtifactsChange: (autoOpenArtifactPanel: boolean) => void;
  onHapticFeedbackChange: (hapticFeedbackEnabled: boolean) => void;
}

/** Row shell: title + optional description left, control right, 16px rhythm. */
function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className='flex items-center gap-4 py-4'>
      <div className='min-w-0 flex-1'>
        <h4 className='text-sm leading-[22px] text-ink'>{title}</h4>
        {description && (
          <p className='mt-0.5 text-xs text-ink-subtle'>{description}</p>
        )}
      </div>
      {children && <div className='shrink-0'>{children}</div>}
    </div>
  );
}

/** Pill-track toggle switch. */
function ToggleSwitch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId?: string;
}) {
  return (
    <label className='relative inline-flex shrink-0 cursor-pointer items-center'>
      <input
        type='checkbox'
        data-testid={testId}
        aria-label={label}
        className='peer sr-only'
        checked={checked}
        onChange={event => onChange(event.target.checked)}
      />
      <div className="peer h-6 w-11 rounded-full bg-line-strong transition-colors peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500/40 peer-checked:bg-primary-500 after:absolute after:start-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow-sm after:transition-all after:content-[''] peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full"></div>
    </label>
  );
}

export function SettingsAppearanceTab({
  theme,
  preferences,
  onThemeChange,
  onAccentChange,
  onCustomAccentChange,
  onAdaptToAccentChange,
  onShowUsernameChange,
  onShowFollowUpsChange,
  onAutoOpenArtifactsChange,
  onHapticFeedbackChange,
}: SettingsAppearanceTabProps) {
  const { t } = useTranslation();
  const activeAccent = theme.accent || DEFAULT_ACCENT;
  const customAccentValue = theme.customAccent || DEFAULT_CUSTOM_ACCENT;
  const accentPreviewColor = getThemeAccentColor(theme);
  const celestialLocation = useCelestialStore(state => state.location);
  const weatherEnabled = useCelestialStore(state => state.weatherEnabled);
  const weather = useCelestialStore(state => state.weather);
  const weatherStatus = useCelestialStore(state => state.weatherStatus);
  const setLocation = useCelestialStore(state => state.setLocation);
  const requestBrowserLocation = useCelestialStore(
    state => state.requestBrowserLocation
  );
  const setWeatherEnabled = useCelestialStore(state => state.setWeatherEnabled);
  const [locating, setLocating] = useState(false);
  const [locationDenied, setLocationDenied] = useState(false);
  const [manualLatitude, setManualLatitude] = useState('');
  const [manualLongitude, setManualLongitude] = useState('');
  const coordinateId = useId();
  const handleUseBrowserLocation = async () => {
    setLocating(true);
    setLocationDenied(false);
    const ok = await requestBrowserLocation();
    setLocating(false);
    if (!ok) setLocationDenied(true);
  };
  const handleApplyManualLocation = () => {
    if (!manualLatitude.trim() || !manualLongitude.trim()) return;
    const latitude = Number(manualLatitude);
    const longitude = Number(manualLongitude);
    // The store treats invalid locations as a request to clear the saved one.
    // Keep invalid drafts here so only an explicit Clear removes a location.
    if (!isValidLocation({ latitude, longitude })) return;
    setLocation({ latitude, longitude });
    setLocationDenied(false);
    setManualLatitude('');
    setManualLongitude('');
  };
  const isCelestial = theme.mode === 'celestial';
  // A preview is for looking, not living: leaving the tab follows the clock.
  useEffect(() => () => previewCelestialMinutes(null), []);

  const themeCube = (mode: Theme['mode'], Icon: typeof Sun, label: string) => {
    const selected = theme.mode === mode;
    return (
      <button
        type='button'
        onClick={() => onThemeChange(mode)}
        aria-pressed={selected}
        className={cn(
          'flex flex-1 basis-[180px] flex-col items-center justify-center gap-1 rounded-2xl border px-8 py-5 text-sm leading-[22px] text-ink transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
          selected
            ? 'border-line-strong bg-surface-subtle'
            : 'border-line hover:bg-interactive-hover'
        )}
      >
        <Icon className='h-4 w-4' />
        {label}
      </button>
    );
  };

  return (
    <div className='divide-y divide-line'>
      <LanguageSwitcher />

      {/* Theme selector cubes. */}
      <div className='flex flex-col gap-2 py-4'>
        <h4 className='text-sm leading-[22px] text-ink'>
          {t('settings.appearance.title')}
        </h4>
        <div className='flex flex-wrap items-stretch gap-2'>
          {themeCube('light', Sun, t('settings.appearance.theme.light'))}
          {themeCube('dark', Moon, t('settings.appearance.theme.dark'))}
          {themeCube('amoled', MoonStar, t('settings.appearance.theme.amoled'))}
          {themeCube(
            'celestial',
            Sunrise,
            t('settings.appearance.theme.celestial')
          )}
        </div>
      </div>

      {/* Celestial: scrub through the day, or follow the clock. */}
      {isCelestial && (
        <div
          className='flex flex-col gap-3 py-4'
          data-testid='celestial-preview'
        >
          <CelestialDayPreview />

          {/* Location: opt-in, browser-only, so sunrise matches the real sky. */}
          <div
            className='mt-2 flex flex-col gap-2 rounded-xl border border-line p-3'
            data-testid='celestial-location'
          >
            <div className='flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2'>
              <div className='min-w-0 flex-1 basis-48'>
                <h5 className='text-sm leading-[22px] text-ink'>
                  {t('settings.appearance.celestial.location')}
                </h5>
                <p className='text-xs leading-5 text-ink-muted'>
                  {t('settings.appearance.celestial.locationHint')}
                </p>
              </div>
              <output
                dir={celestialLocation ? 'ltr' : 'auto'}
                aria-live='polite'
                className='max-w-full break-words rounded-lg bg-surface-subtle px-2 py-1 font-mono text-xs leading-5 text-ink-muted'
                data-testid='celestial-location-value'
              >
                {celestialLocation
                  ? `${celestialLocation.latitude.toFixed(2)}°, ${celestialLocation.longitude.toFixed(2)}°`
                  : t('settings.appearance.celestial.approximateDay')}
              </output>
            </div>
            <form
              className='mt-1 space-y-3'
              onSubmit={event => {
                event.preventDefault();
                handleApplyManualLocation();
              }}
            >
              <div className='grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2'>
                <div className='min-w-0 space-y-1.5'>
                  <label
                    htmlFor={`${coordinateId}-latitude`}
                    className='block text-xs font-medium text-ink-muted'
                  >
                    {t('settings.appearance.celestial.latitude')}
                  </label>
                  <input
                    id={`${coordinateId}-latitude`}
                    type='number'
                    step='any'
                    required
                    min={-90}
                    max={90}
                    dir='ltr'
                    value={manualLatitude}
                    onChange={event => setManualLatitude(event.target.value)}
                    className='w-full min-w-0 rounded-lg border border-line bg-surface-subtle px-3 py-2 text-[16px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 md:text-sm'
                    data-testid='celestial-latitude'
                  />
                </div>
                <div className='min-w-0 space-y-1.5'>
                  <label
                    htmlFor={`${coordinateId}-longitude`}
                    className='block text-xs font-medium text-ink-muted'
                  >
                    {t('settings.appearance.celestial.longitude')}
                  </label>
                  <input
                    id={`${coordinateId}-longitude`}
                    type='number'
                    step='any'
                    required
                    min={-180}
                    max={180}
                    dir='ltr'
                    value={manualLongitude}
                    onChange={event => setManualLongitude(event.target.value)}
                    className='w-full min-w-0 rounded-lg border border-line bg-surface-subtle px-3 py-2 text-[16px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 md:text-sm'
                    data-testid='celestial-longitude'
                  />
                </div>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <button
                  type='submit'
                  className='rounded-lg border border-line bg-surface-raised px-3 py-2 text-xs font-medium text-ink transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
                  data-testid='celestial-apply-location'
                >
                  {t('settings.appearance.celestial.apply')}
                </button>
                <button
                  type='button'
                  onClick={() => void handleUseBrowserLocation()}
                  disabled={locating}
                  className='rounded-lg border border-line px-3 py-2 text-xs text-ink transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:opacity-60'
                  data-testid='celestial-use-location'
                >
                  {t('settings.appearance.celestial.useMyLocation')}
                </button>
                {celestialLocation && (
                  <button
                    type='button'
                    onClick={() => setLocation(null)}
                    className='rounded-lg px-3 py-2 text-xs text-ink-muted transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
                    data-testid='celestial-clear-location'
                  >
                    {t('settings.appearance.celestial.clear')}
                  </button>
                )}
              </div>
            </form>
            {locationDenied && (
              <p className='text-xs text-amber-600 dark:text-amber-400'>
                {t('settings.appearance.celestial.locationDenied')}
              </p>
            )}
          </div>

          {/* Weather: opt-in fetch from Open-Meteo with the rounded location. */}
          <div className='flex items-center justify-between gap-4 py-1'>
            <div className='min-w-0'>
              <h5 className='text-sm leading-[22px] text-ink'>
                {t('settings.appearance.celestial.weather')}
              </h5>
              <p className='text-xs leading-5 text-ink-muted'>
                {t('settings.appearance.celestial.weatherHint')}
              </p>
              {weatherEnabled && celestialLocation && (
                <p
                  className='mt-1 text-xs text-ink-subtle'
                  data-testid='celestial-weather-status'
                >
                  {weatherStatus === 'loading' && !weather
                    ? t('settings.appearance.celestial.weatherLoading')
                    : weatherStatus === 'error' && !weather
                      ? t('settings.appearance.celestial.weatherUnavailable')
                      : weather
                        ? `${t(`settings.appearance.celestial.kinds.${weather.kind}`)} · ${t('settings.appearance.celestial.wind', { speed: Math.round(weather.windSpeed) })}`
                        : ''}
                </p>
              )}
            </div>
            <div data-testid='celestial-weather-toggle'>
              <SettingsToggle
                checked={weatherEnabled}
                onChange={setWeatherEnabled}
                disabled={!celestialLocation}
              />
            </div>
          </div>
        </div>
      )}

      {/* Accent color. */}
      <div className='flex flex-col gap-3 py-4'>
        <div className='flex items-center justify-between gap-4'>
          <h4 className='text-sm leading-[22px] text-ink'>
            {t('settings.appearance.accent.title', {
              defaultValue: 'Accent color',
            })}
          </h4>
          <div
            className='h-6 w-6 flex-shrink-0 rounded-full border border-line'
            style={{ backgroundColor: accentPreviewColor }}
            aria-hidden='true'
          />
        </div>

        <div className='flex flex-wrap items-center gap-2.5'>
          {ACCENT_OPTIONS.map(option => {
            const isSelected = activeAccent === option.id;

            return (
              <button
                key={option.id}
                type='button'
                onClick={() => onAccentChange(option.id)}
                className={cn(
                  'relative h-9 w-9 rounded-full transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  isSelected
                    ? 'scale-105 ring-2 ring-ink ring-offset-2 ring-offset-surface'
                    : 'hover:scale-110'
                )}
                style={{ backgroundColor: option.color }}
                aria-label={t('settings.appearance.accent.useColor', {
                  defaultValue: `Use ${option.label} accent`,
                  color: option.label,
                })}
                title={option.label}
              >
                {isSelected && (
                  <Check
                    className='absolute inset-0 m-auto h-4 w-4 drop-shadow'
                    style={{ color: option.foreground }}
                  />
                )}
              </button>
            );
          })}

          <label
            className={cn(
              'relative h-9 w-9 cursor-pointer overflow-hidden rounded-full transition-all duration-200 focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500/40',
              activeAccent === 'custom'
                ? 'scale-105 ring-2 ring-ink ring-offset-2 ring-offset-surface'
                : 'hover:scale-110'
            )}
            title={t('settings.appearance.accent.custom', {
              defaultValue: 'Custom color',
            })}
            aria-label={t('settings.appearance.accent.custom', {
              defaultValue: 'Custom color',
            })}
          >
            <input
              type='color'
              value={customAccentValue}
              onInput={event => onCustomAccentChange(event.currentTarget.value)}
              onChange={event => onCustomAccentChange(event.target.value)}
              className='absolute inset-0 h-full w-full cursor-pointer opacity-0'
            />
            <span
              className='absolute inset-0'
              style={{ backgroundColor: customAccentValue }}
              aria-hidden='true'
            />
            <Palette className='absolute inset-0 m-auto h-4 w-4 text-white drop-shadow' />
          </label>
        </div>

        {/* Celestial paints the whole palette from the sky, so there is no
            neutral-or-tinted choice to make. */}
        {!isCelestial && (
          <div>
            <h4 className='text-sm leading-[22px] text-ink'>
              {t('settings.appearance.accent.behaviorTitle')}
            </h4>
            <p className='mt-0.5 text-xs text-ink-subtle'>
              {t('settings.appearance.accent.behaviorDescription')}
            </p>

            <div className='mt-3 flex flex-wrap items-stretch gap-2'>
              <button
                type='button'
                aria-pressed={!theme.adaptToAccent}
                onClick={() => onAdaptToAccentChange(false)}
                className={cn(
                  'flex-1 basis-[180px] rounded-2xl border p-4 text-start transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  !theme.adaptToAccent
                    ? 'border-line-strong bg-surface-subtle'
                    : 'border-line hover:bg-interactive-hover'
                )}
              >
                <span className='block text-sm leading-[22px] text-ink'>
                  {t('settings.appearance.accent.defaultStyle')}
                </span>
                <span className='mt-1 block text-xs leading-snug text-ink-subtle'>
                  {t('settings.appearance.accent.defaultStyleDescription')}
                </span>
              </button>

              <button
                type='button'
                aria-pressed={theme.adaptToAccent === true}
                onClick={() => onAdaptToAccentChange(true)}
                className={cn(
                  'flex-1 basis-[180px] rounded-2xl border p-4 text-start transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  theme.adaptToAccent
                    ? 'border-line-strong bg-surface-subtle'
                    : 'border-line hover:bg-interactive-hover'
                )}
              >
                <span className='block text-sm leading-[22px] text-ink'>
                  {t('settings.appearance.accent.adaptedStyle')}
                </span>
                <span className='mt-1 block text-xs leading-snug text-ink-subtle'>
                  {t('settings.appearance.accent.adaptedStyleDescription')}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Chat interface toggles. */}
      <SettingRow
        title={t('settings.appearance.chatInterface.showUsername')}
        description={t(
          'settings.appearance.chatInterface.showUsernameDescription'
        )}
      >
        <ToggleSwitch
          checked={preferences.showUsername}
          onChange={onShowUsernameChange}
          label={t('settings.appearance.chatInterface.showUsername')}
        />
      </SettingRow>

      <SettingRow
        title={t('settings.appearance.chatInterface.followUpSuggestions')}
        description={t(
          'settings.appearance.chatInterface.followUpSuggestionsDescription'
        )}
      >
        <ToggleSwitch
          checked={preferences.showFollowUpSuggestions !== false}
          onChange={onShowFollowUpsChange}
          label={t('settings.appearance.chatInterface.followUpSuggestions')}
        />
      </SettingRow>

      <SettingRow
        title={t('settings.appearance.chatInterface.autoOpenArtifacts')}
        description={t(
          'settings.appearance.chatInterface.autoOpenArtifactsDescription'
        )}
      >
        <ToggleSwitch
          checked={preferences.autoOpenArtifactPanel !== false}
          onChange={onAutoOpenArtifactsChange}
          label={t('settings.appearance.chatInterface.autoOpenArtifacts')}
          testId='auto-open-artifacts-toggle'
        />
      </SettingRow>

      <SettingRow
        title={t('settings.appearance.chatInterface.hapticFeedback', {
          defaultValue: 'Haptic feedback (Android)',
        })}
        description={t(
          'settings.appearance.chatInterface.hapticFeedbackDescription',
          {
            defaultValue: 'Use subtle vibration for important mobile actions',
          }
        )}
      >
        <ToggleSwitch
          checked={preferences.hapticFeedbackEnabled === true}
          onChange={onHapticFeedbackChange}
          label={t('settings.appearance.chatInterface.hapticFeedback', {
            defaultValue: 'Haptic feedback (Android)',
          })}
          testId='haptic-feedback-toggle'
        />
      </SettingRow>

      <div className='py-4'>
        <BackgroundUpload />
      </div>
    </div>
  );
}
