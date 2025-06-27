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

import { useEffect } from 'react';
import { useChatStore } from '@/store/chatStore';
import { ollamaApi } from '@/utils/api';
import toast from 'react-hot-toast';
import { isDemoMode } from '@/utils/demoMode';

export const useInitializeApp = () => {
  console.log('[DEBUG] useInitializeApp hook running');
  const {
    loadSessions,
    loadModels,
    loadPreferences,
    setSelectedModel,
    models,
  } = useChatStore();

  useEffect(() => {
    const initialize = async () => {
      try {
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
            await loadPreferences();
            await Promise.all([loadModels(), loadSessions()]);
            return;
          }
        }
        // Load preferences first, then models and sessions
        await loadPreferences();
        await Promise.all([loadModels(), loadSessions()]);
      } catch (_error) {
        if (!isDemoMode()) {
          console.error('Failed to initialize app:', _error);
          toast.error('Failed to connect to the backend service');
        } else {
          // In demo mode, proceed to load models and sessions anyway, no error log
          await loadPreferences();
          await Promise.all([loadModels(), loadSessions()]);
        }
      }
    };

    initialize();
  }, [loadSessions, loadModels, loadPreferences]);

  // Set default model when models are loaded
  useEffect(() => {
    console.log(
      '🔄 useInitializeApp: models effect triggered, models.length:',
      models.length
    );

    if (models.length > 0) {
      // Check if we already have a selected model from backend preferences
      const { selectedModel: currentSelected } = useChatStore.getState();
      console.log('📋 Current selected model from store:', currentSelected);

      if (currentSelected) {
        // Verify the selected model from backend is still available
        const availableModelNames = models.map(m => m.name);
        console.log('📋 Available models:', availableModelNames);

        if (!availableModelNames.includes(currentSelected)) {
          // Selected model no longer available, use first available
          console.log(
            '⚠️ Selected model not available, falling back to first model:',
            models[0].name
          );
          setSelectedModel(models[0].name);
        } else {
          // Model is available, keep it selected (don't override)
          console.log(
            '✅ Keeping selected model from preferences:',
            currentSelected
          );
        }
      } else {
        // No model selected, use first available
        console.log(
          '⚠️ No model selected, using first available:',
          models[0].name
        );
        setSelectedModel(models[0].name);
      }
    }
  }, [models, setSelectedModel]);
};
