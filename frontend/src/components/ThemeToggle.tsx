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
import { Sun, Moon, Sparkles } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { Button } from '@/components/ui';

export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useAppStore();

  // Get the next theme in the cycle for the tooltip
  const getNextTheme = () => {
    if (theme.mode === 'light') return 'dark';
    if (theme.mode === 'dark') return 'ophelia';
    return 'light';
  };

  // Get the appropriate icon for the current theme
  const getIcon = () => {
    if (theme.mode === 'light') {
      return (
        <Moon className='h-4 w-4 text-primary-600 dark:text-primary-400' />
      );
    }
    if (theme.mode === 'dark') {
      return (
        <Sparkles className='h-4 w-4 text-primary-600 dark:text-primary-400' />
      );
    }
    // ophelia mode - show sun to go back to light
    return <Sun className='h-4 w-4 text-purple-400' />;
  };

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={toggleTheme}
      className='h-9 w-9 p-0 rounded-xl hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212] transition-all duration-200 hover:scale-105 active:scale-95'
      title={`Switch to ${getNextTheme()} mode (⌘D)`}
    >
      {getIcon()}
    </Button>
  );
};
