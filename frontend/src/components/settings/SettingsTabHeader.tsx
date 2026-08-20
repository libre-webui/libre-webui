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
import { cn } from '@/utils';

interface SettingsTabHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

/** Compact header for workspace tabs hosted inside the settings panel. */
export const SettingsTabHeader: React.FC<SettingsTabHeaderProps> = ({
  title,
  description,
  actions,
  className,
}) => (
  <header
    className={cn(
      'mb-5 flex flex-col gap-3 border-b border-gray-200/70 pb-4 dark:border-white/[0.08] sm:flex-row sm:items-end sm:justify-between',
      className
    )}
  >
    <div className='min-w-0'>
      <h3 className='text-lg font-medium text-gray-900 dark:text-dark-800'>
        {title}
      </h3>
      {description && (
        <p className='mt-1 max-w-2xl text-sm leading-6 text-gray-600 dark:text-dark-600'>
          {description}
        </p>
      )}
    </div>
    {actions && (
      <div className='flex shrink-0 flex-wrap items-center gap-2'>
        {actions}
      </div>
    )}
  </header>
);
