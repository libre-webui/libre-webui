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
import { Plugin, PluginStatus } from '@/types';
import { pluginApi } from '@/utils/api';

interface PluginState {
  // Plugin data
  plugins: Plugin[];
  activePlugin: Plugin | null;
  pluginStatus: PluginStatus[];

  // Loading states
  isLoading: boolean;
  isUploading: boolean;

  // Error state
  error: string | null;

  // Actions
  loadPlugins: () => Promise<void>;
  uploadPlugin: (file: File) => Promise<void>;
  installPlugin: (pluginData: Plugin) => Promise<void>;
  updatePlugin: (id: string, pluginData: Plugin) => Promise<void>;
  deletePlugin: (id: string) => Promise<void>;
  activatePlugin: (id: string) => Promise<void>;
  deactivatePlugin: () => Promise<void>;
  loadActivePlugin: () => Promise<void>;
  loadPluginStatus: () => Promise<void>;
  exportPlugin: (id: string) => Promise<void>;

  // UI state
  clearError: () => void;
  setError: (error: string) => void;
}

export const usePluginStore = create<PluginState>()(
  persist(
    (set, get) => ({
      // Initial state
      plugins: [],
      activePlugin: null,
      pluginStatus: [],
      isLoading: false,
      isUploading: false,
      error: null,

      // Actions
      loadPlugins: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await pluginApi.getAllPlugins();
          if (response.success && response.data) {
            set({ plugins: response.data });
          } else {
            set({ error: response.error || 'Failed to load plugins' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error ? error.message : 'Failed to load plugins',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      uploadPlugin: async (file: File) => {
        set({ isUploading: true, error: null });
        try {
          const response = await pluginApi.uploadPlugin(file);
          if (response.success && response.data) {
            // Refresh plugins list
            await get().loadPlugins();
          } else {
            set({ error: response.error || 'Failed to upload plugin' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to upload plugin',
          });
        } finally {
          set({ isUploading: false });
        }
      },

      installPlugin: async (pluginData: Plugin) => {
        set({ isLoading: true, error: null });
        try {
          const response = await pluginApi.installPlugin(pluginData);
          if (response.success && response.data) {
            // Refresh plugins list
            await get().loadPlugins();
          } else {
            set({ error: response.error || 'Failed to install plugin' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to install plugin',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      updatePlugin: async (id: string, pluginData: Plugin) => {
        set({ isLoading: true, error: null });
        try {
          const response = await pluginApi.updatePlugin(id, pluginData);
          if (response.success && response.data) {
            // Refresh plugins list
            await get().loadPlugins();
          } else {
            set({ error: response.error || 'Failed to update plugin' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to update plugin',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      deletePlugin: async (id: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await pluginApi.deletePlugin(id);
          if (response.success) {
            // Refresh plugins list and active plugin
            await Promise.all([get().loadPlugins(), get().loadActivePlugin()]);
          } else {
            set({ error: response.error || 'Failed to delete plugin' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to delete plugin',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      activatePlugin: async (id: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await pluginApi.activatePlugin(id);
          if (response.success) {
            // Refresh plugins list and active plugin
            await Promise.all([get().loadPlugins(), get().loadActivePlugin()]);
          } else {
            set({ error: response.error || 'Failed to activate plugin' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to activate plugin',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      deactivatePlugin: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await pluginApi.deactivatePlugin();
          if (response.success) {
            // Refresh plugins list and active plugin
            await Promise.all([get().loadPlugins(), get().loadActivePlugin()]);
          } else {
            set({ error: response.error || 'Failed to deactivate plugin' });
          }
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to deactivate plugin',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      loadActivePlugin: async () => {
        try {
          const response = await pluginApi.getActivePlugin();
          if (response.success) {
            set({ activePlugin: response.data || null });
          }
        } catch (error) {
          console.error('Failed to load active plugin:', error);
        }
      },

      loadPluginStatus: async () => {
        try {
          const response = await pluginApi.getPluginStatus();
          if (response.success && response.data) {
            set({ pluginStatus: response.data });
          }
        } catch (error) {
          console.error('Failed to load plugin status:', error);
        }
      },

      exportPlugin: async (id: string) => {
        set({ isLoading: true, error: null });
        try {
          const blob = await pluginApi.exportPlugin(id);

          // Create download link
          const url = window.URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${id}.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          window.URL.revokeObjectURL(url);
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : 'Failed to export plugin',
          });
        } finally {
          set({ isLoading: false });
        }
      },

      // UI helpers
      clearError: () => set({ error: null }),
      setError: (error: string) => set({ error }),
    }),
    {
      name: 'plugin-store',
      partialize: state => ({
        // Only persist active plugin ID, not the full plugin data
        activePluginId: state.activePlugin?.id || null,
      }),
    }
  )
);
