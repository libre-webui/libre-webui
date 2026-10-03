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

import { cn } from '@/utils';

interface SettingsToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  /** The toggle renders no text; name it from the setting row it controls. */
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
}

export function SettingsToggle({
  checked,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}: SettingsToggleProps) {
  return (
    // Keep the native focus target inside the visible switch as settings scroll.
    <label
      className={cn(
        'relative flex items-center',
        disabled ? 'cursor-not-allowed' : 'cursor-pointer'
      )}
    >
      <input
        type='checkbox'
        id={id}
        checked={checked}
        onChange={event => onChange(event.target.checked)}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-describedby={ariaDescribedBy}
        className='peer sr-only'
      />
      <div
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-primary-500 peer-focus-visible:ring-offset-2',
          disabled
            ? 'bg-gray-100 dark:bg-dark-200 opacity-50 cursor-not-allowed'
            : checked
              ? 'bg-primary-600 dark:bg-primary-500'
              : 'bg-gray-200 dark:bg-dark-300'
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
            checked
              ? 'translate-x-6 rtl:-translate-x-6'
              : 'translate-x-1 rtl:-translate-x-1'
          )}
        />
      </div>
    </label>
  );
}
