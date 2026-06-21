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

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  Brain,
  ChevronDown,
  Cloud,
  HardDrive,
  Search,
  Sparkles,
  User,
  Zap,
} from 'lucide-react';
import { cn } from '@/utils';
import type { OllamaModel } from '@/types';
import {
  ollamaApi,
  huggingfaceHubApi,
  HuggingFaceModel,
  GgufFileInfo,
} from '@/utils/api';
import { useAuthStore } from '@/store/authStore';
import toast from 'react-hot-toast';
import { createLogger } from '@/utils/logger';
import { HuggingFaceModelsTab } from '@/components/model-selector/HuggingFaceModelsTab';
import { InstalledModelsTab } from '@/components/model-selector/InstalledModelsTab';
import { OllamaLibraryTab } from '@/components/model-selector/OllamaLibraryTab';
import type {
  LibraryModel,
  ModelGroup,
  ModelSelectorProps,
  TabType,
} from '@/components/model-selector/types';

const logger = createLogger('components:model-selector');

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  selectedModel,
  onModelChange,
  currentPersona,
  className,
  disabled = false,
  compact = false,
  showImageGen = false,
  onModelsRefresh,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('installed');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user, systemInfo } = useAuthStore();
  const canInstallModels =
    user?.role === 'admin' || (systemInfo?.allowUserModelPull ?? true);

  const [libraryCategory, setLibraryCategory] = useState('all');
  const [libraryDebouncedSearch, setLibraryDebouncedSearch] = useState('');

  const [hfTask, setHfTask] = useState('text-generation');
  const [hfSort, setHfSort] = useState('downloads');
  const [hfDebouncedSearch, setHfDebouncedSearch] = useState('');
  const [expandedHfModel, setExpandedHfModel] = useState<string | null>(null);
  const [hfGgufFiles, setHfGgufFiles] = useState<
    Record<string, GgufFileInfo[]>
  >({});
  const [loadingGguf, setLoadingGguf] = useState<string | null>(null);

  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<{
    status: string;
    percent?: number;
  } | null>(null);
  const [cancelPull, setCancelPull] = useState<(() => void) | null>(null);

  const libraryCategories = [
    'all',
    'popular',
    'chat',
    'code',
    'vision',
    'embedding',
    'cloud',
  ];

  const groupedModels: ModelGroup[] = [
    {
      type: 'personas' as const,
      label: t('modelSelector.personas'),
      icon: <User className='h-4 w-4 text-purple-600 dark:text-purple-400' />,
      models: models.filter(model => model.isPersona),
      color: 'purple',
    },
    {
      type: 'ollama' as const,
      label: t('modelSelector.ollamaModels'),
      icon: <Bot className='h-4 w-4 text-green-600 dark:text-green-400' />,
      models: models.filter(
        model =>
          !model.isPersona && !model.isPlugin && !model.name.includes('embed')
      ),
      color: 'green',
    },
    {
      type: 'plugins' as const,
      label: t('modelSelector.pluginModels'),
      icon: <Zap className='h-4 w-4 text-green-600 dark:text-green-400' />,
      models: models.filter(model => model.isPlugin),
      color: 'green',
    },
  ].filter(group => group.models.length > 0);

  const filteredGroups = groupedModels
    .map(group => ({
      ...group,
      models: group.models.filter(
        model =>
          model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (model.personaName &&
            model.personaName
              .toLowerCase()
              .includes(searchTerm.toLowerCase())) ||
          (model.pluginName &&
            model.pluginName.toLowerCase().includes(searchTerm.toLowerCase()))
      ),
    }))
    .filter(group => group.models.length > 0);

  const currentModel = models.find(
    m =>
      m.name === selectedModel ||
      (selectedModel.startsWith('persona:') && m.name === selectedModel)
  );

  const {
    data: libraryModels = [],
    isLoading: loadingLibrary,
    refetch: loadLibrary,
  } = useQuery({
    queryKey: [
      'ollama-library-selector',
      libraryDebouncedSearch,
      libraryCategory,
    ],
    queryFn: async (): Promise<LibraryModel[]> => {
      const response = await ollamaApi.getLibraryModels({
        search: libraryDebouncedSearch || undefined,
        sort: 'popular',
        category: libraryCategory === 'cloud' ? 'cloud' : undefined,
      });
      return response.success && response.data ? response.data : [];
    },
    enabled: isOpen && activeTab === 'ollama',
  });

  const {
    data: hfModels = [],
    isLoading: loadingHf,
    refetch: loadHfModels,
  } = useQuery({
    queryKey: [
      'hf-models-selector',
      hfTask,
      hfDebouncedSearch,
      hfSort,
    ] as const,
    queryFn: async (): Promise<HuggingFaceModel[]> => {
      const response = await huggingfaceHubApi.getModels({
        task: hfTask,
        search: hfDebouncedSearch || undefined,
        sort: hfSort as 'downloads' | 'likes' | 'lastModified',
        limit: 30,
      });
      return response.success && response.data ? response.data : [];
    },
    enabled: isOpen && activeTab === 'huggingface',
  });

  const filteredLibraryModels = libraryModels.filter(model => {
    const matchesSearch =
      !searchTerm ||
      model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      model.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory =
      libraryCategory === 'all' || model.category === libraryCategory;
    return matchesSearch && matchesCategory;
  });

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

  const handlePullHfGguf = useCallback(
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
            onModelsRefresh?.();
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
    [canInstallModels, onModelsRefresh, pullingModel, t]
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      if (activeTab === 'huggingface') {
        setHfDebouncedSearch(searchTerm);
      } else if (activeTab === 'ollama') {
        setLibraryDebouncedSearch(searchTerm);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchTerm, activeTab]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const handleModelSelect = async (modelName: string) => {
    setIsOpen(false);
    setSearchTerm('');

    try {
      const runningModelsResponse = await ollamaApi.listRunningModels();
      if (runningModelsResponse.success && runningModelsResponse.data) {
        const runningModels = runningModelsResponse.data;
        if (runningModels.length > 0) {
          const currentlyLoaded = runningModels.some(
            m => m.name === modelName || modelName.startsWith('persona:')
          );
          if (!currentlyLoaded) {
            await ollamaApi.unloadAllModels();
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to unload models before switch:', error);
    }

    const syntheticEvent = {
      target: { value: modelName },
    } as React.ChangeEvent<HTMLSelectElement>;

    onModelChange(syntheticEvent);
  };

  const handlePullModel = async (modelName: string) => {
    if (!canInstallModels) {
      toast.error(t('modelSelector.pullRestricted'));
      return;
    }
    if (pullingModel) return;

    setPullingModel(modelName);
    setPullProgress({ status: 'starting' });

    try {
      const cancelFn = ollamaApi.pullModelStream(
        modelName,
        progress => {
          setPullProgress(progress);
        },
        () => {
          setPullProgress(null);
          setPullingModel(null);
          setCancelPull(null);
          toast.success(`Downloaded ${modelName}`);
          onModelsRefresh?.();
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
  };

  const handleCancelPull = () => {
    if (cancelPull) {
      cancelPull();
      setCancelPull(null);
      setPullingModel(null);
      setPullProgress(null);
      toast.success('Download cancelled');
    }
  };

  const isModelInstalled = (name: string) => {
    return models.some(m => m.name === name || m.name.startsWith(name + ':'));
  };

  const getModelIcon = (model: OllamaModel) => {
    if (model.isPersona) {
      return <User className='h-4 w-4 text-purple-600 dark:text-purple-400' />;
    }
    if (model.isPlugin) {
      return <Zap className='h-4 w-4 text-green-600 dark:text-green-400' />;
    }
    return <Bot className='h-4 w-4 text-green-600 dark:text-green-400' />;
  };

  const getModelLabel = (model: OllamaModel) => {
    if (model.isPersona) {
      return model.personaName || model.name;
    }
    if (model.isPlugin) {
      return `${model.name}`;
    }
    return model.name;
  };

  const getModelSubLabel = (model: OllamaModel) => {
    if (model.isPersona) {
      return `via ${model.model}`;
    }
    if (model.isPlugin) {
      return `via ${model.pluginName}`;
    }
    return null;
  };

  const getCurrentModelDisplay = () => {
    if (!currentModel) {
      return compact ? (
        <div className='flex items-center gap-2 min-w-0'>
          <Bot className='h-4 w-4' />
          <span className='text-xs font-medium text-gray-400 dark:text-gray-500 truncate'>
            {t('modelSelector.selectModel')}
          </span>
        </div>
      ) : (
        t('modelSelector.selectModel')
      );
    }

    if (compact) {
      const modelName = getModelLabel(currentModel);

      return (
        <div className='flex items-center gap-2 min-w-0'>
          {getModelIcon(currentModel)}
          <span className='text-xs font-medium text-gray-700 dark:text-gray-200 truncate'>
            {modelName}
          </span>
        </div>
      );
    }

    const label = getModelLabel(currentModel);
    const subLabel = getModelSubLabel(currentModel);

    return (
      <div className='flex items-center gap-2 min-w-0'>
        {getModelIcon(currentModel)}
        <div className='flex flex-col min-w-0'>
          <span className='text-sm font-medium truncate'>{label}</span>
          {subLabel && (
            <span className='text-xs text-gray-500 dark:text-gray-400 truncate'>
              {subLabel}
            </span>
          )}
        </div>
        {currentModel.isPersona && currentPersona && (
          <div className='flex items-center gap-1 ml-auto'>
            <Brain className='h-3 w-3 text-purple-600 dark:text-purple-400' />
            {currentPersona.embedding_model && (
              <Sparkles className='h-3 w-3 text-purple-500 dark:text-purple-300' />
            )}
          </div>
        )}
      </div>
    );
  };

  const openGallery = () => {
    setIsOpen(false);
    navigate('/gallery');
  };

  return (
    <div className={cn('relative', className)} ref={dropdownRef}>
      <button
        type='button'
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          compact
            ? 'h-[44px] sm:h-[52px] px-3 flex items-center justify-between text-left w-full '
            : 'w-full flex items-center justify-between gap-2 px-3 py-2 text-left ',
          'bg-gray-50 dark:bg-dark-200 border border-gray-200 dark:border-dark-300',
          'rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-dark-100',
          'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        )}
        title={
          compact
            ? currentModel
              ? getModelLabel(currentModel)
              : t('modelSelector.selectModel')
            : undefined
        }
      >
        {getCurrentModelDisplay()}
        <ChevronDown
          className={cn(
            compact ? 'h-3 w-3' : 'h-4 w-4',
            'text-gray-400 flex-shrink-0',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-start sm:items-center justify-center p-2 sm:p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setIsOpen(false)}
            />

            <div
              className={cn(
                'relative bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 shadow-2xl',
                'w-full max-w-md sm:w-[480px] sm:max-w-[90vw]',
                'mt-2 sm:mt-0 rounded-xl',
                'h-[85vh] sm:h-[600px] flex flex-col'
              )}
              onClick={e => e.stopPropagation()}
            >
              <div className='flex-shrink-0'>
                <div className='p-3 border-b border-gray-200 dark:border-dark-200'>
                  <div className='relative'>
                    <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400' />
                    <input
                      ref={searchInputRef}
                      type='text'
                      placeholder={
                        activeTab === 'installed'
                          ? t('modelSelector.searchInstalled')
                          : activeTab === 'ollama'
                            ? t('modelSelector.searchOllama')
                            : t('modelSelector.searchHuggingFace')
                      }
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className={cn(
                        'w-full pl-10 pr-4 py-2.5 text-sm bg-gray-50 dark:bg-dark-200',
                        'border border-gray-200 dark:border-dark-300 rounded-lg',
                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                        'text-gray-900 dark:text-gray-100',
                        'placeholder-gray-500'
                      )}
                    />
                  </div>
                </div>

                <div className='flex border-b border-gray-200 dark:border-dark-300'>
                  <button
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveTab('installed');
                    }}
                    className={cn(
                      'flex-1 px-4 py-2.5 text-sm font-medium transition-colors',
                      activeTab === 'installed'
                        ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-500'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    )}
                  >
                    <HardDrive className='h-4 w-4 inline mr-1.5' />
                    {t('modelSelector.installed')}
                  </button>
                  <button
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveTab('ollama');
                    }}
                    className={cn(
                      'flex-1 px-4 py-2.5 text-sm font-medium transition-colors',
                      activeTab === 'ollama'
                        ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-500'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    )}
                  >
                    <Cloud className='h-4 w-4 inline mr-1.5' />
                    Ollama
                  </button>
                  <button
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveTab('huggingface');
                    }}
                    className={cn(
                      'flex-1 px-4 py-2.5 text-sm font-medium transition-colors',
                      activeTab === 'huggingface'
                        ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-500'
                        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                    )}
                  >
                    <Zap className='h-4 w-4 inline mr-1.5' />
                    HuggingFace
                  </button>
                </div>
              </div>

              {activeTab === 'installed' && (
                <InstalledModelsTab
                  filteredGroups={filteredGroups}
                  selectedModel={selectedModel}
                  showImageGen={showImageGen}
                  getModelIcon={getModelIcon}
                  getModelLabel={getModelLabel}
                  getModelSubLabel={getModelSubLabel}
                  onModelSelect={handleModelSelect}
                  onOpenGallery={openGallery}
                />
              )}
              {activeTab === 'ollama' && (
                <OllamaLibraryTab
                  libraryCategories={libraryCategories}
                  libraryCategory={libraryCategory}
                  canInstallModels={canInstallModels}
                  loadingLibrary={loadingLibrary}
                  filteredLibraryModels={filteredLibraryModels}
                  pullingModel={pullingModel}
                  pullProgress={pullProgress}
                  setLibraryCategory={setLibraryCategory}
                  isModelInstalled={isModelInstalled}
                  onModelSelect={handleModelSelect}
                  onPullModel={handlePullModel}
                  onCancelPull={handleCancelPull}
                  onRefreshLibrary={() => {
                    void loadLibrary();
                  }}
                />
              )}
              {activeTab === 'huggingface' && (
                <HuggingFaceModelsTab
                  hfTask={hfTask}
                  hfSort={hfSort}
                  canInstallModels={canInstallModels}
                  loadingHf={loadingHf}
                  hfModels={hfModels}
                  expandedHfModel={expandedHfModel}
                  hfGgufFiles={hfGgufFiles}
                  loadingGguf={loadingGguf}
                  pullingModel={pullingModel}
                  pullProgress={pullProgress}
                  setHfTask={setHfTask}
                  setHfSort={setHfSort}
                  onToggleHfModel={handleToggleHfModel}
                  onPullHfGguf={handlePullHfGguf}
                  onCancelPull={handleCancelPull}
                  onRefreshHfModels={() => {
                    void loadHfModels();
                  }}
                />
              )}
            </div>
          </div>,
          document.body
        )}

      <select
        value={selectedModel}
        onChange={onModelChange}
        className='sr-only'
        tabIndex={-1}
      >
        {models.map(model => (
          <option key={model.name} value={model.name}>
            {getModelLabel(model)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default ModelSelector;
