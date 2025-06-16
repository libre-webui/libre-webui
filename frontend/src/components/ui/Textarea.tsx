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

interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helper?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helper, className, id, ...props }, ref) => {
    const textareaId =
      id || `textarea-${Math.random().toString(36).substr(2, 9)}`;

    return (
      <div className='space-y-1'>
        {label && (
          <label
            htmlFor={textareaId}
            className='block text-sm font-medium text-gray-700 dark:text-dark-700'
          >
            {label}
          </label>
        )}
        <textarea
          ref={ref}
          id={textareaId}
          className={cn(
            'block w-full rounded-xl border border-gray-200 px-4 py-3 text-sm placeholder-gray-500 shadow-sm transition-all duration-200 resize-none bg-white text-gray-900',
            'focus:border-primary-500 focus:ring-2 focus:ring-primary-500/20 focus:outline-none focus:shadow-md',
            'dark:border-dark-300 dark:bg-dark-100 dark:text-dark-800 dark:placeholder-dark-500',
            'dark:focus:border-primary-400 dark:focus:ring-primary-400/20',
            error &&
              'border-error-500 focus:border-error-500 focus:ring-error-500/20',
            className
          )}
          {...props}
        />
        {error && (
          <p className='text-sm text-error-600 dark:text-error-400'>{error}</p>
        )}
        {helper && !error && (
          <p className='text-sm text-gray-500 dark:text-dark-500'>{helper}</p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';
