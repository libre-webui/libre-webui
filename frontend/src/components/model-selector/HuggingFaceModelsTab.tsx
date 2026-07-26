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
  Download,
  ExternalLink,
  Heart,
  Loader,
  RefreshCw,
  X,
  Zap,
} from 'lucide-react';
import type { GgufFileInfo, HuggingFaceModel } from '@/utils/api';
import { cn } from '@/utils';
import type { PullProgress } from './types';

interface HuggingFaceModelsTabProps {
  hfTask: string;
  hfSort: string;
  canInstallModels: boolean;
  loadingHf: boolean;
  hfModels: HuggingFaceModel[];
  expandedHfModel: string | null;
  hfGgufFiles: Record<string, GgufFileInfo[]>;
  loadingGguf: string | null;
  pullingModel: string | null;
  pullProgress: PullProgress | null;
  setHfTask: (task: string) => void;
  setHfSort: (sort: string) => void;
  onToggleHfModel: (modelId: string) => void;
  onPullHfGguf: (ollamaCommand: string, filename: string) => void;
  onCancelPull: () => void;
  onRefreshHfModels: () => void;
}

function formatNumber(num: number): string {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toString();
}

export function HuggingFaceModelsTab({
  hfTask,
  hfSort,
  canInstallModels,
  loadingHf,
  hfModels,
  expandedHfModel,
  hfGgufFiles,
  loadingGguf,
  pullingModel,
  pullProgress,
  setHfTask,
  setHfSort,
  onToggleHfModel,
  onPullHfGguf,
  onCancelPull,
  onRefreshHfModels,
}: HuggingFaceModelsTabProps) {
  const { t } = useTranslation();

  return (
    <div className='flex-1 flex flex-col overflow-hidden'>
      <div className='px-3 py-2 border-b border-gray-200 dark:border-dark-300 flex-shrink-0 space-y-2'>
        <div className='flex gap-2'>
          <select
            value={hfTask}
            onChange={e => setHfTask(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            className='flex-1 px-2 py-1.5 rounded-lg border text-xs bg-gray-50 dark:bg-dark-50 border-gray-200 dark:border-dark-300 text-gray-900 dark:text-gray-100'
          >
            <option value='text-generation'>
              {t('modelManager.huggingface.taskTextGeneration')}
            </option>
            <option value='text-to-speech'>
              {t('modelManager.huggingface.taskTextToSpeech')}
            </option>
            <option value='text-to-image'>
              {t('modelManager.huggingface.taskTextToImage')}
            </option>
            <option value='automatic-speech-recognition'>
              {t('modelManager.huggingface.taskSpeechRecognition')}
            </option>
          </select>
          <select
            value={hfSort}
            onChange={e => setHfSort(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            className='px-2 py-1.5 rounded-lg border text-xs bg-gray-50 dark:bg-dark-50 border-gray-200 dark:border-dark-300 text-gray-900 dark:text-gray-100'
          >
            <option value='downloads'>
              {t('modelManager.huggingface.sortDownloads')}
            </option>
            <option value='likes'>
              {t('modelManager.huggingface.sortLikes')}
            </option>
            <option value='lastModified'>
              {t('modelManager.huggingface.sortRecent')}
            </option>
          </select>
        </div>
      </div>

      <div className='scroll-region min-h-0 flex-1 scrollbar-thin'>
        {!canInstallModels && (
          <div className='mx-3 mb-1 mt-3 rounded-lg border border-amber-200 bg-amber-500/10 px-3 py-2 text-xs text-ink dark:border-amber-800 dark:bg-amber-900/20'>
            {t('modelSelector.pullRestricted')}
          </div>
        )}
        {loadingHf ? (
          <div className='flex items-center justify-center py-12'>
            <Loader className='h-6 w-6 animate-spin text-gray-400' />
          </div>
        ) : hfModels.length === 0 ? (
          <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400'>
            <Zap className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600' />
            <p className='text-sm'>
              {t('modelManager.huggingface.noModelsFound')}
            </p>
          </div>
        ) : (
          <div className='divide-y divide-gray-100 dark:divide-dark-200'>
            {hfModels.map(model => {
              const isExpanded = expandedHfModel === model.id;
              const ggufFiles = hfGgufFiles[model.id] || [];
              const isLoadingGguf = loadingGguf === model.id;

              return (
                <div key={model.id} className='bg-white dark:bg-dark-100'>
                  <div
                    className='px-3 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-dark-200'
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      onToggleHfModel(model.id);
                    }}
                  >
                    <div className='flex items-start gap-3'>
                      <div className='flex-shrink-0 rounded-lg bg-yellow-500/20 p-2 dark:bg-yellow-900/30'>
                        <Zap className='h-4 w-4 text-yellow-600 dark:text-yellow-400' />
                      </div>
                      <div className='flex-1 min-w-0'>
                        <div className='flex items-center gap-2'>
                          <h4
                            dir='ltr'
                            className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'
                          >
                            {model.id}
                          </h4>
                          {model.gated && (
                            <span className='rounded bg-yellow-500/20 px-1.5 py-0.5 text-xs text-ink dark:bg-yellow-900/30'>
                              Gated
                            </span>
                          )}
                        </div>
                        <p className='text-xs text-gray-500 dark:text-gray-400 mt-0.5'>
                          by {model.author}
                        </p>
                        <div className='flex items-center gap-3 mt-1.5 text-xs text-gray-400 dark:text-gray-500'>
                          <span className='flex items-center gap-1'>
                            <Download className='h-3 w-3' />
                            {formatNumber(model.downloads)}
                          </span>
                          <span className='flex items-center gap-1'>
                            <Heart className='h-3 w-3' />
                            {formatNumber(model.likes)}
                          </span>
                          {model.pipeline_tag && (
                            <span className='px-1.5 py-0.5 rounded bg-gray-100 dark:bg-dark-200'>
                              {model.pipeline_tag}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className='flex items-center gap-2 flex-shrink-0'>
                        <a
                          href={`https://huggingface.co/${model.id}`}
                          target='_blank'
                          rel='noopener noreferrer'
                          onMouseDown={e => e.stopPropagation()}
                          className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
                        >
                          <ExternalLink className='h-4 w-4 text-gray-400' />
                        </a>
                        <ChevronDown
                          className={cn(
                            'h-4 w-4 text-gray-400 transition-transform',
                            isExpanded && 'rotate-180'
                          )}
                        />
                      </div>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className='px-3 pb-3 pt-1 border-t border-gray-100 dark:border-dark-200 bg-gray-50 dark:bg-dark-200'>
                      {isLoadingGguf ? (
                        <div className='flex items-center justify-center py-4'>
                          <Loader className='h-4 w-4 animate-spin text-gray-400' />
                          <span className='ml-2 text-xs text-gray-500'>
                            {t('modelManager.huggingface.checkingGguf')}
                          </span>
                        </div>
                      ) : ggufFiles.length === 0 ? (
                        <div className='py-4 text-center text-xs text-gray-500 dark:text-gray-400'>
                          {t('modelManager.huggingface.noGgufAvailable')}
                        </div>
                      ) : (
                        <div className='space-y-2'>
                          <div className='text-xs font-medium text-gray-600 dark:text-gray-300 mb-2'>
                            {t('modelManager.huggingface.ggufFilesCount', {
                              count: ggufFiles.length,
                            })}
                          </div>
                          {ggufFiles.map(file => {
                            const isPullingThis =
                              pullingModel === file.ollamaCommand;

                            return (
                              <div
                                key={file.filename}
                                className='flex items-center gap-2 p-2 rounded-lg bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300'
                              >
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
                                {isPullingThis ? (
                                  <div className='flex items-center gap-2'>
                                    <div className='text-xs text-gray-500 w-12 text-right'>
                                      {pullProgress?.percent !== undefined
                                        ? `${pullProgress.percent}%`
                                        : '...'}
                                    </div>
                                    <button
                                      onMouseDown={e => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        onCancelPull();
                                      }}
                                      className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                                    >
                                      <X className='h-4 w-4' />
                                    </button>
                                  </div>
                                ) : canInstallModels ? (
                                  <button
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      onPullHfGguf(
                                        file.ollamaCommand,
                                        file.filename
                                      );
                                    }}
                                    disabled={!!pullingModel}
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
                                ) : (
                                  <span className='rounded bg-amber-500/20 px-2 py-1 text-[11px] font-medium text-ink dark:bg-amber-900/30'>
                                    {t('modelSelector.adminOnlyPull')}
                                  </span>
                                )}
                              </div>
                            );
                          })}

                          {pullingModel?.startsWith('hf.co/') &&
                            pullingModel.includes(model.id) &&
                            pullProgress?.percent !== undefined && (
                              <div className='w-full bg-gray-200 dark:bg-dark-300 rounded-full h-1.5 overflow-hidden mt-2'>
                                <div
                                  className='h-1.5 rounded-full bg-primary-500 transition-all duration-300'
                                  style={{ width: `${pullProgress.percent}%` }}
                                />
                              </div>
                            )}
                        </div>
                      )}
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
          href='https://huggingface.co/models'
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
            onRefreshHfModels();
          }}
          className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200'
        >
          <RefreshCw
            className={cn(
              'h-3.5 w-3.5 text-gray-400',
              loadingHf && 'animate-spin'
            )}
          />
        </button>
      </div>
    </div>
  );
}
