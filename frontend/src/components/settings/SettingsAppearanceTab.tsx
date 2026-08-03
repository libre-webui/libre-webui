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

import { Check, Moon, Palette, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { BackgroundUpload } from '@/components/BackgroundUpload';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import type { Theme, UserPreferences } from '@/types';
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
}: SettingsAppearanceTabProps) {
  const { t } = useTranslation();
  const activeAccent = theme.accent || DEFAULT_ACCENT;
  const customAccentValue = theme.customAccent || DEFAULT_CUSTOM_ACCENT;
  const accentPreviewColor = getThemeAccentColor(theme);

  return (
    <div className='space-y-6'>
      <LanguageSwitcher />

      <div className='border-t border-gray-200 dark:border-dark-300 pt-6'>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.appearance.title')}
        </h3>
      </div>
      <div className='grid grid-cols-2 gap-3'>
        <button
          onClick={() => onThemeChange('light')}
          className={`flex items-center justify-center gap-2 h-12 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            theme.mode === 'light'
              ? 'bg-primary-600 text-white shadow-sm hover:bg-primary-700 hover:shadow-md focus:ring-primary-500'
              : 'border border-gray-300 text-gray-700 bg-white shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:ring-gray-500 dark:border-dark-300 dark:text-dark-700 dark:bg-dark-25 dark:hover:bg-dark-200 dark:hover:border-dark-400'
          }`}
        >
          <Sun className='h-4 w-4' />
          {t('settings.appearance.theme.light')}
        </button>
        <button
          onClick={() => onThemeChange('dark')}
          className={`flex items-center justify-center gap-2 h-12 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
            theme.mode === 'dark'
              ? 'bg-primary-600 text-white shadow-sm hover:bg-primary-700 hover:shadow-md focus:ring-primary-500'
              : 'border border-gray-300 text-gray-700 bg-white shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:ring-gray-500 dark:border-dark-300 dark:text-dark-700 dark:bg-dark-25 dark:hover:bg-dark-200 dark:hover:border-dark-400'
          }`}
        >
          <Moon className='h-4 w-4' />
          {t('settings.appearance.theme.dark')}
        </button>
      </div>

      <div className='border-t border-gray-200 dark:border-dark-300 pt-6'>
        <div className='flex items-center justify-between gap-4 mb-3'>
          <div>
            <h4 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
              {t('settings.appearance.accent.title', {
                defaultValue: 'Accent color',
              })}
            </h4>
          </div>
          <div
            className='h-9 w-9 rounded-full border border-gray-200 dark:border-dark-400 shadow-inner flex-shrink-0'
            style={{ backgroundColor: accentPreviewColor }}
            aria-hidden='true'
          />
        </div>

        <div className='grid grid-cols-5 xs:grid-cols-6 sm:grid-cols-9 gap-2'>
          {ACCENT_OPTIONS.map(option => {
            const isSelected = activeAccent === option.id;

            return (
              <button
                key={option.id}
                type='button'
                onClick={() => onAccentChange(option.id)}
                className={`relative h-10 rounded-xl border transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-dark-50 ${
                  isSelected
                    ? 'border-gray-900 dark:border-white shadow-md scale-105'
                    : 'border-gray-200 dark:border-dark-400 hover:scale-105 hover:shadow-sm'
                }`}
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
            className={`relative h-10 rounded-xl border transition-all duration-200 focus-within:outline-none focus-within:ring-2 focus-within:ring-primary-500 focus-within:ring-offset-2 dark:focus-within:ring-offset-dark-50 overflow-hidden cursor-pointer ${
              activeAccent === 'custom'
                ? 'border-gray-900 dark:border-white shadow-md scale-105'
                : 'border-gray-200 dark:border-dark-400 hover:scale-105 hover:shadow-sm'
            }`}
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

        <div className='mt-5 border-t border-gray-200 pt-5 dark:border-dark-300'>
          <h4 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            {t('settings.appearance.accent.behaviorTitle')}
          </h4>
          <p className='mt-1 text-xs leading-relaxed text-gray-500 dark:text-dark-500'>
            {t('settings.appearance.accent.behaviorDescription')}
          </p>

          <div className='mt-3 grid grid-cols-2 gap-3'>
            <button
              type='button'
              aria-pressed={!theme.adaptToAccent}
              onClick={() => onAdaptToAccentChange(false)}
              className={`rounded-xl border p-3 text-start transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-dark-50 ${
                !theme.adaptToAccent
                  ? 'border-primary-500 bg-primary-50/70 shadow-sm dark:border-primary-400 dark:bg-primary-950/25'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-dark-300 dark:bg-dark-100 dark:hover:border-dark-400 dark:hover:bg-dark-200'
              }`}
            >
              <span className='block text-sm font-medium text-gray-900 dark:text-dark-900'>
                {t('settings.appearance.accent.defaultStyle')}
              </span>
              <span className='mt-1 block text-xs leading-snug text-gray-500 dark:text-dark-500'>
                {t('settings.appearance.accent.defaultStyleDescription')}
              </span>
            </button>

            <button
              type='button'
              aria-pressed={theme.adaptToAccent === true}
              onClick={() => onAdaptToAccentChange(true)}
              className={`rounded-xl border p-3 text-start transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-dark-50 ${
                theme.adaptToAccent
                  ? 'border-primary-500 bg-primary-50/70 shadow-sm dark:border-primary-400 dark:bg-primary-950/25'
                  : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50 dark:border-dark-300 dark:bg-dark-100 dark:hover:border-dark-400 dark:hover:bg-dark-200'
              }`}
            >
              <span className='block text-sm font-medium text-gray-900 dark:text-dark-900'>
                {t('settings.appearance.accent.adaptedStyle')}
              </span>
              <span className='mt-1 block text-xs leading-snug text-gray-500 dark:text-dark-500'>
                {t('settings.appearance.accent.adaptedStyleDescription')}
              </span>
            </button>
          </div>
        </div>
      </div>

      <div>
        <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-3'>
          {t('settings.appearance.chatInterface.title')}
        </h4>
        <div className='space-y-3'>
          <div className='flex items-center justify-between'>
            <div className='flex flex-col'>
              <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                {t('settings.appearance.chatInterface.showUsername')}
              </span>
              <span className='text-xs text-gray-500 dark:text-gray-400'>
                {t('settings.appearance.chatInterface.showUsernameDescription')}
              </span>
            </div>
            <label className='relative inline-flex items-center cursor-pointer'>
              <input
                type='checkbox'
                className='sr-only peer'
                checked={preferences.showUsername}
                onChange={event => onShowUsernameChange(event.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600"></div>
            </label>
          </div>
          <div className='flex items-center justify-between'>
            <div className='flex flex-col'>
              <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                {t('settings.appearance.chatInterface.followUpSuggestions')}
              </span>
              <span className='text-xs text-gray-500 dark:text-gray-400'>
                {t(
                  'settings.appearance.chatInterface.followUpSuggestionsDescription'
                )}
              </span>
            </div>
            <label className='relative inline-flex items-center cursor-pointer'>
              <input
                type='checkbox'
                className='sr-only peer'
                checked={preferences.showFollowUpSuggestions !== false}
                onChange={event => onShowFollowUpsChange(event.target.checked)}
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600"></div>
            </label>
          </div>
        </div>
      </div>

      <BackgroundUpload />
    </div>
  );
}
