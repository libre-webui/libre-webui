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

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  ollamaApi,
  huggingfaceHubApi,
  HuggingFaceModel,
  GgufFileInfo,
} from '@/utils/api';
import { Button } from '@/components/ui/Button';
import { RunningModel } from '@/types';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import {
  Download,
  Trash2,
  Info,
  RefreshCw,
  Activity,
  HardDrive,
  Cpu,
  Zap,
  Search,
  X,
  Server,
  Copy,
  FileCode,
  TestTube,
  ChevronDown,
  ChevronUp,
  Settings,
  Clock,
  Hash,
  Layers,
  MemoryStick,
  Gauge,
  ExternalLink,
  Cloud,
  Check,
  Filter,
  Heart,
  Loader,
} from 'lucide-react';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import type {
  LibraryModel,
  ModelDetails,
  ModelInfo,
} from './model-manager/types';

const logger = createLogger('components:model-manager');
const ModelManagerModals = React.lazy(
  () => import('./model-manager/ModelManagerModals')
);

const hasCloudPullTag = (modelName: string): boolean => {
  const tag = modelName.split(':').pop()?.toLowerCase();
  return tag === 'cloud' || tag?.endsWith('-cloud') === true;
};

const normalizeCloudPullName = (modelName: string): string => {
  const trimmedName = modelName.trim();
  if (!trimmedName || hasCloudPullTag(trimmedName)) {
    return trimmedName;
  }

  const tagSeparator = trimmedName.lastIndexOf(':');
  if (tagSeparator === -1) {
    return `${trimmedName}:cloud`;
  }

  const baseName = trimmedName.slice(0, tagSeparator);
  const tag = trimmedName.slice(tagSeparator + 1);
  return `${baseName}:${tag}-cloud`;
};

export const ModelManager: React.FC = () => {
  const { t } = useTranslation();
  const { user, systemInfo } = useAuthStore();
  const canInstallModels =
    user?.role === 'admin' || (systemInfo?.allowUserModelPull ?? true);
  const queryClient = useQueryClient();
  const [libraryFilter, setLibraryFilter] = useState<string>('all');
  const [librarySearch, setLibrarySearch] = useState('');
  const [pullModelName, setPullModelName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<{
    status: string;
    percent?: number;
    total?: number;
    completed?: number;
  } | null>(null);
  const [cancelPull, setCancelPull] = useState<(() => void) | null>(null);

  // Model details modal
  const [selectedModelDetails, setSelectedModelDetails] =
    useState<ModelDetails | null>(null);
  const [selectedModelName, setSelectedModelName] = useState<string>('');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Copy model
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copySource, setCopySource] = useState('');
  const [copyDestination, setCopyDestination] = useState('');
  const [copying, setCopying] = useState(false);

  // Create model
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModelName, setCreateModelName] = useState('');
  const [createModelfile, setCreateModelfile] = useState('');
  const [creating, setCreating] = useState(false);

  // Embeddings test
  const [showEmbeddingsModal, setShowEmbeddingsModal] = useState(false);
  const [embeddingsModel, setEmbeddingsModel] = useState('');
  const [embeddingsInput, setEmbeddingsInput] = useState('');
  const [embeddingsResult, setEmbeddingsResult] = useState<number[] | null>(
    null
  );
  const [generatingEmbeddings, setGeneratingEmbeddings] = useState(false);

  // HuggingFace Hub state
  const [hfSearch, setHfSearch] = useState('');
  const [hfDebouncedSearch, setHfDebouncedSearch] = useState('');
  const [hfTask, setHfTask] = useState<string>('text-generation');
  const [hfSort, setHfSort] = useState<string>('downloads');

  // HuggingFace GGUF state
  const [expandedHfModel, setExpandedHfModel] = useState<string | null>(null);
  const [hfGgufFiles, setHfGgufFiles] = useState<
    Record<string, GgufFileInfo[]>
  >({});
  const [loadingGguf, setLoadingGguf] = useState<string | null>(null);
  const [hfPullingModel, setHfPullingModel] = useState<string | null>(null);
  const [hfPullProgress, setHfPullProgress] = useState<{
    status: string;
    percent?: number;
  } | null>(null);
  const [cancelHfPull, setCancelHfPull] = useState<(() => void) | null>(null);

  // Expanded sections
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['pull', 'local'])
  );

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(section)) {
        newSet.delete(section);
      } else {
        newSet.add(section);
      }
      return newSet;
    });
  };

  // Models, running models, version, and health — combined query
  const {
    data: ollamaState,
    isLoading: loading,
    refetch: refetchOllamaState,
  } = useQuery({
    queryKey: ['ollama-state'],
    queryFn: async () => {
      const [modelsResponse, runningResponse, versionResponse, healthResponse] =
        await Promise.all([
          ollamaApi.getModels(),
          ollamaApi.listRunningModels(),
          ollamaApi.getVersion(),
          ollamaApi.checkHealth(),
        ]);
      return {
        models: modelsResponse.success ? modelsResponse.data || [] : [],
        runningModels: runningResponse.success
          ? Array.isArray(runningResponse.data)
            ? runningResponse.data
            : []
          : [],
        ollamaVersion:
          versionResponse.success && versionResponse.data
            ? versionResponse.data.version
            : null,
        isHealthy: healthResponse.success,
      };
    },
  });

  const models: ModelInfo[] = ollamaState?.models ?? [];
  const runningModels: RunningModel[] = ollamaState?.runningModels ?? [];
  const ollamaVersion = ollamaState?.ollamaVersion ?? null;
  const isHealthy = ollamaState?.isHealthy ?? null;

  const loadData = useCallback(async () => {
    await refetchOllamaState();
  }, [refetchOllamaState]);

  // Library models
  const { data: libraryModels = [], isLoading: loadingLibrary } = useQuery({
    queryKey: ['ollama-library'],
    queryFn: async (): Promise<LibraryModel[]> => {
      const response = await ollamaApi.getLibraryModels();
      return response.success && response.data ? response.data : [];
    },
  });

  // Cloud models live in a dedicated ollama.com listing; fetch them separately
  // so the category chips stay stable while the Cloud filter is active.
  const { data: cloudModels = [], isLoading: loadingCloud } = useQuery({
    queryKey: ['ollama-library', 'cloud'],
    queryFn: async (): Promise<LibraryModel[]> => {
      const response = await ollamaApi.getLibraryModels({ category: 'cloud' });
      return response.success && response.data ? response.data : [];
    },
    enabled: libraryFilter === 'cloud',
  });

  const loadLibraryModels = () =>
    queryClient.invalidateQueries({ queryKey: ['ollama-library'] });

  // HuggingFace search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      setHfDebouncedSearch(hfSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [hfSearch]);

  // HuggingFace models query
  const hfEnabled = expandedSections.has('huggingface');
  const { data: hfModels = [], isLoading: loadingHfModels } = useQuery({
    queryKey: ['hf-models', hfTask, hfDebouncedSearch, hfSort],
    queryFn: async (): Promise<HuggingFaceModel[]> => {
      const response = await huggingfaceHubApi.getModels({
        task: hfTask,
        search: hfDebouncedSearch || undefined,
        sort: hfSort as 'downloads' | 'likes' | 'lastModified',
        limit: 30,
      });
      return response.success && response.data ? response.data : [];
    },
    enabled: hfEnabled,
  });

  const loadHfModels = () =>
    queryClient.invalidateQueries({
      queryKey: ['hf-models', hfTask, hfDebouncedSearch, hfSort],
    });

  // Load GGUF files for a HuggingFace model
  const loadGgufFiles = useCallback(async (modelId: string) => {
    const [author, modelName] = modelId.split('/');
    if (!author || !modelName) return;

    setLoadingGguf(modelId);
    try {
      const response = await huggingfaceHubApi.getGgufFiles(author, modelName);
      if (response.success && response.data) {
        setHfGgufFiles(prev => ({ ...prev, [modelId]: response.data! }));
      }
    } catch (error) {
      logger.error('Failed to load GGUF files:', error);
    } finally {
      setLoadingGguf(null);
    }
  }, []);

  // Toggle expanded HF model and load GGUF files
  const handleToggleHfModel = useCallback(
    (modelId: string) => {
      if (expandedHfModel === modelId) {
        setExpandedHfModel(null);
      } else {
        setExpandedHfModel(modelId);
        if (!hfGgufFiles[modelId]) {
          loadGgufFiles(modelId);
        }
      }
    },
    [expandedHfModel, hfGgufFiles, loadGgufFiles]
  );

  // Pull a GGUF model from HuggingFace via Ollama
  const handlePullHfGguf = useCallback(
    (ollamaCommand: string, filename: string) => {
      if (!canInstallModels) {
        toast.error(t('modelManager.pull.restricted'));
        return;
      }
      if (hfPullingModel) return;

      setHfPullingModel(ollamaCommand);
      setHfPullProgress({ status: 'starting' });

      try {
        const cancelFn = ollamaApi.pullModelStream(
          ollamaCommand,
          progress => {
            setHfPullProgress(progress);
          },
          () => {
            setHfPullProgress(null);
            setHfPullingModel(null);
            setCancelHfPull(null);
            toast.success(`Downloaded ${filename}`);
            loadData();
          },
          error => {
            setHfPullProgress(null);
            setHfPullingModel(null);
            setCancelHfPull(null);
            toast.error(`Failed to download: ${error}`);
          }
        );
        setCancelHfPull(() => cancelFn);
      } catch (_error) {
        setHfPullProgress(null);
        setHfPullingModel(null);
        toast.error('Failed to start download');
      }
    },
    [canInstallModels, hfPullingModel, loadData, t]
  );

  const handleCancelHfPull = useCallback(() => {
    if (cancelHfPull) {
      cancelHfPull();
      setCancelHfPull(null);
      setHfPullingModel(null);
      setHfPullProgress(null);
    }
  }, [cancelHfPull]);

  const handlePullModel = async (
    modelName?: string,
    modelCategory?: string
  ) => {
    if (!canInstallModels) {
      toast.error(t('modelManager.pull.restricted'));
      return;
    }

    const rawName = modelName || pullModelName.trim();
    const shouldUseCloudName =
      modelCategory === 'cloud' || (!modelName && libraryFilter === 'cloud');
    const nameToUse = shouldUseCloudName
      ? normalizeCloudPullName(rawName)
      : rawName;

    if (!nameToUse) {
      toast.error(t('modelManager.pull.enterName'));
      return;
    }

    // If called with a model name from library, update the input field too
    if (modelName) {
      setPullModelName(nameToUse);
    }

    setPulling(true);
    setPullProgress({ status: 'starting' });

    try {
      const cancelFn = ollamaApi.pullModelStream(
        nameToUse,
        progress => {
          setPullProgress(progress);
        },
        () => {
          setPullProgress(null);
          setPulling(false);
          setCancelPull(null);
          toast.success(t('modelManager.pull.success', { name: nameToUse }));
          setPullModelName('');
          loadData();
        },
        error => {
          setPullProgress(null);
          setPulling(false);
          setCancelPull(null);
          toast.error(t('modelManager.pull.failed') + ': ' + error);
        }
      );
      setCancelPull(() => cancelFn);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('modelManager.pull.failed') + ': ' + errorMessage);
      setPullProgress(null);
      setPulling(false);
      setCancelPull(null);
    }
  };

  const handleCancelPull = () => {
    if (cancelPull) {
      cancelPull();
      setCancelPull(null);
      setPulling(false);
      setPullProgress(null);
      toast.success(t('modelManager.pull.cancelled'));
    }
  };

  const handleDeleteModel = async (modelName: string) => {
    if (!confirm(t('modelManager.local.deleteConfirm', { name: modelName }))) {
      return;
    }

    try {
      await ollamaApi.deleteModel(modelName);
      toast.success(t('modelManager.local.deleteSuccess', { name: modelName }));
      await loadData();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('modelManager.local.deleteFailed') + ': ' + errorMessage);
    }
  };

  const handleShowModel = async (modelName: string) => {
    setLoadingDetails(true);
    setSelectedModelName(modelName);
    setShowDetailsModal(true);

    try {
      const response = await ollamaApi.showModel(modelName, true);
      if (response.success && response.data) {
        setSelectedModelDetails(response.data as unknown as ModelDetails);
      } else {
        toast.error(t('modelManager.modals.details.noDetails'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('modelManager.modals.details.noDetails') + ': ' + errorMessage
      );
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleCopyModel = async () => {
    if (!copySource.trim() || !copyDestination.trim()) {
      toast.error(t('modelManager.modals.copy.enterBoth'));
      return;
    }

    setCopying(true);
    try {
      await ollamaApi.copyModel(copySource.trim(), copyDestination.trim());
      toast.success(
        t('modelManager.modals.copy.success', { name: copyDestination })
      );
      setShowCopyModal(false);
      setCopySource('');
      setCopyDestination('');
      await loadData();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('modelManager.modals.copy.failed') + ': ' + errorMessage);
    } finally {
      setCopying(false);
    }
  };

  const handleCreateModel = async () => {
    if (!createModelName.trim() || !createModelfile.trim()) {
      toast.error(t('modelManager.modals.create.enterBoth'));
      return;
    }

    setCreating(true);
    try {
      await ollamaApi.createModel({
        model: createModelName.trim(),
        modelfile: createModelfile.trim(),
      });
      toast.success(
        t('modelManager.modals.create.success', { name: createModelName })
      );
      setShowCreateModal(false);
      setCreateModelName('');
      setCreateModelfile('');
      await loadData();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('modelManager.modals.create.failed') + ': ' + errorMessage);
    } finally {
      setCreating(false);
    }
  };

  const handleGenerateEmbeddings = async () => {
    if (!embeddingsModel.trim() || !embeddingsInput.trim()) {
      toast.error(t('modelManager.modals.embeddings.enterBoth'));
      return;
    }

    setGeneratingEmbeddings(true);
    setEmbeddingsResult(null);

    try {
      const response = await ollamaApi.generateEmbeddings({
        model: embeddingsModel.trim(),
        input: embeddingsInput.trim(),
      });
      if (response.success && response.data) {
        const embeddings = response.data.embeddings?.[0] || [];
        setEmbeddingsResult(embeddings);
        toast.success(
          t('modelManager.modals.embeddings.success', {
            count: embeddings.length,
          })
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('modelManager.modals.embeddings.failed') + ': ' + errorMessage
      );
    } finally {
      setGeneratingEmbeddings(false);
    }
  };

  const formatSize = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(2)} GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const isModelRunning = (modelName: string) => {
    return (
      Array.isArray(runningModels) &&
      runningModels.some((m: RunningModel) => m.name === modelName)
    );
  };

  const getTotalModelSize = () => {
    return models.reduce((acc, model) => acc + model.size, 0);
  };

  const getTotalVRAM = () => {
    return runningModels.reduce(
      (acc, model) => acc + (model.size_vram || 0),
      0
    );
  };

  // Check if a library model is already installed
  const isModelInstalled = (libraryModelName: string) => {
    return models.some(
      m =>
        m.name === libraryModelName || m.name.startsWith(libraryModelName + ':')
    );
  };

  // Filter library models (cloud filter pulls from the dedicated cloud listing)
  const sourceLibraryModels =
    libraryFilter === 'cloud' ? cloudModels : libraryModels;
  const filteredLibraryModels = sourceLibraryModels.filter(model => {
    const matchesFilter =
      libraryFilter === 'all' ||
      libraryFilter === 'cloud' ||
      model.category === libraryFilter;
    const matchesSearch =
      !librarySearch ||
      model.name.toLowerCase().includes(librarySearch.toLowerCase()) ||
      model.description.toLowerCase().includes(librarySearch.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  // Category chips: derived from the popular list, plus a stable Cloud entry
  const libraryCategories = [
    'all',
    ...new Set([...libraryModels.map(m => m.category), 'cloud']),
  ];

  // Popular model suggestions - use live data from library, fallback to hardcoded
  const popularModels = useMemo((): {
    name: string;
    category: string;
    size: string;
  }[] => {
    if (libraryModels.length > 0) {
      // Use top 10 from live library data (already sorted by popularity)
      return libraryModels.slice(0, 10).map(m => ({
        name: m.name,
        category: m.category,
        size: m.sizes?.[0] || '',
      }));
    }
    // Fallback when library hasn't loaded yet
    return [
      { name: 'deepseek-r1', category: 'reasoning', size: '7B' },
      { name: 'llama3.2', category: 'general', size: '3B' },
      { name: 'gemma3', category: 'general', size: '4B' },
      { name: 'qwen2.5', category: 'general', size: '7B' },
      { name: 'mistral', category: 'general', size: '7B' },
      { name: 'codellama', category: 'coding', size: '7B' },
      { name: 'nomic-embed-text', category: 'embedding', size: '137M' },
      { name: 'llava', category: 'vision', size: '7B' },
      { name: 'phi3', category: 'general', size: '3.8B' },
      { name: 'gemma2', category: 'general', size: '9B' },
    ];
  }, [libraryModels]);

  const hasOpenModelManagerModal =
    showDetailsModal || showCopyModal || showCreateModal || showEmbeddingsModal;

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='flex items-center gap-3 text-gray-600 dark:text-dark-600'>
          <RefreshCw className='h-5 w-5 animate-spin' />
          {t('modelManager.loading')}
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      {/* System Status Bar */}
      <div
        className={cn(
          'rounded-xl p-4 border',
          'bg-white dark:bg-dark-100',
          'border-gray-200 dark:border-dark-300'
        )}
      >
        <div className='flex flex-wrap items-center justify-between gap-4'>
          <div className='flex items-center gap-6'>
            {/* Health Status */}
            <div className='flex items-center gap-2'>
              <div
                className={cn(
                  'w-2.5 h-2.5 rounded-full',
                  isHealthy ? 'bg-green-500' : 'bg-red-500'
                )}
              />
              <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                {isHealthy
                  ? t('modelManager.systemStatus.online')
                  : t('modelManager.systemStatus.offline')}
              </span>
            </div>

            {/* Version */}
            {ollamaVersion && (
              <div className='flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400'>
                <Server className='h-4 w-4' />
                <span>v{ollamaVersion}</span>
              </div>
            )}

            {/* Model Count */}
            <div className='flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400'>
              <HardDrive className='h-4 w-4' />
              <span>
                {models.length}{' '}
                {models.length !== 1
                  ? t('modelManager.systemStatus.models_plural')
                  : t('modelManager.systemStatus.models')}
              </span>
            </div>

            {/* Total Size */}
            <div className='flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400'>
              <Layers className='h-4 w-4' />
              <span>{formatSize(getTotalModelSize())}</span>
            </div>

            {/* Running Models */}
            {runningModels.length > 0 && (
              <div className='flex items-center gap-2 text-sm text-green-600 dark:text-green-400'>
                <Activity className='h-4 w-4' />
                <span>
                  {runningModels.length}{' '}
                  {t('modelManager.systemStatus.running')} (
                  {formatSize(getTotalVRAM())}{' '}
                  {t('modelManager.systemStatus.vram')})
                </span>
              </div>
            )}
          </div>

          <div className='flex items-center gap-2'>
            <Button
              onClick={loadData}
              variant='outline'
              size='sm'
              className={cn('gap-1.5', '', '')}
            >
              <RefreshCw className='h-3.5 w-3.5' />
              {t('common.refresh')}
            </Button>
          </div>
        </div>
      </div>

      {/* Pull Model Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100',
          'border-gray-200 dark:border-dark-300'
        )}
      >
        <button
          onClick={() => toggleSection('pull')}
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
          {expandedSections.has('pull') ? (
            <ChevronUp className='h-5 w-5 text-gray-500' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500' />
          )}
        </button>

        {expandedSections.has('pull') && (
          <div className='p-4 pt-0 space-y-4'>
            <div className='flex gap-2'>
              <div className='relative flex-1'>
                <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500' />
                <input
                  type='text'
                  value={pullModelName}
                  onChange={e => setPullModelName(e.target.value)}
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
                  onKeyDown={e =>
                    e.key === 'Enter' &&
                    !pulling &&
                    canInstallModels &&
                    handlePullModel()
                  }
                />
              </div>
              {pulling ? (
                <Button
                  onClick={handleCancelPull}
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
                  onClick={() => handlePullModel()}
                  disabled={!pullModelName.trim() || !canInstallModels}
                  className={cn('px-4 py-2.5 gap-2', '')}
                >
                  <Download className='h-4 w-4' />
                  {t('modelManager.pull.button')}
                </Button>
              )}
            </div>

            {/* Progress Bar */}
            {pulling && pullProgress && (
              <div
                className={cn(
                  'p-4 rounded-lg border',
                  'bg-gray-50 dark:bg-dark-200',
                  'border-gray-200 dark:border-dark-300'
                )}
              >
                <div className='flex items-center justify-between mb-2'>
                  <span className='text-sm font-medium text-gray-800 dark:text-dark-700'>
                    {pullProgress.status === 'starting'
                      ? t('modelManager.progress.starting')
                      : pullProgress.status.startsWith('pulling')
                        ? `${t('modelManager.progress.pullingLayer')} ${pullProgress.status.replace('pulling ', '')}`
                        : pullProgress.status.startsWith('verifying sha256')
                          ? t('modelManager.progress.verifyingDigest')
                          : pullProgress.status === 'writing manifest'
                            ? t('modelManager.progress.writing')
                            : pullProgress.status ===
                                'removing any unused layers'
                              ? t('modelManager.progress.cleaning')
                              : pullProgress.status}
                  </span>
                  {pullProgress.percent !== undefined && (
                    <span className='text-sm font-mono text-gray-600 dark:text-dark-600'>
                      {pullProgress.percent}%
                    </span>
                  )}
                </div>

                {pullProgress.percent !== undefined && (
                  <div className='w-full bg-gray-200 dark:bg-dark-400 rounded-full h-2 overflow-hidden'>
                    <div
                      className={cn(
                        'h-2 rounded-full transition-all duration-300',
                        'bg-primary-500 dark:bg-primary-400'
                      )}
                      style={{ width: `${pullProgress.percent}%` }}
                    />
                  </div>
                )}

                {pullProgress.total && pullProgress.completed && (
                  <div className='mt-2 text-xs text-gray-600 dark:text-dark-600'>
                    {formatSize(pullProgress.completed)} /{' '}
                    {formatSize(pullProgress.total)}
                  </div>
                )}
              </div>
            )}

            {!canInstallModels && (
              <p className='text-xs text-amber-700 dark:text-amber-300'>
                {t('modelManager.pull.restricted')}
              </p>
            )}

            {/* Popular Models */}
            <div>
              <p className='text-xs font-medium text-gray-500 dark:text-gray-400 mb-2'>
                {t('modelManager.pull.popular')}
              </p>
              <div className='flex flex-wrap gap-2'>
                {popularModels.map(model => (
                  <button
                    key={model.name}
                    onClick={() => setPullModelName(model.name)}
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

            {/* Help Link */}
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

      {/* Browse Library Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100',
          'border-gray-200 dark:border-dark-300'
        )}
      >
        <button
          onClick={() => toggleSection('library')}
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
                'bg-blue-100 dark:bg-blue-900/30'
              )}
            >
              <Cloud className='h-5 w-5 text-blue-600 dark:text-blue-400' />
            </div>
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
              {libraryModels.length} {t('modelManager.library.available')}
            </span>
          </div>
          {expandedSections.has('library') ? (
            <ChevronUp className='h-5 w-5 text-gray-500' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500' />
          )}
        </button>

        {expandedSections.has('library') && (
          <div className='p-4 pt-0 space-y-4'>
            {/* Search and Filter */}
            <div className='flex flex-col sm:flex-row gap-3'>
              <div className='relative flex-1'>
                <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500' />
                <input
                  type='text'
                  value={librarySearch}
                  onChange={e => setLibrarySearch(e.target.value)}
                  placeholder={t('modelManager.library.search')}
                  className={cn(
                    'w-full pl-10 pr-4 py-2 rounded-lg border text-sm',
                    'bg-gray-50 dark:bg-dark-50',
                    'border-gray-200 dark:border-dark-300',
                    'text-gray-900 dark:text-dark-700',
                    'placeholder-gray-500 dark:placeholder-gray-400',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                    'focus:border-primary-500'
                  )}
                />
              </div>

              {/* Category Filter */}
              <div className='flex items-center gap-2'>
                <Filter className='h-4 w-4 text-gray-400' />
                <div className='flex flex-wrap gap-1'>
                  {libraryCategories.map(category => (
                    <button
                      key={category}
                      onClick={() => setLibraryFilter(category)}
                      className={cn(
                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                        libraryFilter === category
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

            {/* Models Grid */}
            {loadingLibrary || loadingCloud ? (
              <div className='flex items-center justify-center py-8'>
                <RefreshCw className='h-5 w-5 animate-spin text-gray-400' />
              </div>
            ) : filteredLibraryModels.length === 0 ? (
              <div className='text-center py-8 text-gray-500'>
                {t('modelManager.library.noResults')}
              </div>
            ) : (
              <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
                {filteredLibraryModels.map(model => {
                  const pullName =
                    model.category === 'cloud'
                      ? normalizeCloudPullName(model.name)
                      : model.name;
                  const installed =
                    isModelInstalled(model.name) || isModelInstalled(pullName);
                  return (
                    <div
                      key={model.name}
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
                            // Open the pull section so user can see progress
                            if (!expandedSections.has('pull')) {
                              toggleSection('pull');
                            }
                            // Start the pull immediately
                            handlePullModel(model.name, model.category);
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
                })}
              </div>
            )}

            {/* Refresh Button */}
            <div className='flex justify-center'>
              <Button
                onClick={loadLibraryModels}
                variant='outline'
                size='sm'
                disabled={loadingLibrary}
                className={cn('gap-1.5', '', '')}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    loadingLibrary && 'animate-spin'
                  )}
                />
                {t('modelManager.library.refresh')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* HuggingFace Hub Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100',
          'border-gray-200 dark:border-dark-300'
        )}
      >
        <button
          onClick={() => toggleSection('huggingface')}
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
                'bg-yellow-100 dark:bg-yellow-900/30'
              )}
            >
              <Zap className='h-5 w-5 text-yellow-600 dark:text-yellow-400' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              {t('modelManager.sections.huggingface', 'HuggingFace Hub')}
            </h3>
            {hfModels.length > 0 && (
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-xs font-medium',
                  'bg-gray-100 dark:bg-dark-200',
                  'text-gray-600 dark:text-gray-400'
                )}
              >
                {hfModels.length}{' '}
                {t('modelManager.library.available', 'available')}
              </span>
            )}
          </div>
          {expandedSections.has('huggingface') ? (
            <ChevronUp className='h-5 w-5 text-gray-500' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500' />
          )}
        </button>

        {expandedSections.has('huggingface') && (
          <div className='p-4 pt-0 space-y-4'>
            {/* Search and Filters */}
            <div className='flex flex-col sm:flex-row gap-3'>
              <div className='relative flex-1'>
                <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500' />
                <input
                  type='text'
                  value={hfSearch}
                  onChange={e => setHfSearch(e.target.value)}
                  placeholder={t(
                    'modelManager.huggingface.search',
                    'Search HuggingFace models...'
                  )}
                  className={cn(
                    'w-full pl-10 pr-4 py-2 rounded-lg border text-sm',
                    'bg-gray-50 dark:bg-dark-50',
                    'border-gray-200 dark:border-dark-300',
                    'text-gray-900 dark:text-dark-700',
                    'placeholder-gray-500 dark:placeholder-gray-400',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                    'focus:border-primary-500'
                  )}
                />
              </div>

              {/* Task Filter */}
              <select
                value={hfTask}
                onChange={e => setHfTask(e.target.value)}
                className={cn(
                  'px-3 py-2 rounded-lg border text-sm min-w-[160px]',
                  'bg-gray-50 dark:bg-dark-50',
                  'border-gray-200 dark:border-dark-300',
                  'text-gray-900 dark:text-dark-700',
                  'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                )}
              >
                <option value='text-generation'>
                  {t(
                    'modelManager.huggingface.tasks.textGen',
                    'Text Generation'
                  )}
                </option>
                <option value='text-to-speech'>
                  {t('modelManager.huggingface.tasks.tts', 'Text to Speech')}
                </option>
                <option value='text-to-image'>
                  {t('modelManager.huggingface.tasks.image', 'Text to Image')}
                </option>
                <option value='automatic-speech-recognition'>
                  {t(
                    'modelManager.huggingface.tasks.stt',
                    'Speech Recognition'
                  )}
                </option>
              </select>

              {/* Sort */}
              <select
                value={hfSort}
                onChange={e => setHfSort(e.target.value)}
                className={cn(
                  'px-3 py-2 rounded-lg border text-sm min-w-[140px]',
                  'bg-gray-50 dark:bg-dark-50',
                  'border-gray-200 dark:border-dark-300',
                  'text-gray-900 dark:text-dark-700',
                  'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                )}
              >
                <option value='downloads'>
                  {t(
                    'modelManager.huggingface.sort.downloads',
                    'Most Downloads'
                  )}
                </option>
                <option value='likes'>
                  {t('modelManager.huggingface.sort.likes', 'Most Liked')}
                </option>
                <option value='lastModified'>
                  {t(
                    'modelManager.huggingface.sort.recent',
                    'Recently Updated'
                  )}
                </option>
              </select>
            </div>

            {!canInstallModels && (
              <p className='text-xs text-amber-700 dark:text-amber-300'>
                {t('modelManager.pull.restricted')}
              </p>
            )}

            {/* Models Grid */}
            {loadingHfModels ? (
              <div className='flex items-center justify-center py-8'>
                <Loader className='h-5 w-5 animate-spin text-gray-400' />
              </div>
            ) : hfModels.length === 0 ? (
              <div className='text-center py-8 text-gray-500'>
                {t(
                  'modelManager.huggingface.noResults',
                  'No models found. Try adjusting your search or filters.'
                )}
              </div>
            ) : (
              <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                {hfModels.map(model => {
                  const isExpanded = expandedHfModel === model.id;
                  const isLoadingGguf = loadingGguf === model.id;
                  const ggufFiles = hfGgufFiles[model.id] || [];

                  return (
                    <div
                      key={model.id}
                      className={cn(
                        'rounded-lg border transition-all overflow-hidden',
                        'bg-gray-50 dark:bg-dark-50',
                        'border-gray-200 dark:border-dark-300',
                        'hover:shadow-md hover:border-gray-300 dark:hover:border-dark-400'
                      )}
                    >
                      <div
                        className='p-4 cursor-pointer'
                        onClick={() => handleToggleHfModel(model.id)}
                      >
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
                              {t('modelManager.huggingface.by', 'by')}{' '}
                              {model.author}
                            </p>
                          </div>
                          <div className='flex items-center gap-2 flex-shrink-0'>
                            <a
                              href={`https://huggingface.co/${model.id}`}
                              target='_blank'
                              rel='noopener noreferrer'
                              onClick={e => e.stopPropagation()}
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
                                isExpanded && 'rotate-180'
                              )}
                            />
                          </div>
                        </div>

                        <div className='flex items-center gap-3 text-xs text-gray-500 dark:text-dark-600'>
                          <span className='flex items-center gap-1'>
                            <Download className='h-3.5 w-3.5' />
                            {model.downloads >= 1000000
                              ? `${(model.downloads / 1000000).toFixed(1)}M`
                              : model.downloads >= 1000
                                ? `${(model.downloads / 1000).toFixed(1)}K`
                                : model.downloads}
                          </span>
                          <span className='flex items-center gap-1'>
                            <Heart className='h-3.5 w-3.5' />
                            {model.likes >= 1000
                              ? `${(model.likes / 1000).toFixed(1)}K`
                              : model.likes}
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

                      {/* Expanded GGUF files section */}
                      {isExpanded && (
                        <div className='px-4 pb-4 pt-1 border-t border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100'>
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
                                  hfPullingModel === file.ollamaCommand;

                                return (
                                  <div
                                    key={file.filename}
                                    className='flex items-center gap-2 p-2 rounded-lg bg-gray-50 dark:bg-dark-50 border border-gray-200 dark:border-dark-300'
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
                                          {hfPullProgress?.percent !== undefined
                                            ? `${hfPullProgress.percent}%`
                                            : '...'}
                                        </div>
                                        <button
                                          onClick={e => {
                                            e.stopPropagation();
                                            handleCancelHfPull();
                                          }}
                                          className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                                        >
                                          <X className='h-4 w-4' />
                                        </button>
                                      </div>
                                    ) : (
                                      <button
                                        onClick={e => {
                                          e.stopPropagation();
                                          handlePullHfGguf(
                                            file.ollamaCommand,
                                            file.filename
                                          );
                                        }}
                                        disabled={
                                          !!hfPullingModel || !canInstallModels
                                        }
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
                              })}

                              {/* Pull progress bar */}
                              {hfPullingModel?.startsWith('hf.co/') &&
                                hfPullingModel.includes(model.id) &&
                                hfPullProgress?.percent !== undefined && (
                                  <div className='w-full bg-gray-200 dark:bg-dark-300 rounded-full h-1.5 overflow-hidden mt-2'>
                                    <div
                                      className='h-1.5 rounded-full bg-primary-500 transition-all duration-300'
                                      style={{
                                        width: `${hfPullProgress.percent}%`,
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

            {/* Footer */}
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
                onClick={loadHfModels}
                variant='outline'
                size='sm'
                disabled={loadingHfModels}
                className={cn('gap-1.5', '', '')}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    loadingHfModels && 'animate-spin'
                  )}
                />
                {t('modelManager.library.refresh', 'Refresh')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Running Models Section */}
      {Array.isArray(runningModels) && runningModels.length > 0 && (
        <div
          className={cn(
            'rounded-xl p-4 border',
            'bg-white dark:bg-dark-100',
            'border-gray-200 dark:border-dark-300'
          )}
        >
          <div className='flex items-center gap-3 mb-4'>
            <div
              className={cn(
                'p-2 rounded-lg',
                'bg-green-100 dark:bg-green-900/30'
              )}
            >
              <Activity className='h-5 w-5 text-green-600 dark:text-green-400' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              {t('modelManager.sections.running')}
            </h3>
            <span
              className={cn(
                'ml-auto px-2 py-0.5 rounded-full text-xs font-medium',
                'bg-green-100 dark:bg-green-900/30',
                'text-green-700 dark:text-green-400'
              )}
            >
              {runningModels.length} {t('modelManager.systemStatus.running')}
            </span>
          </div>
          <div className='space-y-2'>
            {runningModels.map((model: RunningModel) => (
              <div
                key={model.name}
                className={cn(
                  'flex items-center justify-between p-4 rounded-lg border',
                  'bg-green-50 dark:bg-green-900/10',
                  'border-green-200 dark:border-green-800/50'
                )}
              >
                <div className='flex items-center gap-3'>
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full animate-pulse',
                      'bg-green-500'
                    )}
                  />
                  <div>
                    <div className='font-medium text-green-800 dark:text-green-400'>
                      {model.name}
                    </div>
                    <div className='flex items-center gap-3 text-sm text-green-600 dark:text-green-500'>
                      <span className='flex items-center gap-1'>
                        <MemoryStick className='h-3 w-3' />
                        {t('modelManager.systemStatus.vram')}:{' '}
                        {formatSize(model.size_vram || 0)}
                      </span>
                      {model.size && (
                        <span className='flex items-center gap-1'>
                          <HardDrive className='h-3 w-3' />
                          {t('models.size')}: {formatSize(model.size)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium',
                    'bg-green-100 dark:bg-green-900/30',
                    'text-green-700 dark:text-green-400'
                  )}
                >
                  <Zap className='h-3 w-3' />
                  {t('modelManager.local.running')}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Local Models Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100',
          'border-gray-200 dark:border-dark-300'
        )}
      >
        <button
          onClick={() => toggleSection('local')}
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
                'bg-blue-100 dark:bg-blue-900/30'
              )}
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
          {expandedSections.has('local') ? (
            <ChevronUp className='h-5 w-5 text-gray-500' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500' />
          )}
        </button>

        {expandedSections.has('local') && (
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
                  <div
                    key={model.name}
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
                          {isModelRunning(model.name) && (
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
                          onClick={() => handleShowModel(model.name)}
                          variant='outline'
                          size='sm'
                          className={cn('gap-1.5', '', '')}
                        >
                          <Info className='h-3.5 w-3.5' />
                          {t('modelManager.local.info')}
                        </Button>
                        <Button
                          onClick={() => {
                            setCopySource(model.name);
                            setShowCopyModal(true);
                          }}
                          variant='outline'
                          size='sm'
                          className={cn('gap-1.5', '', '')}
                        >
                          <Copy className='h-3.5 w-3.5' />
                          {t('modelManager.local.copy')}
                        </Button>
                        <Button
                          onClick={() => handleDeleteModel(model.name)}
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
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Advanced Actions Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100',
          'border-gray-200 dark:border-dark-300'
        )}
      >
        <button
          onClick={() => toggleSection('advanced')}
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
                'bg-amber-100 dark:bg-amber-900/30'
              )}
            >
              <Settings className='h-5 w-5 text-amber-600 dark:text-amber-400' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              {t('modelManager.sections.advanced')}
            </h3>
          </div>
          {expandedSections.has('advanced') ? (
            <ChevronUp className='h-5 w-5 text-gray-500' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500' />
          )}
        </button>

        {expandedSections.has('advanced') && (
          <div className='p-4 pt-0'>
            <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
              <Button
                onClick={() => setShowCreateModal(true)}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  '',
                  ''
                )}
              >
                <FileCode className='h-5 w-5 text-purple-500' />
                <div className='text-left'>
                  <div className='font-medium'>
                    {t('modelManager.advanced.createModel')}
                  </div>
                  <div className='text-xs opacity-70'>
                    {t('modelManager.advanced.fromModelfile')}
                  </div>
                </div>
              </Button>

              <Button
                onClick={() => setShowCopyModal(true)}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  '',
                  ''
                )}
              >
                <Copy className='h-5 w-5 text-blue-500' />
                <div className='text-left'>
                  <div className='font-medium'>
                    {t('modelManager.advanced.copyModel')}
                  </div>
                  <div className='text-xs opacity-70'>
                    {t('modelManager.advanced.duplicateExisting')}
                  </div>
                </div>
              </Button>

              <Button
                onClick={() => setShowEmbeddingsModal(true)}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  '',
                  ''
                )}
              >
                <TestTube className='h-5 w-5 text-green-500' />
                <div className='text-left'>
                  <div className='font-medium'>
                    {t('modelManager.advanced.testEmbeddings')}
                  </div>
                  <div className='text-xs opacity-70'>
                    {t('modelManager.advanced.generateVectors')}
                  </div>
                </div>
              </Button>

              <Button
                onClick={async () => {
                  try {
                    const response = await ollamaApi.checkHealth();
                    if (response.success) {
                      await refetchOllamaState();
                      toast.success(t('modelManager.advanced.healthy'));
                    }
                  } catch {
                    await refetchOllamaState();
                    toast.error(t('modelManager.systemStatus.offline'));
                  }
                }}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  '',
                  ''
                )}
              >
                <Gauge className='h-5 w-5 text-rose-500' />
                <div className='text-left'>
                  <div className='font-medium'>
                    {t('modelManager.advanced.healthCheck')}
                  </div>
                  <div className='text-xs opacity-70'>
                    {t('modelManager.advanced.testConnection')}
                  </div>
                </div>
              </Button>
            </div>
          </div>
        )}
      </div>

      {hasOpenModelManagerModal && (
        <React.Suspense fallback={null}>
          <ModelManagerModals
            models={models}
            showDetailsModal={showDetailsModal}
            setShowDetailsModal={setShowDetailsModal}
            selectedModelName={selectedModelName}
            selectedModelDetails={selectedModelDetails}
            loadingDetails={loadingDetails}
            showCopyModal={showCopyModal}
            setShowCopyModal={setShowCopyModal}
            copySource={copySource}
            setCopySource={setCopySource}
            copyDestination={copyDestination}
            setCopyDestination={setCopyDestination}
            copying={copying}
            handleCopyModel={handleCopyModel}
            showCreateModal={showCreateModal}
            setShowCreateModal={setShowCreateModal}
            createModelName={createModelName}
            setCreateModelName={setCreateModelName}
            createModelfile={createModelfile}
            setCreateModelfile={setCreateModelfile}
            creating={creating}
            handleCreateModel={handleCreateModel}
            showEmbeddingsModal={showEmbeddingsModal}
            setShowEmbeddingsModal={setShowEmbeddingsModal}
            embeddingsModel={embeddingsModel}
            setEmbeddingsModel={setEmbeddingsModel}
            embeddingsInput={embeddingsInput}
            setEmbeddingsInput={setEmbeddingsInput}
            embeddingsResult={embeddingsResult}
            generatingEmbeddings={generatingEmbeddings}
            handleGenerateEmbeddings={handleGenerateEmbeddings}
          />
        </React.Suspense>
      )}
    </div>
  );
};

export default ModelManager;
