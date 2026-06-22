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

import { useTranslation } from 'react-i18next';
import {
  Cloud,
  Download,
  ExternalLink,
  Loader,
  RefreshCw,
  X,
} from 'lucide-react';
import { cn } from '@/utils';
import type { LibraryModel, PullProgress } from './types';

interface OllamaLibraryTabProps {
  libraryCategories: string[];
  libraryCategory: string;
  canInstallModels: boolean;
  loadingLibrary: boolean;
  filteredLibraryModels: LibraryModel[];
  pullingModel: string | null;
  pullProgress: PullProgress | null;
  setLibraryCategory: (category: string) => void;
  isModelInstalled: (name: string) => boolean;
  onModelSelect: (modelName: string) => void;
  onPullModel: (modelName: string) => void;
  onCancelPull: () => void;
  onRefreshLibrary: () => void;
}

export function OllamaLibraryTab({
  libraryCategories,
  libraryCategory,
  canInstallModels,
  loadingLibrary,
  filteredLibraryModels,
  pullingModel,
  pullProgress,
  setLibraryCategory,
  isModelInstalled,
  onModelSelect,
  onPullModel,
  onCancelPull,
  onRefreshLibrary,
}: OllamaLibraryTabProps) {
  const { t } = useTranslation();

  return (
    <div className='flex-1 flex flex-col overflow-hidden'>
      <div className='px-3 py-2 border-b border-gray-200 dark:border-dark-300 flex-shrink-0'>
        <div className='flex flex-wrap gap-1.5'>
          {libraryCategories.map(cat => (
            <button
              key={cat}
              onMouseDown={e => {
                e.preventDefault();
                e.stopPropagation();
                setLibraryCategory(cat);
              }}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                libraryCategory === cat
                  ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400'
                  : 'bg-gray-100 dark:bg-dark-200 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-dark-300'
              )}
            >
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className='flex-1 overflow-y-auto'>
        {!canInstallModels && (
          <div className='mx-3 mt-3 mb-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'>
            {t('modelSelector.pullRestricted')}
          </div>
        )}
        {loadingLibrary ? (
          <div className='flex items-center justify-center py-12'>
            <Loader className='h-6 w-6 animate-spin text-gray-400' />
          </div>
        ) : filteredLibraryModels.length === 0 ? (
          <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400'>
            <Cloud className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600' />
            <p className='text-sm'>{t('models.noModelsFound')}</p>
          </div>
        ) : (
          <div className='divide-y divide-gray-100 dark:divide-dark-200'>
            {filteredLibraryModels.slice(0, 50).map(model => {
              const installed = isModelInstalled(model.name);
              const isPulling = pullingModel === model.name;

              return (
                <div
                  key={model.name}
                  className={cn(
                    'px-3 py-3 bg-white dark:bg-dark-100',
                    installed && 'bg-green-50/50 dark:bg-green-900/10'
                  )}
                >
                  <div className='flex items-start gap-3'>
                    <div className='p-2 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex-shrink-0'>
                      <Cloud className='h-4 w-4 text-blue-600 dark:text-blue-400' />
                    </div>
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center gap-2'>
                        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                          {model.name}
                        </h4>
                        {installed && (
                          <span className='px-1.5 py-0.5 rounded text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'>
                            {t('modelSelector.installed')}
                          </span>
                        )}
                        {(model.category === 'cloud' ||
                          model.tags?.includes('cloud')) && (
                          <span className='px-1.5 py-0.5 rounded text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 flex items-center gap-1'>
                            <Cloud className='h-3 w-3' />
                            Cloud
                          </span>
                        )}
                      </div>
                      <p className='text-xs text-gray-500 dark:text-gray-400 line-clamp-1 mt-0.5'>
                        {model.description}
                      </p>
                      <div className='flex items-center gap-2 mt-1.5'>
                        {model.sizes.slice(0, 3).map(size => (
                          <span
                            key={size}
                            className='px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-dark-200 text-gray-600 dark:text-gray-400'
                          >
                            {size}
                          </span>
                        ))}
                        {model.pulls && (
                          <span className='text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1'>
                            <Download className='h-3 w-3' />
                            {model.pulls}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className='flex-shrink-0'>
                      {isPulling ? (
                        <div className='flex items-center gap-2'>
                          <div className='text-xs text-gray-500 w-12 text-right'>
                            {pullProgress?.percent !== undefined
                              ? `${pullProgress.percent}%`
                              : '...'}
                          </div>
                          <button
                            onClick={onCancelPull}
                            className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                          >
                            <X className='h-4 w-4' />
                          </button>
                        </div>
                      ) : installed ? (
                        <button
                          onClick={() => onModelSelect(model.name)}
                          className='px-3 py-1.5 rounded-lg text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50'
                        >
                          {t('modelSelector.use')}
                        </button>
                      ) : canInstallModels ? (
                        <button
                          onClick={() => onPullModel(model.name)}
                          className='px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400 hover:bg-primary-200 dark:hover:bg-primary-900/50'
                        >
                          <Download className='h-3 w-3 inline mr-1' />
                          {t('modelSelector.pull')}
                        </button>
                      ) : (
                        <span className='px-2 py-1 rounded text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'>
                          {t('modelSelector.adminOnlyPull')}
                        </span>
                      )}
                    </div>
                  </div>

                  {isPulling && pullProgress?.percent !== undefined && (
                    <div className='mt-2 w-full bg-gray-200 dark:bg-dark-300 rounded-full h-1.5 overflow-hidden'>
                      <div
                        className='h-1.5 rounded-full bg-primary-500 transition-all duration-300'
                        style={{ width: `${pullProgress.percent}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className='px-3 py-2 border-t border-gray-200 dark:border-dark-300 flex items-center justify-between flex-shrink-0'>
        <a
          href='https://ollama.com/library'
          target='_blank'
          rel='noopener noreferrer'
          onMouseDown={e => e.stopPropagation()}
          className='text-xs text-primary-600 dark:text-primary-400 hover:underline flex items-center gap-1'
        >
          <ExternalLink className='h-3 w-3' />
          {t('modelManager.huggingface.browseAllLink')}
        </a>
        <button
          onMouseDown={e => {
            e.preventDefault();
            e.stopPropagation();
            onRefreshLibrary();
          }}
          className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
        >
          <RefreshCw
            className={cn(
              'h-3.5 w-3.5 text-gray-400',
              loadingLibrary && 'animate-spin'
            )}
          />
        </button>
      </div>
    </div>
  );
}
