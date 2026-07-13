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

import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Download,
  Filter,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';
import type { LibraryModel } from './types';

interface ModelLibrarySectionProps {
  expanded: boolean;
  models: LibraryModel[];
  totalAvailable: number;
  categories: string[];
  filter: string;
  search: string;
  loading: boolean;
  pulling: boolean;
  canInstallModels: boolean;
  pullSectionExpanded: boolean;
  setFilter: Dispatch<SetStateAction<string>>;
  setSearch: Dispatch<SetStateAction<string>>;
  isModelInstalled: (modelName: string) => boolean;
  normalizeCloudPullName: (modelName: string) => string;
  onToggle: () => void;
  onTogglePullSection: () => void;
  onPullModel: (modelName: string, modelCategory?: string) => void;
  onRefresh: () => void;
}

export function ModelLibrarySection({
  expanded,
  models,
  totalAvailable,
  categories,
  filter,
  search,
  loading,
  pulling,
  canInstallModels,
  pullSectionExpanded,
  setFilter,
  setSearch,
  isModelInstalled,
  normalizeCloudPullName,
  onToggle,
  onTogglePullSection,
  onPullModel,
  onRefresh,
}: ModelLibrarySectionProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border',
        'bg-white/60 dark:bg-white/[0.03]',
        'border-gray-200/80 dark:border-white/10'
      )}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'w-full flex items-center justify-between p-4',
          'hover:bg-gray-50 dark:hover:bg-dark-50',
          'transition-colors'
        )}
      >
        <div className='flex items-center gap-3'>
          <Cloud className='h-4 w-4 text-gray-500 dark:text-dark-500' />
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            {t('modelManager.sections.library')}
          </h3>
          <span
            className={cn(
              'px-2 py-0.5 rounded-full text-xs font-medium',
              'bg-gray-100 dark:bg-dark-200',
              'text-gray-600 dark:text-gray-400'
            )}
          >
            {totalAvailable} {t('modelManager.library.available')}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className='h-5 w-5 text-gray-500' />
        ) : (
          <ChevronDown className='h-5 w-5 text-gray-500' />
        )}
      </button>

      {expanded && (
        <div className='p-4 pt-0 space-y-4'>
          <div className='flex flex-col sm:flex-row gap-3'>
            <div className='relative flex-1'>
              <Search className='absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
              <input
                type='text'
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder={t('modelManager.library.search')}
                className={cn(
                  'w-full rounded-xl border py-2 pe-4 ps-10 text-sm',
                  'bg-gray-50 dark:bg-dark-50',
                  'border-gray-200 dark:border-dark-300',
                  'text-gray-900 dark:text-dark-700',
                  'placeholder-gray-500 dark:placeholder-gray-400',
                  'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                  'focus:border-primary-500'
                )}
              />
            </div>

            <div className='flex items-center gap-2'>
              <Filter className='h-4 w-4 text-gray-400' />
              <div className='flex flex-wrap gap-1'>
                {categories.map(category => (
                  <button
                    key={category}
                    onClick={() => setFilter(category)}
                    className={cn(
                      'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                      filter === category
                        ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400'
                        : 'bg-gray-100 dark:bg-dark-200 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-dark-300'
                    )}
                  >
                    {category.charAt(0).toUpperCase() + category.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {loading ? (
            <div className='flex items-center justify-center py-8'>
              <RefreshCw className='h-5 w-5 animate-spin text-gray-400' />
            </div>
          ) : models.length === 0 ? (
            <div className='text-center py-8 text-gray-500'>
              {t('modelManager.library.noResults')}
            </div>
          ) : (
            <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
              {models.map(model => {
                const pullName =
                  model.category === 'cloud'
                    ? normalizeCloudPullName(model.name)
                    : model.name;
                const installed =
                  isModelInstalled(model.name) || isModelInstalled(pullName);

                return (
                  <LibraryModelCard
                    key={model.name}
                    model={model}
                    installed={installed}
                    pulling={pulling}
                    canInstallModels={canInstallModels}
                    pullSectionExpanded={pullSectionExpanded}
                    onTogglePullSection={onTogglePullSection}
                    onPullModel={onPullModel}
                  />
                );
              })}
            </div>
          )}

          <div className='flex justify-center'>
            <Button
              onClick={onRefresh}
              variant='outline'
              size='sm'
              disabled={loading}
              className={cn('gap-1.5', '', '')}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', loading && 'animate-spin')}
              />
              {t('modelManager.library.refresh')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface LibraryModelCardProps {
  model: LibraryModel;
  installed: boolean;
  pulling: boolean;
  canInstallModels: boolean;
  pullSectionExpanded: boolean;
  onTogglePullSection: () => void;
  onPullModel: (modelName: string, modelCategory?: string) => void;
}

function LibraryModelCard({
  model,
  installed,
  pulling,
  canInstallModels,
  pullSectionExpanded,
  onTogglePullSection,
  onPullModel,
}: LibraryModelCardProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid={`library-model-card-${model.name}`}
      className={cn(
        'p-4 rounded-lg border transition-all',
        'bg-gray-50 dark:bg-dark-50',
        installed
          ? 'border-green-200 dark:border-green-800/50'
          : 'border-gray-200 dark:border-dark-300',
        'hover:shadow-md hover:border-gray-300 dark:hover:border-dark-400'
      )}
    >
      <div className='flex items-start justify-between gap-2 mb-2'>
        <h4 className='font-medium text-gray-900 dark:text-dark-800'>
          {model.name}
        </h4>
        {installed && (
          <span
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
              'bg-green-100 dark:bg-green-900/30',
              'text-green-700 dark:text-green-400'
            )}
          >
            <Check className='h-3 w-3' />
            {t('modelManager.library.installed')}
          </span>
        )}
      </div>

      <p className='text-xs text-gray-600 dark:text-dark-600 mb-3 line-clamp-2'>
        {model.description}
      </p>

      <div className='flex flex-wrap gap-1.5 mb-3'>
        {model.sizes.slice(0, 4).map(size => (
          <span
            key={size}
            className={cn(
              'px-1.5 py-0.5 rounded text-xs',
              'bg-gray-200 dark:bg-dark-300',
              'text-gray-600 dark:text-gray-400'
            )}
          >
            {size}
          </span>
        ))}
        {model.sizes.length > 4 && (
          <span className='text-xs text-gray-400'>
            {t('modelManager.library.more', {
              count: model.sizes.length - 4,
            })}
          </span>
        )}
      </div>

      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-2 text-xs text-gray-500'>
          {model.pulls && (
            <span className='flex items-center gap-1'>
              <Download className='h-3 w-3' />
              {model.pulls}
            </span>
          )}
          <span
            className={cn(
              'px-1.5 py-0.5 rounded capitalize',
              model.category === 'cloud'
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
                : 'bg-gray-100 dark:bg-dark-200'
            )}
          >
            {model.category}
          </span>
        </div>

        <Button
          data-testid={`library-model-pull-${model.name}`}
          onClick={() => {
            if (!pullSectionExpanded) {
              onTogglePullSection();
            }
            onPullModel(model.name, model.category);
          }}
          variant='outline'
          size='sm'
          disabled={pulling || !canInstallModels}
          className={cn('gap-1 text-xs', '', '')}
        >
          <Download className='h-3 w-3' />
          {t('modelManager.pull.button')}
        </Button>
      </div>
    </div>
  );
}
