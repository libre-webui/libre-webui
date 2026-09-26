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

import { useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils';

export const ALL_SOURCES = 'all';

export interface ModelSourceChip {
  key: string;
  label: string;
  /** Models in the source that match the current search. */
  count: number;
}

interface ModelSourceFilterProps {
  sources: ModelSourceChip[];
  active: string;
  onChange: (key: string) => void;
}

/**
 * One chip per provider or agent harness, so a large catalog can be scoped
 * to a single source. A radio group: one chip is always checked and the
 * arrow keys move between them.
 */
export function ModelSourceFilter({
  sources,
  active,
  onChange,
}: ModelSourceFilterProps) {
  const { t } = useTranslation();
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const total = sources.reduce((sum, source) => sum + source.count, 0);
  const chips: ModelSourceChip[] = [
    { key: ALL_SOURCES, label: t('common.all'), count: total },
    ...sources,
  ];

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    const rtl =
      getComputedStyle(event.currentTarget as HTMLElement).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next: number | null = null;
    if (event.key === forward) next = (index + 1) % chips.length;
    else if (event.key === back)
      next = (index - 1 + chips.length) % chips.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = chips.length - 1;
    if (next === null) return;
    event.preventDefault();
    onChange(chips[next].key);
    chipRefs.current[next]?.focus();
  };

  return (
    <div
      role='radiogroup'
      aria-label={t('modelSelector.sources')}
      data-testid='model-selector-sources'
      className='flex gap-1.5 overflow-x-auto px-4 pb-3 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
    >
      {chips.map((chip, index) => {
        const checked = chip.key === active;
        return (
          <button
            key={chip.key}
            ref={element => {
              chipRefs.current[index] = element;
            }}
            type='button'
            role='radio'
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-source-key={chip.key}
            onClick={() => onChange(chip.key)}
            onKeyDown={event => handleKeyDown(event, index)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/50',
              checked
                ? 'border-transparent bg-gray-900 text-white dark:bg-dark-900 dark:text-dark-25'
                : 'border-black/[0.08] text-gray-600 hover:bg-gray-100 dark:border-white/[0.09] dark:text-dark-600 dark:hover:bg-dark-200',
              chip.count === 0 && !checked && 'opacity-50'
            )}
          >
            <span className='whitespace-nowrap'>{chip.label}</span>
            <span
              className={cn(
                'tabular-nums',
                checked
                  ? 'text-white/70 dark:text-dark-25/70'
                  : 'text-gray-400 dark:text-dark-500'
              )}
            >
              {chip.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
