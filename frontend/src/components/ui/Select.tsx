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

import React, { useId } from 'react';
import { cn } from '@/utils';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helper?: string;
  options: { value: string; label: string; key?: string }[];
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
  const generatedId = useId();
  const selectId = id || `select-${generatedId}`;
  const feedbackId = `${selectId}-feedback`;
  const describedBy =
    [props['aria-describedby'], (error || helper) && feedbackId]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className='space-y-1.5'>
      {label && (
        <label
          htmlFor={selectId}
          className='block text-sm font-medium tracking-[-0.005em] text-ink-muted'
        >
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={cn(
          'block w-full rounded-xl border border-line bg-surface-raised px-3.5 py-2.5 text-base text-ink shadow-none',
          'transition-[background-color,border-color,box-shadow,color] duration-150 ease-out',
          'focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus-visible:outline-none dark:focus:border-primary-400 dark:focus:ring-primary-400/20',
          'disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-subtle disabled:opacity-70',
          error &&
            'border-error-500 focus:border-error-500 focus:ring-error-500/20',
          className
        )}
        {...props}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy}
      >
        {options.map((option, index) => (
          <option
            key={option.key ?? `${option.value}-${index}`}
            value={option.value}
          >
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p
          id={feedbackId}
          role='alert'
          className='text-xs leading-relaxed text-error-600 dark:text-error-400'
        >
          {error}
        </p>
      )}
      {helper && !error && (
        <p id={feedbackId} className='text-xs leading-relaxed text-ink-muted'>
          {helper}
        </p>
      )}
    </div>
  );
};
