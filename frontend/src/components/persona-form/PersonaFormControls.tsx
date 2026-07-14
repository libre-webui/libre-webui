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

import type React from 'react';
import { cn } from '@/utils';

interface ParameterSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
  format?: (value: number) => string;
  colorClass?: string;
}

export const ParameterSlider: React.FC<ParameterSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  format = v => String(v),
  colorClass = 'text-gray-700 dark:text-dark-600',
}) => {
  const progress = ((value - min) / (max - min)) * 100;

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = parseFloat(e.target.value);
    if (!isNaN(newValue)) {
      onChange(Math.min(max, Math.max(min, newValue)));
    }
  };

  return (
    <div>
      <div className='flex items-center justify-between mb-2'>
        <label className={cn('block text-sm font-medium', colorClass)}>
          {label}
        </label>
        <input
          type='number'
          min={min}
          max={max}
          step={step}
          value={format(value)}
          onChange={handleInputChange}
          className='w-20 px-2 py-1 text-sm text-right bg-gray-100 dark:bg-dark-200 border border-gray-300 dark:border-dark-300 rounded focus:outline-none focus:ring-1 focus:ring-primary-500 dark:text-dark-600'
        />
      </div>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
        style={{ '--progress': `${progress}%` } as React.CSSProperties}
      />
      {hint && (
        <p
          className={cn(
            'text-xs mt-1',
            colorClass.replace('700', '500').replace('600', '400')
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
};

interface ToggleSwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  colorClass?: string;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  label,
  checked,
  onChange,
  colorClass = 'text-gray-700 dark:text-dark-600',
}) => (
  <label className='flex items-center gap-3 cursor-pointer'>
    <div
      className={cn(
        'relative w-10 h-5 rounded-full transition-colors',
        checked
          ? 'bg-primary-500 dark:bg-primary-600'
          : 'bg-gray-300 dark:bg-dark-300'
      )}
      onClick={() => onChange(!checked)}
    >
      <div
        className={cn(
          'absolute top-0.5 start-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
          checked && 'translate-x-5 rtl:-translate-x-5'
        )}
      />
    </div>
    <span className={cn('text-sm font-medium', colorClass)}>{label}</span>
  </label>
);
