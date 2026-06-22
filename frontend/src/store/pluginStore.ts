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
import { Plugin, PluginStatus } from '@/types';
import { pluginApi, PluginVariableValue } from '@/utils/api';
import { createLogger } from '@/utils/logger';

const logger = createLogger('store:plugin-store');

interface PluginState {
  // Plugin data
  plugins: Plugin[];
  pluginStatus: PluginStatus[];

  // Loading states
  isLoading: boolean;
  isUploading: boolean;

  // Plugin variables (valves)
  pluginVariables: Record<string, Record<string, PluginVariableValue>>;

  // Error state
  error: string | null;

  // Actions
  loadPlugins: () => Promise<void>;
  uploadPlugin: (file: File) => Promise<void>;
  installPlugin: (pluginData: Plugin) => Promise<void>;
  updatePlugin: (id: string, pluginData: Plugin) => Promise<void>;
  deletePlugin: (id: string) => Promise<void>;
  activatePlugin: (id: string) => Promise<void>;
  deactivatePlugin: (id?: string) => Promise<void>;
  loadPluginStatus: () => Promise<void>;
  exportPlugin: (id: string) => Promise<void>;

  // Variable actions
  fetchPluginVariables: (pluginId: string) => Promise<void>;
  updatePluginVariables: (
    pluginId: string,
    variables: Record<string, string | number | boolean>
  ) => Promise<boolean>;
  resetPluginVariables: (pluginId: string) => Promise<void>;

  // UI state
  clearError: () => void;
  setError: (error: string) => void;
}

export const usePluginStore = create<PluginState>((set, get) => ({
  // Initial state
  plugins: [],
  pluginStatus: [],
  pluginVariables: {},
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
          error instanceof Error ? error.message : 'Failed to upload plugin',
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
          error instanceof Error ? error.message : 'Failed to install plugin',
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
          error instanceof Error ? error.message : 'Failed to update plugin',
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
        // Refresh plugins list
        await get().loadPlugins();
      } else {
        set({ error: response.error || 'Failed to delete plugin' });
      }
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : 'Failed to delete plugin',
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
        // Refresh plugins list
        await get().loadPlugins();
      } else {
        set({ error: response.error || 'Failed to activate plugin' });
      }
    } catch (error) {
      set({
        error:
          error instanceof Error ? error.message : 'Failed to activate plugin',
      });
    } finally {
      set({ isLoading: false });
    }
  },

  deactivatePlugin: async (id?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await pluginApi.deactivatePlugin(id);
      if (response.success) {
        // Refresh plugins list
        await get().loadPlugins();
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

  loadPluginStatus: async () => {
    try {
      const response = await pluginApi.getPluginStatus();
      if (response.success && response.data) {
        set({ pluginStatus: response.data });
      }
    } catch (error) {
      logger.error('Failed to load plugin status:', error);
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
          error instanceof Error ? error.message : 'Failed to export plugin',
      });
    } finally {
      set({ isLoading: false });
    }
  },

  // Variable actions
  fetchPluginVariables: async (pluginId: string) => {
    try {
      const response = await pluginApi.getVariables(pluginId);
      if (response.success && response.data) {
        set(state => ({
          pluginVariables: {
            ...state.pluginVariables,
            [pluginId]: response.data!,
          },
        }));
      }
    } catch (error) {
      logger.error('Failed to fetch plugin variables:', error);
    }
  },

  updatePluginVariables: async (
    pluginId: string,
    variables: Record<string, string | number | boolean>
  ): Promise<boolean> => {
    try {
      const response = await pluginApi.setVariables(pluginId, variables);
      if (response.success) {
        await get().fetchPluginVariables(pluginId);
        return true;
      }
      return false;
    } catch (error) {
      logger.error('Failed to update plugin variables:', error);
      return false;
    }
  },

  resetPluginVariables: async (pluginId: string) => {
    try {
      const response = await pluginApi.resetVariables(pluginId);
      if (response.success) {
        set(state => {
          const newVars = { ...state.pluginVariables };
          delete newVars[pluginId];
          return { pluginVariables: newVars };
        });
      }
    } catch (error) {
      logger.error('Failed to reset plugin variables:', error);
    }
  },

  // UI helpers
  clearError: () => set({ error: null }),
  setError: (error: string) => set({ error }),
}));
