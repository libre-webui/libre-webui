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

import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronRight, Cpu, ImageIcon, Plus } from 'lucide-react';
import type { OllamaModel } from '@/types';
import { cn } from '@/utils';
import type { ModelGroup } from './types';

interface InstalledModelsTabProps {
  groups: ModelGroup[];
  selectedModel: string;
  showImageGen: boolean;
  getModelValue: (model: OllamaModel) => string;
  getModelIcon: (model: OllamaModel) => ReactNode;
  getModelLabel: (model: OllamaModel, group: ModelGroup) => string;
  getModelTag: (model: OllamaModel, group: ModelGroup) => string | null;
  getModelSubLabel: (model: OllamaModel, group: ModelGroup) => string | null;
  onModelSelect: (modelName: string) => void;
  onShowAll: (groupKey: string) => void;
  onOpenGallery: () => void;
  /** Arrow Up on the first row hands focus back to the search field. */
  onExitTop: () => void;
}

const ROW_SELECTOR =
  '[data-testid="model-selector-option"], [data-testid="model-selector-show-all"]';

/** Up and Down walk the rows, so the list works without a pointer. */
function moveRowFocus(
  event: KeyboardEvent<HTMLDivElement>,
  onExitTop: () => void
) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR)
  );
  const index = rows.indexOf(document.activeElement as HTMLButtonElement);
  if (index === -1) return;
  event.preventDefault();
  const next = index + (event.key === 'ArrowDown' ? 1 : -1);
  if (next < 0) {
    onExitTop();
    return;
  }
  rows[Math.min(next, rows.length - 1)]?.focus();
}

export function InstalledModelsTab({
  groups,
  selectedModel,
  showImageGen,
  getModelValue,
  getModelIcon,
  getModelLabel,
  getModelTag,
  getModelSubLabel,
  onModelSelect,
  onShowAll,
  onOpenGallery,
  onExitTop,
}: InstalledModelsTabProps) {
  const { t } = useTranslation();

  return (
    <div
      className='scroll-region min-h-0 flex-1 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-dark-400'
      onKeyDown={event => moveRowFocus(event, onExitTop)}
    >
      {groups.length > 0 ? (
        groups.map(group => (
          <div key={group.key} data-testid='model-selector-group'>
            {group.showHeader && (
              <div className='sticky top-0 z-[1] flex items-center gap-2 border-b border-gray-200 bg-gray-100 px-3 py-2 text-xs font-semibold text-gray-500 dark:border-dark-400 dark:bg-dark-300 dark:text-gray-400'>
                {group.icon}
                <span className='min-w-0 truncate'>{group.label}</span>
                <span className='font-normal tabular-nums text-gray-400 dark:text-dark-500'>
                  {group.total}
                </span>
              </div>
            )}
            {group.models.map(model => {
              const modelValue = getModelValue(model);
              const subLabel = getModelSubLabel(model, group);
              const tag = getModelTag(model, group);
              return (
                <button
                  type='button'
                  key={modelValue}
                  data-testid='model-selector-option'
                  data-model-value={modelValue}
                  aria-pressed={selectedModel === modelValue}
                  title={model.isPersona ? undefined : model.name}
                  onClick={() => onModelSelect(modelValue)}
                  className={cn(
                    'block w-full cursor-pointer border-b border-gray-100 px-3 py-2 text-start last:border-b-0 dark:border-dark-200',
                    'hover:bg-gray-50 dark:hover:bg-dark-200',
                    'bg-white dark:bg-dark-100 transition-colors',
                    'focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50',
                    selectedModel === modelValue &&
                      'bg-primary-50 dark:bg-primary-900/30'
                  )}
                >
                  <div className='flex items-center gap-3'>
                    {getModelIcon(model)}
                    <div className='flex-1 min-w-0'>
                      <div className='flex min-w-0 items-center gap-1.5'>
                        <span
                          dir={model.isPersona ? 'auto' : 'ltr'}
                          className='min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100'
                        >
                          {getModelLabel(model, group)}
                        </span>
                        {tag && (
                          <span
                            dir='ltr'
                            className='shrink-0 rounded border border-black/[0.08] px-1 py-px font-mono text-[10px] leading-4 text-gray-500 dark:border-white/[0.1] dark:text-dark-600'
                          >
                            {tag}
                          </span>
                        )}
                      </div>
                      {subLabel && (
                        <div
                          dir='auto'
                          className='text-xs text-gray-500 dark:text-gray-400 truncate'
                        >
                          {subLabel}
                        </div>
                      )}
                    </div>
                    {selectedModel === modelValue && (
                      <Check className='h-4 w-4 text-primary-600 dark:text-primary-400 flex-shrink-0' />
                    )}
                  </div>
                </button>
              );
            })}
            {group.hidden > 0 && (
              <button
                type='button'
                data-testid='model-selector-show-all'
                onClick={() => onShowAll(group.key)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 border-b border-gray-100 bg-white px-3 py-2 text-start text-xs font-medium text-primary-600 dark:border-dark-200 dark:bg-dark-100 dark:text-primary-400',
                  'hover:bg-gray-50 dark:hover:bg-dark-200',
                  'focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500/50'
                )}
              >
                <span className='truncate'>
                  {t('modelSelector.showAll', { total: group.total })}
                </span>
                <ChevronRight className='h-3.5 w-3.5 shrink-0 rtl:rotate-180' />
              </button>
            )}
          </div>
        ))
      ) : (
        <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400'>
          <Cpu className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600' />
          <p className='text-sm'>{t('models.noModelsFound')}</p>
        </div>
      )}

      {showImageGen && (
        <div className='border-t border-gray-200 dark:border-dark-300'>
          <div className='px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-dark-300'>
            <div className='flex items-center gap-2'>
              <Plus className='h-4 w-4 text-blue-600 dark:text-blue-400' />
              {t('modelSelector.actions')}
            </div>
          </div>
          <div
            onMouseDown={e => {
              e.preventDefault();
              onOpenGallery();
            }}
            className='px-3 py-3 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 bg-white dark:bg-dark-100'
          >
            <div className='flex items-center gap-3'>
              <ImageIcon className='h-4 w-4 text-blue-600 dark:text-blue-400' />
              <div className='flex-1'>
                <div className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                  {t('gallery.generate')}
                </div>
                <div className='text-xs text-gray-500 dark:text-gray-400'>
                  {t('gallery.generateDescription')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
