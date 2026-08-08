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

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, SystemInfo } from '@/types';
import type { WorkAccess } from '@/types/work';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import { useWorkStore } from '@/store/workStore';
import { ollamaApi } from '@/utils/api';
import { isDemoMode } from '@/utils/demoMode';
import { createLogger } from '@/utils/logger';
import { clearAllWorkDrafts } from '@/utils/workDrafts';
import websocketService from '@/utils/websocket';

const logger = createLogger('auth-store');

interface AuthState {
  user: User | null;
  token: string | null;
  systemInfo: SystemInfo | null;
  workAccess: WorkAccess | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (user: User, token: string, systemInfo: SystemInfo) => void;
  logout: () => void;
  setUser: (user: User) => void;
  setSystemInfo: (systemInfo: SystemInfo) => void;
  setLoading: (loading: boolean) => void;
  isAdmin: () => boolean;
  requiresAuth: () => boolean;
  canUseWork: () => boolean;
  canUseAgents: () => boolean;
  refreshWorkAccess: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      systemInfo: null,
      workAccess: null,
      isAuthenticated: false,
      isLoading: false,

      login: (user: User, token: string, systemInfo: SystemInfo) => {
        const isSameUser = get().user?.id === user.id;

        // Save token to localStorage
        localStorage.setItem('auth-token', token);

        // Clear chat store state when a new user logs in
        const chatStore = useChatStore.getState();
        if (chatStore.clearAllState) {
          chatStore.clearAllState();
        }
        useWorkStore.getState().clearAllState();

        // Preserve the verified user's hydrated preferences on page refresh, but
        // clear them and any unsaved Work drafts when the authenticated user
        // actually changes.
        if (!isSameUser) {
          clearAllWorkDrafts();
          const appStore = useAppStore.getState();
          appStore.clearUserState();
        }

        set({
          user,
          token,
          systemInfo,
          isAuthenticated: true,
          isLoading: false,
        });

        // Reinitialize models and sessions after login
        setTimeout(async () => {
          try {
            // Get required stores
            const pluginStore = usePluginStore.getState();

            logger.debug('Reinitializing app after login...');

            // Reconnect WebSocket with the new token
            logger.debug('Reconnecting WebSocket with auth token...');
            websocketService.disconnect();
            await websocketService.connect();

            // Ollama is optional when the user has a configured plugin model.
            // Its health check must not block the rest of post-login loading.
            try {
              const healthResponse = await ollamaApi.checkHealth();
              if (!healthResponse.success && !isDemoMode()) {
                logger.warn('Ollama service not available after login');
              }
            } catch (healthError) {
              logger.warn(
                'Ollama health check failed after login; continuing provider initialization:',
                healthError
              );
            }

            // Load the new user's data
            const currentAppStore = useAppStore.getState();
            await Promise.all([
              chatStore.loadModels(),
              chatStore.loadSessions(),
              chatStore.loadPreferences(),
              currentAppStore.loadPreferences(),
              pluginStore.loadPlugins(),
              get().refreshWorkAccess(),
            ]);
            logger.debug('Reinitialized app after login');
          } catch (error) {
            logger.error('Failed to reinitialize app after login:', error);
          }
        }, 100);
      },

      logout: () => {
        // Remove token from localStorage
        localStorage.removeItem('auth-token');

        // Disconnect WebSocket to clear authentication
        logger.debug('Disconnecting WebSocket on logout...');
        websocketService.disconnect();

        // Clear chat store state when logging out
        const chatStore = useChatStore.getState();
        if (chatStore.clearAllState) {
          chatStore.clearAllState();
        }
        useWorkStore.getState().clearAllState();
        clearAllWorkDrafts();

        // Clear app store user-specific state (background, preferences)
        const appStore = useAppStore.getState();
        appStore.clearUserState();

        set({
          user: null,
          token: null,
          workAccess: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },

      setUser: (user: User) => {
        set({ user });
      },

      setSystemInfo: (systemInfo: SystemInfo) => {
        set({ systemInfo });
      },

      setLoading: (loading: boolean) => {
        set({ isLoading: loading });
      },

      isAdmin: () => {
        const { user } = get();
        return user?.role === 'admin';
      },

      requiresAuth: () => {
        const { systemInfo } = get();
        return systemInfo?.requiresAuth ?? false;
      },

      // Whether the interface should offer Work. Administrators always may;
      // other users may when an administrator has opened Work to all users
      // (reported by the backend through /work/access). The backend enforces
      // this on every request regardless of what the interface shows.
      canUseWork: () => {
        const { systemInfo, user, workAccess } = get();
        if (systemInfo?.requiresAuth === false) return true;
        if (user?.role === 'admin') return true;
        return workAccess?.allowed === true;
      },

      // Whether the interface should offer the Agents section (Libre Claw).
      // The feature is an explicit administrator opt-in reported through
      // system info; the backend enforces it on every request regardless.
      canUseAgents: () => {
        const { systemInfo, user } = get();
        if (systemInfo?.agentsEnabled !== true) return false;
        if (systemInfo?.requiresAuth === false) return true;
        return user?.role === 'admin';
      },

      refreshWorkAccess: async () => {
        try {
          const { workApi } = await import('@/utils/api/workApi');
          const response = await workApi.access();
          if (response.success && response.data) {
            set({ workAccess: response.data });
          }
        } catch (error) {
          logger.debug('Could not load Work access mode:', error);
        }
      },
    }),
    {
      name: 'auth-store',
      partialize: state => ({
        user: state.user,
        token: state.token,
        systemInfo: state.systemInfo,
        workAccess: state.workAccess,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
