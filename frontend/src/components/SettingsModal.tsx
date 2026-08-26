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
  useMemo,
  useRef,
  useEffect,
  useCallback,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X,
  Bot,
  Database,
  HardDrive,
  Palette,
  Info,
  Globe,
  Puzzle,
  Sliders,
  Volume2,
  ImageIcon,
  Keyboard,
  KeyRound,
  BellRing,
  MonitorSmartphone,
  Search,
  BookText,
  GraduationCap,
  Wrench,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/utils';
import { SettingsAboutTab } from '@/components/settings/SettingsAboutTab';
import { SettingsAppearanceTab } from '@/components/settings/SettingsAppearanceTab';
import { SettingsDataTab } from '@/components/settings/SettingsDataTab';
import { SettingsDocumentsTab } from '@/components/settings/SettingsDocumentsTab';
import { SettingsGenerationTab } from '@/components/settings/SettingsGenerationTab';
import { SettingsImageGenerationTab } from '@/components/settings/SettingsImageGenerationTab';
import { SettingsModelsTab } from '@/components/settings/SettingsModelsTab';
import { SettingsShortcutsTab } from '@/components/settings/SettingsShortcutsTab';
import { SettingsPluginsTab } from '@/components/settings/SettingsPluginsTab';
import { SettingsSearchTab } from '@/components/settings/SettingsSearchTab';
import { SettingsSessionsTab } from '@/components/settings/SettingsSessionsTab';
import { SettingsNotificationsTab } from '@/components/settings/SettingsNotificationsTab';
import { SettingsApiKeysTab } from '@/components/settings/SettingsApiKeysTab';
import { useAuthStore } from '@/store/authStore';
import { SettingsTtsTab } from '@/components/settings/SettingsTtsTab';
import { SettingsPromptsTab } from '@/components/settings/SettingsPromptsTab';
import { SettingsSkillsTab } from '@/components/settings/SettingsSkillsTab';
import { SettingsToolsTab } from '@/components/settings/SettingsToolsTab';
import { SettingsTabHeader } from '@/components/settings/SettingsTabHeader';
import { ModelManager } from '@/components/ModelManager';
import { useSettingsDataImport } from '@/components/settings/useSettingsDataImport';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/store/chatStore';
import { getErrorMessage } from '@/store/chatStoreHelpers';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import {
  ChatProviderType,
  EmbeddingModel,
  GenerationOptions,
  Theme,
} from '@/types';
import { normalizeTheme } from '@/utils/theme';
import { triggerHapticFeedback } from '@/utils/haptics';
import { resolveAppVersion } from '@/utils/appVersion';
import {
  chatModelOptionKey,
  chatModelSelectionFromKey,
  chatModelSelectionKeyForModels,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';
import {
  preferencesApi,
  ollamaApi,
  documentsApi,
  embeddingApi,
  ttsApi,
  imageGenApi,
  pluginApi,
  findTTSModel,
  resolveTTSModel,
  TTSModel,
  TTSPlugin,
  TTSVoiceProfile,
  ImageGenModel,
  ImageGenPlugin,
  findImageGenModel,
  resolveImageGenOption,
  resolveImageGenModel,
} from '@/utils/api';
import toast from 'react-hot-toast';

// Get version from Vite env (includes -dev suffix on dev branch)
const appVersion = resolveAppVersion() || '0.0.0';
const AUTO_TITLE_CURRENT_MODEL = '__current_running_model__';
const DEFAULT_EMBEDDING_SETTINGS = {
  enabled: false,
  model: 'nomic-embed-text',
  chunkSize: 1000,
  chunkOverlap: 200,
  similarityThreshold: 0.7,
};
const DEFAULT_TTS_SETTINGS = {
  enabled: false,
  autoPlay: false,
  model: '',
  voice: '',
  voiceProfileId: '',
  speed: 1.0,
  pluginId: '',
  streamSentences: true,
};
const DEFAULT_IMAGE_GEN_SETTINGS = {
  enabled: false,
  model: '',
  size: '1024x1024',
  quality: 'standard',
  style: 'vivid',
  pluginId: '',
};

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Tab to open on, for entry points that target one directly. */
  initialTab?: string;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  initialTab,
}) => {
  const {
    models,
    selectedModel,
    selectedProviderType,
    selectedProviderId,
    setSelectedModel,
    systemMessage,
    setSystemMessage,
    clearAllSessions,
    loading,
    sessions,
    loadModels,
    loadSessions,
    loadFolders,
  } = useChatStore();
  const { theme, updateTheme, preferences, setPreferences, loadPreferences } =
    useAppStore();
  const {
    plugins,
    isLoading: pluginLoading,
    isUploading,
    error: pluginError,
    loadPlugins,
    uploadPlugin,
    deletePlugin,
    activatePlugin,
    deactivatePlugin,
    exportPlugin,
    clearError: clearPluginError,
    installPlugin,
  } = usePluginStore();
  const { t } = useTranslation();
  const settingsTitleId = React.useId();

  const defaultSelection = {
    model: selectedModel,
    providerType: selectedProviderType,
    providerId: selectedProviderId,
  };
  const defaultSelectorModels = withUnavailableChatModel(
    models,
    defaultSelection
  );
  const taskSelection = {
    model: preferences.titleSettings?.taskModel || '',
    providerType: preferences.titleSettings?.taskProviderType,
    providerId: preferences.titleSettings?.taskProviderId,
  };
  const taskSelectorModels = withUnavailableChatModel(models, taskSelection);
  const currentTaskModel =
    taskSelection.model === AUTO_TITLE_CURRENT_MODEL
      ? AUTO_TITLE_CURRENT_MODEL
      : taskSelection.model
        ? chatModelSelectionKeyForModels(taskSelectorModels, taskSelection)
        : '';
  const visionSelection = {
    model: preferences.visionModel || '',
    providerType: preferences.visionProviderType,
    providerId: preferences.visionProviderId,
  };
  const visionSelectorModels = withUnavailableChatModel(
    models,
    visionSelection
  );
  const currentVisionModel = visionSelection.model
    ? chatModelSelectionKeyForModels(visionSelectorModels, visionSelection)
    : '';
  const visionModelOptions = [
    {
      value: '',
      label: t('settings.model.selectVisionModel', {
        defaultValue: 'Use the current chat model',
      }),
    },
    ...visionSelectorModels.map(model => ({
      value: chatModelOptionKey(model),
      label: model.isLegacySelection
        ? `${model.name} · provider not recorded${
            model.isUnavailable ? ' (unavailable)' : ''
          }`
        : model.isPersona
          ? `${model.personaName || model.name} (persona)`
          : model.isPlugin
            ? `${model.name} · ${model.pluginName || model.pluginId}${
                model.isUnavailable ? ' (unavailable)' : ''
              }`
            : model.isAgent
              ? `${model.agentName || model.name} · Agent CLI${
                  model.isUnavailable ? ' (unavailable)' : ''
                }`
              : `${model.name} · Ollama${
                  model.isUnavailable ? ' (unavailable)' : ''
                }`,
    })),
  ];
  const autoTitleTaskModelOptions = [
    {
      value: '',
      label: t('settings.model.autoTitle.selectTaskModel'),
    },
    {
      value: AUTO_TITLE_CURRENT_MODEL,
      label: 'Use current running model',
    },
    ...taskSelectorModels.map(model => ({
      value: chatModelOptionKey(model),
      label: model.isLegacySelection
        ? `${model.name} · provider not recorded${
            model.isUnavailable ? ' (unavailable)' : ''
          }`
        : model.isPersona
          ? `${model.personaName || model.name} (persona)`
          : model.isPlugin
            ? `${model.name} · ${model.pluginName || model.pluginId}${
                model.isUnavailable ? ' (unavailable)' : ''
              }`
            : `${model.name} · Ollama${
                model.isUnavailable ? ' (unavailable)' : ''
              }`,
    })),
  ];

  // The Search tab manages a server-wide setting; only administrators (or
  // the single-user no-auth mode) see it.
  const settingsAuthUser = useAuthStore(state => state.user);
  const settingsSystemInfo = useAuthStore(state => state.systemInfo);
  const isSettingsAdmin =
    settingsAuthUser?.role === 'admin' ||
    settingsSystemInfo?.requiresAuth === false;
  const [activeTab, setActiveTab] = useState(initialTab ?? 'appearance');
  // Which settings the Generation tab edits. It used to pin whatever model the
  // chat happened to be on, with no way to reach the global values, so a limit
  // set here came back the moment the model changed.
  const [generationScope, setGenerationScope] = useState<'global' | 'model'>(
    'global'
  );
  const [settingsQuery, setSettingsQuery] = useState('');
  const [tempSystemMessage, setTempSystemMessage] = useState(systemMessage);

  const [updatingAllModels, setUpdatingAllModels] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<{
    current: number;
    total: number;
    modelName: string;
    status: 'starting' | 'success' | 'error';
    error?: string;
  } | null>(null);

  // Plugin state
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [showJsonForm, setShowJsonForm] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Plugin API key state
  const [expandedPluginId, setExpandedPluginId] = useState<string | null>(null);
  const [pluginApiKeys, setPluginApiKeys] = useState<Record<string, string>>(
    {}
  );
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [savingApiKey, setSavingApiKey] = useState<string | null>(null);
  const [refreshingPluginIds, setRefreshingPluginIds] = useState<
    Record<string, boolean>
  >({});

  // Generation options state
  const [tempGenerationOptions, setTempGenerationOptions] = useState(
    preferences.generationOptions || {}
  );

  /**
   * What the selected model recommends for itself, read from its modelfile.
   * Fetched rather than assumed: a fixed 2048-token window truncates a model
   * trained for far more.
   */
  const loadModelRecommendedOptions = useCallback(
    async (model: string): Promise<Partial<GenerationOptions>> => {
      try {
        const response = await ollamaApi.getModelDefaults(model);
        return response.success ? (response.data?.options ?? {}) : {};
      } catch {
        // A model that cannot be inspected simply contributes nothing.
        return {};
      }
    },
    []
  );

  useEffect(() => {
    if (!isOpen) return;

    const forModel = generationScope === 'model' && Boolean(selectedModel);
    let cancelled = false;

    // Editing the global values shows exactly those, so what is saved is what
    // was displayed. For one model it shows what that model will actually run
    // with: the global values, its own recommendations on top, and anything
    // pinned for it winning over both.
    void (
      forModel
        ? loadModelRecommendedOptions(selectedModel)
        : Promise.resolve({})
    ).then(recommended => {
      if (cancelled) return;
      setTempGenerationOptions(
        forModel
          ? {
              ...(preferences.generationOptions || {}),
              ...recommended,
              ...(preferences.modelGenerationOptions?.[selectedModel] || {}),
            }
          : { ...(preferences.generationOptions || {}) }
      );
    });

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    generationScope,
    selectedModel,
    loadModelRecommendedOptions,
    preferences.generationOptions,
    preferences.modelGenerationOptions,
  ]);

  // Embedding settings state
  const [embeddingSettings, setEmbeddingSettings] = useState(
    preferences.embeddingSettings || DEFAULT_EMBEDDING_SETTINGS
  );
  const [regeneratingEmbeddings, setRegeneratingEmbeddings] = useState(false);

  // TTS settings state
  const [ttsSettings, setTtsSettings] = useState(
    preferences.ttsSettings || DEFAULT_TTS_SETTINGS
  );
  const [testingTTS, setTestingTTS] = useState(false);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const clearedDanglingVoiceProfileRef = useRef<string | null>(null);

  // Image Generation settings state
  const [imageGenSettings, setImageGenSettings] = useState(
    preferences.imageGenSettings || DEFAULT_IMAGE_GEN_SETTINGS
  );

  const {
    importing,
    preflighting,
    preflight,
    showImportOptions,
    mergeStrategy,
    importResult,
    setImportResult,
    importFileInputRef,
    handleExportData,
    handleImportFileSelect,
    handleMergeStrategyChange,
    handleConfirmImport,
    handleCancelImport,
  } = useSettingsDataImport({
    loadPreferences,
    loadSessions,
    loadFolders,
  });
  const queryClient = useQueryClient();

  // Plugin credentials query
  const { data: pluginHasKeys = {} } = useQuery({
    queryKey: ['plugin-credentials'],
    queryFn: async (): Promise<Record<string, boolean>> => {
      const response = await pluginApi.getCredentials();
      if (!response.success || !response.data) return {};
      const map: Record<string, boolean> = {};
      for (const cred of response.data) {
        map[cred.plugin_id] = cred.has_api_key;
      }
      return map;
    },
    enabled: isOpen,
  });

  // Embedding models query
  const { data: availableEmbeddingModels = [] } = useQuery({
    queryKey: ['embedding-models'],
    queryFn: async (): Promise<EmbeddingModel[]> => {
      const response = await embeddingApi.getModels();
      return response.success && response.data ? response.data : [];
    },
    enabled: isOpen,
  });
  const effectiveEmbeddingSettings = useMemo(() => {
    const matchingModel = availableEmbeddingModels.find(
      model =>
        model.id === embeddingSettings.model ||
        model.rawModel === embeddingSettings.model
    );

    return matchingModel && matchingModel.id !== embeddingSettings.model
      ? { ...embeddingSettings, model: matchingModel.id }
      : embeddingSettings;
  }, [availableEmbeddingModels, embeddingSettings]);

  // Embedding status query
  const { data: embeddingStatus = null } = useQuery({
    queryKey: ['embedding-status'],
    queryFn: async () => {
      const response = await documentsApi.getEmbeddingStatus();
      return response.success && response.data ? response.data : null;
    },
    enabled: isOpen,
  });

  // TTS data query
  const { data: ttsData, isLoading: loadingTTS } = useQuery({
    queryKey: ['tts-data'],
    queryFn: async () => {
      const [modelsResponse, pluginsResponse] = await Promise.all([
        ttsApi.getModels(),
        ttsApi.getPlugins(),
      ]);
      return {
        models:
          modelsResponse.success && Array.isArray(modelsResponse.data)
            ? modelsResponse.data
            : [],
        plugins:
          pluginsResponse.success && Array.isArray(pluginsResponse.data)
            ? pluginsResponse.data
            : [],
      };
    },
    enabled: isOpen,
  });
  const ttsModels: TTSModel[] = useMemo(() => ttsData?.models ?? [], [ttsData]);
  const ttsPlugins: TTSPlugin[] = ttsData?.plugins ?? [];
  const selectedTtsModel = useMemo(
    () => resolveTTSModel(ttsModels, ttsSettings.model, ttsSettings.pluginId),
    [ttsModels, ttsSettings.model, ttsSettings.pluginId]
  );
  const modelResolvedTtsSettings = useMemo(() => {
    if (!selectedTtsModel) return ttsSettings;

    const savedModel = findTTSModel(
      ttsModels,
      ttsSettings.model,
      ttsSettings.pluginId
    );
    if (savedModel && ttsSettings.pluginId === savedModel.plugin) {
      return ttsSettings;
    }

    return {
      ...ttsSettings,
      model: selectedTtsModel.model,
      pluginId: selectedTtsModel.plugin,
      voice: selectedTtsModel.config?.default_voice ?? '',
      voiceProfileId: '',
    };
  }, [selectedTtsModel, ttsModels, ttsSettings]);

  // TTS voices derived from currently selected model
  const ttsVoices = useMemo(() => {
    const currentModel = findTTSModel(
      ttsModels,
      modelResolvedTtsSettings.model,
      modelResolvedTtsSettings.pluginId
    );
    return currentModel?.config?.voices ?? [];
  }, [modelResolvedTtsSettings, ttsModels]);

  const {
    data: ttsVoiceProfiles = [],
    isLoading: loadingTTSVoiceProfiles,
    isSuccess: loadedTTSVoiceProfiles,
  } = useQuery<TTSVoiceProfile[]>({
    queryKey: ['tts-voice-profiles'],
    queryFn: async () => {
      const response = await ttsApi.getVoiceProfiles();
      if (!response.success) {
        throw new Error(response.message || 'Failed to load saved voices');
      }
      return response.data ?? [];
    },
    enabled: isOpen,
  });

  const selectableTtsVoiceProfiles = useMemo(
    () =>
      ttsVoiceProfiles.filter(
        profile =>
          profile.pluginId === modelResolvedTtsSettings.pluginId &&
          profile.model === modelResolvedTtsSettings.model &&
          (profile.consentStatus ?? 'active') === 'active'
      ),
    [modelResolvedTtsSettings, ttsVoiceProfiles]
  );

  const effectiveTtsSettings = useMemo(() => {
    const selectedProfileId = modelResolvedTtsSettings.voiceProfileId;
    const selectedProfile = selectedProfileId
      ? ttsVoiceProfiles.find(profile => profile.id === selectedProfileId)
      : undefined;
    const selectedModelCannotClone =
      Boolean(selectedProfileId && selectedTtsModel) &&
      !selectedTtsModel?.config?.supports_voice_cloning;
    const selectedProfileIsUnavailable =
      loadedTTSVoiceProfiles &&
      Boolean(selectedProfileId) &&
      (!selectedProfile ||
        selectedProfile.pluginId !== modelResolvedTtsSettings.pluginId ||
        selectedProfile.model !== modelResolvedTtsSettings.model ||
        (selectedProfile.consentStatus ?? 'active') !== 'active');
    if (
      !selectedProfileId ||
      (!selectedModelCannotClone && !selectedProfileIsUnavailable)
    ) {
      return modelResolvedTtsSettings;
    }

    return {
      ...modelResolvedTtsSettings,
      voiceProfileId: '',
      voice: selectedTtsModel?.config?.default_voice ?? '',
    };
  }, [
    loadedTTSVoiceProfiles,
    modelResolvedTtsSettings,
    selectedTtsModel,
    ttsVoiceProfiles,
  ]);

  useEffect(() => {
    const selectedProfileId = modelResolvedTtsSettings.voiceProfileId;
    const selectedProfile = selectedProfileId
      ? ttsVoiceProfiles.find(profile => profile.id === selectedProfileId)
      : undefined;
    const profileIsUnavailable =
      Boolean(selectedProfileId) &&
      ((Boolean(selectedTtsModel) &&
        !selectedTtsModel?.config?.supports_voice_cloning) ||
        (loadedTTSVoiceProfiles &&
          (!selectedProfile ||
            selectedProfile.pluginId !== modelResolvedTtsSettings.pluginId ||
            selectedProfile.model !== modelResolvedTtsSettings.model)));
    if (
      !profileIsUnavailable ||
      !selectedProfileId ||
      clearedDanglingVoiceProfileRef.current === selectedProfileId
    ) {
      return;
    }

    clearedDanglingVoiceProfileRef.current = selectedProfileId;
    void preferencesApi
      .updatePreferences({ ttsSettings: effectiveTtsSettings })
      .then(response => {
        if (response.success && response.data) setPreferences(response.data);
      })
      .catch(error => {
        clearedDanglingVoiceProfileRef.current = null;
        toast.error(
          getErrorMessage(
            error,
            t('settings.tts.savedVoiceUnavailableCleanupFailed')
          )
        );
      });
  }, [
    effectiveTtsSettings,
    loadedTTSVoiceProfiles,
    modelResolvedTtsSettings.model,
    modelResolvedTtsSettings.pluginId,
    modelResolvedTtsSettings.voiceProfileId,
    selectedTtsModel,
    setPreferences,
    t,
    ttsVoiceProfiles,
  ]);

  // Image Gen data query
  const { data: imageGenData, isLoading: loadingImageGen } = useQuery({
    queryKey: ['image-gen-data'],
    queryFn: async () => {
      const [modelsResponse, pluginsResponse] = await Promise.all([
        imageGenApi.getModels(),
        imageGenApi.getPlugins(),
      ]);
      return {
        models:
          modelsResponse.success && modelsResponse.data
            ? modelsResponse.data
            : [],
        plugins:
          pluginsResponse.success && pluginsResponse.data
            ? pluginsResponse.data
            : [],
      };
    },
    enabled: isOpen,
  });
  const imageGenModels: ImageGenModel[] = useMemo(
    () => imageGenData?.models ?? [],
    [imageGenData]
  );
  const imageGenPlugins: ImageGenPlugin[] = useMemo(
    () => imageGenData?.plugins ?? [],
    [imageGenData]
  );
  const selectedImageGenModel = useMemo(
    () =>
      resolveImageGenModel(
        imageGenModels,
        imageGenSettings.model,
        imageGenSettings.pluginId
      ),
    [imageGenModels, imageGenSettings.model, imageGenSettings.pluginId]
  );
  const effectiveImageGenSettings = useMemo(() => {
    if (!selectedImageGenModel) {
      return imageGenSettings;
    }

    const savedModel = findImageGenModel(
      imageGenModels,
      imageGenSettings.model,
      imageGenSettings.pluginId
    );
    if (savedModel && imageGenSettings.pluginId === savedModel.plugin) {
      return imageGenSettings;
    }

    return {
      ...imageGenSettings,
      model: selectedImageGenModel.model,
      pluginId: selectedImageGenModel.plugin,
      size: resolveImageGenOption(
        selectedImageGenModel.config?.sizes,
        imageGenSettings.size,
        selectedImageGenModel.config?.default_size,
        '1024x1024'
      ),
      quality: resolveImageGenOption(
        selectedImageGenModel.config?.qualities,
        imageGenSettings.quality,
        selectedImageGenModel.config?.default_quality,
        'standard'
      ),
      style: resolveImageGenOption(
        selectedImageGenModel.config?.styles,
        imageGenSettings.style,
        selectedImageGenModel.config?.default_style,
        'vivid'
      ),
    };
  }, [imageGenModels, imageGenSettings, selectedImageGenModel]);
  const imageGenSizes = selectedImageGenModel?.config?.sizes ?? [];
  const imageGenQualities = selectedImageGenModel?.config?.qualities ?? [];
  const imageGenStyles = selectedImageGenModel?.config?.styles ?? [];

  const modalInitializedRef = useRef(false);
  const previousSystemMessageRef = useRef(systemMessage);

  useEffect(() => {
    if (!isOpen) {
      modalInitializedRef.current = false;
      return;
    }

    if (
      modalInitializedRef.current &&
      previousSystemMessageRef.current === systemMessage
    ) {
      return;
    }

    modalInitializedRef.current = true;
    previousSystemMessageRef.current = systemMessage;
    setTempSystemMessage(systemMessage);
    setTempGenerationOptions(preferences.generationOptions || {});
    setEmbeddingSettings(
      preferences.embeddingSettings || DEFAULT_EMBEDDING_SETTINGS
    );
    setTtsSettings(preferences.ttsSettings || DEFAULT_TTS_SETTINGS);
    setImageGenSettings(
      preferences.imageGenSettings || DEFAULT_IMAGE_GEN_SETTINGS
    );
  }, [
    isOpen,
    preferences.embeddingSettings,
    preferences.generationOptions,
    preferences.imageGenSettings,
    preferences.ttsSettings,
    systemMessage,
  ]);

  const loadedStoresForOpenRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      loadedStoresForOpenRef.current = false;
      return;
    }

    if (loadedStoresForOpenRef.current) return;
    loadedStoresForOpenRef.current = true;
    loadPlugins();
    loadModels();
  }, [isOpen, loadPlugins, loadModels]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleSaveApiKey = async (pluginId: string) => {
    const apiKey = pluginApiKeys[pluginId];
    if (!apiKey?.trim()) {
      toast.error(t('settings.plugins.apiKey.enterKey'));
      return;
    }

    setSavingApiKey(pluginId);
    try {
      const response = await pluginApi.setApiKey(pluginId, apiKey.trim());
      if (response.success) {
        toast.success(t('settings.plugins.apiKey.saved'));
        await queryClient.invalidateQueries({
          queryKey: ['plugin-credentials'],
        });
        await loadPlugins();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['image-gen-data'] }),
          queryClient.invalidateQueries({ queryKey: ['tts-data'] }),
        ]);
        setPluginApiKeys(prev => ({ ...prev, [pluginId]: '' }));
        setShowApiKey(prev => ({ ...prev, [pluginId]: false }));
      } else {
        toast.error(response.error || t('settings.plugins.apiKey.saveFailed'));
      }
    } catch (_error) {
      toast.error(t('settings.plugins.apiKey.saveFailed'));
    } finally {
      setSavingApiKey(null);
    }
  };

  const handleDeleteApiKey = async (pluginId: string) => {
    setSavingApiKey(pluginId);
    try {
      const response = await pluginApi.deleteApiKey(pluginId);
      if (response.success) {
        toast.success(t('settings.plugins.apiKey.removed'));
        await queryClient.invalidateQueries({
          queryKey: ['plugin-credentials'],
        });
        await loadPlugins();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['image-gen-data'] }),
          queryClient.invalidateQueries({ queryKey: ['tts-data'] }),
        ]);
        setPluginApiKeys(prev => ({ ...prev, [pluginId]: '' }));
      } else {
        toast.error(
          response.error || t('settings.plugins.apiKey.removeFailed')
        );
      }
    } catch (_error) {
      toast.error(t('settings.plugins.apiKey.removeFailed'));
    } finally {
      setSavingApiKey(null);
    }
  };

  const handleTtsModelChange = (modelName: string, pluginId: string) => {
    const selectedModel = findTTSModel(ttsModels, modelName, pluginId);
    if (selectedModel) {
      setTtsSettings(prev => ({
        ...prev,
        model: modelName,
        pluginId,
        voice: selectedModel.config?.default_voice ?? '',
        voiceProfileId: '',
      }));
    }
  };

  const handleImageGenModelChange = (modelName: string, pluginId: string) => {
    const selectedModel = findImageGenModel(
      imageGenModels,
      modelName,
      pluginId
    );
    if (selectedModel) {
      setImageGenSettings(prev => ({
        ...prev,
        model: modelName,
        pluginId: selectedModel.plugin,
        size: resolveImageGenOption(
          selectedModel.config?.sizes,
          prev.size,
          selectedModel.config?.default_size,
          '1024x1024'
        ),
        quality: resolveImageGenOption(
          selectedModel.config?.qualities,
          prev.quality,
          selectedModel.config?.default_quality,
          'standard'
        ),
        style: resolveImageGenOption(
          selectedModel.config?.styles,
          prev.style,
          selectedModel.config?.default_style,
          'vivid'
        ),
      }));
    }
  };

  const handleTtsSettingChange = (
    key: keyof typeof ttsSettings,
    value: string | number | boolean
  ) => {
    setTtsSettings(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleTtsVoiceChange = (voice: string, voiceProfileId: string) => {
    setTtsSettings(prev => ({
      ...prev,
      voice,
      voiceProfileId,
    }));
  };

  const handleRevokeTtsVoiceProfile = async (profile: TTSVoiceProfile) => {
    if (
      !window.confirm(
        t('settings.tts.revokeSavedVoiceConfirm', {
          name: profile.name,
          defaultValue:
            'Withdraw consent for “{{name}}”? The saved voice can no longer be used, but the consent record is kept.',
        })
      )
    ) {
      return;
    }
    try {
      const response = await ttsApi.revokeVoiceProfile(profile.id);
      if (!response.success) {
        throw new Error(
          response.error || t('settings.tts.savedVoiceRevokeFailed')
        );
      }
      const updated = response.data;
      queryClient.setQueryData<TTSVoiceProfile[]>(
        ['tts-voice-profiles'],
        current =>
          current?.map(candidate =>
            candidate.id === profile.id && updated ? updated : candidate
          ) ?? []
      );
      await queryClient.invalidateQueries({
        queryKey: ['tts-voice-profiles'],
      });
      toast.success(
        t('settings.tts.savedVoiceRevoked', {
          defaultValue: 'Consent withdrawn',
        })
      );
    } catch (error: unknown) {
      toast.error(
        getErrorMessage(
          error,
          t('settings.tts.savedVoiceRevokeFailed', {
            defaultValue: 'Failed to withdraw consent',
          })
        )
      );
    }
  };

  const handleDeleteTtsVoiceProfile = async (profile: TTSVoiceProfile) => {
    if (
      !window.confirm(
        t('settings.tts.deleteSavedVoiceConfirm', {
          name: profile.name,
          defaultValue:
            'Delete the saved voice “{{name}}”? Its reference recording and transcript will be removed.',
        })
      )
    ) {
      return;
    }

    try {
      await ttsApi.deleteVoiceProfile(profile.id);
    } catch (error: unknown) {
      toast.error(
        getErrorMessage(
          error,
          t('settings.tts.savedVoiceDeleteFailed', {
            defaultValue: 'Failed to delete saved voice',
          })
        )
      );
      return;
    }

    const fallbackVoice = selectedTtsModel?.config?.default_voice ?? '';
    if (ttsSettings.voiceProfileId === profile.id) {
      setTtsSettings(prev => ({
        ...prev,
        voiceProfileId: '',
        voice: fallbackVoice,
      }));
    }
    if (preferences.ttsSettings?.voiceProfileId === profile.id) {
      setPreferences({
        ...preferences,
        ttsSettings: {
          ...preferences.ttsSettings,
          voiceProfileId: '',
          voice: fallbackVoice,
        },
      });
    }
    queryClient.setQueryData<TTSVoiceProfile[]>(
      ['tts-voice-profiles'],
      current => current?.filter(candidate => candidate.id !== profile.id) ?? []
    );
    await queryClient.invalidateQueries({
      queryKey: ['tts-voice-profiles'],
    });
    toast.success(
      t('settings.tts.savedVoiceDeleted', {
        defaultValue: 'Saved voice deleted',
      })
    );

    if (preferences.ttsSettings?.voiceProfileId === profile.id) {
      try {
        const response = await preferencesApi.updatePreferences({
          ttsSettings: {
            ...preferences.ttsSettings,
            voiceProfileId: '',
            voice: fallbackVoice,
          },
        });
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Preference update failed');
        }
        setPreferences(response.data);
      } catch {
        toast.error(
          t('settings.tts.savedVoicePreferenceCleanupFailed', {
            defaultValue:
              'Saved voice deleted, but Speech settings could not be reset',
          })
        );
      }
    }
  };

  const handleSaveTtsSettings = async () => {
    try {
      const response = await preferencesApi.updatePreferences({
        ttsSettings: effectiveTtsSettings,
      });
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success(t('settings.tts.saveSuccess'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('settings.tts.saveFailed', { error: errorMessage }));
    }
  };

  const handleTestTTS = async () => {
    if (testingTTS) {
      // Stop current test
      const audio = testAudioRef.current;
      if (audio) {
        audio.pause();
        audio.currentTime = 0;
        testAudioRef.current = null;
      }
      setTestingTTS(false);
      return;
    }

    setTestingTTS(true);
    try {
      const response = await ttsApi.generateBase64({
        model: effectiveTtsSettings.model || 'tts-1',
        pluginId: effectiveTtsSettings.pluginId,
        input: 'Hello! This is a test of the text-to-speech system.',
        voice: effectiveTtsSettings.voiceProfileId
          ? undefined
          : effectiveTtsSettings.voice || undefined,
        voiceProfileId: effectiveTtsSettings.voiceProfileId || undefined,
        speed: effectiveTtsSettings.speed || 1.0,
        response_format: selectedTtsModel?.config?.default_format,
      });

      if (response.success && response.data?.audio) {
        const audioUrl = `data:${response.data.mimeType};base64,${response.data.audio}`;
        const audio = new Audio(audioUrl);
        testAudioRef.current = audio;

        audio.onended = () => {
          setTestingTTS(false);
          testAudioRef.current = null;
        };

        audio.onerror = () => {
          toast.error(t('ttsButton.playbackFailed'));
          setTestingTTS(false);
          testAudioRef.current = null;
        };

        await audio.play();
      } else {
        throw new Error(response.message || t('ttsButton.generateFailed'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('settings.tts.testFailed', { error: errorMessage }));
      setTestingTTS(false);
    }
  };

  const handleResetTtsSettings = () => {
    setTtsSettings({
      enabled: false,
      autoPlay: false,
      model: ttsModels[0]?.model || '',
      voice: ttsModels[0]?.config?.default_voice ?? '',
      voiceProfileId: '',
      speed: 1.0,
      pluginId: ttsModels[0]?.plugin || '',
      streamSentences: true,
    });
  };

  // Image Generation settings handlers
  const handleImageGenSettingChange = (
    key: keyof typeof imageGenSettings,
    value: string | boolean
  ) => {
    setImageGenSettings(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSaveImageGenSettings = async () => {
    try {
      const response = await preferencesApi.updatePreferences({
        imageGenSettings: effectiveImageGenSettings,
      });
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success(t('settings.imageGen.saveSuccess'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('settings.imageGen.saveFailed', { error: errorMessage }));
    }
  };

  const handleResetImageGenSettings = () => {
    setImageGenSettings({
      enabled: false,
      model: imageGenModels[0]?.model || '',
      size: imageGenModels[0]?.config?.default_size || '1024x1024',
      quality: imageGenModels[0]?.config?.default_quality || 'standard',
      style: imageGenModels[0]?.config?.default_style || 'vivid',
      pluginId: imageGenModels[0]?.plugin || '',
    });
  };

  const handleRegenerateEmbeddings = async () => {
    try {
      setRegeneratingEmbeddings(true);
      const response = await documentsApi.regenerateEmbeddings();
      if (response.success && response.data) {
        toast.success(
          response.data.documentsSkipped > 0
            ? t('settings.documents.embeddings.regeneratePartialSuccess', {
                count: response.data.documentsRegenerated,
                skipped: response.data.documentsSkipped,
              })
            : t('settings.documents.embeddings.regenerateSuccess', {
                count: response.data.documentsRegenerated,
              })
        );
        await queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.documents.embeddings.regenerateFailed', {
          error: errorMessage,
        })
      );
    } finally {
      setRegeneratingEmbeddings(false);
    }
  };

  // Plugin handlers
  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      await uploadPlugin(file);
      setShowUploadForm(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      // Reload models after uploading a plugin
      await loadModels();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['image-gen-data'] }),
        queryClient.invalidateQueries({ queryKey: ['tts-data'] }),
      ]);
    }
  };

  const handleJsonSubmit = async () => {
    try {
      const pluginData = JSON.parse(jsonInput);
      await installPlugin(pluginData);
      setShowJsonForm(false);
      setJsonInput('');
      // Reload models after installing a plugin
      await loadModels();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['image-gen-data'] }),
        queryClient.invalidateQueries({ queryKey: ['tts-data'] }),
      ]);
    } catch (_error) {
      clearPluginError();
      toast.error(t('settings.plugins.invalidJson'));
    }
  };

  const handleActivatePlugin = async (id: string) => {
    const plugin = plugins.find(p => p.id === id);
    if (plugin?.active) {
      await deactivatePlugin(id);
    } else {
      await activatePlugin(id);
    }
    // Reload models to include/exclude plugin models
    await loadModels();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['image-gen-data'] }),
      queryClient.invalidateQueries({ queryKey: ['tts-data'] }),
    ]);
  };

  const handleRefreshPluginModels = async (id: string) => {
    if (refreshingPluginIds[id]) return;
    setRefreshingPluginIds(current => ({ ...current, [id]: true }));
    try {
      const response = await pluginApi.discoverModels(id);
      if (!response.success || !response.data) {
        toast.error(
          response.error || t('settings.plugins.modelCatalogRefreshFailed')
        );
        return;
      }

      await Promise.all([loadPlugins(), loadModels()]);

      // The provider is not always reachable, and the returned catalog is then
      // the previous one. Say which of those happened instead of always
      // confirming a refresh.
      const { outcome, models, reason } = response.data;
      if (outcome === 'updated') {
        toast.success(
          t('settings.plugins.modelCatalogUpdated', { count: models.length })
        );
      } else if (outcome === 'unchanged') {
        toast.success(t('settings.plugins.modelCatalogUnchanged'));
      } else if (outcome === 'missing_credentials') {
        toast.error(reason || t('settings.plugins.modelCatalogNeedsApiKey'));
      } else {
        toast.error(
          reason
            ? `${t('settings.plugins.modelCatalogUnavailable')} ${reason}`
            : t('settings.plugins.modelCatalogUnavailable')
        );
      }
    } catch (error) {
      toast.error(
        getErrorMessage(error, t('settings.plugins.modelCatalogRefreshFailed'))
      );
    } finally {
      setRefreshingPluginIds(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const handleDeletePlugin = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this plugin?')) {
      await deletePlugin(id);
      // Reload models after deleting a plugin
      await loadModels();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['image-gen-data'] }),
        queryClient.invalidateQueries({ queryKey: ['tts-data'] }),
      ]);
    }
  };

  const handleExportPlugin = async (id: string) => {
    await exportPlugin(id);
  };

  if (!isOpen) return null;

  const handleThemeChange = (mode: Theme['mode']) => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({ ...currentTheme, mode });
    updateTheme(newTheme);
  };

  const handleAccentChange = (accent: NonNullable<Theme['accent']>) => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({ ...currentTheme, accent });
    updateTheme(newTheme);
  };

  const handleCustomAccentChange = (customAccent: string) => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({
      ...currentTheme,
      accent: 'custom',
      customAccent,
    });
    updateTheme(newTheme);
  };

  const handleAdaptToAccentChange = (adaptToAccent: boolean) => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({ ...currentTheme, adaptToAccent });
    updateTheme(newTheme);
  };

  const handleShowUsernameChange = (showUsername: boolean) => {
    setPreferences({ showUsername });
    preferencesApi.updatePreferences({ showUsername }).catch(error => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.preferences.updateFailed', { error: errorMessage })
      );
    });
  };

  const handleShowFollowUpsChange = (showFollowUpSuggestions: boolean) => {
    setPreferences({ showFollowUpSuggestions });
    preferencesApi
      .updatePreferences({ showFollowUpSuggestions })
      .catch(error => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        toast.error(
          t('settings.preferences.updateFailed', { error: errorMessage })
        );
      });
  };

  const handleAutoOpenArtifactsChange = (autoOpenArtifactPanel: boolean) => {
    setPreferences({ autoOpenArtifactPanel });
    preferencesApi.updatePreferences({ autoOpenArtifactPanel }).catch(error => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.preferences.updateFailed', { error: errorMessage })
      );
    });
  };

  const handleHapticFeedbackChange = (hapticFeedbackEnabled: boolean) => {
    setPreferences({ hapticFeedbackEnabled });
    if (hapticFeedbackEnabled) triggerHapticFeedback('selection');
    preferencesApi.updatePreferences({ hapticFeedbackEnabled }).catch(error => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.preferences.updateFailed', { error: errorMessage })
      );
    });
  };

  const handleModelChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    let model = '';
    let providerType: ChatProviderType | null = null;
    let providerId: string | null = null;

    if (!event.target.value) {
      model = '';
    } else {
      const selection = chatModelSelectionFromKey(
        defaultSelectorModels,
        event.target.value
      );
      if (!selection) return;
      model = selection.model;
      providerType = selection.providerType ?? null;
      providerId = selection.providerId ?? null;
    }

    setPreferences({
      defaultModel: model,
      defaultProviderType: providerType,
      defaultProviderId: providerId,
    });
    const result = await setSelectedModel(model, providerType, providerId);
    if (result.success) {
      toast.success(t('settings.model.defaultModelUpdated'));
    } else {
      toast.error(
        t('settings.preferences.updateFailed', {
          error: result.error || t('errors.generic'),
        })
      );
    }
  };

  const handleSystemMessageChange = (
    event: React.ChangeEvent<HTMLTextAreaElement>
  ) => {
    setTempSystemMessage(event.target.value);
  };

  const handleSystemMessageSave = async () => {
    const saved = await setSystemMessage(tempSystemMessage);
    if (saved) {
      toast.success(t('settings.systemMessage.saved'));
    } else {
      toast.error(t('settings.systemMessage.saveFailed'));
    }
  };

  const handleClearAllHistory = async () => {
    if (
      window.confirm(
        'Are you sure you want to delete all chat history? This action cannot be undone.'
      )
    ) {
      await clearAllSessions();
    }
  };

  const handleUpdateAllModels = async () => {
    setUpdatingAllModels(true);
    setUpdateProgress(null);

    ollamaApi.pullAllModelsStream(
      progress => {
        setUpdateProgress(progress);
      },
      () => {
        setUpdatingAllModels(false);
        setUpdateProgress(null);
        toast.success(t('settings.model.allModelsUpdated'));
        loadModels(); // Refresh models list after update
      },
      error => {
        setUpdatingAllModels(false);
        setUpdateProgress(null);
        toast.error(t('settings.model.updateAllFailed', { error }));
      }
    );
  };

  const handleAutoTitleChange = (autoTitle: boolean) => {
    const newTitleSettings = {
      ...preferences.titleSettings,
      autoTitle,
      taskModel: preferences.titleSettings?.taskModel || '',
    };
    setPreferences({ titleSettings: newTitleSettings });
    preferencesApi.updatePreferences({ titleSettings: newTitleSettings });
  };

  const handleVisionModelChange = (visionModel: string) => {
    if (!visionModel) {
      const updates = {
        visionModel: '',
        visionProviderType: null,
        visionProviderId: null,
      };
      setPreferences(updates);
      void preferencesApi.updatePreferences(updates);
      return;
    }

    const selection = chatModelSelectionFromKey(
      visionSelectorModels,
      visionModel
    );
    if (!selection?.providerType) {
      toast.error(t('settings.model.visionModelNoProvider'));
      return;
    }

    const updates = {
      visionModel: selection.model,
      visionProviderType: selection.providerType,
      visionProviderId: selection.providerId || null,
    };
    setPreferences(updates);
    void preferencesApi.updatePreferences(updates).catch(error => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.model.visionModelUpdateFailed', { error: errorMessage })
      );
    });
  };

  const handleAutoTitleTaskModelChange = (taskModel: string) => {
    const selection =
      taskModel && taskModel !== AUTO_TITLE_CURRENT_MODEL
        ? chatModelSelectionFromKey(taskSelectorModels, taskModel)
        : null;
    const newTitleSettings = {
      ...preferences.titleSettings,
      autoTitle: preferences.titleSettings?.autoTitle || false,
      taskModel: selection?.model || taskModel,
      taskProviderType: selection?.providerType || null,
      taskProviderId:
        selection?.providerType === 'plugin'
          ? selection.providerId || null
          : null,
    };
    setPreferences({ titleSettings: newTitleSettings });
    preferencesApi.updatePreferences({ titleSettings: newTitleSettings });
  };

  const handlePluginApiKeyChange = (pluginId: string, apiKey: string) => {
    setPluginApiKeys(prev => ({ ...prev, [pluginId]: apiKey }));
  };

  const handleShowApiKeyChange = (pluginId: string, show: boolean) => {
    setShowApiKey(prev => ({ ...prev, [pluginId]: show }));
  };

  const handleGenerationOptionChange = (
    key: string,
    value: string | number | boolean | string[] | null | undefined
  ) => {
    setTempGenerationOptions(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSaveGenerationOptions = async () => {
    try {
      const pinToModel = generationScope === 'model' && Boolean(selectedModel);
      const response = pinToModel
        ? await preferencesApi.setModelGenerationOptions(
            selectedModel,
            tempGenerationOptions
          )
        : await preferencesApi.setGenerationOptions(tempGenerationOptions);
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success(t('settings.generation.saveSuccess'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(t('settings.generation.saveFailed', { error: errorMessage }));
    }
  };

  const handleResetGenerationOptions = async () => {
    try {
      // Clearing this model's pinned options is what returns it to its own
      // recommended settings; the modelfile is the default, not a fixed set.
      const response =
        generationScope === 'model' && selectedModel
          ? await preferencesApi.setModelGenerationOptions(selectedModel, {})
          : await preferencesApi.resetGenerationOptions();

      if (response.success && response.data) {
        setPreferences(response.data);

        const forModel = generationScope === 'model' && selectedModel;
        const recommended = forModel
          ? await loadModelRecommendedOptions(selectedModel)
          : {};

        setTempGenerationOptions({
          ...(response.data.generationOptions || {}),
          ...recommended,
        });
        toast.success(
          forModel
            ? t('settings.generation.modelDefaultsLoaded', {
                model: selectedModel,
              })
            : t('settings.generation.resetSuccess')
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.generation.resetFailed', { error: errorMessage })
      );
    }
  };

  const handleEmbeddingSettingsChange = (
    key: keyof typeof embeddingSettings,
    value: string | number | boolean
  ) => {
    setEmbeddingSettings(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const embeddingModelOptions = [
    ...availableEmbeddingModels.map(model => ({
      value: model.id,
      label: `${model.name} (${model.pluginName || model.provider})`,
    })),
    ...(!availableEmbeddingModels.find(
      model =>
        model.id === effectiveEmbeddingSettings.model ||
        model.rawModel === effectiveEmbeddingSettings.model
    ) && effectiveEmbeddingSettings.model
      ? [
          {
            value: effectiveEmbeddingSettings.model,
            label: `${effectiveEmbeddingSettings.model} (current)`,
          },
        ]
      : []),
  ];

  const handleSaveEmbeddingSettings = async () => {
    try {
      const response = await preferencesApi.setEmbeddingSettings(
        effectiveEmbeddingSettings
      );
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success(t('settings.documents.embeddings.saveSuccess'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.documents.embeddings.saveFailed', {
          error: errorMessage,
        })
      );
    }
  };

  const handleResetEmbeddingSettings = async () => {
    try {
      const response = await preferencesApi.resetEmbeddingSettings();
      if (response.success && response.data) {
        setPreferences(response.data);
        setEmbeddingSettings(response.data.embeddingSettings || {});
        toast.success(t('settings.documents.embeddings.resetSuccess'));
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        t('settings.documents.embeddings.resetFailed', {
          error: errorMessage,
        })
      );
    }
  };

  // Extra terms per tab so searching finds settings that live inside a tab,
  // not just the tab's name. Labels are matched in the active language;
  // these keywords cover the English vocabulary users search with.
  const tabSearchKeywords: Record<string, string> = {
    appearance:
      'theme dark light accent color language username follow-up background interface artifact panel auto open',
    data: 'export import backup clear history sessions',
    about: 'version license update',
    models: 'default model system prompt title vision auto',
    generation:
      'temperature top_p top_k seed tokens context penalty embedding chunk similarity',
    documents: 'upload pdf rag document embedding',
    tts: 'voice speech audio speak read aloud',
    'image-gen': 'image generation size quality style',
    plugins: 'api key provider connection openai anthropic groq gemini',
    search: 'web search searxng internet browse sources',
    shortcuts: 'keyboard keys hotkeys shortcut command palette',
    sessions: 'sessions devices sign out logout revoke security login',
    'api-keys': 'api key token scope secret bearer security integration',
    'model-manager': 'models download pull delete ollama library huggingface',
    prompts: 'prompts slash command template variables library rollback',
    skills: 'skills manifest instructions slug load_skill rollback',
    tools: 'tools mcp openapi server credential approval function calling',
  };

  const settingsQueryText = settingsQuery.trim().toLowerCase();
  const tabMatchesQuery = (tab: { id: string; label: string }) =>
    !settingsQueryText ||
    tab.label.toLowerCase().includes(settingsQueryText) ||
    (tabSearchKeywords[tab.id] || '').includes(settingsQueryText);

  // Grouped so the nav reads as four short lists instead of one long one.
  const tabGroups = [
    {
      id: 'general',
      label: t('settings.groups.general', 'General'),
      tabs: [
        {
          id: 'appearance',
          label: t('settings.tabs.appearance'),
          icon: Palette,
        },
        { id: 'data', label: t('settings.tabs.data'), icon: HardDrive },
        {
          id: 'sessions',
          label: t('settings.tabs.sessions', 'Sessions'),
          icon: MonitorSmartphone,
        },
        {
          id: 'notifications',
          label: t('settings.tabs.notifications', 'Notifications'),
          icon: BellRing,
        },
        {
          id: 'api-keys',
          label: t('settings.tabs.apiKeys', 'API keys'),
          icon: KeyRound,
        },
        {
          id: 'shortcuts',
          label: t('settings.tabs.shortcuts'),
          icon: Keyboard,
        },
        { id: 'about', label: t('settings.tabs.about'), icon: Info },
      ],
    },
    {
      id: 'chat',
      label: t('settings.groups.chat', 'Chat'),
      tabs: [
        { id: 'models', label: t('settings.tabs.model'), icon: Bot },
        {
          id: 'model-manager',
          label: t('models.title'),
          icon: Database,
        },
        {
          id: 'generation',
          label: t('settings.tabs.generation'),
          icon: Sliders,
        },
        {
          id: 'documents',
          label: t('settings.tabs.documents'),
          icon: Database,
        },
        {
          id: 'prompts',
          label: t('sidebar.navigation.prompts'),
          icon: BookText,
        },
        {
          id: 'skills',
          label: t('sidebar.navigation.skills'),
          icon: GraduationCap,
        },
      ],
    },
    {
      id: 'media',
      label: t('settings.groups.media', 'Speech & images'),
      tabs: [
        { id: 'tts', label: t('settings.tabs.tts'), icon: Volume2 },
        {
          id: 'image-gen',
          label: t('settings.tabs.imageGen'),
          icon: ImageIcon,
        },
      ],
    },
    {
      id: 'connections',
      label: t('settings.groups.connections', 'Connections'),
      tabs: [
        { id: 'plugins', label: t('settings.tabs.plugins'), icon: Puzzle },
        {
          id: 'tools',
          label: t('sidebar.navigation.tools'),
          icon: Wrench,
        },
        ...(isSettingsAdmin
          ? [{ id: 'search', label: t('settings.tabs.search'), icon: Globe }]
          : []),
      ],
    },
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case 'appearance':
        return (
          <SettingsAppearanceTab
            theme={theme}
            preferences={preferences}
            onThemeChange={handleThemeChange}
            onAccentChange={handleAccentChange}
            onCustomAccentChange={handleCustomAccentChange}
            onAdaptToAccentChange={handleAdaptToAccentChange}
            onShowUsernameChange={handleShowUsernameChange}
            onShowFollowUpsChange={handleShowFollowUpsChange}
            onAutoOpenArtifactsChange={handleAutoOpenArtifactsChange}
            onHapticFeedbackChange={handleHapticFeedbackChange}
          />
        );

      case 'models':
        return (
          <SettingsModelsTab
            models={models}
            selectedModel={selectedModel}
            selectedProviderType={selectedProviderType}
            selectedProviderId={selectedProviderId}
            systemMessage={systemMessage}
            tempSystemMessage={tempSystemMessage}
            loading={loading}
            preferences={preferences}
            currentVisionModel={currentVisionModel}
            visionModelOptions={visionModelOptions}
            currentTaskModel={currentTaskModel}
            autoTitleTaskModelOptions={autoTitleTaskModelOptions}
            updatingAllModels={updatingAllModels}
            updateProgress={updateProgress}
            onModelChange={handleModelChange}
            onSystemMessageChange={handleSystemMessageChange}
            onSystemMessageSave={handleSystemMessageSave}
            onAutoTitleChange={handleAutoTitleChange}
            onAutoTitleTaskModelChange={handleAutoTitleTaskModelChange}
            onVisionModelChange={handleVisionModelChange}
            onUpdateAllModels={handleUpdateAllModels}
          />
        );

      case 'tts':
        return (
          <SettingsTtsTab
            loading={loadingTTS}
            settings={ttsSettings}
            effectiveSettings={effectiveTtsSettings}
            models={ttsModels}
            plugins={ttsPlugins}
            voices={ttsVoices}
            voiceProfiles={ttsVoiceProfiles}
            selectableVoiceProfiles={selectableTtsVoiceProfiles}
            loadingVoiceProfiles={loadingTTSVoiceProfiles}
            testing={testingTTS}
            onSettingChange={handleTtsSettingChange}
            onVoiceChange={handleTtsVoiceChange}
            onDeleteVoiceProfile={handleDeleteTtsVoiceProfile}
            onRevokeVoiceProfile={handleRevokeTtsVoiceProfile}
            onModelChange={handleTtsModelChange}
            onReset={handleResetTtsSettings}
            onTest={handleTestTTS}
            onSave={handleSaveTtsSettings}
          />
        );

      case 'image-gen':
        return (
          <SettingsImageGenerationTab
            loading={loadingImageGen}
            settings={imageGenSettings}
            effectiveSettings={effectiveImageGenSettings}
            models={imageGenModels}
            plugins={imageGenPlugins}
            sizes={imageGenSizes}
            qualities={imageGenQualities}
            styles={imageGenStyles}
            onSettingChange={handleImageGenSettingChange}
            onModelChange={handleImageGenModelChange}
            onReset={handleResetImageGenSettings}
            onSave={handleSaveImageGenSettings}
          />
        );

      case 'documents':
        return (
          <SettingsDocumentsTab
            settings={embeddingSettings}
            effectiveSettings={effectiveEmbeddingSettings}
            modelOptions={embeddingModelOptions}
            status={embeddingStatus}
            regenerating={regeneratingEmbeddings}
            onSettingChange={handleEmbeddingSettingsChange}
            onReset={handleResetEmbeddingSettings}
            onRegenerate={handleRegenerateEmbeddings}
            onSave={handleSaveEmbeddingSettings}
          />
        );

      case 'search':
        return <SettingsSearchTab />;

      case 'model-manager':
        return (
          <div className='pb-2'>
            <SettingsTabHeader
              title={t('models.title')}
              description={t('models.subtitle')}
            />
            <ModelManager />
          </div>
        );

      case 'prompts':
        return <SettingsPromptsTab />;

      case 'skills':
        return <SettingsSkillsTab />;

      case 'tools':
        return <SettingsToolsTab />;

      case 'sessions':
        return <SettingsSessionsTab />;
      case 'notifications':
        return <SettingsNotificationsTab />;

      case 'api-keys':
        return <SettingsApiKeysTab />;

      case 'plugins':
        return (
          <SettingsPluginsTab
            plugins={plugins}
            loading={pluginLoading}
            uploading={isUploading}
            error={pluginError}
            hasKeys={pluginHasKeys}
            showUploadForm={showUploadForm}
            showJsonForm={showJsonForm}
            jsonInput={jsonInput}
            fileInputRef={fileInputRef}
            expandedPluginId={expandedPluginId}
            pluginApiKeys={pluginApiKeys}
            showApiKey={showApiKey}
            savingApiKey={savingApiKey}
            refreshingPluginIds={refreshingPluginIds}
            onClearError={clearPluginError}
            onShowUploadFormChange={setShowUploadForm}
            onShowJsonFormChange={setShowJsonForm}
            onJsonInputChange={setJsonInput}
            onFileUpload={handleFileUpload}
            onJsonSubmit={handleJsonSubmit}
            onExpandedPluginChange={setExpandedPluginId}
            onPluginApiKeyChange={handlePluginApiKeyChange}
            onShowApiKeyChange={handleShowApiKeyChange}
            onActivatePlugin={handleActivatePlugin}
            onRefreshModels={handleRefreshPluginModels}
            onDeletePlugin={handleDeletePlugin}
            onExportPlugin={handleExportPlugin}
            onSaveApiKey={handleSaveApiKey}
            onDeleteApiKey={handleDeleteApiKey}
          />
        );

      case 'data':
        return (
          <SettingsDataTab
            sessionCount={sessions.length}
            loading={loading}
            importing={importing}
            preflighting={preflighting}
            preflight={preflight}
            showImportOptions={showImportOptions}
            mergeStrategy={mergeStrategy}
            importResult={importResult}
            importFileInputRef={importFileInputRef}
            onExportData={handleExportData}
            onImportFileSelect={handleImportFileSelect}
            onClearAllHistory={handleClearAllHistory}
            onMergeStrategyChange={handleMergeStrategyChange}
            onConfirmImport={handleConfirmImport}
            onCancelImport={handleCancelImport}
            onDismissImportResult={() => setImportResult(null)}
          />
        );

      case 'shortcuts':
        return <SettingsShortcutsTab />;

      case 'about':
        return <SettingsAboutTab appVersion={appVersion} />;

      case 'generation':
        return (
          <SettingsGenerationTab
            generationOptions={tempGenerationOptions}
            generationScope={generationScope}
            scopedModel={selectedModel || undefined}
            onGenerationScopeChange={setGenerationScope}
            embeddingSettings={embeddingSettings}
            effectiveEmbeddingSettings={effectiveEmbeddingSettings}
            embeddingModelOptions={embeddingModelOptions}
            embeddingStatus={embeddingStatus}
            onGenerationOptionChange={handleGenerationOptionChange}
            onEmbeddingSettingsChange={handleEmbeddingSettingsChange}
            onResetGenerationOptions={handleResetGenerationOptions}
            onSaveGenerationOptions={handleSaveGenerationOptions}
            onResetEmbeddingSettings={handleResetEmbeddingSettings}
            onSaveEmbeddingSettings={handleSaveEmbeddingSettings}
          />
        );

      default:
        return null;
    }
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className='fixed inset-0 z-50 bg-[var(--overlay-mask)] backdrop-blur-[2px] transition-opacity duration-200'
        onClick={onClose}
      />

      {/* Modal */}
      <div
        className='fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-6'
        role='dialog'
        aria-modal='true'
        aria-labelledby={settingsTitleId}
        onMouseDown={event => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          data-testid='settings-modal-panel'
          className='flex h-full w-full flex-col overscroll-behavior-contain bg-surface shadow-lv3 animate-scale-in sm:h-[min(1000px,calc(100vh-2.5rem))] sm:max-w-[1280px] sm:rounded-[24px] sm:border sm:border-black/[0.04] sm:dark:border-white/[0.06]'
        >
          {/* Mobile-only header; on sm+ the title lives in the nav rail. */}
          <div className='flex items-center justify-between border-b border-line px-4 py-4 sm:hidden'>
            <h2 className='text-xl font-medium text-ink'>
              {t('settings.title')}
            </h2>
            <Button
              variant='ghost'
              size='sm'
              onClick={onClose}
              className='h-9 w-9 touch-manipulation rounded-full p-0 hover:bg-interactive-hover'
              title={t('common.close', { defaultValue: 'Close' })}
            >
              <X className='h-5 w-5' />
            </Button>
          </div>

          <div className='flex min-h-0 flex-1 flex-col overscroll-behavior-contain sm:flex-row'>
            {/* Sidebar Tabs */}
            <div
              className='w-full shrink-0 overflow-x-auto border-b border-line p-2 scrollbar-thin sm:w-[210px] sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:px-3 sm:pb-3 sm:pt-[22px]'
              style={{
                WebkitOverflowScrolling: 'touch',
              }}
            >
              <h2
                id={settingsTitleId}
                className='hidden px-3 pb-4 text-base font-medium leading-6 text-ink sm:block'
              >
                {t('settings.title')}
              </h2>
              <div className='relative mb-2 hidden sm:block'>
                <Search className='pointer-events-none absolute start-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle' />
                <input
                  type='search'
                  value={settingsQuery}
                  onChange={event => {
                    const query = event.target.value;
                    setSettingsQuery(query);
                    const text = query.trim().toLowerCase();
                    if (!text) return;
                    const matching = tabGroups
                      .flatMap(group => group.tabs)
                      .filter(
                        tab =>
                          tab.label.toLowerCase().includes(text) ||
                          (tabSearchKeywords[tab.id] || '').includes(text)
                      );
                    if (
                      matching.length > 0 &&
                      !matching.some(tab => tab.id === activeTab)
                    ) {
                      setActiveTab(matching[0].id);
                    }
                  }}
                  placeholder={t('common.search')}
                  className='h-9 w-full rounded-xl border border-transparent bg-surface-subtle pe-2.5 ps-8 text-[13px] text-ink placeholder:text-ink-subtle focus:border-primary-500/40 focus:outline-none'
                />
              </div>
              <nav
                className='flex gap-1 sm:flex-col sm:gap-0'
                role='tablist'
                aria-label={t('settings.title', 'Settings')}
              >
                {tabGroups
                  .map(group => ({
                    ...group,
                    tabs: group.tabs.filter(tabMatchesQuery),
                  }))
                  .filter(group => group.tabs.length > 0)
                  .map(group => (
                    <div
                      key={group.id}
                      className='flex shrink-0 gap-1 sm:flex-col sm:gap-0.5 sm:pb-2'
                    >
                      <p
                        aria-hidden='true'
                        className='hidden px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-subtle sm:block'
                      >
                        {group.label}
                      </p>
                      {group.tabs.map(tab => {
                        const Icon = tab.icon;
                        const isActive = activeTab === tab.id;

                        return (
                          <button
                            key={tab.id}
                            data-testid={`settings-tab-${tab.id}`}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                              'flex h-9 shrink-0 items-center gap-2 rounded-xl px-3 text-start transition-colors duration-150 touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 sm:w-full',
                              isActive
                                ? 'bg-nav-active text-ink'
                                : 'text-ink hover:bg-hover-solid'
                            )}
                            role='tab'
                            aria-selected={isActive}
                            aria-controls='settings-tab-panel'
                          >
                            <Icon
                              className='h-4 w-4 flex-shrink-0 text-ink-muted'
                              aria-hidden='true'
                            />
                            <span className='truncate whitespace-nowrap text-sm'>
                              {tab.label}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
              </nav>
            </div>

            {/* Tab Content */}
            <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
              <div className='hidden h-[54px] shrink-0 items-center justify-end px-3.5 pb-2 pt-5 sm:flex'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={onClose}
                  autoFocus
                  className='h-7 w-7 touch-manipulation rounded-full p-0 text-ink hover:bg-interactive-hover'
                  title={t('common.close', { defaultValue: 'Close' })}
                >
                  <X className='h-4 w-4' />
                </Button>
              </div>
              <div
                data-testid='settings-scroll-region'
                className='scroll-region min-h-0 flex-1 p-4 pt-2 scrollbar-thin sm:px-6 sm:pb-6 sm:pt-0'
                id='settings-tab-panel'
                role='tabpanel'
              >
                {renderTabContent()}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
