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
  ChevronDown,
  ChevronUp,
  Clock,
  Copy,
  Cpu,
  HardDrive,
  Hash,
  Info,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';
import type { ModelInfo } from './types';

interface LocalModelsSectionProps {
  expanded: boolean;
  models: ModelInfo[];
  onToggle: () => void;
  isModelRunning: (modelName: string) => boolean;
  formatSize: (bytes: number) => string;
  onShowModel: (modelName: string) => void;
  onCopyModel: (modelName: string) => void;
  onDeleteModel: (modelName: string) => void;
}

export function LocalModelsSection({
  expanded,
  models,
  onToggle,
  isModelRunning,
  formatSize,
  onShowModel,
  onCopyModel,
  onDeleteModel,
}: LocalModelsSectionProps) {
  const { t } = useTranslation();

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
            className={cn('p-2 rounded-lg', 'bg-blue-100 dark:bg-blue-900/30')}
          >
            <HardDrive className='h-5 w-5 text-blue-600 dark:text-blue-400' />
          </div>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            {t('modelManager.sections.local')}
          </h3>
          <span
            className={cn(
              'px-2 py-0.5 rounded-full text-xs font-medium',
              'bg-gray-100 dark:bg-dark-200',
              'text-gray-600 dark:text-gray-400'
            )}
          >
            {models.length} {t('modelManager.local.installed')}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className='h-5 w-5 text-gray-500' />
        ) : (
          <ChevronDown className='h-5 w-5 text-gray-500' />
        )}
      </button>

      {expanded && (
        <div className='p-4 pt-0'>
          {models.length === 0 ? (
            <div
              className={cn(
                'text-center py-12 rounded-lg border-2 border-dashed',
                'border-gray-200 dark:border-dark-300'
              )}
            >
              <HardDrive className='h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-gray-600' />
              <p className='text-gray-600 dark:text-dark-600 mb-2'>
                {t('modelManager.local.noModels')}
              </p>
              <p className='text-sm text-gray-500 dark:text-gray-500'>
                {t('modelManager.local.pullToStart')}
              </p>
            </div>
          ) : (
            <div className='space-y-3'>
              {models.map(model => (
                <LocalModelCard
                  key={model.name}
                  model={model}
                  running={isModelRunning(model.name)}
                  formatSize={formatSize}
                  onShowModel={onShowModel}
                  onCopyModel={onCopyModel}
                  onDeleteModel={onDeleteModel}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface LocalModelCardProps {
  model: ModelInfo;
  running: boolean;
  formatSize: (bytes: number) => string;
  onShowModel: (modelName: string) => void;
  onCopyModel: (modelName: string) => void;
  onDeleteModel: (modelName: string) => void;
}

function LocalModelCard({
  model,
  running,
  formatSize,
  onShowModel,
  onCopyModel,
  onDeleteModel,
}: LocalModelCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'p-4 rounded-lg border transition-colors',
        'bg-gray-50 dark:bg-dark-50',
        'border-gray-200 dark:border-dark-300',
        'hover:bg-gray-100 dark:hover:bg-dark-200'
      )}
    >
      <div className='flex items-start justify-between gap-4'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-2 flex-wrap'>
            <h4 className='font-medium text-gray-900 dark:text-dark-800'>
              {model.name}
            </h4>
            {running && (
              <span
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                  'bg-green-100 dark:bg-green-900/30',
                  'text-green-700 dark:text-green-400'
                )}
              >
                <span className='w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse' />
                {t('modelManager.local.running')}
              </span>
            )}
          </div>

          <div className='flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-dark-600 mt-2'>
            <span className='flex items-center gap-1'>
              <HardDrive className='h-3.5 w-3.5' />
              {formatSize(model.size)}
            </span>
            {model.details?.parameter_size && (
              <span className='flex items-center gap-1'>
                <Cpu className='h-3.5 w-3.5' />
                {model.details.parameter_size}
              </span>
            )}
            {model.details?.quantization_level && (
              <span
                className={cn(
                  'px-1.5 py-0.5 rounded text-xs',
                  'bg-gray-200 dark:bg-dark-300',
                  'text-gray-600 dark:text-gray-400'
                )}
              >
                {model.details.quantization_level}
              </span>
            )}
            {model.details?.family && (
              <span className='text-gray-500 dark:text-gray-500'>
                {model.details.family}
              </span>
            )}
          </div>

          <div className='flex items-center gap-3 text-xs text-gray-400 dark:text-dark-500 mt-2'>
            <span className='flex items-center gap-1'>
              <Clock className='h-3 w-3' />
              {new Date(model.modified_at).toLocaleDateString()}
            </span>
            <span
              className='flex items-center gap-1 font-mono truncate max-w-[200px]'
              title={model.digest}
            >
              <Hash className='h-3 w-3' />
              {model.digest.slice(0, 12)}...
            </span>
          </div>
        </div>

        <div className='flex gap-2 flex-shrink-0'>
          <Button
            onClick={() => onShowModel(model.name)}
            variant='outline'
            size='sm'
            className={cn('gap-1.5', '', '')}
          >
            <Info className='h-3.5 w-3.5' />
            {t('modelManager.local.info')}
          </Button>
          <Button
            onClick={() => onCopyModel(model.name)}
            variant='outline'
            size='sm'
            className={cn('gap-1.5', '', '')}
          >
            <Copy className='h-3.5 w-3.5' />
            {t('modelManager.local.copy')}
          </Button>
          <Button
            onClick={() => onDeleteModel(model.name)}
            variant='outline'
            size='sm'
            className={cn(
              'gap-1.5',
              'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300',
              '',
              ''
            )}
          >
            <Trash2 className='h-3.5 w-3.5' />
            {t('modelManager.local.delete')}
          </Button>
        </div>
      </div>
    </div>
  );
}
