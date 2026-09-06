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

/**
 * Multi-model comparison picker: choose extra models that answer the next
 * prompt alongside the session's own model. Each extra reply is its own
 * durable generation with independent stop, error, and usage.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Columns2 } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from '@/components/ui';
import {
  chatModelOptionKey,
  isAvailableOllamaModel,
} from '@/utils/chatModelSelection';
import { MAX_COMPARE_MODELS } from './compareTargets';
import type { OllamaModel } from '@/types';

interface ComposerCompareMenuProps {
  models: OllamaModel[];
  /** The session's own model key, excluded from the extra-model list. */
  currentModelKey: string;
  selectedKeys: string[];
  onChange: (keys: string[]) => void;
  disabled?: boolean;
}

export const ComposerCompareMenu: React.FC<ComposerCompareMenuProps> = ({
  models,
  currentModelKey,
  selectedKeys,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const options = models
    .filter(isAvailableOllamaModel)
    .map(model => ({ model, key: chatModelOptionKey(model) }))
    .filter(entry => entry.key !== currentModelKey);

  if (options.length === 0) return null;

  const toggle = (key: string) => {
    if (selectedKeys.includes(key)) {
      onChange(selectedKeys.filter(existing => existing !== key));
    } else if (selectedKeys.length < MAX_COMPARE_MODELS) {
      onChange([...selectedKeys, key]);
    }
  };

  return (
    <div className='relative' ref={containerRef}>
      <Button
        type='button'
        variant='ghost'
        size='sm'
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        className={cn(
          'h-9 w-9 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
          'text-ink-muted hover:bg-interactive-hover hover:text-ink',
          'transition-colors duration-150 touch-manipulation',
          selectedKeys.length > 0 &&
            'bg-primary-50 text-primary-600 dark:bg-primary-900/25 dark:text-primary-400'
        )}
        title={t('chat.compare.title')}
        aria-pressed={selectedKeys.length > 0}
        aria-expanded={open}
        data-testid='composer-compare-toggle'
      >
        <Columns2 className='h-4 w-4' />
        {selectedKeys.length > 0 && (
          <span className='absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-md bg-primary-500 px-1 text-[9px] font-semibold tabular-nums text-white'>
            +{selectedKeys.length}
          </span>
        )}
      </Button>
      {open && (
        <div
          className='absolute bottom-full start-0 z-30 mb-2 max-h-72 w-72 overflow-y-auto rounded-xl border border-gray-200 bg-white p-2 shadow-lg scrollbar-thin dark:border-dark-200 dark:bg-dark-50'
          role='menu'
          data-testid='composer-compare-menu'
        >
          <p className='px-2 pb-1.5 pt-1 text-[11px] font-medium text-gray-400 dark:text-dark-500'>
            {t('chat.compare.hint', { max: MAX_COMPARE_MODELS })}
          </p>
          {options.map(({ model, key }) => {
            const checked = selectedKeys.includes(key);
            const full = !checked && selectedKeys.length >= MAX_COMPARE_MODELS;
            return (
              <label
                key={key}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-gray-800 hover:bg-gray-50 dark:text-dark-800 dark:hover:bg-dark-100',
                  full && 'cursor-not-allowed opacity-40'
                )}
              >
                <input
                  type='checkbox'
                  checked={checked}
                  disabled={full}
                  onChange={() => toggle(key)}
                  className='h-3.5 w-3.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-400'
                />
                <span dir='ltr' className='min-w-0 flex-1 truncate'>
                  {model.name}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ComposerCompareMenu;
