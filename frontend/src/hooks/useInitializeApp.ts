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
import { useAuthStore } from '@/store/authStore';
import { usePluginStore } from '@/store/pluginStore';
import { MODELS_CHANGED_EVENT, ollamaApi } from '@/utils/api';
import { UserService } from '@/services/userService';
import toast from 'react-hot-toast';
import { isDemoMode } from '@/utils/demoMode';
import { createLogger } from '@/utils/logger';
import {
  chatModelSelectionFromModel,
  findChatModelForSelection,
} from '@/utils/chatModelSelection';

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
    ollamaConnected,
  } = useChatStore();
  const { loadPreferences: loadAppPreferences } = useAppStore();
  const { loadPlugins, plugins } = usePluginStore();
  // Re-run protected initialization when a login lands: the first pass runs
  // before authentication and must not permanently swallow the app's data.
  const isAuthenticated = useAuthStore(state => state.isAuthenticated);

  useEffect(() => {
    if (initialized.current || initializing.current) return;

    const initialize = async () => {
      initializing.current = true;
      try {
        logger.debug('Initializing Libre WebUI...');

        // Initialize authentication first
        await UserService.initializeAuth();

        const authState = useAuthStore.getState();
        if (authState.requiresAuth() && !authState.isAuthenticated) {
          logger.debug(
            'Authentication required; deferring protected app initialization'
          );
          // Deliberately NOT marking initialized: the login flipping
          // isAuthenticated re-runs this effect and loads everything the
          // interface needs, instead of showing an empty app until a manual
          // page refresh.
          return;
        }

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
    isAuthenticated,
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
      const {
        selectedModel: currentSelected,
        selectedProviderType,
        selectedProviderId,
      } = useChatStore.getState();

      if (currentSelected) {
        const availableSelection = findChatModelForSelection(models, {
          model: currentSelected,
          providerType: selectedProviderType,
          providerId: selectedProviderId,
        });

        if (
          !availableSelection &&
          selectedProviderType !== 'ollama' &&
          selectedProviderType !== 'plugin'
        ) {
          // Only legacy name-only preferences retain the automatic fallback.
          const fallbackSelection = chatModelSelectionFromModel(fallback);
          logger.debug(
            'Legacy selected model not available, falling back to:',
            fallbackSelection.model
          );
          setSelectedModel(
            fallbackSelection.model,
            fallbackSelection.providerType,
            fallbackSelection.providerId
          );
        }
      } else {
        // No model selected, use first non-embedding model
        const fallbackSelection = chatModelSelectionFromModel(fallback);
        logger.debug(
          'No model selected, using first available:',
          fallbackSelection.model
        );
        setSelectedModel(
          fallbackSelection.model,
          fallbackSelection.providerType,
          fallbackSelection.providerId
        );
      }
    }
  }, [models, setSelectedModel]);

  // Reload models when active plugins change
  useEffect(() => {
    if (!initialized.current) return;
    logger.debug('Plugin availability changed, reloading models...');
    void loadModels();
  }, [plugins, loadModels]);

  // An administrator can open or close Work while a session is running.
  // Re-check on window focus so grants and revocations reach the interface
  // without a re-login; a small gap keeps rapid tab switches from spamming
  // the endpoint.
  useEffect(() => {
    let lastCheck = 0;
    const recheckWorkAccess = () => {
      if (document.visibilityState !== 'visible') return;
      const auth = useAuthStore.getState();
      if (auth.requiresAuth() && !auth.isAuthenticated) return;
      const now = Date.now();
      if (now - lastCheck < 10_000) return;
      lastCheck = now;
      void auth.refreshWorkAccess();
    };
    window.addEventListener('focus', recheckWorkAccess);
    document.addEventListener('visibilitychange', recheckWorkAccess);
    return () => {
      window.removeEventListener('focus', recheckWorkAccess);
      document.removeEventListener('visibilitychange', recheckWorkAccess);
    };
  }, []);

  // Pulling or removing a model changes what can be chatted with, so pick the
  // new list up straight away instead of waiting for the next app start.
  useEffect(() => {
    const reload = () => {
      logger.debug('Installed models changed, reloading models...');
      void loadModels();
    };
    window.addEventListener(MODELS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, reload);
  }, [loadModels]);

  // Providers that are still starting when the app loads — a booting stack or
  // an Ollama daemon launched afterwards — must show up without a page
  // reload. While no provider-backed model is available, poll quietly; once
  // some are, an offline Ollama is only re-checked when the window regains
  // focus, so a deliberately plugin-only setup is not polled forever.
  useEffect(() => {
    if (ollamaConnected) return;
    const auth = useAuthStore.getState();
    if (auth.requiresAuth() && !auth.isAuthenticated) return;

    const reload = () => {
      if (document.visibilityState !== 'visible') return;
      logger.debug('Provider offline at startup, re-checking availability...');
      void loadModels({ quiet: true });
    };

    const hasProviderModels = models.some(model => !model.isPersona);
    const timer = hasProviderModels
      ? undefined
      : window.setInterval(reload, 10_000);
    window.addEventListener('focus', reload);
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      window.removeEventListener('focus', reload);
    };
  }, [ollamaConnected, models, loadModels]);
};
