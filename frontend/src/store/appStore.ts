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
import { UserPreferences, Theme, Artifact } from '@/types';
import { isDemoMode, getDemoConfig } from '@/utils/demoMode';
import {
  applyThemeToDocument,
  createDefaultTheme,
  normalizeTheme,
} from '@/utils/theme';
import { createLogger } from '@/utils/logger';

const logger = createLogger('store:app-store');
const THEME_SYNC_DELAY_MS = 250;
let themeSyncTimeout: ReturnType<typeof setTimeout> | null = null;

interface AppState {
  // Theme
  theme: Theme;
  themeSyncPending: boolean;
  setTheme: (theme: Theme) => void;
  syncThemePreference: (theme: Theme) => Promise<void>;
  scheduleThemePreferenceSync: () => void;
  updateTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  // Sidebar
  sidebarOpen: boolean;
  sidebarCompact: boolean;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCompact: (compact: boolean) => void;
  toggleSidebar: () => void;
  toggleSidebarCompact: () => void;

  // Artifact Panel
  artifactPanelOpen: boolean;
  artifactPanelArtifact: Artifact | null;
  openArtifactPanel: (artifact: Artifact) => void;
  closeArtifactPanel: () => void;

  // User preferences
  preferences: UserPreferences;
  setPreferences: (preferences: Partial<UserPreferences>) => void;
  loadPreferences: () => Promise<void>;

  // Background settings
  backgroundImage: string | null;
  setBackgroundImage: (imageUrl: string | null) => Promise<void>;
  uploadBackgroundImage: (file: File) => Promise<void>;
  removeBackgroundImage: () => void;

  // Clear user-specific state (called on logout/login)
  clearUserState: () => void;

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
      theme: createDefaultTheme(),
      themeSyncPending: false,
      syncThemePreference: async theme => {
        if (themeSyncTimeout) {
          clearTimeout(themeSyncTimeout);
          themeSyncTimeout = null;
        }

        if (!isDemoMode() && !localStorage.getItem('auth-token')) {
          return;
        }

        try {
          const { preferencesApi } = await import('@/utils/api');
          const response = await preferencesApi.updatePreferences({ theme });

          if (!response.success) {
            logger.warn('Failed to save theme preference to backend');
            return;
          }

          const currentTheme = normalizeTheme(get().theme);
          const savedTheme = normalizeTheme(theme);
          const isCurrentTheme =
            currentTheme.mode === savedTheme.mode &&
            currentTheme.adaptToAccent === savedTheme.adaptToAccent &&
            currentTheme.accent === savedTheme.accent &&
            currentTheme.customAccent === savedTheme.customAccent;

          if (isCurrentTheme) {
            set({ themeSyncPending: false });
          } else {
            // A newer selection won the UI race; save it again so an older
            // response cannot leave the backend with the wrong theme.
            set({ themeSyncPending: true });
            get().scheduleThemePreferenceSync();
          }
        } catch (error: unknown) {
          logger.warn('Failed to save theme preference to backend:', error);
        }
      },
      scheduleThemePreferenceSync: () => {
        if (themeSyncTimeout) {
          clearTimeout(themeSyncTimeout);
        }

        themeSyncTimeout = setTimeout(() => {
          themeSyncTimeout = null;
          void get().syncThemePreference(normalizeTheme(get().theme));
        }, THEME_SYNC_DELAY_MS);
      },
      setTheme: theme => {
        const nextTheme = normalizeTheme(theme);
        set(state => ({
          theme: nextTheme,
          preferences: {
            ...state.preferences,
            theme: nextTheme,
          },
        }));
        applyThemeToDocument(nextTheme);
      },
      updateTheme: theme => {
        const nextTheme = normalizeTheme(theme);
        get().setTheme(nextTheme);
        set({ themeSyncPending: true });
        get().scheduleThemePreferenceSync();
      },
      toggleTheme: () => {
        const currentTheme = get().theme;
        const nextMode = currentTheme.mode === 'dark' ? 'light' : 'dark';
        get().updateTheme({ ...currentTheme, mode: nextMode });
      },

      // Sidebar
      sidebarOpen: true,
      sidebarCompact: false,
      setSidebarOpen: open => set({ sidebarOpen: open }),
      setSidebarCompact: compact => set({ sidebarCompact: compact }),
      toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
      toggleSidebarCompact: () =>
        set(state => ({ sidebarCompact: !state.sidebarCompact })),

      // Artifact Panel
      artifactPanelOpen: false,
      artifactPanelArtifact: null,
      openArtifactPanel: artifact =>
        set({ artifactPanelOpen: true, artifactPanelArtifact: artifact }),
      closeArtifactPanel: () =>
        set({ artifactPanelOpen: false, artifactPanelArtifact: null }),

      // User preferences
      preferences: {
        theme: createDefaultTheme(),
        defaultModel: '',
        defaultProviderType: null,
        defaultProviderId: null,
        visionModel: '',
        visionProviderType: null,
        visionProviderId: null,
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
          similarityThreshold: 0.3,
        },
        titleSettings: {
          autoTitle: false,
          taskModel: '',
          taskProviderType: null,
          taskProviderId: null,
        },
        showUsername: false, // Default to showing "you" instead of username
        workRemoteProviderDisclosureDismissed: false,
        backgroundSettings: {
          enabled: false,
          imageUrl: '',
          blurAmount: 10,
          opacity: 0.6,
        },
      },
      setPreferences: newPreferences => {
        const nextTheme = newPreferences.theme
          ? normalizeTheme(newPreferences.theme)
          : null;

        set(state => ({
          ...(nextTheme && { theme: nextTheme }),
          preferences: {
            ...state.preferences,
            ...newPreferences,
            ...(nextTheme && { theme: nextTheme }),
          },
        }));

        if (nextTheme) {
          applyThemeToDocument(nextTheme);
        }
      },

      loadPreferences: async () => {
        try {
          const { preferencesApi } = await import('@/utils/api');
          const response = await preferencesApi.getPreferences();
          if (response.success && response.data) {
            const data = response.data;
            const pendingTheme = get().themeSyncPending
              ? normalizeTheme(get().theme)
              : null;

            get().setPreferences(
              pendingTheme ? { ...data, theme: pendingTheme } : data
            );
            // Restore background image from backend preferences
            set({
              backgroundImage: data.backgroundSettings?.imageUrl || null,
            });

            if (pendingTheme) {
              void get().syncThemePreference(pendingTheme);
            }
          }
        } catch (error: unknown) {
          logger.warn('Failed to load preferences from backend:', error);
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

      // Background settings
      backgroundImage: null,
      setBackgroundImage: async imageUrl => {
        set({ backgroundImage: imageUrl });

        // Only update backend when setting a new image (not when clearing)
        // Clearing is used for temporary persona overlays and shouldn't persist
        if (imageUrl) {
          // Update preferences locally
          const state = get();
          const updatedPreferences = {
            ...state.preferences,
            backgroundSettings: {
              enabled: true,
              imageUrl: imageUrl,
              blurAmount:
                state.preferences.backgroundSettings?.blurAmount || 10,
              opacity: state.preferences.backgroundSettings?.opacity || 0.6,
            },
          };
          state.setPreferences(updatedPreferences);

          // Save to backend for persistence
          try {
            const { preferencesApi } = await import('@/utils/api');
            await preferencesApi.updatePreferences({
              backgroundSettings: updatedPreferences.backgroundSettings,
            });
          } catch (error) {
            logger.warn(
              'Failed to save background settings to backend:',
              error
            );
          }
        }
        // When imageUrl is null, just clear the visual state without persisting
        // The user's saved background from preferences.backgroundSettings will show through
      },
      uploadBackgroundImage: async (file: File) => {
        try {
          // Create a file reader to convert to base64
          const reader = new FileReader();
          return new Promise((resolve, reject) => {
            reader.onload = async e => {
              try {
                const dataUrl = e.target?.result as string;
                const state = get();
                // Await the setBackgroundImage to ensure backend save completes
                await state.setBackgroundImage(dataUrl);
                resolve();
              } catch (error) {
                reject(error);
              }
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
        } catch (error) {
          logger.error('Failed to upload background image:', error);
          throw error;
        }
      },
      removeBackgroundImage: async () => {
        set({ backgroundImage: null });

        // Update preferences locally to disable background
        const state = get();
        const updatedBackgroundSettings = {
          enabled: false,
          imageUrl: '',
          blurAmount: state.preferences.backgroundSettings?.blurAmount || 10,
          opacity: state.preferences.backgroundSettings?.opacity || 0.6,
        };
        state.setPreferences({
          backgroundSettings: updatedBackgroundSettings,
        });

        // Save to backend to persist the removal
        try {
          const { preferencesApi } = await import('@/utils/api');
          await preferencesApi.updatePreferences({
            backgroundSettings: updatedBackgroundSettings,
          });
        } catch (error) {
          logger.warn('Failed to save background removal to backend:', error);
        }
      },

      // Clear user-specific state (called on logout/login to prevent data leaking between users)
      clearUserState: () => {
        const defaultTheme = createDefaultTheme();

        if (themeSyncTimeout) {
          clearTimeout(themeSyncTimeout);
          themeSyncTimeout = null;
        }

        set({
          theme: defaultTheme,
          themeSyncPending: false,
          backgroundImage: null,
          preferences: {
            theme: defaultTheme,
            defaultModel: '',
            defaultProviderType: null,
            defaultProviderId: null,
            visionModel: '',
            visionProviderType: null,
            visionProviderId: null,
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
              similarityThreshold: 0.3,
            },
            titleSettings: {
              autoTitle: false,
              taskModel: '',
              taskProviderType: null,
              taskProviderId: null,
            },
            showUsername: false,
            workRemoteProviderDisclosureDismissed: false,
            backgroundSettings: {
              enabled: false,
              imageUrl: '',
              blurAmount: 10,
              opacity: 0.6,
            },
          },
        });
        applyThemeToDocument(defaultTheme);
      },
    }),
    {
      name: 'libre-webui-app-state',
      onRehydrateStorage: () => state => {
        if (state) {
          state.setTheme(normalizeTheme(state.theme));
        }
      },
      partialize: state => {
        // Exclude backgroundSettings from persisted preferences to avoid overwriting backend data
        const { backgroundSettings: _, ...preferencesWithoutBackground } =
          state.preferences;
        return {
          theme: state.theme,
          themeSyncPending: state.themeSyncPending,
          sidebarOpen: state.sidebarOpen,
          sidebarCompact: state.sidebarCompact,
          preferences: preferencesWithoutBackground,
          hasSeenSettingsNotification: state.hasSeenSettingsNotification,
          // Note: backgroundImage and backgroundSettings are stored in backend preferences, not localStorage
          // This avoids the ~5MB localStorage size limit for base64 images
          // Note: We don't persist isDemoMode as it should be detected on each app load
        };
      },
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
