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

import React from 'react';
import { Sun, Moon, MoonStar, Sunrise } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/appStore';
import { Button } from '@/components/ui';
import { isMac } from '@/utils';
import { getNextThemeMode } from '@/utils/theme';

const ICON_CLASS =
  'h-4 w-4 text-ink-muted transition-colors duration-150 group-hover:text-ink motion-reduce:transition-none';

/** The icon shows where the next click goes: light -> dark -> pure black -> celestial. */
const NEXT_MODE_ICON = {
  light: Sun,
  dark: Moon,
  amoled: MoonStar,
  celestial: Sunrise,
} as const;

const NEXT_MODE_LABEL_KEY = {
  light: 'themeToggle.switchToLight',
  dark: 'themeToggle.switchToDark',
  amoled: 'themeToggle.switchToAmoled',
  celestial: 'themeToggle.switchToCelestial',
} as const;

export const ThemeToggle: React.FC = () => {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useAppStore();

  const nextMode = getNextThemeMode(theme.mode);
  const Icon = NEXT_MODE_ICON[nextMode];
  const label = t(NEXT_MODE_LABEL_KEY[nextMode]);
  const shortcut = isMac() ? '⌘D' : 'Ctrl+D';

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={toggleTheme}
      className='h-9 w-9 rounded-full p-0'
      aria-label={label}
      title={`${label} (${shortcut})`}
    >
      <Icon className={ICON_CLASS} strokeWidth={1.75} aria-hidden='true' />
    </Button>
  );
};
