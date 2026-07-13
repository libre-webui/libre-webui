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
import { Sun, Moon } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { Button } from '@/components/ui';

export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useAppStore();

  const nextTheme = theme.mode === 'light' ? 'dark' : 'light';

  const icon =
    theme.mode === 'light' ? (
      <Moon
        className='h-4 w-4 text-ink-muted transition-colors duration-150 group-hover:text-ink motion-reduce:transition-none'
        strokeWidth={1.75}
        aria-hidden='true'
      />
    ) : (
      <Sun
        className='h-4 w-4 text-ink-muted transition-colors duration-150 group-hover:text-ink motion-reduce:transition-none'
        strokeWidth={1.75}
        aria-hidden='true'
      />
    );

  const label = `Switch to ${nextTheme} mode`;

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={toggleTheme}
      className='h-9 w-9 rounded-full p-0'
      aria-label={label}
      title={`${label} (⌘D)`}
    >
      {icon}
    </Button>
  );
};
