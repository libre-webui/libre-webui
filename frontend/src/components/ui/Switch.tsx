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

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  className = '',
}) => {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 items-center justify-center rounded-full bg-transparent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas dark:focus-visible:ring-primary-400',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        className
      )}
    >
      <span
        aria-hidden='true'
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full border shadow-inner',
          'transition-[background-color,border-color] duration-150 ease-out motion-reduce:transition-none',
          checked
            ? 'border-primary-600/70 bg-primary-600'
            : 'border-line-strong bg-surface-subtle'
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 rounded-full bg-white shadow-subtle ring-1 ring-black/5',
            'transform transition-transform duration-150 ease-out motion-reduce:transition-none',
            checked
              ? 'translate-x-6 rtl:-translate-x-6'
              : 'translate-x-1 rtl:-translate-x-1'
          )}
        />
      </span>
    </button>
  );
};
