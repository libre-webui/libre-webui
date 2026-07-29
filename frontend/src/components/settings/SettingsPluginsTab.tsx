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

import type { ChangeEvent, RefObject } from 'react';
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
  Sliders,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { PluginVariablesEditor } from '@/components/PluginManager';
import { Button } from '@/components/ui';
import type { Plugin } from '@/types';

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
}: SettingsPluginsTabProps) {
  const { t } = useTranslation();
  const activePlugins = plugins.filter(plugin => plugin.active);

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.plugins.title')}
        </h3>

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

        {activePlugins.length > 0 && (
          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300 mb-6'>
            <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              {t('settings.plugins.active')} ({activePlugins.length})
            </h4>
            <div className='space-y-2'>
              {activePlugins.map(plugin => (
                <div
                  key={plugin.id}
                  className='flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg'
                >
                  <div>
                    <p className='font-medium text-green-800 dark:text-green-200'>
                      {plugin.name}
                    </p>
                    <p className='text-xs text-green-600 dark:text-green-300'>
                      {plugin.type} • {plugin.model_map?.length || 0}{' '}
                      {t('settings.plugins.models')}
                    </p>
                  </div>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => onActivatePlugin(plugin.id)}
                    className='text-green-600 border-green-300 hover:bg-green-100'
                  >
                    {t('settings.plugins.deactivate')}
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className='bg-white dark:bg-dark-100 rounded-lg border border-gray-200 dark:border-dark-300'>
          <div className='p-4 border-b border-gray-200 dark:border-dark-300'>
            <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
              {t('settings.plugins.installed')} ({plugins.length})
            </h4>
          </div>

          {loading ? (
            <div className='p-8 text-center'>
              <p className='text-gray-500 dark:text-gray-400'>
                {t('settings.plugins.loading')}
              </p>
            </div>
          ) : plugins.length === 0 ? (
            <div className='p-8 text-center'>
              <Puzzle className='h-12 w-12 text-gray-400 mx-auto mb-4' />
              <p className='text-gray-500 dark:text-gray-400 mb-2'>
                {t('settings.plugins.noPlugins')}
              </p>
              <p className='text-xs text-gray-400 dark:text-gray-500'>
                {t('settings.plugins.noPluginsDescription')}
              </p>
            </div>
          ) : (
            <div className='divide-y divide-gray-200 dark:divide-dark-300'>
              {plugins.map(plugin => (
                <PluginListItem
                  key={plugin.id}
                  plugin={plugin}
                  loading={loading}
                  hasApiKey={hasKeys[plugin.id] || false}
                  expanded={expandedPluginId === plugin.id}
                  apiKey={pluginApiKeys[plugin.id] || ''}
                  showApiKey={showApiKey[plugin.id] || false}
                  savingApiKey={savingApiKey === plugin.id}
                  onExpand={() =>
                    onExpandedPluginChange(
                      expandedPluginId === plugin.id ? null : plugin.id
                    )
                  }
                  onActivate={() => onActivatePlugin(plugin.id)}
                  onExport={() => onExportPlugin(plugin.id)}
                  onDelete={() => onDeletePlugin(plugin.id)}
                  onApiKeyChange={apiKey =>
                    onPluginApiKeyChange(plugin.id, apiKey)
                  }
                  onShowApiKeyChange={show =>
                    onShowApiKeyChange(plugin.id, show)
                  }
                  onSaveApiKey={() => onSaveApiKey(plugin.id)}
                  onDeleteApiKey={() => onDeleteApiKey(plugin.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface PluginListItemProps {
  plugin: Plugin;
  loading: boolean;
  hasApiKey: boolean;
  expanded: boolean;
  apiKey: string;
  showApiKey: boolean;
  savingApiKey: boolean;
  onExpand: () => void;
  onActivate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onApiKeyChange: (apiKey: string) => void;
  onShowApiKeyChange: (show: boolean) => void;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
}

function PluginListItem({
  plugin,
  loading,
  hasApiKey,
  expanded,
  apiKey,
  showApiKey,
  savingApiKey,
  onExpand,
  onActivate,
  onExport,
  onDelete,
  onApiKeyChange,
  onShowApiKeyChange,
  onSaveApiKey,
  onDeleteApiKey,
}: PluginListItemProps) {
  const { t } = useTranslation();
  const requiresApiKey = Boolean(plugin.auth?.header || plugin.auth?.key_env);

  return (
    <div className='p-4'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex-1 min-w-0'>
          <div className='flex items-center space-x-3'>
            <div
              className={`w-3 h-3 rounded-full flex-shrink-0 ${plugin.active ? 'bg-green-500' : 'bg-gray-400 dark:bg-gray-500'}`}
            />
            <div>
              <h5 className='font-medium text-gray-900 dark:text-gray-100'>
                {plugin.name}
              </h5>
              <div className='flex items-center space-x-2 text-xs text-gray-500 dark:text-gray-400'>
                <span>{plugin.type}</span>
                <span>•</span>
                <span>
                  {plugin.model_map?.length || 0} {t('settings.plugins.models')}
                </span>
                {plugin.endpoint && (
                  <>
                    <span>•</span>
                    <span className='truncate max-w-32'>{plugin.endpoint}</span>
                  </>
                )}
                {requiresApiKey && hasApiKey && (
                  <>
                    <span>•</span>
                    <span className='text-green-600'>
                      {t('settings.plugins.apiKeySet')}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className='flex items-center space-x-1 flex-shrink-0'>
          {requiresApiKey && (
            <Button
              variant='ghost'
              size='sm'
              onClick={onExpand}
              title='Configure API key'
              className={hasApiKey ? 'text-green-600' : 'text-ink'}
            >
              <Key className='h-4 w-4' />
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
            className={plugin.active ? 'text-green-600 border-green-300' : ''}
          >
            {plugin.active ? (
              <>
                <Check className='h-4 w-4 me-1' />
                {t('settings.plugins.activeLabel')}
              </>
            ) : (
              t('settings.plugins.activate')
            )}
          </Button>

          <Button
            variant='ghost'
            size='sm'
            onClick={onExport}
            disabled={loading}
            title='Export plugin'
          >
            <Download className='h-4 w-4' />
          </Button>

          <Button
            variant='ghost'
            size='sm'
            onClick={onDelete}
            disabled={loading}
            className='text-red-600 hover:text-red-700 hover:bg-red-50'
            title='Delete plugin'
          >
            <Trash2 className='h-4 w-4' />
          </Button>
        </div>
      </div>

      {requiresApiKey && expanded && (
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

      {plugin.variables && plugin.variables.length > 0 && (
        <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-50 rounded-lg border border-gray-200 dark:border-dark-300'>
          <div className='flex items-center gap-2 mb-2'>
            <Sliders className='h-4 w-4 text-gray-500' />
            <h6 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
              {t('settings.plugins.variables', 'Variables')} (
              {plugin.variables.length})
            </h6>
          </div>
          <PluginVariablesEditor plugin={plugin} />
        </div>
      )}
    </div>
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
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={event => onApiKeyChange(event.target.value)}
              placeholder={t('settings.plugins.apiKeyPlaceholder')}
              className='w-full p-2 pe-10 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500'
            />
            <button
              type='button'
              onClick={() => onShowApiKeyChange(!showApiKey)}
              className='absolute end-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600'
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
