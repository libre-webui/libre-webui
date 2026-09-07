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
  cacheInstanceTheme,
  createDefaultTheme,
  createInstanceDefaultTheme,
  getNextThemeMode,
  normalizeTheme,
} from '@/utils/theme';
import { createLogger } from '@/utils/logger';
import {
  DEFAULT_BACKGROUND_SETTINGS,
  normalizeBackgroundSettings,
  type NormalizedBackgroundSettings,
} from '@/utils/backgroundSettings';

const logger = createLogger('store:app-store');
const THEME_SYNC_DELAY_MS = 250;
const BACKGROUND_SYNC_DELAY_MS = 250;
let themeSyncTimeout: ReturnType<typeof setTimeout> | null = null;

interface AppState {
  // Theme
  theme: Theme;
  themeSyncPending: boolean;
  /**
   * 'default' until this browser (or the signed-in account) picks a theme.
   * While it is 'default', the administrator's instance-wide theme applies.
   */
  themeSource: 'default' | 'user';
  setTheme: (theme: Theme) => void;
  applyInstanceTheme: (theme: Theme | null | undefined) => void;
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
  // Width is shared with the shell layout, which reserves the same space so
  // the chat splits beside the panel instead of sliding under it.
  artifactPanelWidth: number;
  artifactPanelResizing: boolean;
  openArtifactPanel: (artifact: Artifact) => void;
  closeArtifactPanel: () => void;
  setArtifactPanelWidth: (width: number) => void;
  setArtifactPanelResizing: (resizing: boolean) => void;

  // User preferences
  preferences: UserPreferences;
  // Wallpaper changes use the dedicated actions and guarded loader below.
  setPreferences: (preferences: Partial<UserPreferences>) => void;
  loadPreferences: () => Promise<void>;

  // Background settings
  backgroundImage: string | null;
  setBackgroundImage: (imageUrl: string | null) => Promise<void>;
  updateBackgroundSettings: (
    updates: Partial<NonNullable<UserPreferences['backgroundSettings']>>
  ) => Promise<void>;
  uploadBackgroundImage: (file: File) => Promise<void>;
  removeBackgroundImage: () => Promise<void>;

  // Clear user-specific state (called on logout/login)
  clearUserState: () => void;

  // UI state
  isGenerating: boolean;
  setIsGenerating: (generating: boolean) => void;

  // Admin shortcuts pinned into the sidebar footer (ids: users, system, usage)
  pinnedAdminShortcuts: string[];
  toggleAdminShortcut: (id: string) => void;

  // Settings notification
  hasSeenSettingsNotification: boolean;
  markSettingsNotificationAsSeen: () => void;

  // Demo mode
  isDemoMode: boolean;
  demoConfig: ReturnType<typeof getDemoConfig>;
  setDemoMode: (isDemo: boolean) => void;
}

let accountEpoch = 0;
let preferencesSequence = 0;
let backgroundRevision = 0;
let confirmedRevision = 0;
let confirmedBackground = { ...DEFAULT_BACKGROUND_SETTINGS };
let uploadSequence = 0;
let uploadReader: FileReader | null = null;
let cancelUploadDecode: (() => void) | null = null;
let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
type Scope = { epoch: number; token: string | null };
type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type BackgroundBatch = {
  scope: Scope;
  revision: number;
  settings: NormalizedBackgroundSettings;
  waiters: Waiter[];
};
let pendingBackground: BackgroundBatch | null = null;
let savingBackground: BackgroundBatch | null = null;
const token = () =>
  typeof localStorage === 'undefined'
    ? null
    : localStorage.getItem('auth-token');
const scope = (): Scope => ({ epoch: accountEpoch, token: token() });
const isCurrentScope = (owner: Scope) =>
  owner.epoch === accountEpoch && owner.token === token();
const cancelled = () =>
  new DOMException('Wallpaper operation superseded', 'AbortError');
const invalidateUpload = () => {
  uploadSequence += 1;
  uploadReader?.abort();
  uploadReader = null;
  cancelUploadDecode?.();
  cancelUploadDecode = null;
};
const applyBackground = (settings: NormalizedBackgroundSettings) =>
  useAppStore.setState(state => ({
    backgroundImage: settings.imageUrl || null,
    preferences: { ...state.preferences, backgroundSettings: settings },
  }));
const settleBatch = (batch: BackgroundBatch, error?: unknown) => {
  const waiters = batch.waiters.splice(0);
  for (const waiter of waiters) {
    if (error) waiter.reject(error);
    else waiter.resolve();
  }
};
const cancelBackgroundWork = () => {
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = null;
  if (pendingBackground) settleBatch(pendingBackground, cancelled());
  if (savingBackground) settleBatch(savingBackground, cancelled());
  pendingBackground = null;
  savingBackground = null;
  invalidateUpload();
};
const flushBackground = async () => {
  if (savingBackground || !pendingBackground) return;
  const batch = pendingBackground;
  pendingBackground = null;
  savingBackground = batch;
  try {
    const { preferencesApi } = await import('@/utils/api');
    // The API client chooses credentials at dispatch time. Recheck after
    // loading it so an old operation cannot be sent as a new account.
    if (!isCurrentScope(batch.scope)) throw cancelled();
    const response = await preferencesApi.updatePreferences({
      backgroundSettings: batch.settings,
    });
    if (!isCurrentScope(batch.scope)) throw cancelled();
    if (!response.success) {
      throw new Error(response.error || 'Failed to save wallpaper');
    }
    if (batch.revision >= confirmedRevision) {
      confirmedBackground = batch.settings;
      confirmedRevision = batch.revision;
    }
    settleBatch(batch);
  } catch (error) {
    if (
      isCurrentScope(batch.scope) &&
      batch.revision === backgroundRevision &&
      !pendingBackground
    ) {
      applyBackground(confirmedBackground);
    }
    settleBatch(batch, error);
  } finally {
    // An old account's request may finish after reset. It must not
    // release the new account's queue or restore any of its data.
    if (savingBackground === batch) {
      savingBackground = null;
      if (pendingBackground && !backgroundTimer) void flushBackground();
    }
  }
};
const scheduleBackground = () => {
  if (backgroundTimer) clearTimeout(backgroundTimer);
  backgroundTimer = setTimeout(() => {
    backgroundTimer = null;
    void flushBackground();
  }, BACKGROUND_SYNC_DELAY_MS);
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Theme
      theme: createInstanceDefaultTheme(),
      themeSyncPending: false,
      themeSource: 'default',
      applyInstanceTheme: theme => {
        if (!theme) return;
        const instanceTheme = normalizeTheme(theme);
        cacheInstanceTheme(instanceTheme);
        if (get().themeSource === 'user') return;
        get().setTheme(instanceTheme);
      },
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
        set({ themeSyncPending: true, themeSource: 'user' });
        get().scheduleThemePreferenceSync();
      },
      toggleTheme: () => {
        const currentTheme = get().theme;
        get().updateTheme({
          ...currentTheme,
          mode: getNextThemeMode(currentTheme.mode),
        });
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
      artifactPanelWidth: 600,
      artifactPanelResizing: false,
      openArtifactPanel: artifact =>
        set({ artifactPanelOpen: true, artifactPanelArtifact: artifact }),
      closeArtifactPanel: () =>
        set({ artifactPanelOpen: false, artifactPanelArtifact: null }),
      setArtifactPanelWidth: width => set({ artifactPanelWidth: width }),
      setArtifactPanelResizing: resizing =>
        set({ artifactPanelResizing: resizing }),

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
        hapticFeedbackEnabled: false,
        workRemoteProviderDisclosureDismissed: false,
        backgroundSettings: { ...DEFAULT_BACKGROUND_SETTINGS },
      },
      setPreferences: newPreferences => {
        // Unrelated saves return whole preference snapshots. Their wallpaper
        // can be stale or belong to an account that has since signed out.
        // Only loadPreferences and the wallpaper queue may adopt that field.
        const { backgroundSettings: _background, ...updates } = newPreferences;
        const nextTheme = updates.theme ? normalizeTheme(updates.theme) : null;

        set(state => ({
          // A theme from the account's saved preferences is the user's own
          // choice, so the instance default stops applying on this browser.
          ...(nextTheme && {
            theme: nextTheme,
            themeSource: 'user' as const,
          }),
          preferences: {
            ...state.preferences,
            ...updates,
            ...(nextTheme && { theme: nextTheme }),
          },
        }));

        if (nextTheme) {
          applyThemeToDocument(nextTheme);
        }
      },

      loadPreferences: async () => {
        const owner = scope();
        const sequence = ++preferencesSequence;
        const revision = backgroundRevision;
        const backgroundWasPending = Boolean(
          pendingBackground || savingBackground
        );
        try {
          const { preferencesApi } = await import('@/utils/api');
          if (!isCurrentScope(owner)) return;
          const response = await preferencesApi.getPreferences();
          if (!isCurrentScope(owner) || sequence !== preferencesSequence)
            return;
          if (response.success && response.data) {
            const data = { ...response.data };
            // A slow initialization read cannot undo a wallpaper edit, clear,
            // or replacement made while the request was in flight.
            if (
              !backgroundWasPending &&
              revision === backgroundRevision &&
              !pendingBackground &&
              !savingBackground
            ) {
              const backgroundSettings = normalizeBackgroundSettings(
                data.backgroundSettings
              );
              confirmedBackground = backgroundSettings;
              confirmedRevision = ++backgroundRevision;
              applyBackground(backgroundSettings);
            }
            const pendingTheme = get().themeSyncPending
              ? normalizeTheme(get().theme)
              : null;
            get().setPreferences(
              pendingTheme ? { ...data, theme: pendingTheme } : data
            );
            if (pendingTheme) void get().syncThemePreference(pendingTheme);
          }
        } catch (error: unknown) {
          if (isCurrentScope(owner)) {
            logger.warn('Failed to load preferences from backend:', error);
          }
        }
      },

      // UI state
      isGenerating: false,
      setIsGenerating: generating => set({ isGenerating: generating }),

      pinnedAdminShortcuts: [],
      toggleAdminShortcut: id =>
        set(state => ({
          pinnedAdminShortcuts: state.pinnedAdminShortcuts.includes(id)
            ? state.pinnedAdminShortcuts.filter(pinned => pinned !== id)
            : [...state.pinnedAdminShortcuts, id],
        })),

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
      updateBackgroundSettings: updates => {
        if ('imageUrl' in updates || updates.enabled === false) {
          invalidateUpload();
        }
        const settings = normalizeBackgroundSettings({
          ...get().preferences.backgroundSettings,
          ...updates,
        });
        const owner = scope();
        const revision = ++backgroundRevision;
        applyBackground(settings);
        return new Promise<void>((resolve, reject) => {
          const waiters =
            pendingBackground && isCurrentScope(pendingBackground.scope)
              ? pendingBackground.waiters
              : [];
          if (pendingBackground && waiters !== pendingBackground.waiters) {
            settleBatch(pendingBackground, cancelled());
          }
          pendingBackground = {
            scope: owner,
            revision,
            settings,
            waiters: [...waiters, { resolve, reject }],
          };
          scheduleBackground();
        });
      },
      setBackgroundImage: imageUrl =>
        get().updateBackgroundSettings({
          imageUrl: imageUrl || '',
          enabled: Boolean(imageUrl),
        }),
      uploadBackgroundImage: file => {
        invalidateUpload();
        const owner = scope();
        const sequence = uploadSequence;
        const reader = new FileReader();
        uploadReader = reader;
        return new Promise<void>((resolve, reject) => {
          reader.onabort = () => reject(cancelled());
          reader.onerror = () => {
            if (uploadReader === reader) uploadReader = null;
            reject(reader.error || new Error('Failed to read wallpaper'));
          };
          reader.onload = async () => {
            if (uploadReader === reader) uploadReader = null;
            if (!isCurrentScope(owner) || sequence !== uploadSequence) {
              reject(cancelled());
              return;
            }
            const imageUrl = reader.result;
            if (typeof imageUrl !== 'string') {
              reject(new Error('Failed to read wallpaper'));
              return;
            }
            try {
              // A MIME label or extension does not prove the file is an image.
              // Decode before changing the preview or persisted source, while
              // retaining the same account and upload revision through both
              // asynchronous stages.
              await new Promise<void>((decoded, failed) => {
                const image = new Image();
                let settled = false;
                const finish = (error?: Error) => {
                  if (settled) return;
                  settled = true;
                  image.onload = null;
                  image.onerror = null;
                  if (cancelUploadDecode === cancel) cancelUploadDecode = null;
                  image.src = '';
                  if (error) failed(error);
                  else decoded();
                };
                const cancel = () => finish(cancelled());
                cancelUploadDecode = cancel;
                image.onload = () =>
                  finish(
                    image.naturalWidth > 0 && image.naturalHeight > 0
                      ? undefined
                      : new Error('Wallpaper file is not a valid image')
                  );
                image.onerror = () =>
                  finish(new Error('Wallpaper file is not a valid image'));
                image.src = imageUrl;
              });
              if (!isCurrentScope(owner) || sequence !== uploadSequence) {
                throw cancelled();
              }
              await get().setBackgroundImage(imageUrl);
              if (
                !isCurrentScope(owner) ||
                get().preferences.backgroundSettings?.imageUrl !== imageUrl
              ) {
                throw cancelled();
              }
              resolve();
            } catch (error) {
              reject(error);
            }
          };
          reader.readAsDataURL(file);
        });
      },
      removeBackgroundImage: () =>
        get().updateBackgroundSettings({ enabled: false, imageUrl: '' }),

      // Clear user-specific state (called on logout/login to prevent data leaking between users)
      clearUserState: () => {
        accountEpoch += 1;
        preferencesSequence += 1;
        backgroundRevision += 1;
        confirmedRevision = backgroundRevision;
        confirmedBackground = { ...DEFAULT_BACKGROUND_SETTINGS };
        cancelBackgroundWork();
        const defaultTheme = createInstanceDefaultTheme();

        if (themeSyncTimeout) {
          clearTimeout(themeSyncTimeout);
          themeSyncTimeout = null;
        }

        set({
          theme: defaultTheme,
          themeSyncPending: false,
          themeSource: 'default',
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
            backgroundSettings: { ...DEFAULT_BACKGROUND_SETTINGS },
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
          themeSource: state.themeSource,
          sidebarOpen: state.sidebarOpen,
          sidebarCompact: state.sidebarCompact,
          artifactPanelWidth: state.artifactPanelWidth,
          pinnedAdminShortcuts: state.pinnedAdminShortcuts,
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
