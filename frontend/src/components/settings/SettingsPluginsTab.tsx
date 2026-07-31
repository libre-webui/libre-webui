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

import {
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type RefObject,
} from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  Key,
  Loader2,
  Puzzle,
  RefreshCw,
  Search,
  Sliders,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PluginVariablesEditor } from '@/components/PluginManager';
import { Button } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import type { Plugin } from '@/types';
import {
  buildPluginProviderCatalog,
  pluginMatchesProviderSearch,
  pluginSupportsModelRefresh,
  type PluginProviderCatalogEntry,
} from '@/utils/pluginProviderCatalog';
import { getPluginConnectionVariableNames } from '@/utils/pluginVariableOverrides';

interface SettingsPluginsTabProps {
  plugins: Plugin[];
  loading: boolean;
  uploading: boolean;
  error: string | null;
  hasKeys: Record<string, boolean>;
  showUploadForm: boolean;
  showJsonForm: boolean;
  jsonInput: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  expandedPluginId: string | null;
  pluginApiKeys: Record<string, string>;
  showApiKey: Record<string, boolean>;
  savingApiKey: string | null;
  refreshingPluginIds: Record<string, boolean>;
  onClearError: () => void;
  onShowUploadFormChange: (show: boolean) => void;
  onShowJsonFormChange: (show: boolean) => void;
  onJsonInputChange: (json: string) => void;
  onFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onJsonSubmit: () => void;
  onExpandedPluginChange: (pluginId: string | null) => void;
  onPluginApiKeyChange: (pluginId: string, apiKey: string) => void;
  onShowApiKeyChange: (pluginId: string, show: boolean) => void;
  onActivatePlugin: (pluginId: string) => void;
  onDeletePlugin: (pluginId: string) => void;
  onExportPlugin: (pluginId: string) => void;
  onSaveApiKey: (pluginId: string) => void;
  onDeleteApiKey: (pluginId: string) => void;
  onRefreshModels: (pluginId: string) => void;
}

export function SettingsPluginsTab({
  plugins,
  loading,
  uploading,
  error,
  hasKeys,
  showUploadForm,
  showJsonForm,
  jsonInput,
  fileInputRef,
  expandedPluginId,
  pluginApiKeys,
  showApiKey,
  savingApiKey,
  refreshingPluginIds,
  onClearError,
  onShowUploadFormChange,
  onShowJsonFormChange,
  onJsonInputChange,
  onFileUpload,
  onJsonSubmit,
  onExpandedPluginChange,
  onPluginApiKeyChange,
  onShowApiKeyChange,
  onActivatePlugin,
  onDeletePlugin,
  onExportPlugin,
  onSaveApiKey,
  onDeleteApiKey,
  onRefreshModels,
}: SettingsPluginsTabProps) {
  const { t } = useTranslation();
  const user = useAuthStore(state => state.user);
  const systemInfo = useAuthStore(state => state.systemInfo);
  const canManagePlugins =
    systemInfo?.requiresAuth === false || user?.role === 'admin';
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
  const searchInputId = useId();
  const filteredPlugins = useMemo(
    () =>
      plugins.filter(plugin =>
        pluginMatchesProviderSearch(plugin, searchQuery)
      ),
    [plugins, searchQuery]
  );
  const effectiveSelectedPluginId =
    selectedPluginId && plugins.some(plugin => plugin.id === selectedPluginId)
      ? selectedPluginId
      : (plugins[0]?.id ?? null);
  const selectedPlugin =
    plugins.find(plugin => plugin.id === effectiveSelectedPluginId) ?? null;

  const selectProvider = (pluginId: string) => {
    if (pluginId === effectiveSelectedPluginId) return;
    onExpandedPluginChange(null);
    setSelectedPluginId(pluginId);
  };

  return (
    <div className='space-y-6'>
      <div>
        <div className='mb-4'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
            {t('settings.plugins.providerConnections', {
              defaultValue: 'Provider connections',
            })}
          </h3>
          <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
            {t('settings.plugins.providerConnectionsDescription', {
              defaultValue:
                'Connect, configure, and inspect model providers through plugins.',
            })}
          </p>
        </div>

        {error && (
          <div className='p-4 bg-primary-50/80 dark:bg-primary-950/25 border border-primary-200 dark:border-primary-800/50 rounded-lg mb-4'>
            <div className='flex items-center justify-between'>
              <p className='text-primary-800 dark:text-primary-200'>{error}</p>
              <Button
                variant='ghost'
                size='sm'
                onClick={onClearError}
                className='text-primary-700 hover:text-primary-900 dark:text-primary-300 dark:hover:text-primary-100'
              >
                <X className='h-4 w-4' />
              </Button>
            </div>
          </div>
        )}

        {canManagePlugins && (
          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300 mb-6'>
            <div className='flex items-center justify-between mb-4'>
              <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                {t('settings.plugins.addNew')}
              </h4>
              <div className='flex items-center space-x-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => onShowUploadFormChange(!showUploadForm)}
                  disabled={loading || uploading}
                >
                  <Upload className='h-4 w-4 me-2' />
                  {t('settings.plugins.upload')}
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => onShowJsonFormChange(!showJsonForm)}
                  disabled={loading}
                >
                  {t('settings.plugins.addJson')}
                </Button>
              </div>
            </div>

            {showUploadForm && (
              <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300 mb-4'>
                <div className='flex items-center space-x-4'>
                  <input
                    ref={fileInputRef}
                    type='file'
                    accept='.json,.zip'
                    onChange={onFileUpload}
                    className='flex-1 p-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 file:me-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-gray-100 file:text-gray-700 dark:file:bg-dark-200 dark:file:text-dark-700 hover:file:bg-gray-200 dark:hover:file:bg-dark-300'
                    disabled={uploading}
                  />
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => onShowUploadFormChange(false)}
                    disabled={uploading}
                  >
                    {t('common.cancel')}
                  </Button>
                </div>
                {uploading && (
                  <p className='text-sm text-gray-600 dark:text-gray-400 mt-2'>
                    {t('settings.plugins.uploading')}
                  </p>
                )}
              </div>
            )}

            {showJsonForm && (
              <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                <div className='space-y-3'>
                  <textarea
                    value={jsonInput}
                    onChange={event => onJsonInputChange(event.target.value)}
                    placeholder={t('settings.plugins.jsonPlaceholder')}
                    className='w-full h-32 p-3 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500 font-mono text-sm'
                    disabled={loading}
                  />
                  <div className='flex items-center justify-end space-x-2'>
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={() => {
                        onShowJsonFormChange(false);
                        onJsonInputChange('');
                      }}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      size='sm'
                      onClick={onJsonSubmit}
                      disabled={!jsonInput.trim() || loading}
                    >
                      {t('settings.plugins.install')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div
          data-testid='provider-workspace'
          className='overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-dark-300 dark:bg-dark-100'
        >
          <div className='grid min-h-[30rem] grid-cols-1 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,1.6fr)]'>
            <section
              data-testid='provider-list'
              aria-label={t('settings.plugins.providers', {
                defaultValue: 'Providers',
              })}
              className='border-b border-gray-200 dark:border-dark-300 lg:border-b-0 lg:border-e'
            >
              <div className='border-b border-gray-200 p-4 dark:border-dark-300'>
                <div className='mb-3 flex items-center justify-between gap-2'>
                  <h4 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
                    {t('settings.plugins.providers', {
                      defaultValue: 'Providers',
                    })}
                  </h4>
                  <span className='rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-dark-200 dark:text-gray-300'>
                    {plugins.length}
                  </span>
                </div>
                <label htmlFor={searchInputId} className='sr-only'>
                  {t('settings.plugins.searchProviders', {
                    defaultValue: 'Search providers',
                  })}
                </label>
                <div className='relative'>
                  <Search
                    aria-hidden='true'
                    className='absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400'
                  />
                  <input
                    id={searchInputId}
                    type='search'
                    value={searchQuery}
                    onChange={event => setSearchQuery(event.target.value)}
                    placeholder={t('settings.plugins.searchProviders', {
                      defaultValue: 'Search providers',
                    })}
                    className='w-full rounded-lg border border-gray-300 bg-white py-2 pe-3 ps-9 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-dark-300 dark:bg-dark-50 dark:text-gray-100'
                  />
                </div>
              </div>

              <div className='max-h-[32rem] space-y-2 overflow-y-auto p-3'>
                {loading && plugins.length === 0 ? (
                  <div className='p-6 text-center text-sm text-gray-500 dark:text-gray-400'>
                    <Loader2 className='mx-auto mb-2 h-5 w-5 animate-spin' />
                    {t('settings.plugins.loading')}
                  </div>
                ) : plugins.length === 0 ? (
                  <div className='p-6 text-center'>
                    <Puzzle className='mx-auto mb-3 h-9 w-9 text-gray-400' />
                    <p className='text-sm text-gray-500 dark:text-gray-400'>
                      {t('settings.plugins.noPlugins')}
                    </p>
                    <p className='mt-1 text-xs text-gray-400 dark:text-gray-500'>
                      {t('settings.plugins.noPluginsDescription')}
                    </p>
                  </div>
                ) : filteredPlugins.length === 0 ? (
                  <p className='p-6 text-center text-sm text-gray-500 dark:text-gray-400'>
                    {t('settings.plugins.noProvidersFound', {
                      defaultValue: 'No providers match your search.',
                    })}
                  </p>
                ) : (
                  filteredPlugins.map(plugin => {
                    const selected = effectiveSelectedPluginId === plugin.id;
                    const modelCount =
                      buildPluginProviderCatalog(plugin).length;

                    return (
                      <button
                        key={plugin.id}
                        type='button'
                        aria-current={selected ? 'true' : undefined}
                        onClick={() => selectProvider(plugin.id)}
                        className={`w-full rounded-xl border p-3 text-start transition-colors ${
                          selected
                            ? 'border-blue-500 bg-blue-50/70 dark:border-blue-500 dark:bg-blue-950/20'
                            : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 dark:border-dark-300 dark:hover:border-dark-400 dark:hover:bg-dark-50'
                        }`}
                      >
                        <div className='flex items-start gap-3'>
                          <span
                            aria-hidden='true'
                            className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                              plugin.active
                                ? 'bg-green-500'
                                : 'bg-gray-400 dark:bg-gray-500'
                            }`}
                          />
                          <span className='min-w-0 flex-1'>
                            <span className='sr-only'>
                              {plugin.active
                                ? t('settings.plugins.activeLabel')
                                : t('settings.plugins.inactive')}
                              .{' '}
                            </span>
                            <span className='block truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
                              {plugin.name}
                            </span>
                            <span className='mt-0.5 block text-xs capitalize text-gray-500 dark:text-gray-400'>
                              {plugin.type} · {modelCount}{' '}
                              {t('settings.plugins.models')}
                            </span>
                          </span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </section>

            <section
              data-testid='provider-detail'
              className='min-w-0 p-4 sm:p-5'
            >
              {selectedPlugin ? (
                <ProviderDetail
                  plugin={selectedPlugin}
                  loading={loading}
                  hasApiKey={hasKeys[selectedPlugin.id] || false}
                  expanded={expandedPluginId === selectedPlugin.id}
                  apiKey={pluginApiKeys[selectedPlugin.id] || ''}
                  showApiKey={showApiKey[selectedPlugin.id] || false}
                  savingApiKey={savingApiKey === selectedPlugin.id}
                  refreshingModels={Boolean(
                    refreshingPluginIds[selectedPlugin.id]
                  )}
                  canManagePlugin={canManagePlugins}
                  onExpand={() =>
                    onExpandedPluginChange(
                      expandedPluginId === selectedPlugin.id
                        ? null
                        : selectedPlugin.id
                    )
                  }
                  onActivate={() => onActivatePlugin(selectedPlugin.id)}
                  onExport={() => onExportPlugin(selectedPlugin.id)}
                  onDelete={() => onDeletePlugin(selectedPlugin.id)}
                  onRefreshModels={() => onRefreshModels(selectedPlugin.id)}
                  onApiKeyChange={apiKey =>
                    onPluginApiKeyChange(selectedPlugin.id, apiKey)
                  }
                  onShowApiKeyChange={show =>
                    onShowApiKeyChange(selectedPlugin.id, show)
                  }
                  onSaveApiKey={() => onSaveApiKey(selectedPlugin.id)}
                  onDeleteApiKey={() => onDeleteApiKey(selectedPlugin.id)}
                />
              ) : (
                <div className='flex min-h-[24rem] items-center justify-center text-center'>
                  <div>
                    <Puzzle className='mx-auto mb-3 h-10 w-10 text-gray-400' />
                    <p className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      {t('settings.plugins.selectProvider', {
                        defaultValue: 'Select a provider',
                      })}
                    </p>
                    <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
                      {t('settings.plugins.selectProviderDescription', {
                        defaultValue:
                          'Choose a provider to inspect its connection and model catalog.',
                      })}
                    </p>
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ProviderDetailProps {
  plugin: Plugin;
  loading: boolean;
  hasApiKey: boolean;
  expanded: boolean;
  apiKey: string;
  showApiKey: boolean;
  savingApiKey: boolean;
  refreshingModels: boolean;
  canManagePlugin: boolean;
  onExpand: () => void;
  onActivate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onRefreshModels: () => void;
  onApiKeyChange: (apiKey: string) => void;
  onShowApiKeyChange: (show: boolean) => void;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
}

function ProviderDetail({
  plugin,
  loading,
  hasApiKey,
  expanded,
  apiKey,
  showApiKey,
  savingApiKey,
  refreshingModels,
  canManagePlugin,
  onExpand,
  onActivate,
  onExport,
  onDelete,
  onRefreshModels,
  onApiKeyChange,
  onShowApiKeyChange,
  onSaveApiKey,
  onDeleteApiKey,
}: ProviderDetailProps) {
  const { t } = useTranslation();
  const requiresApiKey = Boolean(plugin.auth?.header || plugin.auth?.key_env);
  const connectionVariables = getPluginConnectionVariableNames(plugin);
  const visibleVariables = canManagePlugin
    ? plugin.variables || []
    : (plugin.variables || []).filter(
        definition => !connectionVariables.has(definition.name)
      );
  const hasVariables = visibleVariables.length > 0;
  const hasConfiguration = requiresApiKey || hasVariables;
  const configurationPanelId = useId();
  const catalog = buildPluginProviderCatalog(plugin);
  const defaultEndpoint = plugin.base_url || plugin.endpoint;

  return (
    <div>
      <div className='flex flex-col gap-4 border-b border-gray-200 pb-4 dark:border-dark-300'>
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div className='min-w-0'>
            <div className='flex items-center gap-2'>
              <span
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  plugin.active
                    ? 'bg-green-500'
                    : 'bg-gray-400 dark:bg-gray-500'
                }`}
              />
              <h4 className='truncate text-lg font-semibold text-gray-900 dark:text-gray-100'>
                {plugin.name}
              </h4>
            </div>
            <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
              {plugin.id} · <span className='capitalize'>{plugin.type}</span>
              {requiresApiKey && hasApiKey && (
                <span className='text-green-600'>
                  {' '}
                  · {t('settings.plugins.apiKeySet')}
                </span>
              )}
            </p>
          </div>

          <div className='flex flex-wrap items-center gap-1.5'>
            {hasConfiguration && (
              <Button
                variant='outline'
                size='sm'
                onClick={onExpand}
                aria-expanded={expanded}
                aria-controls={configurationPanelId}
                title={t('settings.plugins.configure')}
                className={hasApiKey ? 'text-green-600' : ''}
              >
                {requiresApiKey ? (
                  <Key className='h-4 w-4' />
                ) : (
                  <Sliders className='h-4 w-4' />
                )}
                {t('settings.plugins.configure')}
                {expanded ? (
                  <ChevronUp className='h-3 w-3' />
                ) : (
                  <ChevronDown className='h-3 w-3' />
                )}
              </Button>
            )}

            <Button
              variant='outline'
              size='sm'
              onClick={onActivate}
              disabled={loading}
              className={plugin.active ? 'border-green-300 text-green-600' : ''}
            >
              {plugin.active ? (
                <>
                  <Check className='h-4 w-4' />
                  {t('settings.plugins.deactivate')}
                </>
              ) : (
                t('settings.plugins.activate')
              )}
            </Button>

            {canManagePlugin && (
              <>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={onExport}
                  disabled={loading}
                  title={t('settings.plugins.exportPlugin', 'Export plugin')}
                  className='px-2'
                >
                  <Download className='h-4 w-4' />
                </Button>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={onDelete}
                  disabled={loading}
                  className='px-2 text-red-600 hover:bg-red-50 hover:text-red-700'
                  title={t('settings.plugins.deletePlugin', 'Delete plugin')}
                >
                  <Trash2 className='h-4 w-4' />
                </Button>
              </>
            )}
          </div>
        </div>

        <div className='grid gap-3 sm:grid-cols-3'>
          <div className='rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400'>
              {t('settings.plugins.status', { defaultValue: 'Status' })}
            </p>
            <p className='mt-1 text-sm text-gray-900 dark:text-gray-100'>
              {plugin.active
                ? t('settings.plugins.activeLabel')
                : t('settings.plugins.inactive')}
            </p>
          </div>
          <div className='rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400'>
              {t('settings.plugins.models')}
            </p>
            <p className='mt-1 text-sm text-gray-900 dark:text-gray-100'>
              {catalog.length}
            </p>
          </div>
          <div className='min-w-0 rounded-lg bg-gray-50 p-3 dark:bg-dark-50'>
            <p className='text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400'>
              {t('settings.plugins.defaultEndpoint', {
                defaultValue: 'Default endpoint',
              })}
            </p>
            <p
              className='mt-1 truncate text-sm text-gray-900 dark:text-gray-100'
              title={defaultEndpoint}
            >
              {defaultEndpoint}
            </p>
          </div>
        </div>
      </div>

      {expanded && hasConfiguration && (
        <div id={configurationPanelId}>
          {requiresApiKey && (
            <ApiKeyPanel
              plugin={plugin}
              hasApiKey={hasApiKey}
              apiKey={apiKey}
              showApiKey={showApiKey}
              savingApiKey={savingApiKey}
              onApiKeyChange={onApiKeyChange}
              onShowApiKeyChange={onShowApiKeyChange}
              onSaveApiKey={onSaveApiKey}
              onDeleteApiKey={onDeleteApiKey}
            />
          )}

          {hasVariables && (
            <div className='mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-dark-300 dark:bg-dark-50'>
              <div className='mb-2 flex items-center gap-2'>
                <Sliders className='h-4 w-4 text-gray-500' />
                <h5 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                  {t('settings.plugins.providerSettings')} (
                  {visibleVariables.length})
                </h5>
              </div>
              <PluginVariablesEditor key={plugin.id} plugin={plugin} />
            </div>
          )}
        </div>
      )}

      <ProviderModelCatalog
        catalog={catalog}
        canRefresh={pluginSupportsModelRefresh(plugin)}
        refreshing={refreshingModels}
        onRefresh={onRefreshModels}
      />
    </div>
  );
}

interface ProviderModelCatalogProps {
  catalog: PluginProviderCatalogEntry[];
  canRefresh: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

function ProviderModelCatalog({
  catalog,
  canRefresh,
  refreshing,
  onRefresh,
}: ProviderModelCatalogProps) {
  const { t } = useTranslation();

  return (
    <section data-testid='provider-model-catalog' className='mt-5'>
      <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
        <div>
          <h5 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            {t('settings.plugins.modelCatalog', {
              defaultValue: 'Model catalog',
            })}
          </h5>
          <p className='mt-0.5 text-xs text-gray-500 dark:text-gray-400'>
            {t('settings.plugins.modelCatalogDescription', {
              defaultValue:
                'Discovered and configured models for this provider and its capabilities.',
            })}
          </p>
        </div>
        {canRefresh && (
          <Button
            variant='outline'
            size='sm'
            onClick={onRefresh}
            disabled={refreshing}
            aria-busy={refreshing}
          >
            {refreshing ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : (
              <RefreshCw className='h-4 w-4' />
            )}
            {t('settings.plugins.refreshModels', {
              defaultValue: 'Refresh models',
            })}
          </Button>
        )}
      </div>

      {catalog.length === 0 ? (
        <div className='rounded-lg border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500 dark:border-dark-300 dark:text-gray-400'>
          {t('settings.plugins.noModelsConfigured', {
            defaultValue: 'No models are configured for this provider.',
          })}
        </div>
      ) : (
        <div className='max-h-[26rem] overflow-auto rounded-lg border border-gray-200 dark:border-dark-300'>
          <table className='w-full min-w-[24rem] text-start text-sm'>
            <thead className='sticky top-0 z-10 bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-dark-50 dark:text-gray-400'>
              <tr>
                <th scope='col' className='px-3 py-2 text-start font-medium'>
                  {t('settings.plugins.modelId', {
                    defaultValue: 'Model ID',
                  })}
                </th>
                <th scope='col' className='px-3 py-2 text-start font-medium'>
                  {t('settings.plugins.capabilities', {
                    defaultValue: 'Capabilities',
                  })}
                </th>
              </tr>
            </thead>
            <tbody className='divide-y divide-gray-200 dark:divide-dark-300'>
              {catalog.map(model => (
                <tr key={model.id}>
                  <td className='px-3 py-2.5 font-mono text-xs text-gray-900 dark:text-gray-100'>
                    {model.id}
                  </td>
                  <td className='px-3 py-2.5'>
                    <div className='flex flex-wrap gap-1.5'>
                      {model.capabilities.map(capability => (
                        <span
                          key={capability}
                          className='rounded-md bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950/30 dark:text-blue-300'
                        >
                          {t(
                            `settings.plugins.capability.${capability.toLowerCase()}`,
                            { defaultValue: capability }
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface ApiKeyPanelProps {
  plugin: Plugin;
  hasApiKey: boolean;
  apiKey: string;
  showApiKey: boolean;
  savingApiKey: boolean;
  onApiKeyChange: (apiKey: string) => void;
  onShowApiKeyChange: (show: boolean) => void;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
}

function ApiKeyPanel({
  plugin,
  hasApiKey,
  apiKey,
  showApiKey,
  savingApiKey,
  onApiKeyChange,
  onShowApiKeyChange,
  onSaveApiKey,
  onDeleteApiKey,
}: ApiKeyPanelProps) {
  const { t } = useTranslation();
  const apiKeyInputId = useId();

  return (
    <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-50 rounded-lg border border-gray-200 dark:border-dark-300'>
      <div className='flex items-center gap-2 mb-3'>
        <Key className='h-4 w-4 text-gray-500' />
        <h6 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
          {t('settings.plugins.apiKeyConfiguration')}
        </h6>
      </div>
      <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
        {t('settings.plugins.apiKeyDescription', {
          name: plugin.name,
          defaultValue: 'Store a personal API key for {{name}}.',
        })}
        {plugin.auth?.key_env && (
          <span className='block mt-1'>
            {t('settings.plugins.apiKeyEnvAlternative')}{' '}
            <code className='bg-gray-200 dark:bg-dark-200 px-1 rounded'>
              {plugin.auth.key_env}
            </code>{' '}
            {t('settings.plugins.environmentVariable')}.
          </span>
        )}
      </p>

      {hasApiKey ? (
        <div className='flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg'>
          <div className='flex items-center gap-2'>
            <Check className='h-4 w-4 text-green-600' />
            <span className='text-sm text-green-700 dark:text-green-300'>
              {t('settings.plugins.apiKeyConfigured')}
            </span>
          </div>
          <Button
            variant='outline'
            size='sm'
            onClick={onDeleteApiKey}
            disabled={savingApiKey}
            className='text-red-600 border-red-300 hover:bg-red-50'
          >
            {savingApiKey ? (
              <Loader2 className='h-4 w-4 animate-spin' />
            ) : (
              t('common.remove')
            )}
          </Button>
        </div>
      ) : (
        <div className='space-y-3'>
          <div className='relative'>
            <label htmlFor={apiKeyInputId} className='sr-only'>
              {t('settings.plugins.apiKey.title')}
            </label>
            <input
              id={apiKeyInputId}
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={event => onApiKeyChange(event.target.value)}
              placeholder={t('settings.plugins.apiKeyPlaceholder')}
              disabled={savingApiKey}
              className='w-full p-2 pe-10 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500'
            />
            <button
              type='button'
              onClick={() => onShowApiKeyChange(!showApiKey)}
              aria-controls={apiKeyInputId}
              aria-label={
                showApiKey
                  ? t('settings.plugins.hideApiKey')
                  : t('settings.plugins.showApiKey')
              }
              disabled={savingApiKey}
              className='absolute end-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50'
            >
              {showApiKey ? (
                <EyeOff className='h-4 w-4' />
              ) : (
                <Eye className='h-4 w-4' />
              )}
            </button>
          </div>
          <div className='flex justify-end'>
            <Button
              size='sm'
              onClick={onSaveApiKey}
              disabled={savingApiKey || !apiKey.trim()}
            >
              {savingApiKey ? (
                <>
                  <Loader2 className='h-4 w-4 me-2 animate-spin' />
                  {t('common.saving')}
                </>
              ) : (
                t('settings.plugins.saveApiKey')
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
