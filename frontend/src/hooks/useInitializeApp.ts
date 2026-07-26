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
import { createLogger } from '@/utils/logger';

const logger = createLogger('initialize');

export const useInitializeApp = () => {
  const initialized = useRef(false);
  const initializing = useRef(false);
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
    if (initialized.current || initializing.current) return;

    const initialize = async () => {
      initializing.current = true;
      try {
        logger.debug('Initializing Libre WebUI...');

        // Initialize authentication first
        await UserService.initializeAuth();

        // Ollama and configured plugins are independent model providers. An
        // unavailable Ollama daemon must not prevent the rest of the app (or
        // plugin-backed Work models) from initializing.
        try {
          const healthResponse = await ollamaApi.checkHealth();
          if (!healthResponse.success && !isDemoMode()) {
            toast.error(
              'Ollama service is not available. Plugin models may still be used.'
            );
          }
        } catch (healthError) {
          logger.warn(
            'Ollama health check failed; continuing provider initialization:',
            healthError
          );
          if (!isDemoMode()) {
            toast.error(
              'Ollama service is not available. Plugin models may still be used.'
            );
          }
        }

        // Load preferences first, then models, sessions, and plugins
        await Promise.all([loadAppPreferences(), loadChatPreferences()]);
        await Promise.all([loadModels(), loadSessions(), loadPlugins()]);

        initialized.current = true;
        logger.debug('Libre WebUI initialized successfully');
      } catch (_error) {
        if (!isDemoMode()) {
          logger.error('Failed to initialize app:', _error);
          toast.error('Failed to connect to the backend service');
        } else {
          // In demo mode, proceed to load models and sessions anyway, no error log
          await Promise.all([loadAppPreferences(), loadChatPreferences()]);
          await Promise.all([loadModels(), loadSessions(), loadPlugins()]);
          initialized.current = true;
        }
      } finally {
        initializing.current = false;
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
      // Filter out embedding models — they can't be used for chat
      const chatModels = models.filter(m => !m.name.includes('embed'));
      const fallback = chatModels[0] || models[0];

      // Check if we already have a selected model from backend preferences
      const { selectedModel: currentSelected } = useChatStore.getState();

      if (currentSelected) {
        // Verify the selected model from backend is still available
        const availableModelNames = models.map(m => m.name);

        if (!availableModelNames.includes(currentSelected)) {
          // Selected model no longer available, use first non-embedding model
          logger.debug(
            'Selected model not available, falling back to:',
            fallback.name
          );
          setSelectedModel(fallback.name);
        }
      } else {
        // No model selected, use first non-embedding model
        logger.debug(
          'No model selected, using first available:',
          fallback.name
        );
        setSelectedModel(fallback.name);
      }
    }
  }, [models, setSelectedModel]);

  // Reload models when active plugins change
  useEffect(() => {
    if (!initialized.current) return;
    logger.debug('Plugin availability changed, reloading models...');
    void loadModels();
  }, [plugins, loadModels]);
};
