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

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helper?: string;
  options: { value: string; label: string }[];
}

export const Select: React.FC<SelectProps> = ({
  label,
  error,
  helper,
  options,
  className,
  id,
  ...props
}) => {
  const selectId = id || `select-${Math.random().toString(36).substr(2, 9)}`;

  return (
    <div className='space-y-1'>
      {label && (
        <label
          htmlFor={selectId}
          className='block text-sm font-medium text-gray-700 dark:text-dark-700'
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={cn(
          'block w-full rounded-xl border border-gray-200 px-4 py-3 text-sm shadow-sm transition-all duration-200 bg-white text-gray-900',
          'focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none focus:shadow-md',
          'dark:border-dark-300 dark:bg-dark-100 dark:text-dark-800',
          'dark:focus:border-primary-400 dark:focus:ring-primary-400/20',
          error &&
            'border-error-500 focus:border-error-500 focus:ring-error-500/20',
          className
        )}
        {...props}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p className='text-sm text-error-600 dark:text-error-400'>{error}</p>
      )}
      {helper && !error && (
        <p className='text-sm text-gray-500 dark:text-dark-600'>{helper}</p>
      )}
    </div>
  );
};
