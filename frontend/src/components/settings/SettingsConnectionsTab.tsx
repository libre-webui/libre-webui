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

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cable, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { ollamaApi, pluginApi } from '@/utils/api';
import { usePluginStore } from '@/store/pluginStore';
import { useChatStore } from '@/store/chatStore';
import { getErrorMessage } from '@/store/chatStoreHelpers';
import { cn } from '@/utils';
import type { Plugin } from '@/types';

type OllamaStatus = 'checking' | 'online' | 'offline';

/** Turn a display name into a plugin id: lowercase, dashes, nothing else. */
const slugifyConnectionId = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Placeholder model list installed until discovery replaces it. */
const PENDING_DISCOVERY_MODEL = 'pending-discovery';

/**
 * Administrator overview of every model provider the server talks to: the
 * local Ollama runtime plus OpenAI-compatible endpoints, which are
 * completion-type plugins under the hood. Adding a connection here builds a
 * minimal plugin definition, stores the key server-side, activates the
 * provider, and discovers its live model list.
 */
export const SettingsConnectionsTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    plugins,
    isLoading: pluginsLoading,
    loadPlugins,
    activatePlugin,
    deactivatePlugin,
    deletePlugin,
  } = usePluginStore();
  const loadModels = useChatStore(state => state.loadModels);

  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus>('checking');
  const [ollamaVersion, setOllamaVersion] = useState('');
  const [refreshingIds, setRefreshingIds] = useState<Record<string, boolean>>(
    {}
  );
  const [togglingIds, setTogglingIds] = useState<Record<string, boolean>>({});

  // Add-connection form
  const [newName, setNewName] = useState('');
  const [newEndpoint, setNewEndpoint] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [adding, setAdding] = useState(false);

  const connections = useMemo(
    () => plugins.filter(plugin => plugin.type === 'completion'),
    [plugins]
  );
  const newConnectionId = slugifyConnectionId(newName);

  useEffect(() => {
    let cancelled = false;
    void loadPlugins();
    ollamaApi
      .checkHealth()
      .then(async response => {
        if (cancelled) return;
        if (!response.success) {
          setOllamaStatus('offline');
          return;
        }
        setOllamaStatus('online');
        try {
          const version = await ollamaApi.getVersion();
          if (!cancelled && version.success && version.data) {
            setOllamaVersion(version.data.version);
          }
        } catch {
          // The version is decoration; health already answered.
        }
      })
      .catch(() => {
        if (!cancelled) setOllamaStatus('offline');
      });
    return () => {
      cancelled = true;
    };
  }, [loadPlugins]);

  const { data: pluginHasKeys = {} } = useQuery({
    queryKey: ['plugin-credentials'],
    queryFn: async (): Promise<Record<string, boolean>> => {
      const response = await pluginApi.getCredentials();
      if (!response.success || !response.data) return {};
      const map: Record<string, boolean> = {};
      for (const cred of response.data) {
        map[cred.plugin_id] = cred.has_api_key;
      }
      return map;
    },
  });

  const handleToggleActive = async (connection: Plugin) => {
    if (togglingIds[connection.id]) return;
    setTogglingIds(current => ({ ...current, [connection.id]: true }));
    try {
      if (connection.active) {
        await deactivatePlugin(connection.id);
      } else {
        await activatePlugin(connection.id);
      }
      await loadModels();
    } finally {
      setTogglingIds(current => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
    }
  };

  const handleRefreshModels = async (id: string) => {
    if (refreshingIds[id]) return;
    setRefreshingIds(current => ({ ...current, [id]: true }));
    try {
      const response = await pluginApi.discoverModels(id);
      if (!response.success || !response.data) {
        toast.error(
          response.error || t('settings.plugins.modelCatalogRefreshFailed')
        );
        return;
      }

      await Promise.all([loadPlugins(), loadModels()]);

      const { outcome, models, reason } = response.data;
      if (outcome === 'updated') {
        toast.success(
          t('settings.plugins.modelCatalogUpdated', { count: models.length })
        );
      } else if (outcome === 'unchanged') {
        toast.success(t('settings.plugins.modelCatalogUnchanged'));
      } else if (outcome === 'missing_credentials') {
        toast.error(reason || t('settings.plugins.modelCatalogNeedsApiKey'));
      } else {
        toast.error(
          reason
            ? `${t('settings.plugins.modelCatalogUnavailable')} ${reason}`
            : t('settings.plugins.modelCatalogUnavailable')
        );
      }
    } catch (error) {
      toast.error(
        getErrorMessage(error, t('settings.plugins.modelCatalogRefreshFailed'))
      );
    } finally {
      setRefreshingIds(current => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('settings.connections.deleteConfirm'))) return;
    await deletePlugin(id);
    await loadModels();
    await queryClient.invalidateQueries({ queryKey: ['plugin-credentials'] });
  };

  const handleAddConnection = async () => {
    const name = newName.trim();
    const endpoint = newEndpoint.trim();
    const apiKey = newApiKey.trim();
    const id = slugifyConnectionId(name);

    if (!name || !id) {
      toast.error(t('settings.connections.nameRequired'));
      return;
    }
    if (!/^https?:\/\/.+/.test(endpoint)) {
      toast.error(t('settings.connections.endpointInvalid'));
      return;
    }
    if (plugins.some(plugin => plugin.id === id)) {
      toast.error(t('settings.connections.alreadyExists'));
      return;
    }

    const definition: Plugin = {
      id,
      name,
      type: 'completion',
      endpoint,
      api_mode: 'chat_completions',
      auth: {
        header: 'Authorization',
        prefix: 'Bearer ',
        key_env: `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      },
      model_map: [PENDING_DISCOVERY_MODEL],
    };

    setAdding(true);
    try {
      const installed = await pluginApi.installPlugin(definition);
      if (!installed.success) {
        throw new Error(installed.error || t('settings.connections.addFailed'));
      }

      if (apiKey) {
        const keyResponse = await pluginApi.setApiKey(id, apiKey);
        if (!keyResponse.success) {
          toast.error(
            keyResponse.error || t('settings.connections.keySaveFailed')
          );
        }
      }

      const activated = await pluginApi.activatePlugin(id);
      if (!activated.success) {
        toast.error(
          activated.error || t('settings.connections.activateFailed')
        );
      }

      toast.success(t('settings.connections.added'));
      setNewName('');
      setNewEndpoint('');
      setNewApiKey('');

      await Promise.all([
        loadPlugins(),
        queryClient.invalidateQueries({ queryKey: ['plugin-credentials'] }),
      ]);

      // Replace the placeholder model list with what the provider reports.
      await handleRefreshModels(id);
    } catch (error) {
      toast.error(getErrorMessage(error, t('settings.connections.addFailed')));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
          <Cable className='h-5 w-5 text-primary-500' />
          {t('settings.connections.title')}
        </h3>
        <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
          {t('settings.connections.description')}
        </p>
      </div>

      {/* Ollama */}
      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
        <div className='flex items-center justify-between gap-4'>
          <div className='flex items-start gap-3'>
            <Server className='mt-0.5 h-5 w-5 flex-shrink-0 text-gray-500 dark:text-gray-400' />
            <div>
              <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                {t('settings.connections.ollamaTitle')}
              </h4>
              <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                {t('settings.connections.ollamaDescription')}
                {ollamaStatus === 'online' && ollamaVersion
                  ? ` ${t('settings.connections.version', { version: ollamaVersion })}`
                  : ''}
              </p>
            </div>
          </div>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              ollamaStatus === 'online'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
                : ollamaStatus === 'offline'
                  ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
                  : 'bg-gray-100 text-gray-600 dark:bg-dark-200 dark:text-gray-400'
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                ollamaStatus === 'online'
                  ? 'bg-green-500'
                  : ollamaStatus === 'offline'
                    ? 'bg-red-500'
                    : 'bg-gray-400'
              )}
            />
            {ollamaStatus === 'online'
              ? t('settings.connections.statusOnline')
              : ollamaStatus === 'offline'
                ? t('settings.connections.statusOffline')
                : t('settings.connections.statusChecking')}
          </span>
        </div>
      </div>

      {/* OpenAI-compatible connections */}
      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
          {t('settings.connections.providersTitle')}
        </h4>
        <p className='text-xs text-gray-500 dark:text-gray-400 mt-1 mb-3'>
          {t('settings.connections.providersDescription')}
        </p>

        {connections.length === 0 ? (
          <p className='py-4 text-center text-sm text-gray-500 dark:text-gray-400'>
            {pluginsLoading
              ? t('common.loading')
              : t('settings.connections.noConnections')}
          </p>
        ) : (
          <div className='space-y-3'>
            {connections.map(connection => {
              const pendingDiscovery =
                connection.model_map.length === 1 &&
                connection.model_map[0] === PENDING_DISCOVERY_MODEL;
              return (
                <div
                  key={connection.id}
                  className='rounded-lg border border-gray-200 dark:border-dark-300 p-3'
                >
                  <div className='flex items-start justify-between gap-4'>
                    <div className='min-w-0'>
                      <div className='flex items-center gap-2'>
                        <h5 className='truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
                          {connection.name}
                        </h5>
                        <span className='text-xs text-gray-400 dark:text-gray-500'>
                          {connection.id}
                        </span>
                      </div>
                      <p
                        className='mt-1 truncate text-xs text-gray-500 dark:text-gray-400'
                        dir='ltr'
                      >
                        {connection.endpoint}
                      </p>
                      <div className='mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500 dark:text-gray-400'>
                        <span>
                          {pendingDiscovery
                            ? t('settings.connections.pendingDiscovery')
                            : t('settings.connections.modelsCount', {
                                total: connection.model_map.length,
                              })}
                        </span>
                        <span>
                          {pluginHasKeys[connection.id]
                            ? t('settings.plugins.apiKeyConfigured')
                            : t('settings.connections.apiKeyMissing')}
                        </span>
                      </div>
                    </div>
                    <SettingsToggle
                      checked={Boolean(connection.active)}
                      onChange={() => void handleToggleActive(connection)}
                      disabled={Boolean(togglingIds[connection.id])}
                    />
                  </div>
                  <div className='mt-3 flex justify-end gap-2'>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => void handleRefreshModels(connection.id)}
                      disabled={Boolean(refreshingIds[connection.id])}
                      className='flex items-center gap-1.5'
                    >
                      <RefreshCw
                        className={cn(
                          'h-3.5 w-3.5',
                          refreshingIds[connection.id] && 'animate-spin'
                        )}
                      />
                      {t('settings.plugins.refreshModels')}
                    </Button>
                    <Button
                      size='sm'
                      variant='outline'
                      onClick={() => void handleDelete(connection.id)}
                      className='flex items-center gap-1.5 text-red-600 dark:text-red-400'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                      {t('common.delete')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add connection */}
      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 space-y-3'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.connections.addTitle')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('settings.connections.addDescription')}
          </p>
        </div>
        <label className='block'>
          <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.connections.nameLabel')}
          </span>
          <Input
            value={newName}
            onChange={event => setNewName(event.target.value)}
            placeholder={t('settings.connections.namePlaceholder')}
          />
          {newConnectionId && (
            <span className='mt-1 block text-xs text-gray-500 dark:text-gray-400'>
              {t('settings.connections.idPreview', { id: newConnectionId })}
            </span>
          )}
        </label>
        <label className='block'>
          <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.connections.endpointLabel')}
          </span>
          <span className='mb-2 block text-xs text-gray-500 dark:text-gray-400'>
            {t('settings.connections.endpointDescription')}
          </span>
          <Input
            value={newEndpoint}
            onChange={event => setNewEndpoint(event.target.value)}
            placeholder='https://api.example.com/v1/chat/completions'
            spellCheck={false}
            dir='ltr'
          />
        </label>
        <label className='block'>
          <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.connections.apiKeyLabel')}
            <span className='ms-1 text-xs font-normal text-gray-500 dark:text-gray-400'>
              {t('settings.connections.apiKeyOptionalHint')}
            </span>
          </span>
          <Input
            type='password'
            value={newApiKey}
            onChange={event => setNewApiKey(event.target.value)}
            autoComplete='off'
            spellCheck={false}
            dir='ltr'
          />
        </label>
        <div className='flex justify-end'>
          <Button
            size='sm'
            onClick={() => void handleAddConnection()}
            disabled={adding || !newName.trim() || !newEndpoint.trim()}
            className='flex items-center gap-1.5'
          >
            <Plus className='h-3.5 w-3.5' />
            {adding
              ? t('settings.connections.adding')
              : t('settings.connections.add')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SettingsConnectionsTab;
