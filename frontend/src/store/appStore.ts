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
import { UserPreferences, Theme } from '@/types';
import { isDemoMode, getDemoConfig } from '@/utils/demoMode';

interface AppState {
  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  // Sidebar
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;

  // User preferences
  preferences: UserPreferences;
  setPreferences: (preferences: Partial<UserPreferences>) => void;
  loadPreferences: () => Promise<void>;

  // UI state
  isGenerating: boolean;
  setIsGenerating: (generating: boolean) => void;

  // Settings notification
  hasSeenSettingsNotification: boolean;
  markSettingsNotificationAsSeen: () => void;

  // Demo mode
  isDemoMode: boolean;
  demoConfig: ReturnType<typeof getDemoConfig>;
  setDemoMode: (isDemo: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: { mode: 'light' },
      setTheme: theme => {
        set({ theme });
        // Apply theme to document
        if (theme.mode === 'dark') {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      },
      toggleTheme: () => {
        const currentTheme = get().theme;
        const newMode = currentTheme.mode === 'light' ? 'dark' : 'light';
        get().setTheme({ mode: newMode });
      },

      // Sidebar
      sidebarOpen: true,
      setSidebarOpen: open => set({ sidebarOpen: open }),
      toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),

      // User preferences
      preferences: {
        theme: { mode: 'light' },
        defaultModel: '',
        systemMessage: '',
        generationOptions: {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          num_predict: 1024,
        },
        embeddingSettings: {
          enabled: false,
          model: 'nomic-embed-text',
          chunkSize: 1000,
          chunkOverlap: 200,
          similarityThreshold: 0.7,
        },
      },
      setPreferences: newPreferences =>
        set(state => ({
          preferences: { ...state.preferences, ...newPreferences },
        })),

      loadPreferences: async () => {
        try {
          const { preferencesApi } = await import('@/utils/api');
          const response = await preferencesApi.getPreferences();
          if (response.success && response.data) {
            set(state => ({
              preferences: { ...state.preferences, ...response.data },
            }));
          }
        } catch (error: unknown) {
          console.warn('Failed to load preferences from backend:', error);
        }
      },

      // UI state
      isGenerating: false,
      setIsGenerating: generating => set({ isGenerating: generating }),

      // Settings notification
      hasSeenSettingsNotification: false,
      markSettingsNotificationAsSeen: () =>
        set({ hasSeenSettingsNotification: true }),

      // Demo mode
      isDemoMode: isDemoMode(),
      demoConfig: getDemoConfig(),
      setDemoMode: isDemo => {
        set({
          isDemoMode: isDemo,
          demoConfig: getDemoConfig(),
        });
      },
    }),
    {
      name: 'libre-webui-app-state',
      partialize: state => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        preferences: state.preferences,
        hasSeenSettingsNotification: state.hasSeenSettingsNotification,
        // Note: We don't persist isDemoMode as it should be detected on each app load
      }),
    }
  )
);

// Initialize theme on app start
const initializeTheme = () => {
  const { theme, setTheme } = useAppStore.getState();
  setTheme(theme);
};

// Call on module load
if (typeof window !== 'undefined') {
  initializeTheme();
}
