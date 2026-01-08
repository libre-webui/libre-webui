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

import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Moon,
  Sun,
  Sparkles,
  Bot,
  Database,
  Palette,
  Monitor,
  MessageSquare,
  Cpu,
  Info,
  Github,
  ExternalLink,
  Puzzle,
  Upload,
  Download,
  Trash2,
  Check,
  Sliders,
  RotateCcw,
  Volume2,
  Play,
  Square,
  Loader2,
  Key,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button, Select, Textarea } from '@/components/ui';
import { BackgroundUpload } from '@/components/BackgroundUpload';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import {
  preferencesApi,
  ollamaApi,
  documentsApi,
  ttsApi,
  pluginApi,
  TTSModel,
  TTSPlugin,
} from '@/utils/api';
import toast from 'react-hot-toast';
// Import package.json to get version dynamically
import packageJson from '../../../package.json';

interface SystemInfo {
  ollamaVersion?: string;
  modelsCount: number;
  sessionsCount: number;
  isHealthy: boolean;
}

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

  const [activeTab, setActiveTab] = useState('appearance');
  const [tempSystemMessage, setTempSystemMessage] = useState(systemMessage);
  const [systemInfo, setSystemInfo] = useState<SystemInfo>({
    modelsCount: 0,
    sessionsCount: 0,
    isHealthy: false,
  });

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
  const [pluginHasKeys, setPluginHasKeys] = useState<Record<string, boolean>>(
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
    preferences.embeddingSettings || {
      enabled: false,
      model: 'nomic-embed-text',
      chunkSize: 1000,
      chunkOverlap: 200,
      similarityThreshold: 0.7,
    }
  );
  const [embeddingStatus, setEmbeddingStatus] = useState<{
    available: boolean;
    model: string;
    chunksWithEmbeddings: number;
    totalChunks: number;
  } | null>(null);
  const [regeneratingEmbeddings, setRegeneratingEmbeddings] = useState(false);

  // TTS settings state
  const [ttsSettings, setTtsSettings] = useState(
    preferences.ttsSettings || {
      enabled: false,
      autoPlay: false,
      model: '',
      voice: '',
      speed: 1.0,
      pluginId: '',
    }
  );
  const [ttsModels, setTtsModels] = useState<TTSModel[]>([]);
  const [ttsPlugins, setTtsPlugins] = useState<TTSPlugin[]>([]);
  const [ttsVoices, setTtsVoices] = useState<string[]>([]);
  const [loadingTTS, setLoadingTTS] = useState(false);
  const [testingTTS, setTestingTTS] = useState(false);
  const [testAudio, setTestAudio] = useState<HTMLAudioElement | null>(null);

  // Import data state
  const [importing, setImporting] = useState(false);
  const [showImportOptions, setShowImportOptions] = useState(false);
  const [mergeStrategy, setMergeStrategy] = useState<
    'skip' | 'overwrite' | 'merge'
  >('skip');
  const [importResult, setImportResult] = useState<{
    preferences: { imported: boolean; error: string | null };
    sessions: { imported: number; skipped: number; errors: string[] };
    documents: { imported: number; skipped: number; errors: string[] };
  } | null>(null);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(
    null
  );
  const importFileInputRef = useRef<HTMLInputElement>(null);

  // Load system information
  useEffect(() => {
    if (isOpen) {
      loadSystemInfo();
      loadEmbeddingStatus();
      loadTTSData();
      setTempSystemMessage(systemMessage);
      setTempGenerationOptions(preferences.generationOptions || {});
      setEmbeddingSettings(
        preferences.embeddingSettings || {
          enabled: false,
          model: 'nomic-embed-text',
          chunkSize: 1000,
          chunkOverlap: 200,
          similarityThreshold: 0.7,
        }
      );
      setTtsSettings(
        preferences.ttsSettings || {
          enabled: false,
          autoPlay: false,
          model: '',
          voice: '',
          speed: 1.0,
          pluginId: '',
        }
      );
      loadPlugins(); // Load plugins when modal opens
      loadPluginCredentials(); // Load plugin API key status
      loadModels(); // Ensure models are up to date when modal opens
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, systemMessage]);

  const loadSystemInfo = async () => {
    try {
      const [healthResponse, versionResponse] = await Promise.all([
        ollamaApi.checkHealth().catch(() => ({ success: false })),
        ollamaApi.getVersion().catch(() => ({ success: false, data: null })),
      ]);

      setSystemInfo({
        ollamaVersion:
          versionResponse.success && versionResponse.data
            ? versionResponse.data.version
            : undefined,
        modelsCount: models.length,
        sessionsCount: sessions.length,
        isHealthy: healthResponse.success,
      });
    } catch (_error) {
      console.error('Failed to load system info:', _error);
    }
  };

  const loadPluginCredentials = async () => {
    try {
      const response = await pluginApi.getCredentials();
      if (response.success && response.data) {
        const hasKeysMap: Record<string, boolean> = {};
        for (const cred of response.data) {
          hasKeysMap[cred.plugin_id] = cred.has_api_key;
        }
        setPluginHasKeys(hasKeysMap);
      }
    } catch (_error) {
      console.error('Failed to load plugin credentials:', _error);
    }
  };

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
        setPluginHasKeys(prev => ({ ...prev, [pluginId]: true }));
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
        setPluginHasKeys(prev => ({ ...prev, [pluginId]: false }));
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

  const loadEmbeddingStatus = async () => {
    try {
      const response = await documentsApi.getEmbeddingStatus();
      if (response.success && response.data) {
        setEmbeddingStatus(response.data);
      }
    } catch (error) {
      console.error('Failed to load embedding status:', error);
    }
  };

  const loadTTSData = async () => {
    setLoadingTTS(true);
    try {
      const [modelsResponse, pluginsResponse] = await Promise.all([
        ttsApi.getModels(),
        ttsApi.getPlugins(),
      ]);

      if (modelsResponse.success && modelsResponse.data) {
        setTtsModels(modelsResponse.data);
        // Set default model if not set
        if (!ttsSettings.model && modelsResponse.data.length > 0) {
          const firstModel = modelsResponse.data[0];
          setTtsSettings(prev => ({
            ...prev,
            model: firstModel.model,
            pluginId: firstModel.plugin,
            voice: firstModel.config?.default_voice || '',
          }));
          // Also load voices for this plugin
          if (firstModel.config?.voices) {
            setTtsVoices(firstModel.config.voices);
          }
        } else if (ttsSettings.model) {
          // Load voices for the currently selected model
          const currentModel = modelsResponse.data.find(
            m => m.model === ttsSettings.model
          );
          if (currentModel?.config?.voices) {
            setTtsVoices(currentModel.config.voices);
          }
        }
      }

      if (pluginsResponse.success && pluginsResponse.data) {
        setTtsPlugins(pluginsResponse.data);
      }
    } catch (error) {
      console.error('Failed to load TTS data:', error);
    } finally {
      setLoadingTTS(false);
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
      // Update available voices
      if (selectedModel.config?.voices) {
        setTtsVoices(selectedModel.config.voices);
      }
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
        ttsSettings,
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
      if (testAudio) {
        testAudio.pause();
        testAudio.currentTime = 0;
        setTestAudio(null);
      }
      setTestingTTS(false);
      return;
    }

    setTestingTTS(true);
    try {
      const response = await ttsApi.generateBase64({
        model: ttsSettings.model || 'tts-1',
        input: 'Hello! This is a test of the text-to-speech system.',
        voice: ttsSettings.voice || 'alloy',
        speed: ttsSettings.speed || 1.0,
        response_format: 'mp3',
      });

      if (response.success && response.data?.audio) {
        const audioUrl = `data:${response.data.mimeType};base64,${response.data.audio}`;
        const audio = new Audio(audioUrl);
        setTestAudio(audio);

        audio.onended = () => {
          setTestingTTS(false);
          setTestAudio(null);
        };

        audio.onerror = () => {
          toast.error('Failed to play audio');
          setTestingTTS(false);
          setTestAudio(null);
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
    });
  };

  const handleRegenerateEmbeddings = async () => {
    try {
      setRegeneratingEmbeddings(true);
      const response = await documentsApi.regenerateEmbeddings();
      if (response.success) {
        toast.success('Embeddings regenerated successfully');
        await loadEmbeddingStatus(); // Reload status
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

  const handleThemeChange = (mode: 'light' | 'dark' | 'ophelia') => {
    const newTheme = { mode };
    setTheme(newTheme);
    handleUpdatePreferences({ theme: newTheme });
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
      loadSystemInfo(); // Refresh system info
      toast.success('All chat sessions deleted');
    }
  };

  const handleExportData = () => {
    const data = {
      format: 'libre-webui-export',
      version: '1.0',
      preferences,
      sessions,
      documents: [], // Documents are handled by the backend
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `libre-webui-export-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success('Data exported successfully');
  };

  const handleImportFileSelect = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      setSelectedImportFile(file);
      setShowImportOptions(true);
      setImportResult(null);
    }
  };

  const handleConfirmImport = async () => {
    if (!selectedImportFile) return;

    setImporting(true);
    try {
      const fileContent = await selectedImportFile.text();
      const importData = JSON.parse(fileContent);

      // Validate the data format
      if (!importData.format || importData.format !== 'libre-webui-export') {
        throw new Error(
          'Invalid export format. Please use a valid Libre WebUI export file.'
        );
      }

      const result = await preferencesApi.importData(
        importData,
        // Map frontend merge strategies to backend API:
        // 'skip' -> 'merge' (merge with existing, keeps existing values)
        // 'overwrite' -> 'replace' (completely replace existing data)
        // 'merge' -> 'merge' (merge with existing, new values take precedence)
        mergeStrategy === 'overwrite' ? 'replace' : 'merge'
      );

      if (result.success && result.data) {
        setImportResult({
          preferences: { imported: true, error: null },
          sessions: { imported: 0, skipped: 0, errors: [] },
          documents: { imported: 0, skipped: 0, errors: [] },
        });
        toast.success('Data imported successfully');

        // Refresh data in store
        await loadPreferences();
        await loadSessions();
      } else {
        throw new Error(result.error || 'Import failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
      setImportResult(null);
    } finally {
      setImporting(false);
      setShowImportOptions(false);
      setSelectedImportFile(null);
      if (importFileInputRef.current) {
        importFileInputRef.current.value = '';
      }
    }
  };

  const handleCancelImport = () => {
    setShowImportOptions(false);
    setSelectedImportFile(null);
    setImportResult(null);
    if (importFileInputRef.current) {
      importFileInputRef.current.value = '';
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
        loadSystemInfo(); // Refresh models after update
      },
      error => {
        setUpdatingAllModels(false);
        setUpdateProgress(null);
        toast.error('Failed to update models: ' + error);
      }
    );
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

  const handleSaveEmbeddingSettings = async () => {
    try {
      const response =
        await preferencesApi.setEmbeddingSettings(embeddingSettings);
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
    { id: 'appearance', label: 'Appearance', icon: Palette },
    { id: 'models', label: 'Models', icon: Bot },
    { id: 'generation', label: 'Generation', icon: Sliders },
    { id: 'tts', label: 'Text-to-Speech', icon: Volume2 },
    {
      id: 'documents',
      label: 'Documents & RAG',
      icon: Database,
    },
    { id: 'plugins', label: 'Plugins', icon: Puzzle },
    { id: 'system', label: 'System', icon: Monitor },
    { id: 'data', label: 'Data', icon: Database },
    { id: 'about', label: 'About', icon: Info },
  ];

  const renderTabContent = () => {
    switch (activeTab) {
      case 'appearance':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Appearance
              </h3>
              <div className='grid grid-cols-3 gap-3'>
                <button
                  onClick={() => handleThemeChange('light')}
                  className={`flex items-center justify-center gap-2 h-12 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    theme.mode === 'light'
                      ? 'bg-primary-600 text-white shadow-sm hover:bg-primary-700 hover:shadow-md focus:ring-primary-500'
                      : 'border border-gray-300 text-gray-700 bg-white shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:ring-gray-500 dark:border-dark-300 dark:text-dark-700 dark:bg-dark-25 dark:hover:bg-dark-200 dark:hover:border-dark-400 ophelia:border-[#262626] ophelia:text-[#e5e5e5] ophelia:bg-[#0a0a0a] ophelia:hover:bg-[#121212]'
                  }`}
                >
                  <Sun className='h-4 w-4' />
                  Light
                </button>
                <button
                  onClick={() => handleThemeChange('dark')}
                  className={`flex items-center justify-center gap-2 h-12 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    theme.mode === 'dark'
                      ? 'bg-dark-300 text-dark-800 border border-dark-400 shadow-sm hover:bg-dark-400 focus:ring-dark-500'
                      : 'border border-gray-300 text-gray-700 bg-white shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:ring-gray-500 dark:border-dark-300 dark:text-dark-700 dark:bg-dark-25 dark:hover:bg-dark-200 dark:hover:border-dark-400 ophelia:border-[#262626] ophelia:text-[#e5e5e5] ophelia:bg-[#0a0a0a] ophelia:hover:bg-[#121212]'
                  }`}
                >
                  <Moon className='h-4 w-4' />
                  Dark
                </button>
                <button
                  onClick={() => handleThemeChange('ophelia')}
                  className={`flex items-center justify-center gap-2 h-12 px-3 py-2.5 text-sm font-medium rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                    theme.mode === 'ophelia'
                      ? 'bg-purple-600 text-white shadow-sm hover:bg-purple-700 hover:shadow-md focus:ring-purple-500 border border-purple-500'
                      : 'border border-gray-300 text-gray-700 bg-white shadow-sm hover:bg-gray-50 hover:border-gray-400 focus:ring-gray-500 dark:border-dark-300 dark:text-dark-700 dark:bg-dark-25 dark:hover:bg-dark-200 dark:hover:border-dark-400'
                  }`}
                >
                  <Sparkles className='h-4 w-4' />
                  AMOLED
                </button>
              </div>
            </div>

            <div>
              <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-3'>
                Chat Interface
              </h4>
              <div className='space-y-3'>
                <div className='flex items-center justify-between'>
                  <div className='flex flex-col'>
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      Show username in chat
                    </span>
                    <span className='text-xs text-gray-500 dark:text-gray-400'>
                      Display your username instead of &quot;you&quot; in chat
                      messages
                    </span>
                  </div>
                  <label className='relative inline-flex items-center cursor-pointer'>
                    <input
                      type='checkbox'
                      className='sr-only peer'
                      checked={preferences.showUsername}
                      onChange={e => {
                        // Only send the specific field being updated to avoid overwriting other settings
                        const showUsername = e.target.checked;
                        setPreferences({ showUsername });
                        preferencesApi.updatePreferences({ showUsername });
                      }}
                    />
                    <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600"></div>
                  </label>
                </div>
              </div>
            </div>

            {/* Background Upload Section */}
            <BackgroundUpload />
          </div>
        );

      case 'system':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                System Status
              </h3>

              <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6'>
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <div className='flex items-center gap-2 mb-2'>
                    <div
                      className={`w-3 h-3 rounded-full ${systemInfo.isHealthy ? 'bg-green-500' : 'bg-red-500'}`}
                    />
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      Ollama Status
                    </span>
                  </div>
                  <p className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                    {systemInfo.isHealthy ? 'Healthy' : 'Offline'}
                  </p>
                  {systemInfo.ollamaVersion && (
                    <p className='text-xs text-gray-500 dark:text-gray-400'>
                      v{systemInfo.ollamaVersion}
                    </p>
                  )}
                </div>

                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <div className='flex items-center gap-2 mb-2'>
                    <Cpu className='h-3 w-3 text-gray-500 dark:text-dark-500' />
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      Models
                    </span>
                  </div>
                  <p className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                    {systemInfo.modelsCount}
                  </p>
                </div>

                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <div className='flex items-center gap-2 mb-2'>
                    <MessageSquare className='h-3 w-3 text-green-500' />
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      Chat Sessions
                    </span>
                  </div>
                  <p className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
                    {systemInfo.sessionsCount}
                  </p>
                </div>

                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <div className='flex items-center gap-2 mb-2'>
                    <Database className='h-3 w-3 text-purple-500' />
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      Current Model
                    </span>
                  </div>
                  <p className='text-sm font-semibold text-gray-900 dark:text-gray-100 truncate'>
                    {selectedModel || 'Not set'}
                  </p>
                </div>
              </div>

              <Button onClick={loadSystemInfo} variant='outline' size='sm'>
                Refresh Status
              </Button>
            </div>
          </div>
        );

      case 'models':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Model Settings
              </h3>
              <div className='space-y-6'>
                {/* Default Model Selection */}
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                    Default Model
                  </label>
                  <Select
                    value={selectedModel || ''}
                    onChange={handleModelChange}
                    options={[
                      { value: '', label: 'Select a model' },
                      ...models.map(model => ({
                        value: model.name,
                        label: model.name,
                      })),
                    ]}
                  />
                  <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
                    This model will be used for new conversations
                  </p>
                </div>

                {/* Current Model Info */}
                {selectedModel && (
                  <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                      Current Model Information
                    </label>
                    <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                      <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                        <div className='flex items-center justify-between p-3 bg-white dark:bg-dark-100 rounded-md border border-gray-200 dark:border-dark-300'>
                          <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                            Name:
                          </span>
                          <span className='text-sm font-semibold text-gray-900 dark:text-gray-100 truncate ml-2'>
                            {selectedModel}
                          </span>
                        </div>
                        {(() => {
                          const model = models.find(
                            m => m.name === selectedModel
                          );
                          if (model?.details) {
                            return (
                              <>
                                <div className='flex items-center justify-between p-3 bg-white dark:bg-dark-100 rounded-md border border-gray-200 dark:border-dark-300'>
                                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                                    Size:
                                  </span>
                                  <span className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
                                    {model.details.parameter_size}
                                  </span>
                                </div>
                                <div className='flex items-center justify-between p-3 bg-white dark:bg-dark-100 rounded-md border border-gray-200 dark:border-dark-300'>
                                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                                    Family:
                                  </span>
                                  <span className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
                                    {model.details.family}
                                  </span>
                                </div>
                                <div className='flex items-center justify-between p-3 bg-white dark:bg-dark-100 rounded-md border border-gray-200 dark:border-dark-300'>
                                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                                    Format:
                                  </span>
                                  <span className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
                                    {model.details.format}
                                  </span>
                                </div>
                              </>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    </div>
                  </div>
                )}

                {/* System Message */}
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                    System Message
                  </label>
                  <Textarea
                    value={tempSystemMessage}
                    onChange={handleSystemMessageChange}
                    placeholder='Enter a system message that will be added to the beginning of new chat sessions...'
                    className='w-full min-h-[100px] bg-gray-50 dark:bg-dark-50 border-gray-200 dark:border-dark-300 text-gray-900 dark:text-gray-100'
                    rows={4}
                  />
                  <div className='flex items-center justify-between mt-3'>
                    <p className='text-xs text-gray-500 dark:text-gray-400'>
                      This message will be automatically added to the start of
                      new conversations to set the AI&apos;s behavior and
                      context.
                    </p>
                    <Button
                      onClick={handleSystemMessageSave}
                      size='sm'
                      disabled={loading || tempSystemMessage === systemMessage}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </div>

              {/* Auto Title Generation Settings */}
              <div className='mt-6'>
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                    Auto Title Generation
                  </label>
                  <div className='space-y-4'>
                    <div className='flex items-center justify-between'>
                      <div className='flex flex-col'>
                        <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                          Enable auto-title
                        </span>
                        <span className='text-xs text-gray-500 dark:text-gray-400'>
                          Automatically generate chat titles from the first
                          message
                        </span>
                      </div>
                      <label className='relative inline-flex items-center cursor-pointer'>
                        <input
                          type='checkbox'
                          className='sr-only peer'
                          checked={
                            preferences.titleSettings?.autoTitle || false
                          }
                          onChange={e => {
                            const autoTitle = e.target.checked;
                            const newTitleSettings = {
                              ...preferences.titleSettings,
                              autoTitle,
                              taskModel:
                                preferences.titleSettings?.taskModel || '',
                            };
                            setPreferences({ titleSettings: newTitleSettings });
                            preferencesApi.updatePreferences({
                              titleSettings: newTitleSettings,
                            });
                          }}
                        />
                        <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600"></div>
                      </label>
                    </div>

                    {preferences.titleSettings?.autoTitle && (
                      <div>
                        <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          Task Model
                        </label>
                        <Select
                          value={preferences.titleSettings?.taskModel || ''}
                          onChange={e => {
                            const taskModel = e.target.value;
                            const newTitleSettings = {
                              ...preferences.titleSettings,
                              autoTitle:
                                preferences.titleSettings?.autoTitle || false,
                              taskModel,
                            };
                            setPreferences({ titleSettings: newTitleSettings });
                            preferencesApi.updatePreferences({
                              titleSettings: newTitleSettings,
                            });
                          }}
                          options={[
                            {
                              value: '',
                              label: 'Select a model for title generation',
                            },
                            ...models.map(model => ({
                              value: model.name,
                              label: model.name,
                            })),
                          ]}
                        />
                        <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
                          This model will summarize your first message to create
                          a chat title. Use a smaller, faster model for best
                          performance.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Update All Models Section */}
              <div className='mt-6'>
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                    Bulk Model Operations
                  </label>
                  <div className='space-y-3'>
                    <div>
                      <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Update All Models
                      </h4>
                      <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                        Pull the latest versions of all currently installed
                        models from the registry.
                      </p>

                      {updatingAllModels && updateProgress && (
                        <div className='mb-4 space-y-3'>
                          <div className='flex items-center justify-between text-xs'>
                            <span className='text-gray-600 dark:text-dark-600 font-medium'>
                              Updating {updateProgress.modelName}... (
                              {updateProgress.current}/{updateProgress.total})
                            </span>
                            <span className='text-primary-600 dark:text-primary-400 font-semibold'>
                              {Math.round(
                                (updateProgress.current /
                                  updateProgress.total) *
                                  100
                              )}
                              %
                            </span>
                          </div>
                          <div className='w-full bg-gray-200 dark:bg-dark-300 rounded-full h-3 shadow-subtle'>
                            <div
                              className='bg-gradient-to-r from-primary-500 to-primary-600 dark:from-primary-400 dark:to-primary-500 h-3 rounded-full transition-all duration-500 ease-out shadow-glow'
                              style={{
                                width: `${(updateProgress.current / updateProgress.total) * 100}%`,
                              }}
                            />
                          </div>
                          <div className='text-xs flex items-center justify-between'>
                            <span className='text-gray-500 dark:text-dark-500'>
                              Status:{' '}
                              {updateProgress.status === 'starting' ? (
                                <span className='text-accent-500 dark:text-accent-400'>
                                  🔄 Starting...
                                </span>
                              ) : updateProgress.status === 'success' ? (
                                <span className='text-success-600 dark:text-success-500'>
                                  ✓ Complete
                                </span>
                              ) : updateProgress.status === 'error' ? (
                                <span className='text-error-600 dark:text-error-500'>
                                  ✗ Error: {updateProgress.error}
                                </span>
                              ) : (
                                ''
                              )}
                            </span>
                            <span className='text-gray-400 dark:text-dark-600 text-[10px]'>
                              {updateProgress.current} of {updateProgress.total}{' '}
                              models
                            </span>
                          </div>
                        </div>
                      )}

                      <Button
                        onClick={handleUpdateAllModels}
                        variant='outline'
                        size='sm'
                        className='w-full'
                        disabled={
                          updatingAllModels || loading || models.length === 0
                        }
                      >
                        {updatingAllModels
                          ? 'Updating Models...'
                          : `Update All Models (${models.length})`}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );

      case 'tts':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Text-to-Speech Settings
              </h3>
              <p className='text-sm text-gray-600 dark:text-gray-400 mb-6'>
                Configure text-to-speech for reading assistant messages aloud.
              </p>

              {loadingTTS ? (
                <div className='flex items-center justify-center py-8'>
                  <Loader2 className='h-8 w-8 animate-spin text-primary-500' />
                  <span className='ml-3 text-gray-600 dark:text-gray-400'>
                    Loading TTS providers...
                  </span>
                </div>
              ) : ttsModels.length === 0 ? (
                <div className='bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4'>
                  <div className='flex items-start gap-3'>
                    <Volume2 className='h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5' />
                    <div>
                      <h4 className='text-sm font-medium text-yellow-800 dark:text-yellow-200'>
                        No TTS Providers Available
                      </h4>
                      <p className='text-sm text-yellow-700 dark:text-yellow-300 mt-1'>
                        To enable text-to-speech, install a TTS plugin (like
                        OpenAI TTS or ElevenLabs) and configure the API key in
                        your environment.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className='space-y-6'>
                  {/* Enable TTS Toggle */}
                  <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                    <div className='flex items-center justify-between'>
                      <div>
                        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                          Enable Text-to-Speech
                        </h4>
                        <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                          Show TTS button on assistant messages
                        </p>
                      </div>
                      <label className='flex items-center cursor-pointer'>
                        <input
                          type='checkbox'
                          checked={ttsSettings.enabled}
                          onChange={e =>
                            handleTtsSettingChange('enabled', e.target.checked)
                          }
                          className='sr-only'
                        />
                        <div
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                            ttsSettings.enabled
                              ? 'bg-primary-600 dark:bg-primary-500'
                              : 'bg-gray-200 dark:bg-dark-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              ttsSettings.enabled
                                ? 'translate-x-6'
                                : 'translate-x-1'
                            }`}
                          />
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Auto-Play Toggle */}
                  <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                    <div className='flex items-center justify-between'>
                      <div>
                        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                          Auto-Play Messages
                        </h4>
                        <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                          Automatically read assistant messages aloud when they
                          complete
                        </p>
                      </div>
                      <label className='flex items-center cursor-pointer'>
                        <input
                          type='checkbox'
                          checked={ttsSettings.autoPlay}
                          onChange={e =>
                            handleTtsSettingChange('autoPlay', e.target.checked)
                          }
                          disabled={!ttsSettings.enabled}
                          className='sr-only'
                        />
                        <div
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                            !ttsSettings.enabled
                              ? 'bg-gray-100 dark:bg-dark-200 opacity-50 cursor-not-allowed'
                              : ttsSettings.autoPlay
                                ? 'bg-primary-600 dark:bg-primary-500'
                                : 'bg-gray-200 dark:bg-dark-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              ttsSettings.autoPlay
                                ? 'translate-x-6'
                                : 'translate-x-1'
                            }`}
                          />
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Voice Settings */}
                  <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                    <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-4'>
                      Voice Configuration
                    </h4>
                    <div className='space-y-4'>
                      {/* Model Selection */}
                      <div>
                        <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          TTS Model
                        </label>
                        <Select
                          value={ttsSettings.model}
                          onChange={e => handleTtsModelChange(e.target.value)}
                          disabled={!ttsSettings.enabled}
                          options={[
                            { value: '', label: 'Select a model' },
                            ...ttsModels.map(model => ({
                              value: model.model,
                              label: `${model.model} (${model.plugin})`,
                            })),
                          ]}
                        />
                        <p className='text-xs text-gray-500 mt-1'>
                          The AI model used for speech synthesis
                        </p>
                      </div>

                      {/* Voice Selection */}
                      <div>
                        <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          Voice
                        </label>
                        <Select
                          value={ttsSettings.voice}
                          onChange={e =>
                            handleTtsSettingChange('voice', e.target.value)
                          }
                          disabled={
                            !ttsSettings.enabled || ttsVoices.length === 0
                          }
                          options={[
                            { value: '', label: 'Select a voice' },
                            ...ttsVoices.map(voice => ({
                              value: voice,
                              label:
                                voice.charAt(0).toUpperCase() + voice.slice(1),
                            })),
                          ]}
                        />
                        <p className='text-xs text-gray-500 mt-1'>
                          The voice persona for speech output
                        </p>
                      </div>

                      {/* Speed Control */}
                      <div>
                        <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                          Speed: {ttsSettings.speed.toFixed(1)}x
                        </label>
                        <input
                          type='range'
                          min='0.25'
                          max='4.0'
                          step='0.25'
                          value={ttsSettings.speed}
                          onChange={e =>
                            handleTtsSettingChange(
                              'speed',
                              parseFloat(e.target.value)
                            )
                          }
                          disabled={!ttsSettings.enabled}
                          className='w-full range-slider'
                        />
                        <div className='flex justify-between text-xs text-gray-500 mt-1'>
                          <span>0.25x (Slow)</span>
                          <span>1.0x (Normal)</span>
                          <span>4.0x (Fast)</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Available Providers Info */}
                  {ttsPlugins.length > 0 && (
                    <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                      <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                        Available TTS Providers
                      </h4>
                      <div className='grid grid-cols-1 sm:grid-cols-2 gap-2'>
                        {ttsPlugins.map(plugin => (
                          <div
                            key={plugin.id}
                            className='flex items-center gap-2 p-2 bg-white dark:bg-dark-100 rounded border border-gray-200 dark:border-dark-300'
                          >
                            <div className='w-2 h-2 rounded-full bg-green-500' />
                            <span className='text-sm text-gray-700 dark:text-gray-300'>
                              {plugin.name}
                            </span>
                            <span className='text-xs text-gray-500 dark:text-gray-400'>
                              ({plugin.models?.length || 0} models)
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Test & Action Buttons */}
                  <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
                    <div className='flex gap-2'>
                      <Button
                        onClick={handleResetTtsSettings}
                        variant='outline'
                        className='flex items-center gap-2'
                      >
                        <RotateCcw size={16} />
                        Reset
                      </Button>
                      <Button
                        onClick={handleTestTTS}
                        variant='outline'
                        disabled={!ttsSettings.enabled || !ttsSettings.model}
                        className='flex items-center gap-2'
                      >
                        {testingTTS ? (
                          <>
                            <Square size={16} />
                            Stop
                          </>
                        ) : (
                          <>
                            <Play size={16} />
                            Test Voice
                          </>
                        )}
                      </Button>
                    </div>
                    <Button
                      onClick={handleSaveTtsSettings}
                      className='flex items-center gap-2'
                    >
                      <Check size={16} />
                      Save Settings
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        );

      case 'documents':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Documents & RAG Settings
              </h3>

              {/* Embedding Settings */}
              <div className='bg-gray-50 dark:bg-dark-50 p-4 rounded-lg border border-gray-200 dark:border-dark-300 space-y-4'>
                <div className='flex items-center justify-between'>
                  <div>
                    <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                      Vector Embeddings
                    </h4>
                    <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                      Enable semantic search using vector embeddings for better
                      document relevance
                    </p>
                  </div>
                  <label className='flex items-center cursor-pointer'>
                    <input
                      type='checkbox'
                      checked={embeddingSettings.enabled}
                      onChange={e =>
                        handleEmbeddingSettingsChange(
                          'enabled',
                          e.target.checked
                        )
                      }
                      className='sr-only'
                    />
                    <div
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                        embeddingSettings.enabled
                          ? 'bg-primary-600 dark:bg-primary-500'
                          : 'bg-gray-200 dark:bg-dark-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                          embeddingSettings.enabled
                            ? 'translate-x-6'
                            : 'translate-x-1'
                        }`}
                      />
                    </div>
                  </label>
                </div>

                {embeddingSettings.enabled && (
                  <div className='space-y-4 pt-4 border-t border-gray-200 dark:border-dark-300'>
                    {/* Embedding Model */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Embedding Model
                      </label>
                      <Select
                        value={embeddingSettings.model}
                        onChange={e =>
                          handleEmbeddingSettingsChange('model', e.target.value)
                        }
                        options={[
                          {
                            value: 'nomic-embed-text',
                            label: 'nomic-embed-text',
                          },
                          { value: 'all-minilm', label: 'all-minilm' },
                          {
                            value: 'sentence-transformers',
                            label: 'sentence-transformers',
                          },
                        ]}
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Model used for generating embeddings
                      </p>
                    </div>

                    {/* Chunk Size */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Chunk Size: {embeddingSettings.chunkSize}
                      </label>
                      <input
                        type='range'
                        min='500'
                        max='2000'
                        step='100'
                        value={embeddingSettings.chunkSize}
                        onChange={e =>
                          handleEmbeddingSettingsChange(
                            'chunkSize',
                            parseInt(e.target.value)
                          )
                        }
                        className='w-full range-slider'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Size of text chunks for processing
                      </p>
                    </div>

                    {/* Chunk Overlap */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Chunk Overlap: {embeddingSettings.chunkOverlap}
                      </label>
                      <input
                        type='range'
                        min='50'
                        max='500'
                        step='50'
                        value={embeddingSettings.chunkOverlap}
                        onChange={e =>
                          handleEmbeddingSettingsChange(
                            'chunkOverlap',
                            parseInt(e.target.value)
                          )
                        }
                        className='w-full range-slider'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Character overlap between chunks
                      </p>
                    </div>

                    {/* Similarity Threshold */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Similarity Threshold:{' '}
                        {embeddingSettings.similarityThreshold.toFixed(2)}
                      </label>
                      <input
                        type='range'
                        min='0.3'
                        max='0.9'
                        step='0.05'
                        value={embeddingSettings.similarityThreshold}
                        onChange={e =>
                          handleEmbeddingSettingsChange(
                            'similarityThreshold',
                            parseFloat(e.target.value)
                          )
                        }
                        className='w-full range-slider'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Minimum similarity score for search results
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Embedding Status */}
              {embeddingStatus && (
                <div className='bg-gray-50 dark:bg-dark-100 p-4 rounded-lg border border-gray-200 dark:border-dark-300'>
                  <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-2'>
                    Embedding Status
                  </h4>
                  <div className='text-sm text-gray-700 dark:text-gray-300 space-y-1'>
                    <div>
                      Status:{' '}
                      <span
                        className={`font-medium ${embeddingStatus.available ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
                      >
                        {embeddingStatus.available ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <div>
                      Model:{' '}
                      <span className='font-medium'>
                        {embeddingStatus.model}
                      </span>
                    </div>
                    <div>
                      Chunks with embeddings:{' '}
                      <span className='font-medium'>
                        {embeddingStatus.chunksWithEmbeddings} /{' '}
                        {embeddingStatus.totalChunks}
                      </span>
                    </div>
                    {embeddingStatus.totalChunks > 0 && (
                      <div>
                        Coverage:{' '}
                        <span className='font-medium'>
                          {Math.round(
                            (embeddingStatus.chunksWithEmbeddings /
                              embeddingStatus.totalChunks) *
                              100
                          )}
                          %
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
                <div className='flex gap-2'>
                  <Button
                    onClick={handleResetEmbeddingSettings}
                    variant='outline'
                    className='flex items-center gap-2'
                  >
                    <RotateCcw size={16} />
                    Reset to Defaults
                  </Button>
                  {embeddingSettings.enabled &&
                    embeddingStatus &&
                    embeddingStatus.totalChunks > 0 && (
                      <Button
                        onClick={handleRegenerateEmbeddings}
                        disabled={regeneratingEmbeddings}
                        variant='outline'
                        className='flex items-center gap-2 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20'
                      >
                        <Database size={16} />
                        {regeneratingEmbeddings
                          ? 'Regenerating...'
                          : 'Regenerate Embeddings'}
                      </Button>
                    )}
                </div>
                <Button
                  onClick={handleSaveEmbeddingSettings}
                  className='flex items-center gap-2'
                >
                  <Check size={16} />
                  Save Settings
                </Button>
              </div>
            </div>
          </div>
        );

      case 'plugins':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Plugin Management
              </h3>

              {/* Error Message */}
              {pluginError && (
                <div className='p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg mb-4'>
                  <div className='flex items-center justify-between'>
                    <p className='text-red-800 dark:text-red-200'>
                      {pluginError}
                    </p>
                    <Button
                      variant='ghost'
                      size='sm'
                      onClick={clearPluginError}
                      className='text-red-600 hover:text-red-800'
                    >
                      <X className='h-4 w-4' />
                    </Button>
                  </div>
                </div>
              )}

              {/* Upload and Add Buttons */}
              <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300 mb-6'>
                <div className='flex items-center justify-between mb-4'>
                  <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Add New Plugin
                  </h4>
                  <div className='flex items-center space-x-2'>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => setShowUploadForm(!showUploadForm)}
                      disabled={pluginLoading || isUploading}
                    >
                      <Upload className='h-4 w-4 mr-2' />
                      Upload File
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => setShowJsonForm(!showJsonForm)}
                      disabled={pluginLoading}
                    >
                      Add JSON
                    </Button>
                  </div>
                </div>

                {/* Upload Form */}
                {showUploadForm && (
                  <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300 mb-4'>
                    <div className='flex items-center space-x-4'>
                      <input
                        ref={fileInputRef}
                        type='file'
                        accept='.json,.zip'
                        onChange={handleFileUpload}
                        className='flex-1 p-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 dark:file:bg-dark-200 dark:file:text-dark-700 hover:file:bg-gray-200 dark:hover:file:bg-dark-300'
                        disabled={isUploading}
                      />
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => setShowUploadForm(false)}
                        disabled={isUploading}
                      >
                        Cancel
                      </Button>
                    </div>
                    {isUploading && (
                      <p className='text-sm text-gray-600 dark:text-gray-400 mt-2'>
                        Uploading plugin...
                      </p>
                    )}
                  </div>
                )}

                {/* JSON Form */}
                {showJsonForm && (
                  <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                    <div className='space-y-3'>
                      <textarea
                        value={jsonInput}
                        onChange={e => setJsonInput(e.target.value)}
                        placeholder='Paste plugin JSON here...'
                        className='w-full h-32 p-3 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500 font-mono text-sm'
                        disabled={pluginLoading}
                      />
                      <div className='flex items-center justify-end space-x-2'>
                        <Button
                          variant='outline'
                          size='sm'
                          onClick={() => {
                            setShowJsonForm(false);
                            setJsonInput('');
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size='sm'
                          onClick={handleJsonSubmit}
                          disabled={!jsonInput.trim() || pluginLoading}
                        >
                          Install Plugin
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Active Plugins Status */}
              {plugins.filter(p => p.active).length > 0 && (
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300 mb-6'>
                  <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                    Active Plugins ({plugins.filter(p => p.active).length})
                  </h4>
                  <div className='space-y-2'>
                    {plugins
                      .filter(p => p.active)
                      .map(plugin => (
                        <div
                          key={plugin.id}
                          className='flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg'
                        >
                          <div>
                            <p className='font-medium text-green-800 dark:text-green-200'>
                              {plugin.name}
                            </p>
                            <p className='text-xs text-green-600 dark:text-green-300'>
                              {plugin.type} • {plugin.model_map?.length || 0}{' '}
                              models
                            </p>
                          </div>
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={async () => {
                              await deactivatePlugin(plugin.id);
                              await loadModels();
                            }}
                            className='text-green-600 border-green-300 hover:bg-green-100'
                          >
                            Deactivate
                          </Button>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* Plugin List */}
              <div className='bg-white dark:bg-dark-100 rounded-lg border border-gray-200 dark:border-dark-300'>
                <div className='p-4 border-b border-gray-200 dark:border-dark-300'>
                  <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    Installed Plugins ({plugins.length})
                  </h4>
                </div>

                {pluginLoading ? (
                  <div className='p-8 text-center'>
                    <p className='text-gray-500 dark:text-gray-400'>
                      Loading plugins...
                    </p>
                  </div>
                ) : plugins.length === 0 ? (
                  <div className='p-8 text-center'>
                    <Puzzle className='h-12 w-12 text-gray-400 mx-auto mb-4' />
                    <p className='text-gray-500 dark:text-gray-400 mb-2'>
                      No plugins installed
                    </p>
                    <p className='text-xs text-gray-400 dark:text-gray-500'>
                      Upload a plugin file or add JSON configuration to get
                      started
                    </p>
                  </div>
                ) : (
                  <div className='divide-y divide-gray-200 dark:divide-dark-300'>
                    {plugins.map(plugin => (
                      <div key={plugin.id} className='p-4'>
                        <div className='flex items-center justify-between gap-2'>
                          <div className='flex-1 min-w-0'>
                            <div className='flex items-center space-x-3'>
                              <div
                                className={`w-3 h-3 rounded-full flex-shrink-0 ${plugin.active ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-500'}`}
                              />
                              <div>
                                <h5 className='font-medium text-gray-900 dark:text-gray-100'>
                                  {plugin.name}
                                </h5>
                                <div className='flex items-center space-x-2 text-xs text-gray-500 dark:text-gray-400'>
                                  <span>{plugin.type}</span>
                                  <span>•</span>
                                  <span>
                                    {plugin.model_map?.length || 0} models
                                  </span>
                                  {plugin.endpoint && (
                                    <>
                                      <span>•</span>
                                      <span className='truncate max-w-32'>
                                        {plugin.endpoint}
                                      </span>
                                    </>
                                  )}
                                  {pluginHasKeys[plugin.id] && (
                                    <>
                                      <span>•</span>
                                      <span className='text-green-600'>
                                        API key set
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className='flex items-center space-x-1 flex-shrink-0'>
                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={() =>
                                setExpandedPluginId(
                                  expandedPluginId === plugin.id
                                    ? null
                                    : plugin.id
                                )
                              }
                              title='Configure API key'
                              className={
                                pluginHasKeys[plugin.id]
                                  ? 'text-green-600'
                                  : 'text-amber-600'
                              }
                            >
                              <Key className='h-4 w-4' />
                              {expandedPluginId === plugin.id ? (
                                <ChevronUp className='h-3 w-3' />
                              ) : (
                                <ChevronDown className='h-3 w-3' />
                              )}
                            </Button>

                            <Button
                              variant='outline'
                              size='sm'
                              onClick={() => handleActivatePlugin(plugin.id)}
                              disabled={pluginLoading}
                              className={
                                plugin.active
                                  ? 'text-green-600 border-green-300'
                                  : ''
                              }
                            >
                              {plugin.active ? (
                                <>
                                  <Check className='h-4 w-4 mr-1' />
                                  Active
                                </>
                              ) : (
                                'Activate'
                              )}
                            </Button>

                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={() => handleExportPlugin(plugin.id)}
                              disabled={pluginLoading}
                              title='Export plugin'
                            >
                              <Download className='h-4 w-4' />
                            </Button>

                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={() => handleDeletePlugin(plugin.id)}
                              disabled={pluginLoading}
                              className='text-red-600 hover:text-red-700 hover:bg-red-50'
                              title='Delete plugin'
                            >
                              <Trash2 className='h-4 w-4' />
                            </Button>
                          </div>
                        </div>

                        {/* API Key Configuration Section */}
                        {expandedPluginId === plugin.id && (
                          <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-50 rounded-lg border border-gray-200 dark:border-dark-300'>
                            <div className='flex items-center gap-2 mb-3'>
                              <Key className='h-4 w-4 text-gray-500' />
                              <h6 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                                API Key Configuration
                              </h6>
                            </div>
                            <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                              Enter your API key for {plugin.name}. This will be
                              stored securely and used for API requests.
                              {plugin.auth?.key_env && (
                                <span className='block mt-1'>
                                  Alternatively, set the{' '}
                                  <code className='bg-gray-200 dark:bg-dark-200 px-1 rounded'>
                                    {plugin.auth.key_env}
                                  </code>{' '}
                                  environment variable.
                                </span>
                              )}
                            </p>

                            {pluginHasKeys[plugin.id] ? (
                              <div className='flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg'>
                                <div className='flex items-center gap-2'>
                                  <Check className='h-4 w-4 text-green-600' />
                                  <span className='text-sm text-green-700 dark:text-green-300'>
                                    API key is configured
                                  </span>
                                </div>
                                <Button
                                  variant='outline'
                                  size='sm'
                                  onClick={() => handleDeleteApiKey(plugin.id)}
                                  disabled={savingApiKey === plugin.id}
                                  className='text-red-600 border-red-300 hover:bg-red-50'
                                >
                                  {savingApiKey === plugin.id ? (
                                    <Loader2 className='h-4 w-4 animate-spin' />
                                  ) : (
                                    'Remove'
                                  )}
                                </Button>
                              </div>
                            ) : (
                              <div className='space-y-3'>
                                <div className='relative'>
                                  <input
                                    type={
                                      showApiKey[plugin.id]
                                        ? 'text'
                                        : 'password'
                                    }
                                    value={pluginApiKeys[plugin.id] || ''}
                                    onChange={e =>
                                      setPluginApiKeys(prev => ({
                                        ...prev,
                                        [plugin.id]: e.target.value,
                                      }))
                                    }
                                    placeholder='Enter your API key...'
                                    className='w-full p-2 pr-10 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500'
                                  />
                                  <button
                                    type='button'
                                    onClick={() =>
                                      setShowApiKey(prev => ({
                                        ...prev,
                                        [plugin.id]: !prev[plugin.id],
                                      }))
                                    }
                                    className='absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600'
                                  >
                                    {showApiKey[plugin.id] ? (
                                      <EyeOff className='h-4 w-4' />
                                    ) : (
                                      <Eye className='h-4 w-4' />
                                    )}
                                  </button>
                                </div>
                                <div className='flex justify-end'>
                                  <Button
                                    size='sm'
                                    onClick={() => handleSaveApiKey(plugin.id)}
                                    disabled={
                                      savingApiKey === plugin.id ||
                                      !pluginApiKeys[plugin.id]?.trim()
                                    }
                                  >
                                    {savingApiKey === plugin.id ? (
                                      <>
                                        <Loader2 className='h-4 w-4 mr-2 animate-spin' />
                                        Saving...
                                      </>
                                    ) : (
                                      'Save API Key'
                                    )}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        );

      case 'data':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Data Management
              </h3>
              <div className='space-y-4'>
                <div className='grid grid-cols-1 md:grid-cols-3 gap-4'>
                  <div>
                    <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      Export Data
                    </h4>
                    <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                      Download your settings and chat history as a JSON file.
                    </p>
                    <Button
                      onClick={handleExportData}
                      variant='outline'
                      size='sm'
                      className='w-full'
                    >
                      Export All Data
                    </Button>
                  </div>

                  <div>
                    <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      Import Data
                    </h4>
                    <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                      Restore your settings and chat history from a JSON file.
                    </p>
                    <input
                      ref={importFileInputRef}
                      type='file'
                      accept='.json'
                      onChange={handleImportFileSelect}
                      className='hidden'
                    />
                    <Button
                      onClick={() => importFileInputRef.current?.click()}
                      variant='outline'
                      size='sm'
                      className='w-full'
                      disabled={importing}
                    >
                      {importing ? 'Importing...' : 'Import Data'}
                    </Button>
                  </div>

                  <div>
                    <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      Clear Sessions
                    </h4>
                    <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                      Delete all chat sessions permanently. This cannot be
                      undone.
                    </p>
                    <Button
                      onClick={handleClearAllHistory}
                      variant='outline'
                      size='sm'
                      className='w-full text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 border-red-200 hover:border-red-300 dark:border-red-800 dark:hover:border-red-700'
                      disabled={sessions.length === 0 || loading}
                    >
                      {loading
                        ? 'Clearing...'
                        : `Clear All Sessions (${sessions.length})`}
                    </Button>
                  </div>
                </div>

                {/* Import Options Modal */}
                {showImportOptions && (
                  <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg'>
                    <h5 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-3'>
                      Import Options
                    </h5>
                    <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                      How should we handle existing data with the same IDs?
                    </p>
                    <div className='space-y-2 mb-4'>
                      <label className='flex items-center'>
                        <input
                          type='radio'
                          name='mergeStrategy'
                          value='skip'
                          checked={mergeStrategy === 'skip'}
                          onChange={e =>
                            setMergeStrategy(
                              e.target.value as 'skip' | 'overwrite' | 'merge'
                            )
                          }
                          className='mr-2'
                        />
                        <span className='text-sm text-gray-700 dark:text-gray-300'>
                          Skip duplicates (keep existing data)
                        </span>
                      </label>
                      <label className='flex items-center'>
                        <input
                          type='radio'
                          name='mergeStrategy'
                          value='overwrite'
                          checked={mergeStrategy === 'overwrite'}
                          onChange={e =>
                            setMergeStrategy(
                              e.target.value as 'skip' | 'overwrite' | 'merge'
                            )
                          }
                          className='mr-2'
                        />
                        <span className='text-sm text-gray-700 dark:text-gray-300'>
                          Overwrite existing data
                        </span>
                      </label>
                    </div>
                    <div className='flex gap-2'>
                      <Button
                        onClick={handleConfirmImport}
                        size='sm'
                        disabled={importing}
                      >
                        {importing ? 'Importing...' : 'Import'}
                      </Button>
                      <Button
                        onClick={handleCancelImport}
                        variant='outline'
                        size='sm'
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* Import Results */}
                {importResult && (
                  <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg'>
                    <h5 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-2'>
                      Import Results
                    </h5>
                    <div className='text-xs text-gray-700 dark:text-gray-300 space-y-1'>
                      <div>
                        Preferences:{' '}
                        {importResult.preferences.imported
                          ? '✅ Imported'
                          : '❌ Failed'}
                      </div>
                      <div>
                        Sessions: ✅ {importResult.sessions.imported} imported,
                        ⏭️ {importResult.sessions.skipped} skipped
                      </div>
                      <div>
                        Documents: ✅ {importResult.documents.imported}{' '}
                        imported, ⏭️ {importResult.documents.skipped} skipped
                      </div>
                      {(importResult.sessions.errors.length > 0 ||
                        importResult.documents.errors.length > 0) && (
                        <div className='mt-2'>
                          <p className='font-medium'>Errors:</p>
                          {importResult.sessions.errors.map(
                            (error: string, idx: number) => (
                              <p
                                key={idx}
                                className='text-red-600 dark:text-red-400'
                              >
                                • {error}
                              </p>
                            )
                          )}
                          {importResult.documents.errors.map(
                            (error: string, idx: number) => (
                              <p
                                key={idx}
                                className='text-red-600 dark:text-red-400'
                              >
                                • {error}
                              </p>
                            )
                          )}
                        </div>
                      )}
                    </div>
                    <Button
                      onClick={() => setImportResult(null)}
                      variant='outline'
                      size='sm'
                      className='mt-2'
                    >
                      Close
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );

      case 'about':
        return (
          <div className='space-y-6'>
            <div>
              <h3
                className='libre-brand text-2xl sm:text-3xl font-normal text-gray-900 dark:text-gray-100 mb-4'
                style={{ fontWeight: 300, letterSpacing: '0.01em' }}
              >
                Libre WebUI
              </h3>
              <div className='text-sm text-gray-700 dark:text-gray-300 mb-6'>
                <span>About</span>
              </div>
              <div className='bg-gray-50 dark:bg-dark-100 rounded-lg p-6 border border-gray-200 dark:border-dark-300'>
                <div className='space-y-4 text-sm text-gray-700 dark:text-gray-300'>
                  <div className='flex items-start gap-3'>
                    <div className='w-2 h-2 bg-green-500 rounded-full mt-2 flex-shrink-0'></div>
                    <div>
                      <p className='font-semibold text-gray-900 dark:text-gray-100 mb-1'>
                        Privacy First
                      </p>
                      <p>
                        All your data stays on your machine. No telemetry, no
                        tracking, no cloud dependencies.
                      </p>
                    </div>
                  </div>

                  <div className='flex items-start gap-3'>
                    <div className='w-2 h-2 bg-primary-500 rounded-full mt-2 flex-shrink-0'></div>
                    <div>
                      <p className='font-semibold text-gray-900 dark:text-gray-100 mb-1'>
                        Open Source
                      </p>
                      <p>
                        100% free and open source software licensed under Apache
                        2.0. Community-driven development.
                      </p>
                    </div>
                  </div>

                  <div className='flex items-start gap-3'>
                    <div className='w-2 h-2 bg-purple-500 rounded-full mt-2 flex-shrink-0'></div>
                    <div>
                      <p className='font-semibold text-gray-900 dark:text-gray-100 mb-1'>
                        Local Inference
                      </p>
                      <p>
                        Powered by Ollama for completely offline AI inference.
                        No internet required once models are downloaded.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Links Section */}
              <div className='mt-6 space-y-4'>
                <h4 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
                  Links & Resources
                </h4>
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                  <a
                    href='https://github.com/libre-webui/libre-webui'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-3 p-3 bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 hover:border-gray-300 dark:hover:border-dark-400 transition-all duration-200 group'
                  >
                    <Github className='h-5 w-5 text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200' />
                    <div>
                      <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                        GitHub Repository
                      </p>
                      <p className='text-xs text-gray-500 dark:text-gray-400'>
                        Source code & contributions
                      </p>
                    </div>
                    <ExternalLink className='h-4 w-4 text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity' />
                  </a>

                  <a
                    href='https://librewebui.org'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-3 p-3 bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 hover:border-gray-300 dark:hover:border-dark-400 transition-all duration-200 group'
                  >
                    <ExternalLink className='h-5 w-5 text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200' />
                    <div>
                      <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                        Official Website
                      </p>
                      <p className='text-xs text-gray-500 dark:text-gray-400'>
                        Documentation & guides
                      </p>
                    </div>
                    <ExternalLink className='h-4 w-4 text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity' />
                  </a>

                  <a
                    href='https://ollama.ai'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-3 p-3 bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 hover:border-gray-300 dark:hover:border-dark-400 transition-all duration-200 group'
                  >
                    <Bot className='h-5 w-5 text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200' />
                    <div>
                      <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                        Ollama
                      </p>
                      <p className='text-xs text-gray-500 dark:text-gray-400'>
                        Local AI inference engine
                      </p>
                    </div>
                    <ExternalLink className='h-4 w-4 text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity' />
                  </a>

                  <a
                    href='https://github.com/libre-webui/libre-webui/issues'
                    target='_blank'
                    rel='noopener noreferrer'
                    className='flex items-center gap-3 p-3 bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg hover:bg-gray-50 dark:hover:bg-dark-200 hover:border-gray-300 dark:hover:border-dark-400 transition-all duration-200 group'
                  >
                    <MessageSquare className='h-5 w-5 text-gray-600 dark:text-gray-400 group-hover:text-gray-900 dark:group-hover:text-gray-200' />
                    <div>
                      <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                        Report Issues
                      </p>
                      <p className='text-xs text-gray-500 dark:text-gray-400'>
                        Bug reports & feature requests
                      </p>
                    </div>
                    <ExternalLink className='h-4 w-4 text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity' />
                  </a>
                </div>
              </div>

              {/* Version Info */}
              <div className='mt-6 p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg'>
                <div className='flex items-center justify-between text-xs text-gray-500 dark:text-gray-400'>
                  <a
                    href={`https://github.com/libre-webui/libre-webui/releases/tag/v${packageJson.version}`}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='hover:text-primary-600 dark:hover:text-primary-400 transition-colors'
                  >
                    Version {packageJson.version}
                  </a>
                  <span>
                    Open source by{' '}
                    <a
                      href='https://kroonen.ai'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-primary-600 dark:text-primary-400 hover:text-primary-700 dark:hover:text-primary-300 transition-colors'
                    >
                      Kroonen AI
                    </a>
                  </span>
                </div>
              </div>
            </div>
          </div>
        );

      case 'generation':
        return (
          <div className='space-y-6'>
            <div>
              <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
                Generation Options
              </h3>
              <p className='text-sm text-gray-600 dark:text-gray-400 mb-6'>
                Fine-tune AI generation parameters to control response behavior
                and quality.
              </p>

              <div className='space-y-6'>
                {/* Core Parameters */}
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-4'>
                    Core Parameters
                  </h4>
                  <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                    {/* Temperature */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Temperature
                        <span className='text-xs text-gray-500 ml-1'>
                          (0.0-2.0)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='0'
                        max='2'
                        step='0.1'
                        value={tempGenerationOptions.temperature ?? ''}
                        placeholder='0.8'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'temperature',
                            e.target.value
                              ? parseFloat(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Controls randomness. Lower = more focused, Higher = more
                        creative
                      </p>
                    </div>

                    {/* Top P */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Top P
                        <span className='text-xs text-gray-500 ml-1'>
                          (0.0-1.0)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='0'
                        max='1'
                        step='0.05'
                        value={tempGenerationOptions.top_p ?? ''}
                        placeholder='0.9'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'top_p',
                            e.target.value
                              ? parseFloat(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Nucleus sampling. Lower = more constrained vocabulary
                      </p>
                    </div>

                    {/* Top K */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Top K
                        <span className='text-xs text-gray-500 ml-1'>
                          (1-100)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='1'
                        max='100'
                        value={tempGenerationOptions.top_k ?? ''}
                        placeholder='40'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'top_k',
                            e.target.value
                              ? parseInt(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Limits vocabulary to top K tokens
                      </p>
                    </div>

                    {/* Min P */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Min P
                        <span className='text-xs text-gray-500 ml-1'>
                          (0.0-1.0)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='0'
                        max='1'
                        step='0.05'
                        value={tempGenerationOptions.min_p ?? ''}
                        placeholder='0.0'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'min_p',
                            e.target.value
                              ? parseFloat(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Minimum probability threshold
                      </p>
                    </div>
                  </div>
                </div>

                {/* Generation Control */}
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-4'>
                    Generation Control
                  </h4>
                  <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                    {/* Max Tokens */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Max Tokens
                      </label>
                      <input
                        type='number'
                        min='-1'
                        max='4096'
                        value={tempGenerationOptions.num_predict ?? ''}
                        placeholder='128'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'num_predict',
                            e.target.value
                              ? parseInt(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Maximum number of tokens to generate. Leave empty to use
                        default. Use -1 for unlimited.
                      </p>
                    </div>

                    {/* Repeat Penalty */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Repeat Penalty
                        <span className='text-xs text-gray-500 ml-1'>
                          (0.0-2.0)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='0'
                        max='2'
                        step='0.1'
                        value={tempGenerationOptions.repeat_penalty ?? ''}
                        placeholder='1.1'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'repeat_penalty',
                            e.target.value
                              ? parseFloat(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Penalty for repeating tokens
                      </p>
                    </div>

                    {/* Context Length */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Context Length
                      </label>
                      <input
                        type='number'
                        min='512'
                        max='32768'
                        step='512'
                        value={tempGenerationOptions.num_ctx ?? ''}
                        placeholder='2048'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'num_ctx',
                            e.target.value
                              ? parseInt(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Context window size
                      </p>
                    </div>

                    {/* Seed */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Seed
                        <span className='text-xs text-gray-500 ml-1'>
                          (optional)
                        </span>
                      </label>
                      <input
                        type='number'
                        value={tempGenerationOptions.seed || ''}
                        onChange={e =>
                          handleGenerationOptionChange(
                            'seed',
                            e.target.value
                              ? parseInt(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                        placeholder='Random'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Seed for reproducible outputs
                      </p>
                    </div>
                  </div>
                </div>

                {/* Advanced Options */}
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-4'>
                    Advanced Options
                  </h4>
                  <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                    {/* Presence Penalty */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Presence Penalty
                        <span className='text-xs text-gray-500 ml-1'>
                          (-2.0-2.0)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='-2'
                        max='2'
                        step='0.1'
                        value={tempGenerationOptions.presence_penalty ?? ''}
                        placeholder='0.0'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'presence_penalty',
                            e.target.value
                              ? parseFloat(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Penalty for token presence
                      </p>
                    </div>

                    {/* Frequency Penalty */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Frequency Penalty
                        <span className='text-xs text-gray-500 ml-1'>
                          (-2.0-2.0)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='-2'
                        max='2'
                        step='0.1'
                        value={tempGenerationOptions.frequency_penalty ?? ''}
                        placeholder='0.0'
                        onChange={e =>
                          handleGenerationOptionChange(
                            'frequency_penalty',
                            e.target.value
                              ? parseFloat(e.target.value)
                              : undefined
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      />
                      <p className='text-xs text-gray-500 mt-1'>
                        Penalty for token frequency
                      </p>
                    </div>
                  </div>

                  {/* Stop Sequences */}
                  <div className='mt-4'>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      Stop Sequences
                      <span className='text-xs text-gray-500 ml-1'>
                        (comma-separated)
                      </span>
                    </label>
                    <input
                      type='text'
                      value={
                        tempGenerationOptions.stop
                          ? tempGenerationOptions.stop.join(', ')
                          : ''
                      }
                      onChange={e =>
                        handleGenerationOptionChange(
                          'stop',
                          e.target.value
                            ? e.target.value
                                .split(',')
                                .map(s => s.trim())
                                .filter(s => s)
                            : undefined
                        )
                      }
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                      placeholder='\\n, ###, STOP'
                    />
                    <p className='text-xs text-gray-500 mt-1'>
                      Sequences that will stop generation
                    </p>
                  </div>
                </div>

                {/* Action Buttons */}
                <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
                  <Button
                    onClick={handleResetGenerationOptions}
                    variant='outline'
                    className='flex items-center gap-2'
                  >
                    <RotateCcw size={16} />
                    Reset to Defaults
                  </Button>
                  <Button
                    onClick={handleSaveGenerationOptions}
                    className='flex items-center gap-2'
                  >
                    <Check size={16} />
                    Save Options
                  </Button>
                </div>
              </div>

              {/* Embedding Settings Section */}
              <div className='mt-6'>
                <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                    Embedding Settings
                  </label>
                  <div className='space-y-4'>
                    {/* Enable/Disable Embeddings */}
                    <div className='flex items-center justify-between'>
                      <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                        Enable Embeddings
                      </span>
                      <label className='flex items-center cursor-pointer'>
                        <input
                          type='checkbox'
                          checked={embeddingSettings.enabled}
                          onChange={e =>
                            handleEmbeddingSettingsChange(
                              'enabled',
                              e.target.checked
                            )
                          }
                          className='sr-only'
                        />
                        <div
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 ${
                            embeddingSettings.enabled
                              ? 'bg-primary-600 dark:bg-primary-500'
                              : 'bg-gray-200 dark:bg-dark-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                              embeddingSettings.enabled
                                ? 'translate-x-6'
                                : 'translate-x-1'
                            }`}
                          />
                        </div>
                      </label>
                    </div>

                    {/* Model Selection */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Embedding Model
                      </label>
                      <Select
                        value={embeddingSettings.model}
                        onChange={e =>
                          handleEmbeddingSettingsChange('model', e.target.value)
                        }
                        options={[
                          {
                            value: 'nomic-embed-text',
                            label: 'Nomic Embed Text',
                          },
                          {
                            value: 'openai-embedding',
                            label: 'OpenAI Embedding',
                          },
                        ]}
                        disabled={!embeddingSettings.enabled}
                      />
                    </div>

                    {/* Chunk Size */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Chunk Size
                        <span className='text-xs text-gray-500 ml-1'>
                          (in tokens)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='1'
                        value={embeddingSettings.chunkSize}
                        onChange={e =>
                          handleEmbeddingSettingsChange(
                            'chunkSize',
                            parseInt(e.target.value)
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                        disabled={!embeddingSettings.enabled}
                      />
                    </div>

                    {/* Chunk Overlap */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Chunk Overlap
                        <span className='text-xs text-gray-500 ml-1'>
                          (in tokens)
                        </span>
                      </label>
                      <input
                        type='number'
                        min='0'
                        value={embeddingSettings.chunkOverlap}
                        onChange={e =>
                          handleEmbeddingSettingsChange(
                            'chunkOverlap',
                            parseInt(e.target.value)
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                        disabled={!embeddingSettings.enabled}
                      />
                    </div>

                    {/* Similarity Threshold */}
                    <div>
                      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                        Similarity Threshold
                      </label>
                      <input
                        type='number'
                        min='0'
                        max='1'
                        step='0.01'
                        value={embeddingSettings.similarityThreshold}
                        onChange={e =>
                          handleEmbeddingSettingsChange(
                            'similarityThreshold',
                            parseFloat(e.target.value)
                          )
                        }
                        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                        disabled={!embeddingSettings.enabled}
                      />
                    </div>
                  </div>

                  {/* Status and Regenerate Button */}
                  {embeddingStatus && (
                    <div className='mt-4'>
                      <div className='flex items-center justify-between text-sm'>
                        <span className='text-gray-700 dark:text-gray-300'>
                          Embedding Status:
                        </span>
                        <span className='font-medium text-gray-900 dark:text-gray-100'>
                          {embeddingStatus.available
                            ? 'Available'
                            : 'Not Available'}
                        </span>
                      </div>
                      {embeddingStatus.available && (
                        <div className='flex items-center justify-between text-sm mt-1'>
                          <span className='text-gray-700 dark:text-gray-300'>
                            Chunks with Embeddings:
                          </span>
                          <span className='font-medium text-gray-900 dark:text-gray-100'>
                            {embeddingStatus.chunksWithEmbeddings} /{' '}
                            {embeddingStatus.totalChunks}
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div className='flex justify-between items-center mt-4'>
                    <Button
                      onClick={handleResetEmbeddingSettings}
                      variant='outline'
                      className='flex items-center gap-2'
                    >
                      <RotateCcw size={16} />
                      Reset to Defaults
                    </Button>
                    <Button
                      onClick={handleSaveEmbeddingSettings}
                      className='flex items-center gap-2'
                    >
                      <Check size={16} />
                      Save Settings
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
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
              Settings
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
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`w-full flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5 sm:py-2.5 text-left rounded-lg transition-colors duration-200 touch-manipulation ${
                        activeTab === tab.id
                          ? 'bg-gray-100 dark:bg-dark-100 ophelia:bg-[#0a0a0a] text-gray-900 dark:text-white ophelia:text-[#fafafa] border border-gray-200 dark:border-dark-300 ophelia:border-[rgba(38,38,38,0.3)]'
                          : 'text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] hover:bg-gray-50 dark:hover:bg-dark-200 ophelia:hover:bg-[#0a0a0a] active:bg-gray-100 dark:active:bg-dark-100 ophelia:active:bg-[#121212]'
                      }`}
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
