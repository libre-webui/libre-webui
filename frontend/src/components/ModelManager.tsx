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
  RefreshCw,
  Activity,
  HardDrive,
  Zap,
  Server,
  Copy,
  FileCode,
  TestTube,
  ChevronDown,
  ChevronUp,
  Settings,
  Layers,
  MemoryStick,
  Gauge,
} from 'lucide-react';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { HuggingFaceSection } from './model-manager/HuggingFaceSection';
import { LocalModelsSection } from './model-manager/LocalModelsSection';
import { ModelLibrarySection } from './model-manager/ModelLibrarySection';
import { PullModelSection } from './model-manager/PullModelSection';
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
  // An administrator can open model downloads to all users; the backend
  // reports whether this account may pull and enforces it on every request.
  const { data: modelAccess } = useQuery({
    queryKey: ['model-download-access'],
    queryFn: async () => {
      const response = await ollamaApi.getModelAccess();
      return response.success && response.data ? response.data : null;
    },
    staleTime: 60_000,
  });
  const canInstallModels =
    user?.role === 'admin' ||
    systemInfo?.requiresAuth === false ||
    modelAccess?.allowed === true;
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
      { name: 'gemma4', category: 'general', size: '12B' },
      { name: 'gemma4', category: 'general', size: '26B' },
      { name: 'gemma4', category: 'general', size: '31B' },
      { name: 'qwen3.8', category: 'reasoning', size: '27B' },
      { name: 'nomic-embed-text', category: 'embedding', size: '137M' },
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
          'rounded-2xl border px-4 py-3',
          'bg-white/60 dark:bg-white/[0.03]',
          'border-gray-200/80 dark:border-white/10'
        )}
      >
        <div className='flex flex-wrap items-center justify-between gap-4'>
          <div className='flex flex-wrap items-center gap-x-6 gap-y-2'>
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

      <PullModelSection
        expanded={expandedSections.has('pull')}
        modelName={pullModelName}
        setModelName={setPullModelName}
        pulling={pulling}
        progress={pullProgress}
        canInstallModels={canInstallModels}
        popularModels={popularModels}
        onToggle={() => toggleSection('pull')}
        onPull={() => handlePullModel()}
        onCancelPull={handleCancelPull}
        formatSize={formatSize}
      />

      <ModelLibrarySection
        expanded={expandedSections.has('library')}
        models={filteredLibraryModels}
        totalAvailable={libraryModels.length}
        categories={libraryCategories}
        filter={libraryFilter}
        search={librarySearch}
        loading={loadingLibrary || loadingCloud}
        pulling={pulling}
        canInstallModels={canInstallModels}
        pullSectionExpanded={expandedSections.has('pull')}
        setFilter={setLibraryFilter}
        setSearch={setLibrarySearch}
        isModelInstalled={isModelInstalled}
        normalizeCloudPullName={normalizeCloudPullName}
        onToggle={() => toggleSection('library')}
        onTogglePullSection={() => toggleSection('pull')}
        onPullModel={handlePullModel}
        onRefresh={loadLibraryModels}
      />

      <HuggingFaceSection
        expanded={expandedSections.has('huggingface')}
        models={hfModels}
        search={hfSearch}
        task={hfTask}
        sort={hfSort}
        loadingModels={loadingHfModels}
        canInstallModels={canInstallModels}
        expandedModelId={expandedHfModel}
        loadingGgufModelId={loadingGguf}
        ggufFiles={hfGgufFiles}
        pullingModel={hfPullingModel}
        pullProgress={hfPullProgress}
        setSearch={setHfSearch}
        setTask={setHfTask}
        setSort={setHfSort}
        onToggle={() => toggleSection('huggingface')}
        onToggleModel={handleToggleHfModel}
        onPullGguf={handlePullHfGguf}
        onCancelPull={handleCancelHfPull}
        onRefresh={loadHfModels}
      />

      {/* Running Models Section */}
      {Array.isArray(runningModels) && runningModels.length > 0 && (
        <div
          className={cn(
            'rounded-2xl border p-4',
            'bg-white/60 dark:bg-white/[0.03]',
            'border-gray-200/80 dark:border-white/10'
          )}
        >
          <div className='flex items-center gap-3 mb-4'>
            <Activity className='h-4 w-4 text-gray-500 dark:text-dark-500' />
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              {t('modelManager.sections.running')}
            </h3>
            <span
              className={cn(
                'ms-auto rounded-full px-2 py-0.5 text-xs font-medium',
                'border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.04]',
                'text-gray-600 dark:text-dark-600'
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
                  'bg-white/50 dark:bg-white/[0.025]',
                  'border-gray-200/80 dark:border-white/[0.08]'
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
                    <div className='font-medium text-gray-900 dark:text-dark-800'>
                      {model.name}
                    </div>
                    <div className='flex items-center gap-3 text-sm text-gray-500 dark:text-dark-500'>
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
                    'border border-gray-200 bg-gray-50 dark:border-white/10 dark:bg-white/[0.04]',
                    'text-gray-600 dark:text-dark-600'
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

      <LocalModelsSection
        expanded={expandedSections.has('local')}
        models={models}
        onToggle={() => toggleSection('local')}
        isModelRunning={isModelRunning}
        formatSize={formatSize}
        onShowModel={handleShowModel}
        onCopyModel={modelName => {
          setCopySource(modelName);
          setShowCopyModal(true);
        }}
        onDeleteModel={handleDeleteModel}
      />

      {/* Advanced Actions Section */}
      <div
        className={cn(
          'overflow-hidden rounded-2xl border',
          'bg-white/60 dark:bg-white/[0.03]',
          'border-gray-200/80 dark:border-white/10'
        )}
      >
        <button
          onClick={() => toggleSection('advanced')}
          aria-expanded={expandedSections.has('advanced')}
          className={cn(
            'w-full flex items-center justify-between p-4',
            'hover:bg-gray-50 dark:hover:bg-dark-50',
            'transition-colors'
          )}
        >
          <div className='flex items-center gap-3'>
            <Settings className='h-4 w-4 text-gray-500 dark:text-dark-500' />
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
                <FileCode className='h-5 w-5 text-gray-500 dark:text-dark-500' />
                <div className='text-start'>
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
                <Copy className='h-5 w-5 text-gray-500 dark:text-dark-500' />
                <div className='text-start'>
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
                <TestTube className='h-5 w-5 text-gray-500 dark:text-dark-500' />
                <div className='text-start'>
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
                <Gauge className='h-5 w-5 text-gray-500 dark:text-dark-500' />
                <div className='text-start'>
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
