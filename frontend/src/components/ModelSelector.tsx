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

import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useImperativeHandle,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import {
  Bot,
  Brain,
  ChevronDown,
  Cloud,
  HardDrive,
  Search,
  Sparkles,
  Terminal,
  User,
  X,
  Zap,
} from 'lucide-react';
import { cn } from '@/utils';
import type { OllamaModel, Persona } from '@/types';
import { getPersonaAvatarSrc } from '@/utils/personaAvatar';
import {
  ollamaApi,
  huggingfaceHubApi,
  HuggingFaceModel,
  GgufFileInfo,
} from '@/utils/api';
import { useAuthStore } from '@/store/authStore';
import toast from 'react-hot-toast';
import { createLogger } from '@/utils/logger';
import { isAvailableOllamaModel } from '@/utils/chatModelSelection';
import { modelVisibilityKey } from '@/utils/modelVisibility';
import { useChatStore } from '@/store/chatStore';
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
  getModelValue: getModelValueOverride,
  getModelLabel: getModelLabelOverride,
  getModelTitle,
  triggerRef,
  triggerTestId,
  selectTestId,
  ariaLabel,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<TabType>('installed');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const internalTriggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { user, systemInfo } = useAuthStore();
  const canInstallModels =
    user?.role === 'admin' || systemInfo?.requiresAuth === false;

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
    'general',
    'coding',
    'reasoning',
    'vision',
    'embedding',
    'cloud',
  ];

  const groupedModels: ModelGroup[] = [
    {
      type: 'legacy' as const,
      label: t('modelSelector.providerNotRecorded', 'Provider not recorded'),
      icon: <Brain className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(model => model.isLegacySelection),
      color: 'gray',
    },
    {
      type: 'unavailable' as const,
      label: t('modelSelector.unavailableSelections', 'Unavailable selections'),
      icon: <X className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(
        model => model.isUnavailable && !model.isLegacySelection
      ),
      color: 'gray',
    },
    {
      type: 'personas' as const,
      label: t('modelSelector.personas'),
      icon: <User className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(model => model.isPersona && !model.isUnavailable),
      color: 'purple',
    },
    {
      type: 'agents' as const,
      label: t('modelSelector.agentModels', 'Agents'),
      icon: <Terminal className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(model => model.isAgent && !model.isUnavailable),
      color: 'green',
    },
    {
      type: 'ollama' as const,
      label: t('modelSelector.ollamaModels'),
      icon: <Bot className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(
        model => isAvailableOllamaModel(model) && !model.name.includes('embed')
      ),
      color: 'green',
    },
    {
      type: 'plugins' as const,
      label: t('modelSelector.pluginModels'),
      icon: <Zap className='h-4 w-4 text-gray-500 dark:text-dark-600' />,
      models: models.filter(model => model.isPlugin && !model.isUnavailable),
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

  const getModelValue = (model: OllamaModel): string =>
    getModelValueOverride?.(model) ?? model.name;

  const modelMetadata = useChatStore(state => state.modelMetadata);
  const personasById = useChatStore(state => state.personas);

  const currentModel = models.find(
    model => getModelValue(model) === selectedModel
  );

  /**
   * Human name for any persona-backed entry, including the fallback rows
   * fabricated for sessions whose persona is not in the loaded list (a
   * legacy record without provider identity, or personas still loading).
   * Those fallbacks only know the raw `persona:<uuid>` value, which must
   * never reach the trigger label.
   */
  const personaDisplayName = (model: OllamaModel): string | undefined => {
    if (!model.name.startsWith('persona:')) return undefined;
    const id = model.name.slice('persona:'.length);
    let decoded = id;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      // Not URL-encoded; use as-is.
    }
    const persona = personasById[id] ?? personasById[decoded];
    if (persona?.name) return persona.name;
    // Fabricated fallbacks copy the raw id into personaName; only trust a
    // personaName that is an actual name.
    if (model.personaName && model.personaName !== id) {
      return model.personaName;
    }
    return undefined;
  };

  /** The persona record behind a `persona:<id>` entry, if it is loaded. */
  const personaForModel = (model: OllamaModel): Persona | undefined => {
    if (!model.name.startsWith('persona:')) return undefined;
    const id = model.name.slice('persona:'.length);
    let decoded = id;
    try {
      decoded = decodeURIComponent(id);
    } catch {
      // Not URL-encoded; use as-is.
    }
    return personasById[id] ?? personasById[decoded];
  };
  useImperativeHandle(
    triggerRef,
    () => internalTriggerRef.current as HTMLButtonElement
  );
  const closeSelector = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    setSearchTerm('');
    if (restoreFocus) {
      window.requestAnimationFrame(() => internalTriggerRef.current?.focus());
    }
  }, []);

  const {
    data: libraryModels = [],
    isLoading: loadingLibrary,
    refetch: loadLibrary,
  } = useQuery({
    queryKey: [
      'ollama-library-selector',
      libraryDebouncedSearch,
      libraryCategory === 'cloud' ? 'cloud' : 'all',
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
            toast.success(t('modelDownload.success', { name: filename }));
            onModelsRefresh?.();
          },
          error => {
            setPullProgress(null);
            setPullingModel(null);
            setCancelPull(null);
            toast.error(t('modelDownload.failed', { error }));
          }
        );
        setCancelPull(() => cancelFn);
      } catch (_error) {
        setPullProgress(null);
        setPullingModel(null);
        toast.error(t('modelDownload.startFailed'));
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
        event.preventDefault();
        closeSelector();
        return;
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        ).filter(element => element.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeSelector, isOpen]);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const handleModelSelect = async (modelValue: string) => {
    const selectedOption =
      models.find(model => getModelValue(model) === modelValue) ??
      models.find(
        model =>
          !model.isPlugin && !model.isPersona && model.name === modelValue
      );
    const selectedValue = selectedOption
      ? getModelValue(selectedOption)
      : modelValue;
    const runtimeModelName = selectedOption?.name ?? modelValue;
    closeSelector();

    try {
      const runningModelsResponse = await ollamaApi.listRunningModels();
      if (runningModelsResponse.success && runningModelsResponse.data) {
        const runningModels = runningModelsResponse.data;
        if (runningModels.length > 0) {
          const currentlyLoaded =
            selectedOption?.isPlugin !== true &&
            runningModels.some(
              m =>
                m.name === runtimeModelName ||
                runtimeModelName.startsWith('persona:')
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
      target: { value: selectedValue },
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
          toast.success(t('modelDownload.success', { name: modelName }));
          onModelsRefresh?.();
        },
        error => {
          setPullProgress(null);
          setPullingModel(null);
          setCancelPull(null);
          toast.error(t('modelDownload.failed', { error }));
        }
      );
      setCancelPull(() => cancelFn);
    } catch (_error) {
      setPullProgress(null);
      setPullingModel(null);
      toast.error(t('modelDownload.startFailed'));
    }
  };

  const handleCancelPull = () => {
    if (cancelPull) {
      cancelPull();
      setCancelPull(null);
      setPullingModel(null);
      setPullProgress(null);
      toast.success(t('modelDownload.cancelled'));
    }
  };

  const isModelInstalled = (name: string) => {
    return models.some(
      model =>
        isAvailableOllamaModel(model) &&
        (model.name === name || model.name.startsWith(name + ':'))
    );
  };

  const getModelIcon = (model: OllamaModel) => {
    // An administrator-set picture stands in for the generic provider icon.
    const picture = modelMetadata[modelVisibilityKey(model)]?.avatar;
    if (picture && !model.isPersona) {
      return (
        <img
          src={picture}
          alt=''
          className='h-4 w-4 shrink-0 rounded-full object-cover'
        />
      );
    }
    // Personas show their own face, the same rounded square as everywhere
    // else; the generic icon only stands in while personas are loading.
    if (model.isPersona || model.isLegacySelection) {
      const persona = personaForModel(model);
      if (persona) {
        return (
          <img
            src={getPersonaAvatarSrc(persona, 64)}
            alt=''
            className='h-4 w-4 shrink-0 rounded object-cover'
          />
        );
      }
    }
    if (model.isLegacySelection) {
      return <Brain className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
    }
    if (model.isPersona) {
      return <User className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
    }
    if (model.isPlugin) {
      return <Zap className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
    }
    return <Bot className='h-4 w-4 text-gray-500 dark:text-dark-600' />;
  };

  const getModelLabel = (model: OllamaModel) => {
    if (getModelLabelOverride) {
      return getModelLabelOverride(model);
    }
    const named = modelMetadata[modelVisibilityKey(model)]?.label;
    if (named && !model.isPersona) {
      return named;
    }
    if (model.isLegacySelection) {
      const personaLabel = personaDisplayName(model);
      return `${personaLabel ?? model.name} (${t(
        'modelSelector.legacyProvider',
        'provider not recorded'
      )})`;
    }
    if (model.isPersona) {
      return personaDisplayName(model) || model.personaName || model.name;
    }
    if (model.isAgent) {
      return model.isUnavailable
        ? `${model.agentName || model.name} (${t('modelSelector.unavailable', 'unavailable')})`
        : model.agentName || model.name;
    }
    if (model.isPlugin) {
      return model.isUnavailable
        ? `${model.name} (${t('modelSelector.unavailable', 'unavailable')})`
        : model.name;
    }
    return model.isUnavailable
      ? `${model.name} (${t('modelSelector.unavailable', 'unavailable')})`
      : model.name;
  };

  const getModelSubLabel = (model: OllamaModel) => {
    if (model.isLegacySelection) {
      return model.isUnavailable
        ? t('modelSelector.providerUnavailable', 'provider unavailable')
        : t(
            'modelSelector.reselectProvider',
            'reselect a provider to pin this model'
          );
    }
    if (model.isPersona) {
      return `via ${model.model}`;
    }
    if (model.isPlugin) {
      return model.isUnavailable
        ? `via ${model.pluginName || model.pluginId} · ${t(
            'modelSelector.providerUnavailable',
            'provider unavailable'
          )}`
        : `via ${model.pluginName}`;
    }
    if (model.isUnavailable) {
      return t('modelSelector.providerUnavailable', 'provider unavailable');
    }
    return null;
  };

  const getCurrentModelDisplay = () => {
    if (!currentModel) {
      return compact ? (
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          <Bot className='h-4 w-4 shrink-0' />
          <span className='truncate text-xs font-medium text-ink-subtle'>
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
        <div className='flex min-w-0 flex-1 items-center gap-2'>
          <span className='shrink-0'>{getModelIcon(currentModel)}</span>
          <span
            dir={currentModel.isPersona ? 'auto' : 'ltr'}
            className='truncate text-xs font-medium text-ink'
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
    closeSelector(false);
    navigate('/gallery');
  };

  return (
    <div className={cn('relative min-w-0', className)} ref={dropdownRef}>
      <button
        ref={internalTriggerRef}
        data-testid={triggerTestId}
        type='button'
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        aria-haspopup='dialog'
        aria-expanded={isOpen}
        aria-label={
          ariaLabel && currentModel
            ? `${ariaLabel}: ${getModelLabel(currentModel)}`
            : ariaLabel
        }
        className={cn(
          compact
            ? 'flex h-9 w-full min-w-0 items-center justify-between gap-2 px-2.5 text-start'
            : 'w-full flex items-center justify-between gap-2 px-3 py-2.5 text-start',
          'rounded-xl border border-line bg-surface-subtle text-sm text-ink hover:bg-hover-solid',
          'transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500/40',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        )}
        title={
          compact
            ? currentModel
              ? (getModelTitle?.(currentModel) ?? getModelLabel(currentModel))
              : t('modelSelector.selectModel')
            : undefined
        }
      >
        {getCurrentModelDisplay()}
        <ChevronDown
          className={cn(
            compact ? 'h-3 w-3' : 'h-4 w-4',
            'shrink-0 text-ink-subtle transition-transform duration-150 motion-reduce:transition-none',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {isOpen &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-3 sm:p-6'>
            <div
              className='absolute inset-0 bg-gray-950/55 backdrop-blur-md'
              onClick={() => closeSelector()}
            />

            <div
              ref={dialogRef}
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
                    onClick={() => closeSelector()}
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
                  getModelValue={getModelValue}
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
        data-testid={selectTestId}
        aria-label={ariaLabel}
        aria-hidden='true'
        dir='ltr'
        value={selectedModel}
        onChange={onModelChange}
        className='hidden'
        tabIndex={-1}
      >
        {models.map(model => (
          <option
            key={`${model.isLegacySelection ? 'legacy' : model.isPersona ? 'persona' : model.isPlugin ? 'plugin' : 'ollama'}:${model.pluginId || ''}:${getModelValue(model)}`}
            value={getModelValue(model)}
          >
            {getModelLabel(model)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default ModelSelector;
