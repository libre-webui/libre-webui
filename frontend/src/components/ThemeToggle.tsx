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
import { Sun, Moon, MoonStar } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { Button } from '@/components/ui';
import { getNextThemeMode } from '@/utils/theme';

const ICON_CLASS =
  'h-4 w-4 text-ink-muted transition-colors duration-150 group-hover:text-ink motion-reduce:transition-none';

/** The icon shows where the next click goes: light -> dark -> pure black. */
const NEXT_MODE_ICON = {
  light: Sun,
  dark: Moon,
  amoled: MoonStar,
} as const;

const NEXT_MODE_LABEL = {
  light: 'light',
  dark: 'dark',
  amoled: 'pure black',
} as const;

export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useAppStore();

  const nextMode = getNextThemeMode(theme.mode);
  const Icon = NEXT_MODE_ICON[nextMode];
  const label = `Switch to ${NEXT_MODE_LABEL[nextMode]} mode`;

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={toggleTheme}
      className='h-9 w-9 rounded-full p-0'
      aria-label={label}
      title={`${label} (⌘D)`}
    >
      <Icon className={ICON_CLASS} strokeWidth={1.75} aria-hidden='true' />
    </Button>
  );
};
