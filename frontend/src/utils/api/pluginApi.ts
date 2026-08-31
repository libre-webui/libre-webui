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

import type { ApiResponse, Plugin, PluginStatus } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import type { PluginVariableInput } from '@/utils/pluginVariableOverrides';
import { api, createDemoResponse } from './client';

export interface PluginVariableValue {
  name: string;
  value: string | number | boolean;
  is_sensitive: boolean;
  has_value: boolean;
}

export type PluginModelDiscoveryOutcome =
  'updated' | 'unchanged' | 'missing_credentials' | 'unavailable';

export interface PluginModelDiscoveryResult {
  models: string[];
  outcome: PluginModelDiscoveryOutcome;
  reason?: string;
}

export interface PluginUsageAnalytics {
  range: { from: number; to: number; days: number };
  totals: {
    calls: number;
    successfulCalls: number;
    failedCalls: number;
    cancelledCalls: number;
    meteredCalls: number;
    promptTokens: number;
    completionTokens: number;
    reportedTokens: number;
    averageLatencyMs: number;
    uniqueUsers: number;
  };
  series: Array<{
    timestamp: number;
    calls: number;
    tokens: number;
    errors: number;
  }>;
  plugins: Array<{
    pluginId: string;
    pluginName: string;
    calls: number;
    tokens: number;
    errors: number;
    averageLatencyMs: number;
  }>;
  models: Array<{
    model: string;
    pluginId: string;
    pluginName: string;
    calls: number;
    tokens: number;
    errors: number;
    averageLatencyMs: number;
  }>;
  capabilities: Array<{
    capability:
      'chat' | 'embedding' | 'image' | 'stt' | 'tts' | 'audio' | 'video';
    calls: number;
    tokens: number;
    inputUnits: number;
    outputUnits: number;
  }>;
  heatmap?: {
    from: number;
    days: number;
    models: string[];
    cells: Array<{
      timestamp: number;
      calls: number;
      models: Array<{ model: string; calls: number }>;
    }>;
  };
}

const emptyUsageAnalytics = (days: number): PluginUsageAnalytics => {
  const to = Date.now();
  const from = to - Math.max(0, days - 1) * 86_400_000;
  return {
    range: { from, to, days },
    totals: {
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      cancelledCalls: 0,
      meteredCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      reportedTokens: 0,
      averageLatencyMs: 0,
      uniqueUsers: 0,
    },
    series: [],
    plugins: [],
    models: [],
    capabilities: [],
  };
};

export const pluginApi = {
  getUsage: (days = 30): Promise<ApiResponse<PluginUsageAnalytics>> => {
    if (isDemoMode()) {
      return createDemoResponse<PluginUsageAnalytics>(
        emptyUsageAnalytics(days)
      );
    }
    return api
      .get('/plugins/usage', { params: { days } })
      .then(res => res.data);
  },

  getAllPlugins: (): Promise<ApiResponse<Plugin[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin[]>([]);
    }
    return api.get('/plugins').then(res => res.data);
  },

  discoverModels: (
    id: string
  ): Promise<ApiResponse<PluginModelDiscoveryResult>> => {
    if (isDemoMode()) {
      return createDemoResponse<PluginModelDiscoveryResult>({
        models: [],
        outcome: 'unavailable',
      });
    }
    return api
      .post(`/plugins/discover/${encodeURIComponent(id)}`)
      .then(res => res.data);
  },

  uploadPlugin: (file: File): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    const formData = new FormData();
    formData.append('plugin', file);
    return api.post('/plugins/upload', formData).then(res => res.data);
  },

  probeEndpoint: (
    baseUrl: string,
    kind: 'openai' | 'ollama'
  ): Promise<
    ApiResponse<{ reachable: boolean; models: string[]; kind: string }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({
        reachable: false,
        models: [],
        kind,
      });
    }
    return api
      .post('/plugins/probe-endpoint', { baseUrl, kind })
      .then(res => res.data);
  },

  installPlugin: (
    pluginData: Omit<Plugin, 'id' | 'created_at' | 'updated_at'>
  ): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    return api.post('/plugins/install', pluginData).then(res => res.data);
  },

  updatePlugin: (
    id: string,
    updates: Partial<Plugin>
  ): Promise<ApiResponse<Plugin>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin>({} as Plugin, false);
    }
    return api.put(`/plugins/${id}`, updates).then(res => res.data);
  },

  deletePlugin: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse<void>(undefined);
    }
    return api.delete(`/plugins/${id}`).then(res => res.data);
  },

  activatePlugin: (id: string): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(false, false);
    }
    return api.post(`/plugins/activate/${id}`).then(res => res.data);
  },

  deactivatePlugin: (id?: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse<void>(undefined);
    }
    const endpoint = id ? `/plugins/deactivate/${id}` : '/plugins/deactivate';
    return api.post(endpoint).then(res => res.data);
  },

  getActivePlugin: (): Promise<ApiResponse<Plugin | null>> => {
    if (isDemoMode()) {
      return createDemoResponse<Plugin | null>(null);
    }
    return api.get('/plugins/active').then(res => res.data);
  },

  getPluginStatus: (): Promise<ApiResponse<PluginStatus[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<PluginStatus[]>([]);
    }
    return api.get('/plugins/status').then(res => res.data);
  },

  exportPlugin: (id: string): Promise<Blob> => {
    if (isDemoMode()) {
      return Promise.resolve(new Blob(['{}'], { type: 'application/json' }));
    }
    return api
      .get(`/plugins/${id}/export`, {
        responseType: 'blob',
      })
      .then(res => res.data);
  },

  // Plugin credentials (API keys)
  getCredentials: (): Promise<
    ApiResponse<
      Array<{ plugin_id: string; has_api_key: boolean; updated_at: number }>
    >
  > => {
    if (isDemoMode()) {
      return createDemoResponse<
        Array<{ plugin_id: string; has_api_key: boolean; updated_at: number }>
      >([]);
    }
    return api.get('/plugins/credentials/all').then(res => res.data);
  },

  setApiKey: (
    pluginId: string,
    apiKey: string
  ): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(false, false);
    }
    return api
      .post(`/plugins/${pluginId}/credentials`, { api_key: apiKey })
      .then(res => res.data);
  },

  deleteApiKey: (pluginId: string): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(false, false);
    }
    return api.delete(`/plugins/${pluginId}/credentials`).then(res => res.data);
  },

  checkApiKey: (pluginId: string): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(false);
    }
    return api
      .get(`/plugins/${pluginId}/credentials/check`)
      .then(res => res.data);
  },

  // Plugin variables (valves)
  getVariables: (
    pluginId: string
  ): Promise<ApiResponse<Record<string, PluginVariableValue>>> => {
    if (isDemoMode()) {
      return createDemoResponse<Record<string, PluginVariableValue>>({});
    }
    return api.get(`/plugins/${pluginId}/variables`).then(res => res.data);
  },

  setVariables: (
    pluginId: string,
    variables: Record<string, PluginVariableInput>,
    unset: string[] = []
  ): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(true);
    }
    return api
      .put(`/plugins/${pluginId}/variables`, { variables, unset })
      .then(res => res.data);
  },

  resetVariables: (pluginId: string): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(true);
    }
    return api.delete(`/plugins/${pluginId}/variables`).then(res => res.data);
  },
};
