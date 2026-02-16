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

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  huggingfaceHubApi,
  ollamaApi,
  HuggingFaceModel,
  GgufFileInfo,
} from '@/utils/api';
import { Button } from '@/components/ui/Button';
import {
  Search,
  X,
  Download,
  Heart,
  ExternalLink,
  Zap,
  Filter,
  TrendingUp,
  Check,
  Loader,
  ChevronDown,
} from '@/components/icons';
import toast from 'react-hot-toast';
import { cn } from '@/utils';
import { useAuthStore } from '@/store/authStore';

interface HuggingFaceModelBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectModel?: (modelId: string) => void;
  selectedModels?: string[];
}

type SortOption = 'downloads' | 'likes' | 'lastModified';
type TaskOption =
  | 'text-generation'
  | 'text-to-speech'
  | 'text-to-image'
  | 'automatic-speech-recognition';

const TASK_OPTIONS: { value: TaskOption; label: string }[] = [
  { value: 'text-generation', label: 'Text Generation' },
  { value: 'text-to-speech', label: 'Text to Speech' },
  { value: 'text-to-image', label: 'Text to Image' },
  { value: 'automatic-speech-recognition', label: 'Speech Recognition' },
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'downloads', label: 'Most Downloads' },
  { value: 'likes', label: 'Most Liked' },
  { value: 'lastModified', label: 'Recently Updated' },
];

export const HuggingFaceModelBrowser: React.FC<
  HuggingFaceModelBrowserProps
> = ({ isOpen, onClose, onSelectModel, selectedModels = [] }) => {
  const { t } = useTranslation();
  const { user, systemInfo } = useAuthStore();
  const canInstallModels =
    user?.role === 'admin' || (systemInfo?.allowUserModelPull ?? true);
  const [models, setModels] = useState<HuggingFaceModel[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [task, setTask] = useState<TaskOption>('text-generation');
  const [sort, setSort] = useState<SortOption>('downloads');
  const [showFilters, setShowFilters] = useState(false);

  // GGUF state
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [ggufFiles, setGgufFiles] = useState<Record<string, GgufFileInfo[]>>(
    {}
  );
  const [loadingGguf, setLoadingGguf] = useState<string | null>(null);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<{
    status: string;
    percent?: number;
  } | null>(null);
  const [cancelPull, setCancelPull] = useState<(() => void) | null>(null);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchModels = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await huggingfaceHubApi.getModels({
        task,
        search: debouncedSearch || undefined,
        sort,
        limit: 50,
      });

      if (response.success && response.data) {
        setModels(response.data);
      } else {
        setError(response.error || 'Failed to fetch models');
      }
    } catch (_err) {
      setError('Failed to connect to HuggingFace Hub');
    } finally {
      setIsLoading(false);
    }
  }, [task, debouncedSearch, sort]);

  useEffect(() => {
    if (isOpen) {
      fetchModels();
    }
  }, [isOpen, fetchModels]);

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const handleSelectModel = (modelId: string) => {
    if (onSelectModel) {
      onSelectModel(modelId);
    }
  };

  const isModelSelected = (modelId: string) => selectedModels.includes(modelId);

  // Load GGUF files for a HuggingFace model
  const loadGgufFiles = useCallback(async (modelId: string) => {
    const [author, modelName] = modelId.split('/');
    if (!author || !modelName) return;

    setLoadingGguf(modelId);
    try {
      const response = await huggingfaceHubApi.getGgufFiles(author, modelName);
      if (response.success && response.data) {
        setGgufFiles(prev => ({ ...prev, [modelId]: response.data! }));
      }
    } catch (error) {
      console.error('Failed to load GGUF files:', error);
    } finally {
      setLoadingGguf(null);
    }
  }, []);

  // Toggle expanded model and load GGUF files
  const handleToggleModel = useCallback(
    (modelId: string) => {
      if (expandedModel === modelId) {
        setExpandedModel(null);
      } else {
        setExpandedModel(modelId);
        if (!ggufFiles[modelId]) {
          loadGgufFiles(modelId);
        }
      }
    },
    [expandedModel, ggufFiles, loadGgufFiles]
  );

  // Pull a GGUF model from HuggingFace via Ollama
  const handlePullGguf = useCallback(
    (ollamaCommand: string, filename: string) => {
      if (!canInstallModels) {
        toast.error(t('modelSelector.pullRestricted'));
        return;
      }
      if (pullingModel) return;

      setPullingModel(ollamaCommand);
      setPullProgress({ status: 'starting' });

      try {
        const cancelFn = ollamaApi.pullModelStream(
          ollamaCommand,
          progress => {
            setPullProgress(progress);
          },
          () => {
            setPullProgress(null);
            setPullingModel(null);
            setCancelPull(null);
            toast.success(`Downloaded ${filename}`);
          },
          error => {
            setPullProgress(null);
            setPullingModel(null);
            setCancelPull(null);
            toast.error(`Failed to download: ${error}`);
          }
        );
        setCancelPull(() => cancelFn);
      } catch (_error) {
        setPullProgress(null);
        setPullingModel(null);
        toast.error('Failed to start download');
      }
    },
    [canInstallModels, pullingModel, t]
  );

  // Cancel in-progress pull
  const handleCancelPull = useCallback(() => {
    if (cancelPull) {
      cancelPull();
      setCancelPull(null);
      setPullingModel(null);
      setPullProgress(null);
    }
  }, [cancelPull]);

  if (!isOpen) return null;

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm'>
      <div className='relative w-full max-w-4xl max-h-[90vh] bg-white dark:bg-dark-100 rounded-xl shadow-2xl flex flex-col overflow-hidden'>
        {/* Header */}
        <div className='flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-dark-300'>
          <div className='flex items-center gap-3'>
            <div className='p-2 bg-yellow-100 dark:bg-yellow-900/30 rounded-lg'>
              <Zap className='w-5 h-5 text-yellow-600 dark:text-yellow-400' />
            </div>
            <div>
              <h2 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
                {t('huggingface.title')}
              </h2>
              <p className='text-sm text-gray-500 dark:text-dark-600'>
                {t('huggingface.subtitle')}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className='p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
          >
            <X className='w-5 h-5 text-gray-500 dark:text-dark-600' />
          </button>
        </div>

        {/* Search and Filters */}
        <div className='px-6 py-4 border-b border-gray-200 dark:border-dark-300 space-y-4'>
          {/* Search Bar */}
          <div className='relative'>
            <Search className='absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 dark:text-dark-500' />
            <input
              type='text'
              placeholder={t('huggingface.searchPlaceholder')}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className='w-full pl-10 pr-4 py-2.5 bg-gray-100 dark:bg-dark-50 border border-gray-200 dark:border-dark-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-gray-900 dark:text-dark-800 placeholder-gray-500 dark:placeholder-dark-500'
            />
          </div>

          {/* Filter Toggle */}
          <div className='flex items-center justify-between'>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className='flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-200 rounded-lg transition-colors'
            >
              <Filter className='w-4 h-4' />
              {t('huggingface.filters')}
            </button>
            <div className='text-sm text-gray-500 dark:text-dark-600'>
              {models.length} {t('huggingface.modelsFound')}
            </div>
          </div>

          {/* Expanded Filters */}
          {showFilters && (
            <div className='flex flex-wrap gap-4'>
              {/* Task Filter */}
              <div className='flex-1 min-w-[200px]'>
                <label className='block text-xs font-medium text-gray-500 dark:text-dark-600 mb-1'>
                  {t('huggingface.task')}
                </label>
                <select
                  value={task}
                  onChange={e => setTask(e.target.value as TaskOption)}
                  className='w-full px-3 py-2 bg-gray-100 dark:bg-dark-50 border border-gray-200 dark:border-dark-300 rounded-lg text-sm text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-blue-500 outline-none'
                >
                  {TASK_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sort Filter */}
              <div className='flex-1 min-w-[200px]'>
                <label className='block text-xs font-medium text-gray-500 dark:text-dark-600 mb-1'>
                  {t('huggingface.sortBy')}
                </label>
                <select
                  value={sort}
                  onChange={e => setSort(e.target.value as SortOption)}
                  className='w-full px-3 py-2 bg-gray-100 dark:bg-dark-50 border border-gray-200 dark:border-dark-300 rounded-lg text-sm text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-blue-500 outline-none'
                >
                  {SORT_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Model List */}
        <div className='flex-1 overflow-y-auto px-6 py-4'>
          {!canInstallModels && (
            <div className='mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300'>
              {t('modelSelector.pullRestricted')}
            </div>
          )}
          {isLoading ? (
            <div className='flex items-center justify-center py-12'>
              <Loader className='w-8 h-8 text-blue-500 animate-spin' />
            </div>
          ) : error ? (
            <div className='flex flex-col items-center justify-center py-12'>
              <p className='text-red-500 dark:text-red-400 mb-4'>{error}</p>
              <Button onClick={fetchModels} variant='outline' size='sm'>
                {t('common.retry')}
              </Button>
            </div>
          ) : models.length === 0 ? (
            <div className='flex flex-col items-center justify-center py-12 text-gray-500 dark:text-dark-600'>
              <Search className='w-12 h-12 mb-4 opacity-50' />
              <p>{t('huggingface.noModels')}</p>
              <p className='text-sm'>{t('huggingface.adjustSearch')}</p>
            </div>
          ) : (
            <div className='space-y-3'>
              {models.map(model => {
                const isExpanded = expandedModel === model.id;
                const modelGgufFiles = ggufFiles[model.id] || [];
                const isLoadingGguf = loadingGguf === model.id;

                return (
                  <div
                    key={model.id}
                    className={`rounded-lg border transition-all ${
                      isModelSelected(model.id)
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                        : 'border-gray-200 dark:border-dark-300 hover:border-gray-300 dark:hover:border-dark-400'
                    }`}
                  >
                    {/* Model header - clickable to expand */}
                    <div
                      className='p-4 cursor-pointer'
                      onClick={() => handleToggleModel(model.id)}
                    >
                      <div className='flex items-start justify-between gap-4'>
                        <div className='flex-1 min-w-0'>
                          <div className='flex items-center gap-2 mb-1'>
                            <h3 className='font-medium text-gray-900 dark:text-dark-800 truncate'>
                              {model.id}
                            </h3>
                            {model.gated && (
                              <span className='px-1.5 py-0.5 text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 rounded'>
                                {t('huggingface.gated')}
                              </span>
                            )}
                          </div>
                          <p className='text-sm text-gray-500 dark:text-dark-600 mb-2'>
                            by {model.author}
                          </p>
                          <div className='flex items-center gap-4 text-sm text-gray-500 dark:text-dark-600'>
                            <span className='flex items-center gap-1'>
                              <Download className='w-4 h-4' />
                              {formatNumber(model.downloads)}
                            </span>
                            <span className='flex items-center gap-1'>
                              <Heart className='w-4 h-4' />
                              {formatNumber(model.likes)}
                            </span>
                            {model.pipeline_tag && (
                              <span className='px-2 py-0.5 bg-gray-100 dark:bg-dark-200 rounded text-xs'>
                                {model.pipeline_tag}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className='flex items-center gap-2'>
                          <a
                            href={`https://huggingface.co/${model.id}`}
                            target='_blank'
                            rel='noopener noreferrer'
                            className='p-2 text-gray-400 hover:text-gray-600 dark:text-dark-500 dark:hover:text-dark-700 transition-colors'
                            title='View on HuggingFace'
                            onClick={e => e.stopPropagation()}
                          >
                            <ExternalLink className='w-4 h-4' />
                          </a>
                          {onSelectModel && (
                            <Button
                              onClick={e => {
                                e.stopPropagation();
                                handleSelectModel(model.id);
                              }}
                              variant={
                                isModelSelected(model.id)
                                  ? 'primary'
                                  : 'outline'
                              }
                              size='sm'
                            >
                              {isModelSelected(model.id) ? (
                                <>
                                  <Check className='w-4 h-4 mr-1' />
                                  {t('huggingface.selected')}
                                </>
                              ) : (
                                t('huggingface.select')
                              )}
                            </Button>
                          )}
                          <ChevronDown
                            className={cn(
                              'w-5 h-5 text-gray-400 transition-transform',
                              isExpanded && 'rotate-180'
                            )}
                          />
                        </div>
                      </div>
                    </div>

                    {/* Expanded GGUF files section */}
                    {isExpanded && (
                      <div className='px-4 pb-4 pt-2 border-t border-gray-100 dark:border-dark-200 bg-gray-50 dark:bg-dark-50'>
                        {isLoadingGguf ? (
                          <div className='flex items-center justify-center py-4'>
                            <Loader className='w-4 h-4 animate-spin text-gray-400' />
                            <span className='ml-2 text-xs text-gray-500'>
                              {t(
                                'modelManager.huggingface.checkingGguf',
                                'Checking for GGUF files...'
                              )}
                            </span>
                          </div>
                        ) : modelGgufFiles.length === 0 ? (
                          <div className='py-4 text-center text-xs text-gray-500 dark:text-gray-400'>
                            {t(
                              'modelManager.huggingface.noGgufAvailable',
                              'No GGUF files available for direct Ollama pull'
                            )}
                          </div>
                        ) : (
                          <div className='space-y-2'>
                            <div className='text-xs font-medium text-gray-600 dark:text-gray-300 mb-2'>
                              {t('modelManager.huggingface.ggufFilesCount', {
                                count: modelGgufFiles.length,
                                defaultValue: `GGUF Files (${modelGgufFiles.length}) - Pull directly to Ollama`,
                              })}
                            </div>
                            {modelGgufFiles.map(file => {
                              const isPullingThis =
                                pullingModel === file.ollamaCommand;

                              return (
                                <div
                                  key={file.filename}
                                  className='flex items-center gap-3 p-3 rounded-lg bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300'
                                >
                                  <div className='flex-1 min-w-0'>
                                    <div className='text-sm font-medium text-gray-800 dark:text-gray-200 truncate'>
                                      {file.filename}
                                    </div>
                                    <div className='flex items-center gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400'>
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
                                        onClick={e => {
                                          e.stopPropagation();
                                          handleCancelPull();
                                        }}
                                        className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                                      >
                                        <X className='w-4 h-4' />
                                      </button>
                                    </div>
                                  ) : canInstallModels ? (
                                    <button
                                      onClick={e => {
                                        e.stopPropagation();
                                        handlePullGguf(
                                          file.ollamaCommand,
                                          file.filename
                                        );
                                      }}
                                      disabled={!!pullingModel}
                                      className={cn(
                                        'px-3 py-1.5 rounded-lg text-xs font-medium',
                                        'bg-blue-100 dark:bg-blue-900/30',
                                        'text-blue-700 dark:text-blue-400',
                                        'hover:bg-blue-200 dark:hover:bg-blue-900/50',
                                        'disabled:opacity-50 disabled:cursor-not-allowed'
                                      )}
                                    >
                                      <Download className='w-3 h-3 inline mr-1' />
                                      {t('models.pull', 'Pull')}
                                    </button>
                                  ) : (
                                    <span className='px-2 py-1 rounded text-[11px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'>
                                      {t('modelSelector.adminOnlyPull')}
                                    </span>
                                  )}
                                </div>
                              );
                            })}

                            {/* Pull progress bar */}
                            {pullingModel?.startsWith('hf.co/') &&
                              pullingModel.includes(model.id) &&
                              pullProgress?.percent !== undefined && (
                                <div className='w-full bg-gray-200 dark:bg-dark-300 rounded-full h-1.5 overflow-hidden mt-2'>
                                  <div
                                    className='h-1.5 rounded-full bg-blue-500 transition-all duration-300'
                                    style={{
                                      width: `${pullProgress.percent}%`,
                                    }}
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

        {/* Footer */}
        <div className='px-6 py-4 border-t border-gray-200 dark:border-dark-300 bg-gray-50 dark:bg-dark-50'>
          <div className='flex items-center justify-between'>
            <p className='text-sm text-gray-500 dark:text-dark-600'>
              Powered by{' '}
              <a
                href='https://huggingface.co'
                target='_blank'
                rel='noopener noreferrer'
                className='text-blue-500 hover:underline'
              >
                HuggingFace Hub
              </a>
            </p>
            <div className='flex items-center gap-2'>
              <Button onClick={fetchModels} variant='outline' size='sm'>
                <TrendingUp className='w-4 h-4 mr-1' />
                {t('huggingface.refresh')}
              </Button>
              <Button onClick={onClose} variant='outline' size='sm'>
                {t('common.close')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HuggingFaceModelBrowser;
