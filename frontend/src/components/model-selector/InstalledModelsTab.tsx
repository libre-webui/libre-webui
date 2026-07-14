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

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Cpu, ImageIcon, Plus } from 'lucide-react';
import type { OllamaModel } from '@/types';
import { cn } from '@/utils';
import type { ModelGroup } from './types';

interface InstalledModelsTabProps {
  filteredGroups: ModelGroup[];
  selectedModel: string;
  showImageGen: boolean;
  getModelIcon: (model: OllamaModel) => ReactNode;
  getModelLabel: (model: OllamaModel) => string;
  getModelSubLabel: (model: OllamaModel) => string | null;
  onModelSelect: (modelName: string) => void;
  onOpenGallery: () => void;
}

export function InstalledModelsTab({
  filteredGroups,
  selectedModel,
  showImageGen,
  getModelIcon,
  getModelLabel,
  getModelSubLabel,
  onModelSelect,
  onOpenGallery,
}: InstalledModelsTabProps) {
  const { t } = useTranslation();

  return (
    <div className='flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-dark-400'>
      {filteredGroups.length > 0 ? (
        filteredGroups.map(group => (
          <div key={group.type}>
            <div className='px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-dark-300 border-b border-gray-200 dark:border-dark-400 sticky top-0'>
              <div className='flex items-center gap-2'>
                {group.icon}
                {group.label} ({group.models.length})
              </div>
            </div>
            {group.models.map(model => (
              <div
                key={model.name}
                onMouseDown={e => {
                  e.preventDefault();
                  onModelSelect(model.name);
                }}
                className={cn(
                  'px-3 py-3 cursor-pointer border-b border-gray-100 dark:border-dark-200 last:border-b-0',
                  'hover:bg-gray-50 dark:hover:bg-dark-200',
                  'bg-white dark:bg-dark-100 transition-colors',
                  selectedModel === model.name &&
                    'bg-primary-50 dark:bg-primary-900/30'
                )}
              >
                <div className='flex items-center gap-3'>
                  {getModelIcon(model)}
                  <div className='flex-1 min-w-0'>
                    <div
                      dir={model.isPersona ? 'auto' : 'ltr'}
                      className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'
                    >
                      {getModelLabel(model)}
                    </div>
                    {getModelSubLabel(model) && (
                      <div
                        dir='auto'
                        className='text-xs text-gray-500 dark:text-gray-400 truncate'
                      >
                        {getModelSubLabel(model)}
                      </div>
                    )}
                  </div>
                  {selectedModel === model.name && (
                    <Check className='h-4 w-4 text-primary-600 dark:text-primary-400 flex-shrink-0' />
                  )}
                </div>
              </div>
            ))}
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
