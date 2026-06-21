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

import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Search,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';

interface PullProgress {
  status: string;
  percent?: number;
  total?: number;
  completed?: number;
}

interface PopularModel {
  name: string;
  category: string;
  size: string;
}

interface PullModelSectionProps {
  expanded: boolean;
  modelName: string;
  setModelName: Dispatch<SetStateAction<string>>;
  pulling: boolean;
  progress: PullProgress | null;
  canInstallModels: boolean;
  popularModels: PopularModel[];
  onToggle: () => void;
  onPull: () => void;
  onCancelPull: () => void;
  formatSize: (bytes: number) => string;
}

export function PullModelSection({
  expanded,
  modelName,
  setModelName,
  pulling,
  progress,
  canInstallModels,
  popularModels,
  onToggle,
  onPull,
  onCancelPull,
  formatSize,
}: PullModelSectionProps) {
  const { t } = useTranslation();

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !pulling && canInstallModels) {
      onPull();
    }
  };

  return (
    <div
      className={cn(
        'rounded-xl border overflow-hidden',
        'bg-white dark:bg-dark-100',
        'border-gray-200 dark:border-dark-300'
      )}
    >
      <button
        onClick={onToggle}
        className={cn(
          'w-full flex items-center justify-between p-4',
          'hover:bg-gray-50 dark:hover:bg-dark-50',
          'transition-colors'
        )}
      >
        <div className='flex items-center gap-3'>
          <div
            className={cn(
              'p-2 rounded-lg',
              'bg-primary-100 dark:bg-primary-900/30'
            )}
          >
            <Download className='h-5 w-5 text-primary-600 dark:text-primary-400' />
          </div>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            {t('modelManager.sections.pull')}
          </h3>
        </div>
        {expanded ? (
          <ChevronUp className='h-5 w-5 text-gray-500' />
        ) : (
          <ChevronDown className='h-5 w-5 text-gray-500' />
        )}
      </button>

      {expanded && (
        <div className='p-4 pt-0 space-y-4'>
          <div className='flex gap-2'>
            <div className='relative flex-1'>
              <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500' />
              <input
                type='text'
                value={modelName}
                onChange={event => setModelName(event.target.value)}
                placeholder={t('modelManager.pull.placeholder')}
                className={cn(
                  'w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm',
                  'bg-gray-50 dark:bg-dark-50',
                  'border-gray-200 dark:border-dark-300',
                  'text-gray-900 dark:text-dark-700',
                  'placeholder-gray-500 dark:placeholder-gray-400',
                  'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                  'focus:border-primary-500'
                )}
                disabled={pulling || !canInstallModels}
                onKeyDown={handleInputKeyDown}
              />
            </div>
            {pulling ? (
              <Button
                onClick={onCancelPull}
                variant='outline'
                className={cn(
                  'px-4 py-2.5 gap-2',
                  'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300',
                  '',
                  ''
                )}
              >
                <X className='h-4 w-4' />
                {t('modelManager.pull.cancel')}
              </Button>
            ) : (
              <Button
                onClick={onPull}
                disabled={!modelName.trim() || !canInstallModels}
                className={cn('px-4 py-2.5 gap-2', '')}
              >
                <Download className='h-4 w-4' />
                {t('modelManager.pull.button')}
              </Button>
            )}
          </div>

          {pulling && progress && (
            <PullProgressPanel progress={progress} formatSize={formatSize} />
          )}

          {!canInstallModels && (
            <p className='text-xs text-amber-700 dark:text-amber-300'>
              {t('modelManager.pull.restricted')}
            </p>
          )}

          <div>
            <p className='text-xs font-medium text-gray-500 dark:text-gray-400 mb-2'>
              {t('modelManager.pull.popular')}
            </p>
            <div className='flex flex-wrap gap-2'>
              {popularModels.map(model => (
                <button
                  key={model.name}
                  onClick={() => setModelName(model.name)}
                  disabled={pulling || !canInstallModels}
                  className={cn(
                    'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                    'bg-gray-100 dark:bg-dark-200',
                    'text-gray-700 dark:text-gray-300',
                    'hover:bg-gray-200 dark:hover:bg-dark-300',
                    'border border-gray-200 dark:border-dark-300',
                    'disabled:opacity-50 disabled:cursor-not-allowed'
                  )}
                >
                  {model.name}
                  <span className='ml-1 text-gray-400 dark:text-gray-500'>
                    {model.size}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <a
            href='https://ollama.com/library'
            target='_blank'
            rel='noopener noreferrer'
            className={cn(
              'inline-flex items-center gap-1.5 text-xs',
              'text-primary-600 dark:text-primary-400',
              'hover:underline'
            )}
          >
            <ExternalLink className='h-3 w-3' />
            {t('modelManager.pull.browseAll')}
          </a>
        </div>
      )}
    </div>
  );
}

interface PullProgressPanelProps {
  progress: PullProgress;
  formatSize: (bytes: number) => string;
}

function PullProgressPanel({ progress, formatSize }: PullProgressPanelProps) {
  const { t } = useTranslation();

  const progressLabel =
    progress.status === 'starting'
      ? t('modelManager.progress.starting')
      : progress.status.startsWith('pulling')
        ? `${t('modelManager.progress.pullingLayer')} ${progress.status.replace('pulling ', '')}`
        : progress.status.startsWith('verifying sha256')
          ? t('modelManager.progress.verifyingDigest')
          : progress.status === 'writing manifest'
            ? t('modelManager.progress.writing')
            : progress.status === 'removing any unused layers'
              ? t('modelManager.progress.cleaning')
              : progress.status;

  return (
    <div
      className={cn(
        'p-4 rounded-lg border',
        'bg-gray-50 dark:bg-dark-200',
        'border-gray-200 dark:border-dark-300'
      )}
    >
      <div className='flex items-center justify-between mb-2'>
        <span className='text-sm font-medium text-gray-800 dark:text-dark-700'>
          {progressLabel}
        </span>
        {progress.percent !== undefined && (
          <span className='text-sm font-mono text-gray-600 dark:text-dark-600'>
            {progress.percent}%
          </span>
        )}
      </div>

      {progress.percent !== undefined && (
        <div className='w-full bg-gray-200 dark:bg-dark-400 rounded-full h-2 overflow-hidden'>
          <div
            className={cn(
              'h-2 rounded-full transition-all duration-300',
              'bg-primary-500 dark:bg-primary-400'
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}

      {progress.total && progress.completed && (
        <div className='mt-2 text-xs text-gray-600 dark:text-dark-600'>
          {formatSize(progress.completed)} / {formatSize(progress.total)}
        </div>
      )}
    </div>
  );
}
