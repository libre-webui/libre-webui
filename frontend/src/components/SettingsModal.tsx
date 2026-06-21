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

import React, { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  X,
  Bot,
  Database,
  Palette,
  Info,
  Puzzle,
  Sliders,
  Volume2,
  ImageIcon,
} from 'lucide-react';
import { Button } from '@/components/ui';
import { SettingsAboutTab } from '@/components/settings/SettingsAboutTab';
import { SettingsAppearanceTab } from '@/components/settings/SettingsAppearanceTab';
import { SettingsDataTab } from '@/components/settings/SettingsDataTab';
import { SettingsDocumentsTab } from '@/components/settings/SettingsDocumentsTab';
import { SettingsGenerationTab } from '@/components/settings/SettingsGenerationTab';
import { SettingsImageGenerationTab } from '@/components/settings/SettingsImageGenerationTab';
import { SettingsModelsTab } from '@/components/settings/SettingsModelsTab';
import { SettingsPluginsTab } from '@/components/settings/SettingsPluginsTab';
import { SettingsTtsTab } from '@/components/settings/SettingsTtsTab';
import { useSettingsDataImport } from '@/components/settings/useSettingsDataImport';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import { useAuthStore } from '@/store/authStore';
import { EmbeddingModel, Theme } from '@/types';
import { normalizeTheme } from '@/utils/theme';
import {
  preferencesApi,
  ollamaApi,
  authApi,
  documentsApi,
  embeddingApi,
  ttsApi,
  imageGenApi,
  pluginApi,
  TTSModel,
  TTSPlugin,
  ImageGenModel,
  ImageGenPlugin,
} from '@/utils/api';
import toast from 'react-hot-toast';

// Get version from Vite env (includes -dev suffix on dev branch)
const appVersion = import.meta.env.VITE_APP_VERSION || '0.0.0';
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
  speed: 1.0,
  pluginId: '',
  streamSentences: false,
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
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
}) => {
  const {
    models,
    selectedModel,
    setSelectedModel,
    systemMessage,
    setSystemMessage,
    clearAllSessions,
    loading,
    sessions,
    loadModels,
    loadSessions,
  } = useChatStore();
  const { theme, setTheme, preferences, setPreferences, loadPreferences } =
    useAppStore();
  const { user, systemInfo, setSystemInfo } = useAuthStore();
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

  const currentTaskModel = preferences.titleSettings?.taskModel || '';
  const autoTitleTaskModelOptions = [
    {
      value: '',
      label: t('settings.model.autoTitle.selectTaskModel'),
    },
    {
      value: AUTO_TITLE_CURRENT_MODEL,
      label: 'Use current running model',
    },
    ...models.map(model => ({
      value: model.name,
      label: model.name,
    })),
    ...(![
      '',
      AUTO_TITLE_CURRENT_MODEL,
      ...models.map(model => model.name),
    ].includes(currentTaskModel) && currentTaskModel
      ? [
          {
            value: currentTaskModel,
            label: `${currentTaskModel} (current)`,
          },
        ]
      : []),
  ];

  const [activeTab, setActiveTab] = useState('appearance');
  const [tempSystemMessage, setTempSystemMessage] = useState(systemMessage);

  const [updatingAllModels, setUpdatingAllModels] = useState(false);
  const [updatingModelPullAccess, setUpdatingModelPullAccess] = useState(false);
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

  // Generation options state
  const [tempGenerationOptions, setTempGenerationOptions] = useState(
    preferences.generationOptions || {}
  );

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

  // Image Generation settings state
  const [imageGenSettings, setImageGenSettings] = useState(
    preferences.imageGenSettings || DEFAULT_IMAGE_GEN_SETTINGS
  );

  const {
    importing,
    showImportOptions,
    mergeStrategy,
    setMergeStrategy,
    importResult,
    setImportResult,
    importFileInputRef,
    handleExportData,
    handleImportFileSelect,
    handleConfirmImport,
    handleCancelImport,
  } = useSettingsDataImport({
    preferences,
    sessions,
    loadPreferences,
    loadSessions,
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
  const ttsModels: TTSModel[] = useMemo(() => ttsData?.models ?? [], [ttsData]);
  const ttsPlugins: TTSPlugin[] = ttsData?.plugins ?? [];
  const effectiveTtsSettings = useMemo(() => {
    if (ttsSettings.model || ttsModels.length === 0) return ttsSettings;

    const firstModel = ttsModels[0];
    return {
      ...ttsSettings,
      model: firstModel.model,
      pluginId: firstModel.plugin,
      voice: firstModel.config?.default_voice || '',
    };
  }, [ttsModels, ttsSettings]);

  // TTS voices derived from currently selected model
  const ttsVoices = useMemo(() => {
    if (!effectiveTtsSettings.model) return [];
    const currentModel = ttsModels.find(
      m => m.model === effectiveTtsSettings.model
    );
    return currentModel?.config?.voices ?? [];
  }, [effectiveTtsSettings.model, ttsModels]);

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
      imageGenModels.find(m => m.model === imageGenSettings.model) ||
      imageGenModels[0],
    [imageGenModels, imageGenSettings.model]
  );
  const effectiveImageGenSettings = useMemo(() => {
    if (imageGenSettings.model || !selectedImageGenModel) {
      return imageGenSettings;
    }

    return {
      ...imageGenSettings,
      model: selectedImageGenModel.model,
      pluginId: selectedImageGenModel.plugin,
      size: selectedImageGenModel.config?.default_size || '1024x1024',
      quality: selectedImageGenModel.config?.default_quality || 'standard',
      style: selectedImageGenModel.config?.default_style || 'vivid',
    };
  }, [imageGenSettings, selectedImageGenModel]);
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

  const handleSaveApiKey = async (pluginId: string) => {
    const apiKey = pluginApiKeys[pluginId];
    if (!apiKey?.trim()) {
      toast.error('Please enter an API key');
      return;
    }

    setSavingApiKey(pluginId);
    try {
      const response = await pluginApi.setApiKey(pluginId, apiKey.trim());
      if (response.success) {
        toast.success('API key saved successfully');
        await queryClient.invalidateQueries({
          queryKey: ['plugin-credentials'],
        });
        setPluginApiKeys(prev => ({ ...prev, [pluginId]: '' }));
        setShowApiKey(prev => ({ ...prev, [pluginId]: false }));
        setExpandedPluginId(null);
      } else {
        toast.error(response.error || 'Failed to save API key');
      }
    } catch (_error) {
      toast.error('Failed to save API key');
    } finally {
      setSavingApiKey(null);
    }
  };

  const handleDeleteApiKey = async (pluginId: string) => {
    setSavingApiKey(pluginId);
    try {
      const response = await pluginApi.deleteApiKey(pluginId);
      if (response.success) {
        toast.success('API key removed');
        await queryClient.invalidateQueries({
          queryKey: ['plugin-credentials'],
        });
        setPluginApiKeys(prev => ({ ...prev, [pluginId]: '' }));
      } else {
        toast.error(response.error || 'Failed to remove API key');
      }
    } catch (_error) {
      toast.error('Failed to remove API key');
    } finally {
      setSavingApiKey(null);
    }
  };

  const handleTtsModelChange = async (modelName: string) => {
    const selectedModel = ttsModels.find(m => m.model === modelName);
    if (selectedModel) {
      setTtsSettings(prev => ({
        ...prev,
        model: modelName,
        pluginId: selectedModel.plugin,
        voice: selectedModel.config?.default_voice || prev.voice,
      }));
    }
  };

  const handleImageGenModelChange = async (modelName: string) => {
    const selectedModel = imageGenModels.find(m => m.model === modelName);
    if (selectedModel) {
      setImageGenSettings(prev => ({
        ...prev,
        model: modelName,
        pluginId: selectedModel.plugin,
        size: selectedModel.config?.default_size || prev.size,
        quality: selectedModel.config?.default_quality || prev.quality,
        style: selectedModel.config?.default_style || prev.style,
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

  const handleSaveTtsSettings = async () => {
    try {
      const response = await preferencesApi.updatePreferences({
        ttsSettings: effectiveTtsSettings,
      });
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success('TTS settings saved successfully');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to save TTS settings: ' + errorMessage);
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
        input: 'Hello! This is a test of the text-to-speech system.',
        voice: effectiveTtsSettings.voice || 'alloy',
        speed: effectiveTtsSettings.speed || 1.0,
        response_format: 'mp3',
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
          toast.error('Failed to play audio');
          setTestingTTS(false);
          testAudioRef.current = null;
        };

        await audio.play();
      } else {
        throw new Error(response.message || 'Failed to generate speech');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('TTS test failed: ' + errorMessage);
      setTestingTTS(false);
    }
  };

  const handleResetTtsSettings = () => {
    setTtsSettings({
      enabled: false,
      autoPlay: false,
      model: ttsModels[0]?.model || '',
      voice: ttsModels[0]?.config?.default_voice || '',
      speed: 1.0,
      pluginId: ttsModels[0]?.plugin || '',
      streamSentences: false,
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
        toast.success('Image generation settings saved successfully');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to save image generation settings: ' + errorMessage);
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
      if (response.success) {
        toast.success('Embeddings regenerated successfully');
        await queryClient.invalidateQueries({ queryKey: ['embedding-status'] });
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to regenerate embeddings: ' + errorMessage);
    } finally {
      setRegeneratingEmbeddings(false);
    }
  };

  const handleUpdatePreferences = async (
    updates: Partial<typeof preferences>
  ) => {
    try {
      const response = await preferencesApi.updatePreferences(updates);
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success('Settings updated successfully');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to update settings: ' + errorMessage);
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
    } catch (_error) {
      clearPluginError();
      toast.error('Invalid JSON format');
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
  };

  const handleDeletePlugin = async (id: string) => {
    if (window.confirm('Are you sure you want to delete this plugin?')) {
      await deletePlugin(id);
      // Reload models after deleting a plugin
      await loadModels();
    }
  };

  const handleExportPlugin = async (id: string) => {
    await exportPlugin(id);
  };

  if (!isOpen) return null;

  const handleThemeChange = (mode: 'light' | 'dark') => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({ ...currentTheme, mode });
    setTheme(newTheme);
    handleUpdatePreferences({ theme: newTheme });
  };

  const handleAccentChange = (accent: NonNullable<Theme['accent']>) => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({ ...currentTheme, accent });
    setTheme(newTheme);
    handleUpdatePreferences({ theme: newTheme });
  };

  const handleCustomAccentChange = (customAccent: string) => {
    const currentTheme = useAppStore.getState().theme;
    const newTheme = normalizeTheme({
      ...currentTheme,
      accent: 'custom',
      customAccent,
    });
    setTheme(newTheme);
    handleUpdatePreferences({ theme: newTheme });
  };

  const handleShowUsernameChange = (showUsername: boolean) => {
    setPreferences({ showUsername });
    preferencesApi.updatePreferences({ showUsername }).catch(error => {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to update settings: ' + errorMessage);
    });
  };

  const handleModelChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const newModel = event.target.value;
    setSelectedModel(newModel);
    handleUpdatePreferences({ defaultModel: newModel });
    toast.success('Default model updated');
  };

  const handleSystemMessageChange = (
    event: React.ChangeEvent<HTMLTextAreaElement>
  ) => {
    setTempSystemMessage(event.target.value);
  };

  const handleSystemMessageSave = () => {
    setSystemMessage(tempSystemMessage);
    handleUpdatePreferences({ systemMessage: tempSystemMessage });
    toast.success('System message updated');
  };

  const handleClearAllHistory = async () => {
    if (
      window.confirm(
        'Are you sure you want to delete all chat history? This action cannot be undone.'
      )
    ) {
      await clearAllSessions();
      toast.success('All chat sessions deleted');
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
        toast.success('All models updated successfully!');
        loadModels(); // Refresh models list after update
      },
      error => {
        setUpdatingAllModels(false);
        setUpdateProgress(null);
        toast.error('Failed to update models: ' + error);
      }
    );
  };

  const handleModelPullAccessToggle = async (allowUserModelPull: boolean) => {
    setUpdatingModelPullAccess(true);
    try {
      const response = await authApi.updateModelPullSetting(allowUserModelPull);
      if (response.success && response.data) {
        setSystemInfo(response.data);
        toast.success(t('settings.model.modelPullAccessSaved'));
      } else {
        throw new Error(response.error || 'Failed to update model access');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error(
        `${t('settings.model.modelPullAccessSaveFailed')}: ${errorMessage}`
      );
    } finally {
      setUpdatingModelPullAccess(false);
    }
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

  const handleAutoTitleTaskModelChange = (taskModel: string) => {
    const newTitleSettings = {
      ...preferences.titleSettings,
      autoTitle: preferences.titleSettings?.autoTitle || false,
      taskModel,
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
    value: string | number | boolean | string[] | undefined
  ) => {
    setTempGenerationOptions(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSaveGenerationOptions = async () => {
    try {
      const response = await preferencesApi.setGenerationOptions(
        tempGenerationOptions
      );
      if (response.success && response.data) {
        setPreferences(response.data);
        toast.success('Generation options updated successfully');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to update generation options: ' + errorMessage);
    }
  };

  const handleResetGenerationOptions = async () => {
    try {
      const response = await preferencesApi.resetGenerationOptions();
      if (response.success && response.data) {
        setPreferences(response.data);
        setTempGenerationOptions(response.data.generationOptions || {});
        toast.success('Generation options reset to defaults');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to reset generation options: ' + errorMessage);
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
        toast.success('Embedding settings updated successfully');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to update embedding settings: ' + errorMessage);
    }
  };

  const handleResetEmbeddingSettings = async () => {
    try {
      const response = await preferencesApi.resetEmbeddingSettings();
      if (response.success && response.data) {
        setPreferences(response.data);
        setEmbeddingSettings(response.data.embeddingSettings || {});
        toast.success('Embedding settings reset to defaults');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to reset embedding settings: ' + errorMessage);
    }
  };

  const tabs = [
    { id: 'appearance', label: t('settings.tabs.appearance'), icon: Palette },
    { id: 'models', label: t('settings.tabs.model'), icon: Bot },
    { id: 'generation', label: t('settings.tabs.generation'), icon: Sliders },
    { id: 'tts', label: t('settings.tabs.tts'), icon: Volume2 },
    { id: 'image-gen', label: t('settings.tabs.imageGen'), icon: ImageIcon },
    {
      id: 'documents',
      label: t('settings.tabs.documents'),
      icon: Database,
    },
    { id: 'plugins', label: t('settings.tabs.plugins'), icon: Puzzle },
    { id: 'data', label: t('settings.tabs.data'), icon: Database },
    { id: 'about', label: t('settings.tabs.about'), icon: Info },
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
            onShowUsernameChange={handleShowUsernameChange}
          />
        );

      case 'models':
        return (
          <SettingsModelsTab
            models={models}
            selectedModel={selectedModel}
            systemMessage={systemMessage}
            tempSystemMessage={tempSystemMessage}
            loading={loading}
            user={user}
            systemInfo={systemInfo}
            preferences={preferences}
            currentTaskModel={currentTaskModel}
            autoTitleTaskModelOptions={autoTitleTaskModelOptions}
            updatingModelPullAccess={updatingModelPullAccess}
            updatingAllModels={updatingAllModels}
            updateProgress={updateProgress}
            onModelPullAccessToggle={handleModelPullAccessToggle}
            onModelChange={handleModelChange}
            onSystemMessageChange={handleSystemMessageChange}
            onSystemMessageSave={handleSystemMessageSave}
            onAutoTitleChange={handleAutoTitleChange}
            onAutoTitleTaskModelChange={handleAutoTitleTaskModelChange}
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
            testing={testingTTS}
            onSettingChange={handleTtsSettingChange}
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
            showImportOptions={showImportOptions}
            mergeStrategy={mergeStrategy}
            importResult={importResult}
            importFileInputRef={importFileInputRef}
            onExportData={handleExportData}
            onImportFileSelect={handleImportFileSelect}
            onClearAllHistory={handleClearAllHistory}
            onMergeStrategyChange={setMergeStrategy}
            onConfirmImport={handleConfirmImport}
            onCancelImport={handleCancelImport}
            onDismissImportResult={() => setImportResult(null)}
          />
        );

      case 'about':
        return <SettingsAboutTab appVersion={appVersion} />;

      case 'generation':
        return (
          <SettingsGenerationTab
            generationOptions={tempGenerationOptions}
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
        className='fixed inset-0 bg-black/60 backdrop-blur-sm z-50 transition-opacity duration-200'
        onClick={onClose}
      />

      {/* Modal */}
      <div className='fixed inset-0 lg:top-1/2 lg:left-1/2 lg:-translate-x-1/2 lg:-translate-y-1/2 z-50 w-full lg:max-w-4xl lg:mx-4 h-full lg:h-[85vh] p-0 lg:p-4'>
        <div className='bg-white dark:bg-dark-25 rounded-2xl shadow-2xl border border-gray-200 dark:border-dark-200 animate-scale-in flex flex-col h-full overscroll-behavior-contain'>
          {/* Header */}
          <div className='flex items-center justify-between p-4 sm:p-6 border-b border-gray-100 dark:border-dark-200 sticky top-0 z-10 rounded-t-2xl'>
            <h2 className='text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100'>
              {t('settings.title')}
            </h2>
            <Button
              variant='ghost'
              size='sm'
              onClick={onClose}
              className='h-9 w-9 sm:h-8 sm:w-8 p-0 hover:bg-gray-100 dark:hover:bg-gray-700 active:bg-gray-200 dark:active:bg-dark-100 touch-manipulation'
              title='Close'
            >
              <X className='h-5 w-5 sm:h-4 sm:w-4' />
            </Button>
          </div>

          <div className='flex flex-1 min-h-0 overscroll-behavior-contain'>
            {/* Sidebar Tabs */}
            <div
              className='w-40 xs:w-48 sm:w-64 border-r border-gray-100 dark:border-dark-200 p-2 xs:p-3 sm:p-4 overflow-y-auto scrollbar-thin'
              style={{
                WebkitOverflowScrolling: 'touch',
              }}
            >
              <nav className='space-y-1'>
                {tabs.map(tab => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;

                  let buttonClass =
                    'w-full flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 sm:py-2.5 text-left rounded-lg transition-colors duration-200 touch-manipulation border';

                  buttonClass += isActive
                    ? ' bg-gray-100 dark:bg-dark-100 text-gray-900 dark:text-white border-gray-200 dark:border-dark-300'
                    : ' border-transparent text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200';

                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={buttonClass}
                    >
                      <Icon className='h-4 w-4 flex-shrink-0' />
                      <span className='text-xs sm:text-sm font-medium truncate'>
                        {tab.label}
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Tab Content */}
            <div
              className='flex-1 p-3 xs:p-4 sm:p-6 overflow-auto overscroll-behavior-contain'
              style={{
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {renderTabContent()}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
