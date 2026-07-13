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
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Heart,
  Loader,
  RefreshCw,
  Search,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { GgufFileInfo, HuggingFaceModel } from '@/utils/api';
import { cn } from '@/utils';

interface HfPullProgress {
  status: string;
  percent?: number;
}

interface HuggingFaceSectionProps {
  expanded: boolean;
  models: HuggingFaceModel[];
  search: string;
  task: string;
  sort: string;
  loadingModels: boolean;
  canInstallModels: boolean;
  expandedModelId: string | null;
  loadingGgufModelId: string | null;
  ggufFiles: Record<string, GgufFileInfo[]>;
  pullingModel: string | null;
  pullProgress: HfPullProgress | null;
  setSearch: Dispatch<SetStateAction<string>>;
  setTask: Dispatch<SetStateAction<string>>;
  setSort: Dispatch<SetStateAction<string>>;
  onToggle: () => void;
  onToggleModel: (modelId: string) => void;
  onPullGguf: (ollamaCommand: string, filename: string) => void;
  onCancelPull: () => void;
  onRefresh: () => void;
}

export function HuggingFaceSection({
  expanded,
  models,
  search,
  task,
  sort,
  loadingModels,
  canInstallModels,
  expandedModelId,
  loadingGgufModelId,
  ggufFiles,
  pullingModel,
  pullProgress,
  setSearch,
  setTask,
  setSort,
  onToggle,
  onToggleModel,
  onPullGguf,
  onCancelPull,
  onRefresh,
}: HuggingFaceSectionProps) {
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
          <Zap className='h-4 w-4 text-gray-500 dark:text-dark-500' />
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            {t('modelManager.sections.huggingface', 'HuggingFace Hub')}
          </h3>
          {models.length > 0 && (
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-xs font-medium',
                'bg-gray-100 dark:bg-dark-200',
                'text-gray-600 dark:text-gray-400'
              )}
            >
              {models.length} {t('modelManager.library.available', 'available')}
            </span>
          )}
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
                placeholder={t(
                  'modelManager.huggingface.search',
                  'Search HuggingFace models...'
                )}
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

            <select
              value={task}
              onChange={event => setTask(event.target.value)}
              className={cn(
                'px-3 py-2 rounded-lg border text-sm min-w-[160px]',
                'bg-gray-50 dark:bg-dark-50',
                'border-gray-200 dark:border-dark-300',
                'text-gray-900 dark:text-dark-700',
                'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
              )}
            >
              <option value='text-generation'>
                {t('modelManager.huggingface.tasks.textGen', 'Text Generation')}
              </option>
              <option value='text-to-speech'>
                {t('modelManager.huggingface.tasks.tts', 'Text to Speech')}
              </option>
              <option value='text-to-image'>
                {t('modelManager.huggingface.tasks.image', 'Text to Image')}
              </option>
              <option value='automatic-speech-recognition'>
                {t('modelManager.huggingface.tasks.stt', 'Speech Recognition')}
              </option>
            </select>

            <select
              value={sort}
              onChange={event => setSort(event.target.value)}
              className={cn(
                'px-3 py-2 rounded-lg border text-sm min-w-[140px]',
                'bg-gray-50 dark:bg-dark-50',
                'border-gray-200 dark:border-dark-300',
                'text-gray-900 dark:text-dark-700',
                'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
              )}
            >
              <option value='downloads'>
                {t('modelManager.huggingface.sort.downloads', 'Most Downloads')}
              </option>
              <option value='likes'>
                {t('modelManager.huggingface.sort.likes', 'Most Liked')}
              </option>
              <option value='lastModified'>
                {t('modelManager.huggingface.sort.recent', 'Recently Updated')}
              </option>
            </select>
          </div>

          {!canInstallModels && (
            <p className='text-xs text-amber-700 dark:text-amber-300'>
              {t('modelManager.pull.restricted')}
            </p>
          )}

          {loadingModels ? (
            <div className='flex items-center justify-center py-8'>
              <Loader className='h-5 w-5 animate-spin text-gray-400' />
            </div>
          ) : models.length === 0 ? (
            <div className='text-center py-8 text-gray-500'>
              {t(
                'modelManager.huggingface.noResults',
                'No models found. Try adjusting your search or filters.'
              )}
            </div>
          ) : (
            <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
              {models.map(model => (
                <HuggingFaceModelCard
                  key={model.id}
                  model={model}
                  expanded={expandedModelId === model.id}
                  loadingGguf={loadingGgufModelId === model.id}
                  ggufFiles={ggufFiles[model.id] || []}
                  pullingModel={pullingModel}
                  pullProgress={pullProgress}
                  canInstallModels={canInstallModels}
                  onToggle={() => onToggleModel(model.id)}
                  onPullGguf={onPullGguf}
                  onCancelPull={onCancelPull}
                />
              ))}
            </div>
          )}

          <div className='flex items-center justify-between pt-2'>
            <a
              href='https://huggingface.co/models'
              target='_blank'
              rel='noopener noreferrer'
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                'text-primary-600 dark:text-primary-400',
                'hover:underline'
              )}
            >
              <ExternalLink className='h-3 w-3' />
              {t(
                'modelManager.huggingface.browseAll',
                'Browse all on HuggingFace'
              )}
            </a>
            <Button
              onClick={onRefresh}
              variant='outline'
              size='sm'
              disabled={loadingModels}
              className={cn('gap-1.5', '', '')}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', loadingModels && 'animate-spin')}
              />
              {t('modelManager.library.refresh', 'Refresh')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface HuggingFaceModelCardProps {
  model: HuggingFaceModel;
  expanded: boolean;
  loadingGguf: boolean;
  ggufFiles: GgufFileInfo[];
  pullingModel: string | null;
  pullProgress: HfPullProgress | null;
  canInstallModels: boolean;
  onToggle: () => void;
  onPullGguf: (ollamaCommand: string, filename: string) => void;
  onCancelPull: () => void;
}

function HuggingFaceModelCard({
  model,
  expanded,
  loadingGguf,
  ggufFiles,
  pullingModel,
  pullProgress,
  canInstallModels,
  onToggle,
  onPullGguf,
  onCancelPull,
}: HuggingFaceModelCardProps) {
  const { t } = useTranslation();

  return (
    <div
      className={cn(
        'rounded-lg border transition-all overflow-hidden',
        'bg-gray-50 dark:bg-dark-50',
        'border-gray-200 dark:border-dark-300',
        'hover:shadow-md hover:border-gray-300 dark:hover:border-dark-400'
      )}
    >
      <div className='p-4 cursor-pointer' onClick={onToggle}>
        <div className='flex items-start justify-between gap-2 mb-2'>
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-2'>
              <h4 className='font-medium text-gray-900 dark:text-dark-800 truncate'>
                {model.id}
              </h4>
              {model.gated && (
                <span
                  className={cn(
                    'px-1.5 py-0.5 rounded text-xs',
                    'bg-yellow-100 dark:bg-yellow-900/30',
                    'text-yellow-700 dark:text-yellow-400'
                  )}
                >
                  {t('modelManager.huggingface.gated', 'Gated')}
                </span>
              )}
            </div>
            <p className='text-xs text-gray-500 dark:text-dark-600 mt-0.5'>
              {t('modelManager.huggingface.by', 'by')} {model.author}
            </p>
          </div>
          <div className='flex items-center gap-2 flex-shrink-0'>
            <a
              href={`https://huggingface.co/${model.id}`}
              target='_blank'
              rel='noopener noreferrer'
              onClick={event => event.stopPropagation()}
              className='p-1.5 rounded-lg hover:bg-gray-200 dark:hover:bg-dark-300 transition-colors'
              title={t(
                'modelManager.huggingface.viewOnHF',
                'View on HuggingFace'
              )}
            >
              <ExternalLink className='h-4 w-4 text-gray-400 dark:text-gray-500' />
            </a>
            <ChevronDown
              className={cn(
                'h-4 w-4 text-gray-400 transition-transform',
                expanded && 'rotate-180'
              )}
            />
          </div>
        </div>

        <div className='flex items-center gap-3 text-xs text-gray-500 dark:text-dark-600'>
          <span className='flex items-center gap-1'>
            <Download className='h-3.5 w-3.5' />
            {formatCompactCount(model.downloads)}
          </span>
          <span className='flex items-center gap-1'>
            <Heart className='h-3.5 w-3.5' />
            {formatCompactCount(model.likes)}
          </span>
          {model.pipeline_tag && (
            <span
              className={cn(
                'px-1.5 py-0.5 rounded',
                'bg-gray-200 dark:bg-dark-300'
              )}
            >
              {model.pipeline_tag}
            </span>
          )}
        </div>
      </div>

      {expanded && (
        <GgufFilesPanel
          modelId={model.id}
          loading={loadingGguf}
          files={ggufFiles}
          pullingModel={pullingModel}
          pullProgress={pullProgress}
          canInstallModels={canInstallModels}
          onPullGguf={onPullGguf}
          onCancelPull={onCancelPull}
        />
      )}
    </div>
  );
}

interface GgufFilesPanelProps {
  modelId: string;
  loading: boolean;
  files: GgufFileInfo[];
  pullingModel: string | null;
  pullProgress: HfPullProgress | null;
  canInstallModels: boolean;
  onPullGguf: (ollamaCommand: string, filename: string) => void;
  onCancelPull: () => void;
}

function GgufFilesPanel({
  modelId,
  loading,
  files,
  pullingModel,
  pullProgress,
  canInstallModels,
  onPullGguf,
  onCancelPull,
}: GgufFilesPanelProps) {
  const { t } = useTranslation();

  return (
    <div className='px-4 pb-4 pt-1 border-t border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100'>
      {loading ? (
        <div className='flex items-center justify-center py-4'>
          <Loader className='h-4 w-4 animate-spin text-gray-400' />
          <span className='ml-2 text-xs text-gray-500'>
            {t('modelManager.huggingface.checkingGguf')}
          </span>
        </div>
      ) : files.length === 0 ? (
        <div className='py-4 text-center text-xs text-gray-500 dark:text-gray-400'>
          {t('modelManager.huggingface.noGgufAvailable')}
        </div>
      ) : (
        <div className='space-y-2'>
          <div className='text-xs font-medium text-gray-600 dark:text-gray-300 mb-2'>
            {t('modelManager.huggingface.ggufFilesCount', {
              count: files.length,
            })}
          </div>
          {files.map(file => (
            <GgufFileRow
              key={file.filename}
              file={file}
              pulling={pullingModel === file.ollamaCommand}
              pullProgress={pullProgress}
              canInstallModels={canInstallModels}
              disabled={!!pullingModel || !canInstallModels}
              onPullGguf={onPullGguf}
              onCancelPull={onCancelPull}
            />
          ))}

          {pullingModel?.startsWith('hf.co/') &&
            pullingModel.includes(modelId) &&
            pullProgress?.percent !== undefined && (
              <div className='w-full bg-gray-200 dark:bg-dark-300 rounded-full h-1.5 overflow-hidden mt-2'>
                <div
                  className='h-1.5 rounded-full bg-primary-500 transition-all duration-300'
                  style={{
                    width: `${pullProgress.percent}%`,
                  }}
                />
              </div>
            )}
        </div>
      )}
    </div>
  );
}

interface GgufFileRowProps {
  file: GgufFileInfo;
  pulling: boolean;
  disabled: boolean;
  canInstallModels: boolean;
  pullProgress: HfPullProgress | null;
  onPullGguf: (ollamaCommand: string, filename: string) => void;
  onCancelPull: () => void;
}

function GgufFileRow({
  file,
  pulling,
  disabled,
  pullProgress,
  onPullGguf,
  onCancelPull,
}: GgufFileRowProps) {
  const { t } = useTranslation();

  return (
    <div className='flex items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-dark-50 border border-gray-200 dark:border-dark-300'>
      <div className='flex-1 min-w-0'>
        <div className='text-xs font-medium text-gray-800 dark:text-gray-200 truncate'>
          {file.filename}
        </div>
        <div className='flex items-center gap-2 mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
          <span>{file.sizeFormatted}</span>
          {file.quantization && (
            <span className='px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'>
              {file.quantization}
            </span>
          )}
        </div>
      </div>
      {pulling ? (
        <div className='flex items-center gap-2'>
          <div className='text-xs text-gray-500 w-12 text-right'>
            {pullProgress?.percent !== undefined
              ? `${pullProgress.percent}%`
              : '...'}
          </div>
          <button
            onClick={event => {
              event.stopPropagation();
              onCancelPull();
            }}
            className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
          >
            <X className='h-4 w-4' />
          </button>
        </div>
      ) : (
        <button
          onClick={event => {
            event.stopPropagation();
            onPullGguf(file.ollamaCommand, file.filename);
          }}
          disabled={disabled}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-medium',
            'bg-primary-100 dark:bg-primary-900/30',
            'text-primary-700 dark:text-primary-400',
            'hover:bg-primary-200 dark:hover:bg-primary-900/50',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <Download className='h-3 w-3 inline mr-1' />
          {t('models.pull')}
        </button>
      )}
    </div>
  );
}

function formatCompactCount(count: number): string | number {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }

  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }

  return count;
}
