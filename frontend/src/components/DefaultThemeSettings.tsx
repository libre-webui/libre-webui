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

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Moon, MoonStar, Sun } from 'lucide-react';
import { Button } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import { preferencesApi } from '@/utils/api';
import { cn } from '@/utils';
import { normalizeTheme } from '@/utils/theme';
import type { Theme } from '@/types';

const MODES: Array<{ mode: Theme['mode']; icon: typeof Sun; key: string }> = [
  { mode: 'light', icon: Sun, key: 'settings.appearance.theme.light' },
  { mode: 'dark', icon: Moon, key: 'settings.appearance.theme.dark' },
  { mode: 'amoled', icon: MoonStar, key: 'settings.appearance.theme.amoled' },
];

/**
 * Administrator choice of the instance-wide default theme: the sign-in page,
 * new accounts, and browsers without a theme of their own follow it. The
 * administrator's own saved theme is untouched; that lives in Settings.
 */
export const DefaultThemeSettings: React.FC = () => {
  const { t } = useTranslation();
  const systemInfo = useAuthStore(state => state.systemInfo);
  const setSystemInfo = useAuthStore(state => state.setSystemInfo);
  const applyInstanceTheme = useAppStore(state => state.applyInstanceTheme);
  const [theme, setTheme] = useState<Theme | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    preferencesApi
      .getDefaultTheme()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setTheme(normalizeTheme(response.data.theme));
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const handleSelect = async (mode: Theme['mode']) => {
    if (!theme || theme.mode === mode) return;
    setSaving(true);
    try {
      const response = await preferencesApi.setDefaultTheme({
        ...theme,
        mode,
      });
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Default theme update failed.');
      }
      const saved = normalizeTheme(response.data.theme);
      setTheme(saved);
      if (systemInfo) {
        setSystemInfo({ ...systemInfo, defaultTheme: saved });
      }
      // Refresh the local cache so the next sign-in page paints it at once.
      applyInstanceTheme(saved);
      toast.success(t('userManager.defaultTheme.saved'));
    } catch {
      toast.error(t('userManager.defaultTheme.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div className='min-w-0 flex-1'>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.defaultTheme.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.defaultTheme.description')}
          </p>
        </div>
        {theme === null && loadFailed ? (
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              setLoadFailed(false);
              setLoadAttempt(attempt => attempt + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        ) : (
          <div
            role='radiogroup'
            aria-label={t('userManager.defaultTheme.title')}
            className='flex flex-wrap gap-2'
          >
            {MODES.map(({ mode, icon: Icon, key }) => {
              const selected = theme?.mode === mode;
              return (
                <button
                  key={mode}
                  type='button'
                  role='radio'
                  aria-checked={selected}
                  disabled={saving || theme === null}
                  onClick={() => void handleSelect(mode)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-ink transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:cursor-not-allowed disabled:opacity-60',
                    selected
                      ? 'border-line-strong bg-surface-subtle'
                      : 'border-line hover:bg-interactive-hover'
                  )}
                >
                  <Icon className='h-4 w-4' aria-hidden='true' />
                  {t(key)}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default DefaultThemeSettings;
