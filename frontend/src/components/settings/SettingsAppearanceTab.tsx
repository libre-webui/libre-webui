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

import type { ReactNode } from 'react';
import { Check, Moon, Palette, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BackgroundUpload } from '@/components/BackgroundUpload';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import type { Theme, UserPreferences } from '@/types';
import { cn } from '@/utils';
import {
  ACCENT_OPTIONS,
  DEFAULT_ACCENT,
  DEFAULT_CUSTOM_ACCENT,
  getThemeAccentColor,
} from '@/utils/theme';

interface SettingsAppearanceTabProps {
  theme: Theme;
  preferences: UserPreferences;
  onThemeChange: (mode: 'light' | 'dark') => void;
  onAccentChange: (accent: NonNullable<Theme['accent']>) => void;
  onCustomAccentChange: (customAccent: string) => void;
  onAdaptToAccentChange: (adaptToAccent: boolean) => void;
  onShowUsernameChange: (showUsername: boolean) => void;
  onShowFollowUpsChange: (showFollowUpSuggestions: boolean) => void;
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
  onHapticFeedbackChange,
}: SettingsAppearanceTabProps) {
  const { t } = useTranslation();
  const activeAccent = theme.accent || DEFAULT_ACCENT;
  const customAccentValue = theme.customAccent || DEFAULT_CUSTOM_ACCENT;
  const accentPreviewColor = getThemeAccentColor(theme);

  const themeCube = (
    mode: 'light' | 'dark',
    Icon: typeof Sun,
    label: string
  ) => {
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
        </div>
      </div>

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

        <div className='grid grid-cols-5 gap-2 xs:grid-cols-6 sm:grid-cols-9'>
          {ACCENT_OPTIONS.map(option => {
            const isSelected = activeAccent === option.id;

            return (
              <button
                key={option.id}
                type='button'
                onClick={() => onAccentChange(option.id)}
                className={cn(
                  'relative h-9 rounded-xl border transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40',
                  isSelected
                    ? 'border-ink'
                    : 'border-transparent hover:scale-105'
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
              'relative h-9 cursor-pointer overflow-hidden rounded-xl border transition-all duration-200 focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500/40',
              activeAccent === 'custom'
                ? 'border-ink'
                : 'border-transparent hover:scale-105'
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
