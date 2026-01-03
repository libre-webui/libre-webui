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
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { usePluginStore } from '@/store/pluginStore';
import { ollamaApi } from '@/utils/api';
import { isDemoMode } from '@/utils/demoMode';
import websocketService from '@/utils/websocket';

interface AuthState {
  user: User | null;
  token: string | null;
  systemInfo: SystemInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (user: User, token: string, systemInfo: SystemInfo) => void;
  logout: () => void;
  setUser: (user: User) => void;
  setSystemInfo: (systemInfo: SystemInfo) => void;
  setLoading: (loading: boolean) => void;
  isAdmin: () => boolean;
  requiresAuth: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      systemInfo: null,
      isAuthenticated: false,
      isLoading: false,

      login: (user: User, token: string, systemInfo: SystemInfo) => {
        // Save token to localStorage
        localStorage.setItem('auth-token', token);

        // Clear chat store state when a new user logs in
        const chatStore = useChatStore.getState();
        if (chatStore.clearAllState) {
          chatStore.clearAllState();
        }

        // Clear app store user-specific state (background, preferences) to prevent data leaking between users
        const appStore = useAppStore.getState();
        appStore.clearUserState();

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

            console.log('🔄 Reinitializing app after login...');

            // Reconnect WebSocket with the new token
            console.log('🔌 Reconnecting WebSocket with auth token...');
            websocketService.disconnect();
            await websocketService.connect();

            // Check Ollama health first
            const healthResponse = await ollamaApi.checkHealth();
            if (!healthResponse.success && !isDemoMode()) {
              console.warn('Ollama service not available after login');
            }

            // Load the new user's data
            const currentAppStore = useAppStore.getState();
            await Promise.all([
              chatStore.loadModels(),
              chatStore.loadSessions(),
              chatStore.loadPreferences(),
              currentAppStore.loadPreferences(),
              pluginStore.loadPlugins(),
            ]);
            console.log('✅ Reinitialized app after login');
          } catch (error) {
            console.error('Failed to reinitialize app after login:', error);
          }
        }, 100);
      },

      logout: () => {
        // Remove token from localStorage
        localStorage.removeItem('auth-token');

        // Disconnect WebSocket to clear authentication
        console.log('🔌 Disconnecting WebSocket on logout...');
        websocketService.disconnect();

        // Clear chat store state when logging out
        const chatStore = useChatStore.getState();
        if (chatStore.clearAllState) {
          chatStore.clearAllState();
        }

        // Clear app store user-specific state (background, preferences)
        const appStore = useAppStore.getState();
        appStore.clearUserState();

        set({
          user: null,
          token: null,
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
    }),
    {
      name: 'auth-store',
      partialize: state => ({
        user: state.user,
        token: state.token,
        systemInfo: state.systemInfo,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
