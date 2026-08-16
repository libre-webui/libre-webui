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

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  LayoutGrid,
  Search,
  Star,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';
import { ollamaApi } from '@/utils/api';
import { modelVisibilityKey } from '@/utils/modelVisibility';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import type { OllamaModel } from '@/types';

interface ModelCatalogSectionProps {
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Every chat-selectable model the current account can see (Ollama and plugin
 * providers alike), with a per-row "make default" action. Administrators
 * additionally hide or show models in everyone else's pickers.
 */
export function ModelCatalogSection({
  expanded,
  onToggle,
}: ModelCatalogSectionProps) {
  const { t } = useTranslation();
  const { user, systemInfo } = useAuthStore();
  const isAdmin = user?.role === 'admin' || systemInfo?.requiresAuth === false;

  const models = useChatStore(state => state.models);
  const hiddenModels = useChatStore(state => state.hiddenModels);
  const setHiddenModels = useChatStore(state => state.setHiddenModels);
  const selectedModel = useChatStore(state => state.selectedModel);
  const selectedProviderType = useChatStore(
    state => state.selectedProviderType
  );
  const selectedProviderId = useChatStore(state => state.selectedProviderId);
  const setSelectedModel = useChatStore(state => state.setSelectedModel);

  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  // The chat store owns the combined model list; make sure it exists when
  // the models page is opened before any chat view populated it.
  useEffect(() => {
    if (useChatStore.getState().models.length === 0) {
      void useChatStore.getState().loadModels({ quiet: true });
    }
  }, []);

  const catalogModels = useMemo(
    () => models.filter(model => !model.isPersona && !model.isAgent),
    [models]
  );

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return catalogModels;
    return catalogModels.filter(model => {
      const provider = model.isPlugin
        ? model.pluginName || model.pluginId || ''
        : 'ollama';
      return (
        model.name.toLowerCase().includes(query) ||
        provider.toLowerCase().includes(query)
      );
    });
  }, [catalogModels, search]);

  const hiddenSet = useMemo(() => new Set(hiddenModels), [hiddenModels]);

  const isDefaultModel = (model: OllamaModel): boolean => {
    if (selectedModel !== model.name) return false;
    if (model.isPlugin) {
      return (
        selectedProviderType === 'plugin' &&
        selectedProviderId === (model.pluginId || null)
      );
    }
    return (
      selectedProviderType !== 'plugin' && selectedProviderType !== 'agent'
    );
  };

  const handleMakeDefault = (model: OllamaModel) => {
    if (model.isPlugin) {
      setSelectedModel(model.name, 'plugin', model.pluginId || null);
    } else {
      setSelectedModel(model.name, 'ollama', null);
    }
    toast.success(t('modelManager.catalog.defaultSet', { model: model.name }));
  };

  const handleToggleHidden = async (model: OllamaModel) => {
    if (saving) return;
    const key = modelVisibilityKey(model);
    const previous = hiddenModels;
    const next = hiddenSet.has(key)
      ? previous.filter(hidden => hidden !== key)
      : [...previous, key];

    // Optimistic: the eye flips immediately, and flips back on failure.
    setHiddenModels(next);
    setSaving(true);
    try {
      const response = await ollamaApi.setModelVisibility(next);
      if (!response.success) {
        throw new Error(
          response.error || t('modelManager.catalog.visibilityFailed')
        );
      }
      if (response.data) {
        setHiddenModels(response.data.hidden);
      }
    } catch (error: unknown) {
      setHiddenModels(previous);
      const message =
        error instanceof Error
          ? error.message
          : t('modelManager.catalog.visibilityFailed');
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-2xl border',
        'bg-white/60 dark:bg-white/[0.03]',
        'border-gray-200/80 dark:border-white/10'
      )}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          'w-full flex items-center justify-between p-4',
          'hover:bg-gray-50 dark:hover:bg-dark-50',
          'transition-colors'
        )}
      >
        <div className='flex items-center gap-3'>
          <LayoutGrid className='h-4 w-4 text-gray-500 dark:text-dark-500' />
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            {t('modelManager.sections.catalog')}
          </h3>
          <span
            className={cn(
              'px-2 py-0.5 rounded-full text-xs font-medium',
              'bg-gray-100 dark:bg-dark-200',
              'text-gray-600 dark:text-gray-400'
            )}
          >
            {catalogModels.length} {t('modelManager.catalog.models')}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className='h-5 w-5 text-gray-500' />
        ) : (
          <ChevronDown className='h-5 w-5 text-gray-500' />
        )}
      </button>

      {expanded && (
        <div className='p-4 pt-0 space-y-4'>
          <div className='relative'>
            <Search className='absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500' />
            <input
              type='text'
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder={t('modelManager.catalog.searchPlaceholder')}
              className={cn(
                'w-full rounded-xl border py-2 pe-4 ps-10 text-sm',
                'bg-gray-50 dark:bg-dark-50',
                'border-gray-200 dark:border-dark-300',
                'text-gray-900 dark:text-dark-700',
                'placeholder-gray-500 dark:placeholder-gray-400',
                'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                'focus:border-primary-500'
              )}
            />
          </div>

          {filteredModels.length === 0 ? (
            <div
              className={cn(
                'text-center py-12 rounded-lg border-2 border-dashed',
                'border-gray-200 dark:border-dark-300'
              )}
            >
              <LayoutGrid className='h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-gray-600' />
              <p className='text-gray-600 dark:text-dark-600'>
                {catalogModels.length === 0
                  ? t('modelManager.catalog.noModels')
                  : t('modelManager.catalog.empty')}
              </p>
            </div>
          ) : (
            <div className='space-y-2'>
              {filteredModels.map(model => {
                const key = modelVisibilityKey(model);
                const hidden = hiddenSet.has(key);
                const isDefault = isDefaultModel(model);
                return (
                  <div
                    key={key}
                    className={cn(
                      'flex items-center justify-between gap-4 p-3 rounded-lg border transition-colors',
                      'bg-gray-50 dark:bg-dark-50',
                      'border-gray-200 dark:border-dark-300',
                      'hover:bg-gray-100 dark:hover:bg-dark-200',
                      hidden && 'opacity-60'
                    )}
                  >
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center gap-2 flex-wrap'>
                        <span className='font-medium text-gray-900 dark:text-dark-800 truncate'>
                          {model.name}
                        </span>
                        <span
                          className={cn(
                            'px-1.5 py-0.5 rounded text-xs font-medium',
                            model.isPlugin
                              ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-700 dark:text-primary-400'
                              : 'bg-gray-200 dark:bg-dark-300 text-gray-600 dark:text-gray-400'
                          )}
                        >
                          {model.isPlugin
                            ? model.pluginName || model.pluginId
                            : t('modelManager.catalog.providerOllama')}
                        </span>
                        {isDefault && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                              'bg-amber-100 dark:bg-amber-900/30',
                              'text-amber-700 dark:text-amber-400'
                            )}
                          >
                            <Star className='h-3 w-3 fill-current' />
                            {t('modelManager.catalog.default')}
                          </span>
                        )}
                        {hidden && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                              'bg-gray-200 dark:bg-dark-300',
                              'text-gray-600 dark:text-gray-400'
                            )}
                          >
                            <EyeOff className='h-3 w-3' />
                            {t('modelManager.catalog.hidden')}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className='flex gap-2 flex-shrink-0'>
                      {!isDefault && (
                        <Button
                          onClick={() => handleMakeDefault(model)}
                          variant='outline'
                          size='sm'
                          className='gap-1.5'
                        >
                          <Star className='h-3.5 w-3.5' />
                          {t('modelManager.catalog.makeDefault')}
                        </Button>
                      )}
                      {isAdmin && (
                        <Button
                          onClick={() => void handleToggleHidden(model)}
                          variant='outline'
                          size='sm'
                          disabled={saving}
                          className='gap-1.5'
                          title={
                            hidden
                              ? t('modelManager.catalog.show')
                              : t('modelManager.catalog.hide')
                          }
                          aria-label={
                            hidden
                              ? t('modelManager.catalog.show')
                              : t('modelManager.catalog.hide')
                          }
                        >
                          {hidden ? (
                            <EyeOff className='h-3.5 w-3.5' />
                          ) : (
                            <Eye className='h-3.5 w-3.5' />
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
