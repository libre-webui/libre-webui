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
import { useAuthStore } from '@/store/authStore';
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
import {
  getPluginEndpointValidationError,
  isPluginUrlVariable,
  isValidPluginApiPath,
} from '@/utils/pluginEndpoint';
import {
  buildPluginVariableUpdate,
  getInheritedPluginVariableValue,
  getPluginConnectionVariableNames,
  initializePluginVariableInputs,
  splitPluginVariableDefinitions,
  type PluginVariableInput,
} from '@/utils/pluginVariableOverrides';
import toast from 'react-hot-toast';
import { HuggingFaceModelBrowser } from './HuggingFaceModelBrowser';

// Inline variables editor for a plugin
export const PluginVariablesEditor: React.FC<{
  plugin: Plugin;
}> = ({ plugin }) => {
  const { t } = useTranslation();
  const user = useAuthStore(state => state.user);
  const systemInfo = useAuthStore(state => state.systemInfo);
  const canManageProviderRouting =
    systemInfo?.requiresAuth === false || user?.role === 'admin';
  const {
    pluginVariables,
    fetchPluginVariables,
    updatePluginVariables,
    resetPluginVariables,
    loadPlugins,
  } = usePluginStore();
  const [localValues, setLocalValues] = useState<
    Record<string, PluginVariableInput>
  >({});
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedPanelId = React.useId();
  const fieldIdPrefix = React.useId();

  const fullSchema = useMemo(() => plugin.variables || [], [plugin.variables]);
  const connectionVariableNames = useMemo(
    () => getPluginConnectionVariableNames(plugin),
    [plugin]
  );
  const schema = useMemo(
    () =>
      canManageProviderRouting
        ? fullSchema
        : fullSchema.filter(
            definition => !connectionVariableNames.has(definition.name)
          ),
    [canManageProviderRouting, connectionVariableNames, fullSchema]
  );
  const storedVars = useMemo(
    () => pluginVariables[plugin.id] || {},
    [pluginVariables, plugin.id]
  );
  const variableSections = useMemo(
    () => splitPluginVariableDefinitions(schema, plugin),
    [plugin, schema]
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
      setLocalValues(initializePluginVariableInputs(schema, vars));
      setDirtyFields(new Set());
      setInitialized(true);
    }
    setPrevStoredVarsJson(storedVarsJson);
  }

  const handleSave = async () => {
    // Validate fields before saving
    const errors: Record<string, string> = {};
    for (const def of schema) {
      if (!dirtyFields.has(def.name)) continue;

      const val = localValues[def.name];
      const isBlank = typeof val === 'string' && val.trim().length === 0;
      const storedVar = storedVars[def.name] as PluginVariableValue | undefined;
      const inheritedValue = getInheritedPluginVariableValue(
        def,
        plugin.endpoint
      );

      if (
        isBlank &&
        def.required &&
        inheritedValue === undefined &&
        !(def.sensitive && storedVar?.has_value)
      ) {
        errors[def.name] = t(
          'pluginManager.variables.required',
          'A value is required'
        );
        continue;
      }

      if (
        isPluginUrlVariable(def.name) &&
        typeof val === 'string' &&
        !isBlank
      ) {
        const endpointError = getPluginEndpointValidationError(val, def.name);
        if (endpointError === 'invalid-url') {
          errors[def.name] = t(
            'pluginManager.variables.invalidUrl',
            'Enter a valid full API endpoint URL, for example https://provider.example/v1/chat/completions'
          );
        } else if (endpointError === 'insecure-url') {
          errors[def.name] = t(
            'pluginManager.variables.insecureUrl',
            'Remote API endpoints must use HTTPS. HTTP is allowed only for localhost and private IPv4 addresses.'
          );
        } else if (endpointError === 'query-or-fragment') {
          errors[def.name] = t(
            'pluginManager.variables.invalidBaseUrl',
            'Base URLs cannot contain a query string or fragment.'
          );
        }
      }
      if (
        def.name === 'api_path' &&
        typeof val === 'string' &&
        val.length > 0 &&
        !isValidPluginApiPath(val)
      ) {
        errors[def.name] = t(
          'pluginManager.variables.invalidApiPath',
          'Must start with / and contain no URL, query, fragment, or .. segment'
        );
      }
      if (def.type === 'number' && !isBlank) {
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

    const update = buildPluginVariableUpdate(
      schema,
      localValues,
      dirtyFields,
      storedVars,
      plugin.endpoint
    );
    const submittedDirtyFields = new Set(dirtyFields);
    const changedVariables = Object.fromEntries([
      ...Object.keys(update.variables).map(name => [name, true]),
      ...update.unset.map(name => [name, true]),
    ]);

    if (
      Object.keys(update.variables).length === 0 &&
      update.unset.length === 0
    ) {
      setDirtyFields(new Set());
      setFieldErrors({});
      toast.success(t('pluginManager.variables.saved', 'Variables saved'));
      return;
    }

    setSaving(true);
    const success = await updatePluginVariables(
      plugin.id,
      update.variables,
      update.unset
    );
    setSaving(false);
    if (success) {
      if (
        Object.keys(changedVariables).some(name =>
          connectionVariableNames.has(name)
        )
      ) {
        await loadPlugins();
      }
      setLocalValues(current => {
        const next = { ...current };
        for (const def of schema) {
          if (def.sensitive && submittedDirtyFields.has(def.name)) {
            next[def.name] = '';
          }
        }
        return next;
      });
      setRevealedFields(current => {
        const next = new Set(current);
        for (const def of schema) {
          if (def.sensitive && submittedDirtyFields.has(def.name)) {
            next.delete(def.name);
          }
        }
        return next;
      });
      setDirtyFields(new Set());
      setFieldErrors({});
      toast.success(t('pluginManager.variables.saved', 'Variables saved'));
    } else {
      toast.error(
        t('pluginManager.variables.saveFailed', 'Failed to save variables')
      );
    }
  };

  const handleReset = async () => {
    setResetting(true);
    const success = await resetPluginVariables(plugin.id);
    setResetting(false);
    if (!success) {
      toast.error(
        t('pluginManager.variables.resetFailed', 'Failed to reset variables')
      );
      return;
    }

    if (
      schema.some(definition => connectionVariableNames.has(definition.name))
    ) {
      await loadPlugins();
    }

    setLocalValues(initializePluginVariableInputs(schema, {}));
    setDirtyFields(new Set());
    setFieldErrors({});
    setRevealedFields(new Set());
    toast.success(
      t('pluginManager.variables.reset', 'Variables reset to defaults')
    );
  };

  const updateLocalValue = (name: string, value: PluginVariableInput) => {
    setLocalValues(prev => ({ ...prev, [name]: value }));
    setDirtyFields(prev => new Set(prev).add(name));
    setFieldErrors(prev => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const toggleReveal = (name: string) => {
    setRevealedFields(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const getFieldIds = (def: PluginVariableDefinition) => {
    const fieldIndex = schema.indexOf(def);
    const controlId = `${fieldIdPrefix}-${fieldIndex}`;
    return {
      controlId,
      descriptionId: `${controlId}-description`,
      errorId: `${controlId}-error`,
    };
  };

  const renderField = (def: PluginVariableDefinition) => {
    const value = localValues[def.name];
    const isSensitive = def.sensitive ?? false;
    const isRevealed = revealedFields.has(def.name);
    const storedVar = storedVars[def.name] as PluginVariableValue | undefined;
    const { controlId, descriptionId, errorId } = getFieldIds(def);
    const hasError = Boolean(fieldErrors[def.name]);
    const hasEndpointHelp = def.name === 'endpoint' || def.name === 'api_url';
    const describedBy =
      [
        def.description || hasEndpointHelp ? descriptionId : undefined,
        hasError ? errorId : undefined,
      ]
        .filter(Boolean)
        .join(' ') || undefined;
    const inheritedDefault = getInheritedPluginVariableValue(
      def,
      plugin.endpoint
    );
    const inheritedLabel =
      inheritedDefault !== undefined
        ? t('pluginManager.variables.inheritedValue', {
            defaultValue: 'Use provider default ({{value}})',
            value: String(inheritedDefault),
          })
        : t('pluginManager.variables.inherited', 'Use provider default');

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
          <select
            id={controlId}
            value={value === '' ? '' : String(Boolean(value))}
            onChange={event =>
              updateLocalValue(
                def.name,
                event.target.value === '' ? '' : event.target.value === 'true'
              )
            }
            className={inputClasses}
            aria-invalid={hasError}
            aria-describedby={describedBy}
            disabled={saving || resetting}
          >
            <option value=''>{inheritedLabel}</option>
            <option value='true'>
              {t('pluginManager.variables.enabled', 'Enabled')}
            </option>
            <option value='false'>
              {t('pluginManager.variables.disabled', 'Disabled')}
            </option>
          </select>
        );

      case 'select':
        return (
          <select
            id={controlId}
            value={String(value ?? '')}
            onChange={event => updateLocalValue(def.name, event.target.value)}
            className={inputClasses}
            aria-invalid={hasError}
            aria-describedby={describedBy}
            disabled={saving || resetting}
          >
            <option value=''>{inheritedLabel}</option>
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
            id={controlId}
            type='number'
            value={value === '' ? '' : Number(value)}
            min={def.min}
            max={def.max}
            placeholder={inheritedLabel}
            onChange={event =>
              updateLocalValue(
                def.name,
                event.target.value === '' ? '' : Number(event.target.value)
              )
            }
            className={inputClasses}
            aria-invalid={hasError}
            aria-describedby={describedBy}
            disabled={saving || resetting}
          />
        );

      default: // string
        return (
          <div className='relative'>
            <input
              id={controlId}
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
                  : inheritedLabel
              }
              onChange={event => updateLocalValue(def.name, event.target.value)}
              className={cn(inputClasses, isSensitive && 'pr-10')}
              aria-invalid={hasError}
              aria-describedby={describedBy}
              disabled={saving || resetting}
            />
            {isSensitive && (
              <button
                type='button'
                onClick={() => toggleReveal(def.name)}
                aria-controls={controlId}
                aria-label={
                  isRevealed
                    ? t('pluginManager.variables.hideValue', {
                        defaultValue: 'Hide {{label}} value',
                        label: def.label,
                      })
                    : t('pluginManager.variables.showValue', {
                        defaultValue: 'Show {{label}} value',
                        label: def.label,
                      })
                }
                disabled={saving || resetting}
                className='absolute end-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-gray-300'
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

  const renderDefinition = (def: PluginVariableDefinition) => {
    const { controlId, descriptionId, errorId } = getFieldIds(def);
    const hasEndpointHelp = def.name === 'endpoint' || def.name === 'api_url';

    return (
      <div key={def.name}>
        <label
          htmlFor={controlId}
          className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'
        >
          {hasEndpointHelp
            ? t(
                'pluginManager.variables.fullApiEndpoint',
                'Full API endpoint URL'
              )
            : def.label}
          {def.required && (
            <span aria-hidden='true' className='text-red-500 ml-1'>
              *
            </span>
          )}
        </label>
        {(def.description || hasEndpointHelp) && (
          <p
            id={descriptionId}
            className='text-xs text-gray-500 dark:text-gray-400 mb-1'
          >
            {def.description}
            {def.description && hasEndpointHelp && ' '}
            {hasEndpointHelp &&
              t(
                'pluginManager.variables.endpointHelp',
                'Enter the complete request URL, including its operation path (for example, /v1/chat/completions), not only the provider base URL.'
              )}
          </p>
        )}
        {renderField(def)}
        {fieldErrors[def.name] && (
          <p id={errorId} role='alert' className='text-xs text-red-500 mt-1'>
            {fieldErrors[def.name]}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className='mt-3 pt-3 border-t border-gray-200 dark:border-gray-700'>
      {variableSections.connection.length > 0 && (
        <div className='space-y-3'>
          <p className='text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400'>
            {t('pluginManager.variables.connection', 'Connection')}
          </p>
          {variableSections.connection.map(renderDefinition)}
        </div>
      )}

      {variableSections.advanced.length > 0 && (
        <div
          className={cn(
            variableSections.connection.length > 0 && 'mt-4 border-t pt-4',
            'border-gray-200 dark:border-gray-700'
          )}
        >
          <button
            type='button'
            aria-expanded={advancedOpen}
            aria-controls={advancedPanelId}
            onClick={() => setAdvancedOpen(open => !open)}
            className='flex w-full items-center justify-between rounded-md py-1 text-left text-sm font-medium text-gray-700 hover:text-gray-950 dark:text-gray-300 dark:hover:text-white'
          >
            <span>
              {t('pluginManager.variables.advanced', 'Advanced parameters')} (
              {variableSections.advanced.length})
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 transition-transform',
                advancedOpen && 'rotate-180'
              )}
            />
          </button>
          {advancedOpen && (
            <div id={advancedPanelId} className='mt-3 space-y-3'>
              {variableSections.advanced.map(renderDefinition)}
            </div>
          )}
        </div>
      )}

      <div className='flex items-center gap-2 mt-4'>
        <Button
          size='sm'
          onClick={handleSave}
          disabled={saving || resetting || dirtyFields.size === 0}
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
          disabled={saving || resetting}
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
  const user = useAuthStore(state => state.user);
  const systemInfo = useAuthStore(state => state.systemInfo);
  const canManagePlugins =
    systemInfo?.requiresAuth === false || user?.role === 'admin';

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

  const getVisibleVariableCount = (plugin: Plugin) => {
    const definitions = plugin.variables || [];
    if (canManagePlugins) return definitions.length;

    const connectionVariables = getPluginConnectionVariableNames(plugin);
    return definitions.filter(
      definition => !connectionVariables.has(definition.name)
    ).length;
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
            {canManagePlugins && (
              <>
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
                  className='border-yellow-300 text-ink hover:bg-yellow-500/10 dark:border-yellow-600 dark:hover:bg-yellow-900/20'
                >
                  <Zap className='mr-2 h-4 w-4 text-yellow-500' />
                  {t('pluginManager.browseHF')}
                </Button>
              </>
            )}
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
        {canManagePlugins && showUploadForm && (
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
        {canManagePlugins && showJsonForm && (
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
                      {canManagePlugins && (
                        <p className='text-sm text-gray-600 dark:text-gray-400 mb-2'>
                          {t(
                            'pluginManager.defaultEndpoint',
                            'Default endpoint'
                          )}
                          : {plugin.endpoint}
                        </p>
                      )}
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
                      {getVisibleVariableCount(plugin) > 0 && (
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
                            {getVisibleVariableCount(plugin)})
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
                      {canManagePlugins && (
                        <>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => handleExportPlugin(plugin.id)}
                            disabled={isLoading}
                            title={t(
                              'settings.plugins.exportPlugin',
                              'Export plugin'
                            )}
                          >
                            <Download className='w-4 h-4' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={() => handleDeletePlugin(plugin.id)}
                            disabled={isLoading}
                            className='text-red-600 hover:text-red-800 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20'
                            title={t(
                              'settings.plugins.deletePlugin',
                              'Delete plugin'
                            )}
                          >
                            <Trash2 className='w-4 h-4' />
                          </Button>
                        </>
                      )}
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
      {canManagePlugins && (
        <HuggingFaceModelBrowser
          isOpen={showHuggingFaceBrowser}
          onClose={() => setShowHuggingFaceBrowser(false)}
          onSelectModel={modelId => {
            // Copy model ID to clipboard for easy use
            navigator.clipboard.writeText(modelId);
            // Show a brief notification (the user can add the model to their HF plugin manually)
          }}
        />
      )}
    </div>
  );
};
