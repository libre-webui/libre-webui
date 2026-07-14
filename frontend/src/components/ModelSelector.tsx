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
  X,
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
      icon: <User className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(model => model.isPersona),
      color: 'purple',
    },
    {
      type: 'ollama' as const,
      label: t('modelSelector.ollamaModels'),
      icon: <Bot className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(
        model =>
          !model.isPersona && !model.isPlugin && !model.name.includes('embed')
      ),
      color: 'green',
    },
    {
      type: 'plugins' as const,
      label: t('modelSelector.pluginModels'),
      icon: <Zap className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
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
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

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
      return <User className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
    }
    if (model.isPlugin) {
      return <Zap className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
    }
    return <Bot className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
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
          <span
            dir={currentModel.isPersona ? 'auto' : 'ltr'}
            className='text-xs font-medium text-gray-700 dark:text-gray-200 truncate'
          >
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
          <span
            dir={currentModel.isPersona ? 'auto' : 'ltr'}
            className='text-sm font-medium truncate'
          >
            {label}
          </span>
          {subLabel && (
            <span
              dir='auto'
              className='text-xs text-gray-500 dark:text-gray-400 truncate'
            >
              {subLabel}
            </span>
          )}
        </div>
        {currentModel.isPersona && currentPersona && (
          <div className='flex items-center gap-1 ms-auto'>
            <Brain className='h-3 w-3 text-gray-500 dark:text-dark-600' />
            {currentPersona.embedding_model && (
              <Sparkles className='h-3 w-3 text-gray-400 dark:text-dark-500' />
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
        aria-haspopup='dialog'
        aria-expanded={isOpen}
        className={cn(
          compact
            ? 'h-9 sm:h-10 px-2.5 flex items-center justify-between text-start w-full'
            : 'w-full flex items-center justify-between gap-2 px-3 py-2.5 text-start',
          'border border-black/[0.06] bg-gray-100/70 dark:border-white/[0.06] dark:bg-dark-300/70',
          'rounded-xl text-sm hover:bg-gray-100 dark:hover:bg-dark-300',
          'transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500/40',
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
            'text-gray-400 flex-shrink-0 transition-transform duration-150',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-3 sm:p-6'>
            <div
              className='absolute inset-0 bg-gray-950/55 backdrop-blur-md'
              onClick={() => {
                setIsOpen(false);
                setSearchTerm('');
              }}
            />

            <div
              role='dialog'
              aria-modal='true'
              aria-label={t('modelSelector.selectModel')}
              className={cn(
                'relative flex w-full max-w-xl flex-col overflow-hidden bg-white/[0.98] dark:bg-dark-25/[0.98]',
                'h-[min(620px,88vh)] rounded-[1.5rem] border border-black/[0.08] dark:border-white/[0.09]',
                'shadow-[0_30px_100px_rgba(0,0,0,0.28)] backdrop-blur-xl animate-scale-in'
              )}
              onClick={e => e.stopPropagation()}
            >
              <div className='flex-shrink-0'>
                <div className='flex items-center justify-between px-4 pb-2 pt-4 sm:px-5 sm:pt-5'>
                  <h2 className='text-lg font-medium tracking-[-0.025em] text-gray-950 dark:text-dark-950 rtl:tracking-normal'>
                    {t('modelSelector.selectModel')}
                  </h2>
                  <button
                    type='button'
                    onClick={() => {
                      setIsOpen(false);
                      setSearchTerm('');
                    }}
                    className='flex h-9 w-9 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-950 dark:text-dark-500 dark:hover:bg-dark-200 dark:hover:text-dark-950'
                    title={t('common.close')}
                  >
                    <X className='h-4 w-4' />
                  </button>
                </div>

                <div className='px-4 pb-3 sm:px-5'>
                  <div className='relative'>
                    <Search className='absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400' />
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
                        'w-full rounded-xl border border-black/[0.07] bg-gray-100/70 py-2.5 ps-10 pe-4 text-sm dark:border-white/[0.07] dark:bg-dark-200/70',
                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                        'text-gray-900 dark:text-dark-900 placeholder:text-gray-400 dark:placeholder:text-dark-500'
                      )}
                    />
                  </div>
                </div>

                <div className='mx-4 mb-3 flex rounded-xl bg-gray-100/70 p-1 dark:bg-dark-200/70 sm:mx-5'>
                  <button
                    onClick={() => {
                      setActiveTab('installed');
                    }}
                    className={cn(
                      'flex-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-4',
                      activeTab === 'installed'
                        ? 'bg-white text-gray-950 shadow-sm dark:bg-dark-300 dark:text-dark-950'
                        : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
                    )}
                    aria-pressed={activeTab === 'installed'}
                  >
                    <HardDrive className='h-4 w-4 inline me-1.5' />
                    {t('modelSelector.installed')}
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('ollama');
                    }}
                    className={cn(
                      'flex-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-4',
                      activeTab === 'ollama'
                        ? 'bg-white text-gray-950 shadow-sm dark:bg-dark-300 dark:text-dark-950'
                        : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
                    )}
                    aria-pressed={activeTab === 'ollama'}
                  >
                    <Cloud className='h-4 w-4 inline me-1.5' />
                    Ollama
                  </button>
                  <button
                    onClick={() => {
                      setActiveTab('huggingface');
                    }}
                    className={cn(
                      'flex-1 rounded-lg px-2 py-2 text-xs font-medium transition-colors sm:px-4',
                      activeTab === 'huggingface'
                        ? 'bg-white text-gray-950 shadow-sm dark:bg-dark-300 dark:text-dark-950'
                        : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
                    )}
                    aria-pressed={activeTab === 'huggingface'}
                  >
                    <Zap className='h-4 w-4 inline me-1.5' />
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
