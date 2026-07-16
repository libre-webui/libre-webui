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

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginStore } from '@/store/pluginStore';
import { Plugin, PluginVariableDefinition } from '@/types';
import { PluginVariableValue } from '@/utils/api';
import { Button } from '@/components/ui/Button';
import {
  Settings,
  Upload,
  Download,
  Trash2,
  Check,
  X,
  Zap,
} from '@/components/icons';
import { ChevronDown, RotateCcw, Save, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/utils';
import toast from 'react-hot-toast';
import { HuggingFaceModelBrowser } from './HuggingFaceModelBrowser';

// Inline variables editor for a plugin
export const PluginVariablesEditor: React.FC<{
  plugin: Plugin;
}> = ({ plugin }) => {
  const { t } = useTranslation();
  const {
    pluginVariables,
    fetchPluginVariables,
    updatePluginVariables,
    resetPluginVariables,
  } = usePluginStore();
  const [localValues, setLocalValues] = useState<
    Record<string, string | number | boolean>
  >({});
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const schema = useMemo(() => plugin.variables || [], [plugin.variables]);
  const storedVars = useMemo(
    () => pluginVariables[plugin.id] || {},
    [pluginVariables, plugin.id]
  );

  // Load variables on mount
  useEffect(() => {
    fetchPluginVariables(plugin.id);
  }, [fetchPluginVariables, plugin.id]);

  // Initialize local values from store once available — adjust state during render
  const storedVarsJson = JSON.stringify(storedVars);
  const [prevStoredVarsJson, setPrevStoredVarsJson] = useState<string | null>(
    null
  );
  if (prevStoredVarsJson !== storedVarsJson) {
    const vars = JSON.parse(storedVarsJson) as Record<
      string,
      PluginVariableValue
    >;
    if (!(Object.keys(vars).length === 0 && initialized)) {
      const values: Record<string, string | number | boolean> = {};
      for (const def of schema) {
        const stored = vars[def.name];
        if (stored?.has_value && !stored.is_sensitive) {
          values[def.name] = stored.value;
        } else {
          values[def.name] =
            def.default ??
            (def.type === 'boolean' ? false : def.type === 'number' ? 0 : '');
        }
      }
      setLocalValues(values);
      setInitialized(true);
    }
    setPrevStoredVarsJson(storedVarsJson);
  }

  const handleSave = async () => {
    // Validate fields before saving
    const errors: Record<string, string> = {};
    for (const def of schema) {
      const val = localValues[def.name];
      if (
        def.name === 'endpoint' &&
        typeof val === 'string' &&
        val.length > 0
      ) {
        try {
          new URL(val);
        } catch {
          errors[def.name] = t(
            'pluginManager.variables.invalidUrl',
            'Must be a valid URL'
          );
        }
      }
      if (def.type === 'number') {
        const num = Number(val);
        if (def.min !== undefined && num < def.min) {
          errors[def.name] = `Min: ${def.min}`;
        }
        if (def.max !== undefined && num > def.max) {
          errors[def.name] = `Max: ${def.max}`;
        }
      }
      if (
        def.type === 'string' &&
        typeof val === 'string' &&
        val.length > 2048
      ) {
        errors[def.name] = t(
          'pluginManager.variables.tooLong',
          'Value is too long'
        );
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSaving(true);
    const success = await updatePluginVariables(plugin.id, localValues);
    setSaving(false);
    if (success) {
      toast.success(t('pluginManager.variables.saved', 'Variables saved'));
    } else {
      toast.error(
        t('pluginManager.variables.saveFailed', 'Failed to save variables')
      );
    }
  };

  const handleReset = async () => {
    await resetPluginVariables(plugin.id);
    // Reset local values to defaults
    const defaults: Record<string, string | number | boolean> = {};
    for (const def of schema) {
      defaults[def.name] =
        def.default ??
        (def.type === 'boolean' ? false : def.type === 'number' ? 0 : '');
    }
    setLocalValues(defaults);
    toast.success(
      t('pluginManager.variables.reset', 'Variables reset to defaults')
    );
  };

  const toggleReveal = (name: string) => {
    setRevealedFields(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const renderField = (def: PluginVariableDefinition) => {
    const value = localValues[def.name];
    const isSensitive = def.sensitive ?? false;
    const isRevealed = revealedFields.has(def.name);
    const storedVar = storedVars[def.name] as PluginVariableValue | undefined;

    const inputClasses = cn(
      'w-full px-3 py-2 rounded-lg border text-sm',
      'bg-white dark:bg-dark-100',
      'border-gray-300 dark:border-dark-300',
      'text-gray-900 dark:text-dark-700',
      'focus:outline-none focus:ring-2 focus:ring-blue-500/20'
    );

    switch (def.type) {
      case 'boolean':
        return (
          <label className='flex items-center gap-2 cursor-pointer'>
            <input
              type='checkbox'
              checked={Boolean(value ?? false)}
              onChange={e =>
                setLocalValues(prev => ({
                  ...prev,
                  [def.name]: e.target.checked,
                }))
              }
              className='rounded border-gray-300 dark:border-gray-600 text-blue-600 focus:ring-blue-500'
            />
            <span className='text-sm text-gray-700 dark:text-gray-300'>
              {def.label}
            </span>
          </label>
        );

      case 'select':
        return (
          <select
            value={String(value ?? '')}
            onChange={e =>
              setLocalValues(prev => ({ ...prev, [def.name]: e.target.value }))
            }
            className={inputClasses}
          >
            {(def.options || []).map(opt => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );

      case 'number':
        return (
          <input
            type='number'
            value={(value as number) ?? 0}
            min={def.min}
            max={def.max}
            onChange={e =>
              setLocalValues(prev => ({
                ...prev,
                [def.name]: e.target.value === '' ? 0 : Number(e.target.value),
              }))
            }
            className={inputClasses}
          />
        );

      default: // string
        return (
          <div className='relative'>
            <input
              type={isSensitive && !isRevealed ? 'password' : 'text'}
              value={
                isSensitive && storedVar?.has_value && value === ''
                  ? ''
                  : String(value ?? '')
              }
              placeholder={
                isSensitive && storedVar?.has_value
                  ? t(
                      'pluginManager.variables.sensitiveSet',
                      'Value is set (enter new value to change)'
                    )
                  : undefined
              }
              onChange={e =>
                setLocalValues(prev => ({
                  ...prev,
                  [def.name]: e.target.value,
                }))
              }
              className={cn(inputClasses, isSensitive && 'pr-10')}
            />
            {isSensitive && (
              <button
                type='button'
                onClick={() => toggleReveal(def.name)}
                className='absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              >
                {isRevealed ? (
                  <EyeOff className='w-4 h-4' />
                ) : (
                  <Eye className='w-4 h-4' />
                )}
              </button>
            )}
          </div>
        );
    }
  };

  return (
    <div className='mt-3 pt-3 border-t border-gray-200 dark:border-gray-700'>
      <div className='space-y-3'>
        {schema.map(def => (
          <div key={def.name}>
            {def.type !== 'boolean' && (
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                {def.label}
                {def.required && <span className='text-red-500 ml-1'>*</span>}
              </label>
            )}
            {def.description && def.type !== 'boolean' && (
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-1'>
                {def.description}
              </p>
            )}
            {renderField(def)}
            {fieldErrors[def.name] && (
              <p className='text-xs text-red-500 mt-1'>
                {fieldErrors[def.name]}
              </p>
            )}
          </div>
        ))}
      </div>
      <div className='flex items-center gap-2 mt-4'>
        <Button
          size='sm'
          onClick={handleSave}
          disabled={saving}
          className='gap-1.5'
        >
          <Save className='w-3.5 h-3.5' />
          {saving
            ? t('pluginManager.variables.saving', 'Saving...')
            : t('pluginManager.variables.save', 'Save')}
        </Button>
        <Button
          variant='outline'
          size='sm'
          onClick={handleReset}
          className='gap-1.5'
        >
          <RotateCcw className='w-3.5 h-3.5' />
          {t('pluginManager.variables.resetDefaults', 'Reset to Defaults')}
        </Button>
      </div>
    </div>
  );
};

interface PluginManagerProps {
  onClose?: () => void;
}

export const PluginManager: React.FC<PluginManagerProps> = ({ onClose }) => {
  const {
    plugins,
    isLoading,
    isUploading,
    error,
    loadPlugins,
    uploadPlugin,
    deletePlugin,
    activatePlugin,
    deactivatePlugin,
    exportPlugin,
    clearError,
  } = usePluginStore();

  const { t } = useTranslation();

  // Get the active plugin from the plugins array
  const activePlugin = plugins.find(plugin => plugin.active);

  const [showUploadForm, setShowUploadForm] = useState(false);
  const [showJsonForm, setShowJsonForm] = useState(false);
  const [showHuggingFaceBrowser, setShowHuggingFaceBrowser] = useState(false);
  const [jsonInput, setJsonInput] = useState('');
  const [expandedVarsPlugin, setExpandedVarsPlugin] = useState<string | null>(
    null
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      await uploadPlugin(file);
      setShowUploadForm(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleJsonSubmit = async () => {
    try {
      const pluginData = JSON.parse(jsonInput) as Plugin;
      await usePluginStore.getState().installPlugin(pluginData);
      setShowJsonForm(false);
      setJsonInput('');
    } catch (_error) {
      usePluginStore.getState().setError('Invalid JSON format');
    }
  };

  const handleActivatePlugin = async (id: string) => {
    if (activePlugin?.id === id) {
      await deactivatePlugin();
    } else {
      await activatePlugin(id);
    }
  };

  const handleDeletePlugin = async (id: string) => {
    if (window.confirm(t('pluginManager.confirmDelete'))) {
      await deletePlugin(id);
    }
  };

  const handleExportPlugin = async (id: string) => {
    await exportPlugin(id);
  };

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-3 sm:p-6'>
      <div className='flex max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-xl dark:bg-gray-800 sm:max-h-[90dvh]'>
        {/* Header */}
        <div className='flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700'>
          <div className='flex items-center space-x-3'>
            <Settings className='w-6 h-6 text-blue-600' />
            <h2 className='text-xl font-semibold text-gray-900 dark:text-white'>
              {t('pluginManager.title')}
            </h2>
          </div>
          <div className='flex items-center space-x-2'>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setShowUploadForm(!showUploadForm)}
              disabled={isLoading || isUploading}
            >
              <Upload className='w-4 h-4 mr-2' />
              {t('pluginManager.upload')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setShowJsonForm(!showJsonForm)}
              disabled={isLoading}
            >
              {t('pluginManager.addJson')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setShowHuggingFaceBrowser(true)}
              disabled={isLoading}
              className='text-yellow-600 border-yellow-300 hover:bg-yellow-50 dark:text-yellow-400 dark:border-yellow-600 dark:hover:bg-yellow-900/20'
            >
              <Zap className='w-4 h-4 mr-2' />
              {t('pluginManager.browseHF')}
            </Button>
            {onClose && (
              <Button variant='ghost' size='sm' onClick={onClose}>
                <X className='w-4 h-4' />
              </Button>
            )}
          </div>
        </div>

        {/* Error Message */}
        {error && (
          <div className='p-4 bg-primary-50/80 dark:bg-primary-950/25 border-b border-primary-200 dark:border-primary-800/50'>
            <div className='flex items-center justify-between'>
              <p className='text-primary-800 dark:text-primary-200'>{error}</p>
              <Button
                variant='ghost'
                size='sm'
                onClick={clearError}
                className='text-primary-700 hover:text-primary-900 dark:text-primary-300 dark:hover:text-primary-100'
              >
                <X className='w-4 h-4' />
              </Button>
            </div>
          </div>
        )}

        {/* Upload Form */}
        {showUploadForm && (
          <div className='p-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700'>
            <div className='flex items-center space-x-4'>
              <input
                ref={fileInputRef}
                type='file'
                accept='.json,.zip'
                onChange={handleFileUpload}
                className='flex-1 p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white'
                disabled={isUploading}
              />
              <Button
                variant='outline'
                size='sm'
                onClick={() => setShowUploadForm(false)}
                disabled={isUploading}
              >
                {t('common.cancel')}
              </Button>
            </div>
            {isUploading && (
              <p className='text-sm text-gray-600 dark:text-gray-400 mt-2'>
                {t('pluginManager.uploading')}
              </p>
            )}
          </div>
        )}

        {/* JSON Form */}
        {showJsonForm && (
          <div className='p-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700'>
            <div className='space-y-3'>
              <textarea
                value={jsonInput}
                onChange={e => setJsonInput(e.target.value)}
                placeholder={t('pluginManager.pasteJson')}
                className='w-full h-32 p-3 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono text-sm'
                disabled={isLoading}
              />
              <div className='flex items-center justify-end space-x-2'>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => {
                    setShowJsonForm(false);
                    setJsonInput('');
                  }}
                  disabled={isLoading}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  variant='primary'
                  size='sm'
                  onClick={handleJsonSubmit}
                  disabled={isLoading || !jsonInput.trim()}
                >
                  {t('pluginManager.installPlugin')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Plugin List */}
        <div className='scroll-region min-h-0 flex-1 scrollbar-thin'>
          {isLoading ? (
            <div className='flex items-center justify-center p-8'>
              <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600'></div>
              <span className='ml-2 text-gray-600 dark:text-gray-400'>
                {t('pluginManager.loading')}
              </span>
            </div>
          ) : plugins.length === 0 ? (
            <div className='text-center p-8'>
              <Settings className='w-12 h-12 mx-auto mb-4 text-gray-400' />
              <h3 className='text-lg font-medium text-gray-900 dark:text-white mb-2'>
                {t('pluginManager.noPlugins')}
              </h3>
              <p className='text-gray-600 dark:text-gray-400'>
                {t('pluginManager.noPluginsDescription')}
              </p>
            </div>
          ) : (
            <div className='divide-y divide-gray-200 dark:divide-gray-700'>
              {plugins.map(plugin => (
                <div
                  key={plugin.id}
                  className='p-4 hover:bg-gray-50 dark:hover:bg-gray-900/50 transition-colors'
                >
                  <div className='flex items-center justify-between'>
                    <div className='flex-1'>
                      <div className='flex items-center space-x-3 mb-2'>
                        <h3 className='font-medium text-gray-900 dark:text-white'>
                          {plugin.name}
                        </h3>
                        {plugin.active && (
                          <span className='inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'>
                            <Check className='w-3 h-3 mr-1' />
                            {t('pluginManager.active')}
                          </span>
                        )}
                        <span className='inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300'>
                          {plugin.type}
                        </span>
                      </div>
                      <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                        {t('pluginManager.id')}: {plugin.id}
                      </p>
                      <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                        {t('pluginManager.endpoint')}: {plugin.endpoint}
                      </p>
                      <div className='flex flex-wrap gap-1'>
                        {plugin.model_map.map(model => (
                          <span
                            key={model}
                            className='inline-block px-2 py-1 text-xs rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                          >
                            {model}
                          </span>
                        ))}
                      </div>

                      {/* Variables (Valves) section */}
                      {plugin.variables && plugin.variables.length > 0 && (
                        <div className='mt-3'>
                          <button
                            onClick={() =>
                              setExpandedVarsPlugin(
                                expandedVarsPlugin === plugin.id
                                  ? null
                                  : plugin.id
                              )
                            }
                            className={cn(
                              'flex items-center gap-1.5 text-xs font-medium',
                              'text-blue-600 dark:text-blue-400',
                              'hover:underline'
                            )}
                          >
                            <Settings className='w-3.5 h-3.5' />
                            {t('pluginManager.variables.title', 'Variables')}(
                            {plugin.variables.length})
                            <ChevronDown
                              className={cn(
                                'w-3.5 h-3.5 transition-transform',
                                expandedVarsPlugin === plugin.id && 'rotate-180'
                              )}
                            />
                          </button>
                          {expandedVarsPlugin === plugin.id && (
                            <PluginVariablesEditor plugin={plugin} />
                          )}
                        </div>
                      )}
                    </div>
                    <div className='flex items-center space-x-2 ml-4'>
                      <Button
                        variant={plugin.active ? 'outline' : 'primary'}
                        size='sm'
                        onClick={() => handleActivatePlugin(plugin.id)}
                        disabled={isLoading}
                      >
                        {plugin.active
                          ? t('pluginManager.deactivate')
                          : t('pluginManager.activate')}
                      </Button>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => handleExportPlugin(plugin.id)}
                        disabled={isLoading}
                        title='Export plugin'
                      >
                        <Download className='w-4 h-4' />
                      </Button>
                      <Button
                        variant='ghost'
                        size='sm'
                        onClick={() => handleDeletePlugin(plugin.id)}
                        disabled={isLoading}
                        className='text-red-600 hover:text-red-800 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20'
                        title='Delete plugin'
                      >
                        <Trash2 className='w-4 h-4' />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Plugin Status - Keep green for active status as requested */}
        {activePlugin && (
          <div className='p-4 bg-green-50 dark:bg-green-900/20 border-t border-green-200 dark:border-green-800'>
            <div className='flex items-center space-x-3'>
              <Check className='w-5 h-5 text-green-600 dark:text-green-400' />
              <div>
                <p className='text-sm font-medium text-green-800 dark:text-green-200'>
                  {t('pluginManager.activePlugin')}: {activePlugin.name}
                </p>
                <p className='text-xs text-green-600 dark:text-green-400'>
                  {t('pluginManager.activePluginDescription')}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* HuggingFace Model Browser */}
      <HuggingFaceModelBrowser
        isOpen={showHuggingFaceBrowser}
        onClose={() => setShowHuggingFaceBrowser(false)}
        onSelectModel={modelId => {
          // Copy model ID to clipboard for easy use
          navigator.clipboard.writeText(modelId);
          // Show a brief notification (the user can add the model to their HF plugin manually)
        }}
      />
    </div>
  );
};
