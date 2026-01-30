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
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  User,
  Brain,
  Cpu,
  Check,
  Sparkles,
  Bot,
  Zap,
  ImageIcon,
  Plus,
  Download,
  Heart,
  ExternalLink,
  Search,
  X,
  Cloud,
  Loader,
  HardDrive,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@/utils';
import { OllamaModel, Persona } from '@/types';
import {
  ollamaApi,
  huggingfaceHubApi,
  HuggingFaceModel,
  GgufFileInfo,
} from '@/utils/api';
import toast from 'react-hot-toast';

interface ModelGroup {
  type: 'personas' | 'ollama' | 'plugins';
  label: string;
  icon: React.ReactNode;
  models: OllamaModel[];
  color: string;
}

interface LibraryModel {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
}

interface ModelSelectorProps {
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  currentPersona?: Persona | null;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
  showImageGen?: boolean;
  onModelsRefresh?: () => void;
}

type TabType = 'installed' | 'ollama' | 'huggingface';

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

  // Ollama library state
  const [libraryModels, setLibraryModels] = useState<LibraryModel[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [libraryCategory, setLibraryCategory] = useState('all');
  const [libraryDebouncedSearch, setLibraryDebouncedSearch] = useState('');

  // HuggingFace state
  const [hfModels, setHfModels] = useState<HuggingFaceModel[]>([]);
  const [loadingHf, setLoadingHf] = useState(false);
  const [hfTask, setHfTask] = useState('text-generation');
  const [hfSort, setHfSort] = useState('downloads');
  const [hfDebouncedSearch, setHfDebouncedSearch] = useState('');
  const [expandedHfModel, setExpandedHfModel] = useState<string | null>(null);
  const [hfGgufFiles, setHfGgufFiles] = useState<
    Record<string, GgufFileInfo[]>
  >({});
  const [loadingGguf, setLoadingGguf] = useState<string | null>(null);

  // Pull state
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [pullProgress, setPullProgress] = useState<{
    status: string;
    percent?: number;
  } | null>(null);
  const [cancelPull, setCancelPull] = useState<(() => void) | null>(null);

  // Library categories
  const libraryCategories = [
    'all',
    'popular',
    'chat',
    'code',
    'vision',
    'embedding',
  ];

  // Group models by type
  const groupedModels: ModelGroup[] = [
    {
      type: 'personas' as const,
      label: 'Personas',
      icon: (
        <User className='h-4 w-4 text-purple-600 dark:text-purple-400 ophelia:text-[#a855f7]' />
      ),
      models: models.filter(model => model.isPersona),
      color: 'purple',
    },
    {
      type: 'ollama' as const,
      label: 'Ollama Models',
      icon: (
        <Bot className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
      ),
      models: models.filter(model => !model.isPersona && !model.isPlugin),
      color: 'green',
    },
    {
      type: 'plugins' as const,
      label: 'Plugin Models',
      icon: (
        <Zap className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
      ),
      models: models.filter(model => model.isPlugin),
      color: 'green',
    },
  ].filter(group => group.models.length > 0);

  // Filter models based on search term
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

  // Filter library models
  const filteredLibraryModels = libraryModels.filter(model => {
    const matchesSearch =
      !searchTerm ||
      model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      model.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory =
      libraryCategory === 'all' || model.category === libraryCategory;
    return matchesSearch && matchesCategory;
  });

  // Find current model info
  const currentModel = models.find(
    m =>
      m.name === selectedModel ||
      (selectedModel.startsWith('persona:') && m.name === selectedModel)
  );

  // Load Ollama library
  const loadLibrary = useCallback(async () => {
    setLoadingLibrary(true);
    try {
      const response = await ollamaApi.getLibraryModels({
        search: libraryDebouncedSearch || undefined,
        sort: 'popular',
      });
      if (response.success && response.data) {
        setLibraryModels(response.data);
      }
    } catch (error) {
      console.error('Failed to load library:', error);
    } finally {
      setLoadingLibrary(false);
    }
  }, [libraryDebouncedSearch]);

  // Load HuggingFace models
  const loadHfModels = useCallback(async () => {
    setLoadingHf(true);
    try {
      const response = await huggingfaceHubApi.getModels({
        task: hfTask,
        search: hfDebouncedSearch || undefined,
        sort: hfSort as 'downloads' | 'likes' | 'lastModified',
        limit: 30,
      });
      if (response.success && response.data) {
        setHfModels(response.data);
      }
    } catch (error) {
      console.error('Failed to load HuggingFace models:', error);
    } finally {
      setLoadingHf(false);
    }
  }, [hfTask, hfDebouncedSearch, hfSort]);

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
      console.error('Failed to load GGUF files:', error);
    } finally {
      setLoadingGguf(null);
    }
  }, []);

  // Toggle expanded model and load GGUF files
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
    [pullingModel, onModelsRefresh]
  );

  // Debounce search for both tabs
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

  // Load data when tab changes or search changes
  useEffect(() => {
    if (isOpen && activeTab === 'ollama') {
      loadLibrary();
    }
  }, [isOpen, activeTab, libraryDebouncedSearch, loadLibrary]);

  useEffect(() => {
    if (isOpen && activeTab === 'huggingface') {
      loadHfModels();
    }
  }, [isOpen, activeTab, hfTask, hfDebouncedSearch, hfSort, loadHfModels]);

  // Close dropdown when clicking outside
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

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const handleModelSelect = (modelName: string) => {
    const syntheticEvent = {
      target: { value: modelName },
    } as React.ChangeEvent<HTMLSelectElement>;

    onModelChange(syntheticEvent);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handlePullModel = async (modelName: string) => {
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
      return (
        <Zap className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
      );
    }
    return (
      <Bot className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
    );
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

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const getCurrentModelDisplay = () => {
    if (!currentModel) {
      return compact ? (
        <div className='flex items-center gap-2 min-w-0'>
          <Bot className='h-4 w-4' />
          <span className='text-xs font-medium text-gray-400 dark:text-gray-500 truncate'>
            Select Model
          </span>
        </div>
      ) : (
        'Select Model'
      );
    }

    if (compact) {
      const modelName = getModelLabel(currentModel);

      return (
        <div className='flex items-center gap-2 min-w-0'>
          {getModelIcon(currentModel)}
          <span className='text-xs font-medium text-gray-700 dark:text-gray-200 ophelia:text-[#e5e5e5] truncate'>
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

  const renderInstalledTab = () => (
    <div className='flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-dark-400'>
      {filteredGroups.length > 0 ? (
        filteredGroups.map(group => (
          <div key={group.type}>
            <div className='px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3] bg-gray-100 dark:bg-dark-300 ophelia:bg-[#0a0a0a] border-b border-gray-200 dark:border-dark-400 ophelia:border-[#1a1a1a] sticky top-0'>
              <div className='flex items-center gap-2'>
                {group.icon}
                {group.label} ({group.models.length})
              </div>
            </div>
            {group.models.map(model => (
              <div
                key={model.name}
                onMouseDown={e => {
                  e.preventDefault();
                  handleModelSelect(model.name);
                }}
                className={cn(
                  'px-3 py-3 cursor-pointer border-b border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a] last:border-b-0',
                  'hover:bg-gray-50 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212]',
                  'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a] transition-colors',
                  selectedModel === model.name &&
                    'bg-primary-50 dark:bg-primary-900/30 ophelia:bg-[rgba(147,51,234,0.15)]'
                )}
              >
                <div className='flex items-center gap-3'>
                  {getModelIcon(model)}
                  <div className='flex-1 min-w-0'>
                    <div className='text-sm font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] truncate'>
                      {getModelLabel(model)}
                    </div>
                    {getModelSubLabel(model) && (
                      <div className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373] truncate'>
                        {getModelSubLabel(model)}
                      </div>
                    )}
                  </div>
                  {selectedModel === model.name && (
                    <Check className='h-4 w-4 text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] flex-shrink-0' />
                  )}
                </div>
              </div>
            ))}
          </div>
        ))
      ) : (
        <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
          <Cpu className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600 ophelia:text-[#525252]' />
          <p className='text-sm'>{t('models.noModelsFound')}</p>
        </div>
      )}

      {showImageGen && (
        <div className='border-t border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'>
          <div className='px-3 py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3] bg-gray-100 dark:bg-dark-300 ophelia:bg-[#0a0a0a]'>
            <div className='flex items-center gap-2'>
              <Plus className='h-4 w-4 text-blue-600 dark:text-blue-400' />
              Actions
            </div>
          </div>
          <div
            onMouseDown={e => {
              e.preventDefault();
              setIsOpen(false);
              navigate('/gallery');
            }}
            className='px-3 py-3 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20 ophelia:hover:bg-[rgba(147,51,234,0.1)] bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]'
          >
            <div className='flex items-center gap-3'>
              <ImageIcon className='h-4 w-4 text-blue-600 dark:text-blue-400 ophelia:text-[#a855f7]' />
              <div className='flex-1'>
                <div className='text-sm font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                  {t('gallery.generate')}
                </div>
                <div className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                  {t('gallery.generateDescription')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  const renderOllamaLibraryTab = () => (
    <div className='flex-1 flex flex-col overflow-hidden'>
      {/* Category filters */}
      <div className='px-3 py-2 border-b border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a] flex-shrink-0'>
        <div className='flex flex-wrap gap-1.5'>
          {libraryCategories.map(cat => (
            <button
              key={cat}
              onMouseDown={e => {
                e.preventDefault();
                e.stopPropagation();
                setLibraryCategory(cat);
              }}
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                libraryCategory === cat
                  ? 'bg-primary-100 dark:bg-primary-900/30 ophelia:bg-[#9333ea]/20 text-primary-700 dark:text-primary-400 ophelia:text-[#a855f7]'
                  : 'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3] hover:bg-gray-200 dark:hover:bg-dark-300 ophelia:hover:bg-[#262626]'
              )}
            >
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Model list */}
      <div className='flex-1 overflow-y-auto'>
        {loadingLibrary ? (
          <div className='flex items-center justify-center py-12'>
            <Loader className='h-6 w-6 animate-spin text-gray-400' />
          </div>
        ) : filteredLibraryModels.length === 0 ? (
          <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
            <Cloud className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600' />
            <p className='text-sm'>{t('models.noModelsFound')}</p>
          </div>
        ) : (
          <div className='divide-y divide-gray-100 dark:divide-dark-200 ophelia:divide-[#1a1a1a]'>
            {filteredLibraryModels.slice(0, 50).map(model => {
              const installed = isModelInstalled(model.name);
              const isPulling = pullingModel === model.name;

              return (
                <div
                  key={model.name}
                  className={cn(
                    'px-3 py-3 bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
                    installed && 'bg-green-50/50 dark:bg-green-900/10'
                  )}
                >
                  <div className='flex items-start gap-3'>
                    <div className='p-2 rounded-lg bg-cyan-100 dark:bg-cyan-900/30 ophelia:bg-[#06b6d4]/20 flex-shrink-0'>
                      <Cloud className='h-4 w-4 text-cyan-600 dark:text-cyan-400' />
                    </div>
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center gap-2'>
                        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] truncate'>
                          {model.name}
                        </h4>
                        {installed && (
                          <span className='px-1.5 py-0.5 rounded text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'>
                            Installed
                          </span>
                        )}
                      </div>
                      <p className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373] line-clamp-1 mt-0.5'>
                        {model.description}
                      </p>
                      <div className='flex items-center gap-2 mt-1.5'>
                        {model.sizes.slice(0, 3).map(size => (
                          <span
                            key={size}
                            className='px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'
                          >
                            {size}
                          </span>
                        ))}
                        {model.pulls && (
                          <span className='text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1'>
                            <Download className='h-3 w-3' />
                            {model.pulls}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className='flex-shrink-0'>
                      {isPulling ? (
                        <div className='flex items-center gap-2'>
                          <div className='text-xs text-gray-500 w-12 text-right'>
                            {pullProgress?.percent !== undefined
                              ? `${pullProgress.percent}%`
                              : '...'}
                          </div>
                          <button
                            onClick={handleCancelPull}
                            className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                          >
                            <X className='h-4 w-4' />
                          </button>
                        </div>
                      ) : installed ? (
                        <button
                          onClick={() => handleModelSelect(model.name)}
                          className='px-3 py-1.5 rounded-lg text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50'
                        >
                          Use
                        </button>
                      ) : (
                        <button
                          onClick={() => handlePullModel(model.name)}
                          className='px-3 py-1.5 rounded-lg text-xs font-medium bg-primary-100 dark:bg-primary-900/30 ophelia:bg-[#9333ea]/20 text-primary-700 dark:text-primary-400 ophelia:text-[#a855f7] hover:bg-primary-200 dark:hover:bg-primary-900/50'
                        >
                          <Download className='h-3 w-3 inline mr-1' />
                          Pull
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Pull progress bar */}
                  {isPulling && pullProgress?.percent !== undefined && (
                    <div className='mt-2 w-full bg-gray-200 dark:bg-dark-300 rounded-full h-1.5 overflow-hidden'>
                      <div
                        className='h-1.5 rounded-full bg-primary-500 transition-all duration-300'
                        style={{ width: `${pullProgress.percent}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className='px-3 py-2 border-t border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a] flex items-center justify-between flex-shrink-0'>
        <a
          href='https://ollama.com/library'
          target='_blank'
          rel='noopener noreferrer'
          onMouseDown={e => e.stopPropagation()}
          className='text-xs text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] hover:underline flex items-center gap-1'
        >
          <ExternalLink className='h-3 w-3' />
          {t('modelManager.huggingface.browseAllLink')}
        </a>
        <button
          onMouseDown={e => {
            e.preventDefault();
            e.stopPropagation();
            setLibraryModels([]);
            loadLibrary();
          }}
          className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
        >
          <RefreshCw
            className={cn(
              'h-3.5 w-3.5 text-gray-400',
              loadingLibrary && 'animate-spin'
            )}
          />
        </button>
      </div>
    </div>
  );

  const renderHuggingFaceTab = () => (
    <div className='flex-1 flex flex-col overflow-hidden'>
      {/* Filters */}
      <div className='px-3 py-2 border-b border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a] flex-shrink-0 space-y-2'>
        <div className='flex gap-2'>
          <select
            value={hfTask}
            onChange={e => setHfTask(e.target.value)}
            onMouseDown={e => e.stopPropagation()}
            className='flex-1 px-2 py-1.5 rounded-lg border text-xs bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212] border-gray-200 dark:border-dark-300 ophelia:border-[#262626] text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'
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
            className='px-2 py-1.5 rounded-lg border text-xs bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212] border-gray-200 dark:border-dark-300 ophelia:border-[#262626] text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'
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

      {/* Model list */}
      <div className='flex-1 overflow-y-auto'>
        {loadingHf ? (
          <div className='flex items-center justify-center py-12'>
            <Loader className='h-6 w-6 animate-spin text-gray-400' />
          </div>
        ) : hfModels.length === 0 ? (
          <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
            <Zap className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600' />
            <p className='text-sm'>
              {t('modelManager.huggingface.noModelsFound')}
            </p>
          </div>
        ) : (
          <div className='divide-y divide-gray-100 dark:divide-dark-200 ophelia:divide-[#1a1a1a]'>
            {hfModels.map(model => {
              const isExpanded = expandedHfModel === model.id;
              const ggufFiles = hfGgufFiles[model.id] || [];
              const isLoadingGguf = loadingGguf === model.id;

              return (
                <div
                  key={model.id}
                  className='bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]'
                >
                  <div
                    className='px-3 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212]'
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleToggleHfModel(model.id);
                    }}
                  >
                    <div className='flex items-start gap-3'>
                      <div className='p-2 rounded-lg bg-yellow-100 dark:bg-yellow-900/30 ophelia:bg-[#eab308]/20 flex-shrink-0'>
                        <Zap className='h-4 w-4 text-yellow-600 dark:text-yellow-400' />
                      </div>
                      <div className='flex-1 min-w-0'>
                        <div className='flex items-center gap-2'>
                          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] truncate'>
                            {model.id}
                          </h4>
                          {model.gated && (
                            <span className='px-1.5 py-0.5 rounded text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'>
                              Gated
                            </span>
                          )}
                        </div>
                        <p className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373] mt-0.5'>
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
                            <span className='px-1.5 py-0.5 rounded bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]'>
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
                          className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
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

                  {/* Expanded GGUF files section */}
                  {isExpanded && (
                    <div className='px-3 pb-3 pt-1 border-t border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a] bg-gray-50 dark:bg-dark-200 ophelia:bg-[#0d0d0d]'>
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
                          <div className='text-xs font-medium text-gray-600 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
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
                                className='flex items-center gap-2 p-2 rounded-lg bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a] border border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
                              >
                                <div className='flex-1 min-w-0'>
                                  <div className='text-xs font-medium text-gray-800 dark:text-gray-200 ophelia:text-[#e5e5e5] truncate'>
                                    {file.filename}
                                  </div>
                                  <div className='flex items-center gap-2 mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
                                    <span>{file.sizeFormatted}</span>
                                    {file.quantization && (
                                      <span className='px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 ophelia:bg-[#9333ea]/20 text-purple-700 dark:text-purple-400 ophelia:text-[#a855f7]'>
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
                                        handleCancelPull();
                                      }}
                                      className='p-1.5 rounded-lg text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                                    >
                                      <X className='h-4 w-4' />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    onMouseDown={e => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      handlePullHfGguf(
                                        file.ollamaCommand,
                                        file.filename
                                      );
                                    }}
                                    disabled={!!pullingModel}
                                    className={cn(
                                      'px-3 py-1.5 rounded-lg text-xs font-medium',
                                      'bg-primary-100 dark:bg-primary-900/30 ophelia:bg-[#9333ea]/20',
                                      'text-primary-700 dark:text-primary-400 ophelia:text-[#a855f7]',
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

      {/* Footer */}
      <div className='px-3 py-2 border-t border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a] flex items-center justify-between flex-shrink-0'>
        <a
          href='https://huggingface.co/models'
          target='_blank'
          rel='noopener noreferrer'
          onMouseDown={e => e.stopPropagation()}
          className='text-xs text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] hover:underline flex items-center gap-1'
        >
          <ExternalLink className='h-3 w-3' />
          {t('modelManager.huggingface.browseAllLink')}
        </a>
        <button
          onMouseDown={e => {
            e.preventDefault();
            e.stopPropagation();
            loadHfModels();
          }}
          className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
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

  return (
    <div className={cn('relative', className)} ref={dropdownRef}>
      {/* Custom Select Button */}
      <button
        type='button'
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          compact
            ? 'h-[44px] sm:h-[52px] px-3 flex items-center justify-between text-left w-full '
            : 'w-full flex items-center justify-between gap-2 px-3 py-2 text-left ',
          'bg-gray-50 dark:bg-dark-200 ophelia:bg-[#121212] border border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
          'rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-dark-100 ophelia:hover:bg-[#1a1a1a]',
          'focus:outline-none focus:ring-2 focus:ring-primary-500/20 ophelia:focus:ring-[#9333ea]/20 focus:border-primary-500 ophelia:focus:border-[#9333ea]',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        )}
        title={
          compact
            ? currentModel
              ? getModelLabel(currentModel)
              : 'Select Model'
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

      {/* Portal Dropdown */}
      {isOpen &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-start sm:items-center justify-center p-2 sm:p-4'>
            {/* Background overlay */}
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setIsOpen(false)}
            />

            {/* Dropdown */}
            <div
              className={cn(
                'relative bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a] border border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a] shadow-2xl',
                'w-full max-w-md sm:w-[480px] sm:max-w-[90vw]',
                'mt-2 sm:mt-0 rounded-xl',
                'h-[85vh] sm:h-[600px] flex flex-col'
              )}
              onClick={e => e.stopPropagation()}
            >
              {/* Header with tabs */}
              <div className='flex-shrink-0'>
                {/* Search */}
                <div className='p-3 border-b border-gray-200 dark:border-dark-200 ophelia:border-[#1a1a1a]'>
                  <div className='relative'>
                    <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400' />
                    <input
                      ref={searchInputRef}
                      type='text'
                      placeholder={
                        activeTab === 'installed'
                          ? 'Search installed models...'
                          : activeTab === 'ollama'
                            ? 'Search Ollama library...'
                            : 'Search HuggingFace...'
                      }
                      value={searchTerm}
                      onChange={e => setSearchTerm(e.target.value)}
                      className={cn(
                        'w-full pl-10 pr-4 py-2.5 text-sm bg-gray-50 dark:bg-dark-200 ophelia:bg-[#121212]',
                        'border border-gray-200 dark:border-dark-300 ophelia:border-[#262626] rounded-lg',
                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20 ophelia:focus:ring-[#9333ea]/20',
                        'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]',
                        'placeholder-gray-500 ophelia:placeholder-[#737373]'
                      )}
                    />
                  </div>
                </div>

                {/* Tabs */}
                <div className='flex border-b border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'>
                  <button
                    onMouseDown={e => {
                      e.preventDefault();
                      e.stopPropagation();
                      setActiveTab('installed');
                    }}
                    className={cn(
                      'flex-1 px-4 py-2.5 text-sm font-medium transition-colors',
                      activeTab === 'installed'
                        ? 'text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] border-b-2 border-primary-500 ophelia:border-[#9333ea]'
                        : 'text-gray-500 dark:text-gray-400 ophelia:text-[#737373] hover:text-gray-700 dark:hover:text-gray-300'
                    )}
                  >
                    <HardDrive className='h-4 w-4 inline mr-1.5' />
                    Installed
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
                        ? 'text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] border-b-2 border-primary-500 ophelia:border-[#9333ea]'
                        : 'text-gray-500 dark:text-gray-400 ophelia:text-[#737373] hover:text-gray-700 dark:hover:text-gray-300'
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
                        ? 'text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] border-b-2 border-primary-500 ophelia:border-[#9333ea]'
                        : 'text-gray-500 dark:text-gray-400 ophelia:text-[#737373] hover:text-gray-700 dark:hover:text-gray-300'
                    )}
                  >
                    <Zap className='h-4 w-4 inline mr-1.5' />
                    HuggingFace
                  </button>
                </div>
              </div>

              {/* Content */}
              {activeTab === 'installed' && renderInstalledTab()}
              {activeTab === 'ollama' && renderOllamaLibraryTab()}
              {activeTab === 'huggingface' && renderHuggingFaceTab()}
            </div>
          </div>,
          document.body
        )}

      {/* Hidden select for form compatibility */}
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
