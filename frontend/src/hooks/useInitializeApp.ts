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

import { useEffect, useRef } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import { ollamaApi } from '@/utils/api';
import { UserService } from '@/services/userService';
import toast from 'react-hot-toast';
import { isDemoMode } from '@/utils/demoMode';

export const useInitializeApp = () => {
  const initialized = useRef(false);
  const {
    loadSessions,
    loadModels,
    loadPreferences: loadChatPreferences,
    setSelectedModel,
    models,
  } = useChatStore();
  const { loadPreferences: loadAppPreferences } = useAppStore();
  const { loadPlugins, plugins } = usePluginStore();

  useEffect(() => {
    if (initialized.current) return;

    const initialize = async () => {
      try {
        if (process.env.NODE_ENV === 'development') {
          console.log('🚀 Initializing Libre WebUI...');
        }
        initialized.current = true;

        // Initialize authentication first
        await UserService.initializeAuth();

        // Check Ollama health
        const healthResponse = await ollamaApi.checkHealth();
        if (!healthResponse.success) {
          if (!isDemoMode()) {
            toast.error(
              "Ollama service is not available. Please make sure it's running."
            );
            return;
          } else {
            // In demo mode, proceed to load models and sessions anyway
            await Promise.all([loadAppPreferences(), loadChatPreferences()]);
            await Promise.all([loadModels(), loadSessions(), loadPlugins()]);
            return;
          }
        }
        // Load preferences first, then models, sessions, and plugins
        await Promise.all([loadAppPreferences(), loadChatPreferences()]);
        await Promise.all([loadModels(), loadSessions(), loadPlugins()]);

        if (process.env.NODE_ENV === 'development') {
          console.log('✅ Libre WebUI initialized successfully');
        }
      } catch (_error) {
        if (!isDemoMode()) {
          console.error('Failed to initialize app:', _error);
          toast.error('Failed to connect to the backend service');
        } else {
          // In demo mode, proceed to load models and sessions anyway, no error log
          await Promise.all([loadAppPreferences(), loadChatPreferences()]);
          await Promise.all([loadModels(), loadSessions(), loadPlugins()]);
        }
      }
    };

    initialize();
  }, [
    loadAppPreferences,
    loadChatPreferences,
    loadModels,
    loadSessions,
    loadPlugins,
  ]);

  // Set default model when models are loaded
  useEffect(() => {
    if (models.length > 0) {
      // Check if we already have a selected model from backend preferences
      const { selectedModel: currentSelected } = useChatStore.getState();

      if (currentSelected) {
        // Verify the selected model from backend is still available
        const availableModelNames = models.map(m => m.name);

        if (!availableModelNames.includes(currentSelected)) {
          // Selected model no longer available, use first available
          console.log(
            '⚠️ Selected model not available, falling back to first model:',
            models[0].name
          );
          setSelectedModel(models[0].name);
        }
      } else {
        // No model selected, use first available
        console.log(
          '📋 No model selected, using first available:',
          models[0].name
        );
        setSelectedModel(models[0].name);
      }
    }
  }, [models, setSelectedModel]);

  // Reload models when active plugins change
  useEffect(() => {
    const activePlugins = plugins.filter(plugin => plugin.active);
    if (activePlugins.length > 0) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🔄 Active plugins changed, reloading models...');
      }
      loadModels();
    }
  }, [plugins, loadModels]);
};
