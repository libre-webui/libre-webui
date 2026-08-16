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

/**
 * Administrator control over the shared model list: which models people can
 * pick, the order they appear in, and how each one is presented.
 *
 * Edits are staged locally and written in one request, so an administrator
 * can switch a dozen models off and reorder them without the picker changing
 * under everyone mid-edit.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import {
  Eye,
  EyeOff,
  GripVertical,
  Image as ImageIcon,
  Pencil,
  Search,
  X,
} from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { useChatStore } from '@/store/chatStore';
import { ollamaApi } from '@/utils/api';
import type { ModelPresentation } from '@/utils/api/modelApi';
import { modelVisibilityKey } from '@/utils/modelVisibility';
import { getErrorMessage } from '@/store/chatStoreHelpers';
import { cn } from '@/utils';
import type { OllamaModel } from '@/types';

type CatalogFilter = 'all' | 'local' | 'provider' | 'hidden';

/** Which side of the hovered row a dragged model would land on. */
type DropEdge = 'before' | 'after';

/** Pictures are stored inline, so keep them small enough to serve cheaply. */
const MAX_AVATAR_BYTES = 192_000;

const providerLabelFor = (model: OllamaModel, fallback: string): string =>
  model.isPlugin && model.pluginId ? model.pluginId : fallback;

export const SettingsModelCatalog: React.FC = () => {
  const { t } = useTranslation();
  const models = useChatStore(state => state.models);
  const loadModels = useChatStore(state => state.loadModels);

  const [hidden, setHidden] = useState<string[]>([]);
  const [order, setOrder] = useState<string[]>([]);
  const [metadata, setMetadata] = useState<Record<string, ModelPresentation>>(
    {}
  );
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CatalogFilter>('all');
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    key: string;
    edge: DropEdge;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingAvatarKey = useRef<string | null>(null);

  const catalogModels = useMemo(
    () => models.filter(model => !model.isPersona && !model.isAgent),
    [models]
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await ollamaApi.getModelVisibility();
        if (cancelled || !response.success || !response.data) return;
        const { hidden: h, order: o, metadata: m } = response.data;
        setHidden(h ?? []);
        setOrder(o ?? []);
        setMetadata(m ?? {});
      } catch {
        // An unreadable catalog is an empty one; edits still write through.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const hiddenSet = useMemo(() => new Set(hidden), [hidden]);

  /** Administrator order first, then anything the providers added since. */
  const orderedModels = useMemo(() => {
    const byKey = new Map(
      catalogModels.map(model => [modelVisibilityKey(model), model])
    );
    const ordered: OllamaModel[] = [];
    for (const key of order) {
      const model = byKey.get(key);
      if (model) {
        ordered.push(model);
        byKey.delete(key);
      }
    }
    return [...ordered, ...byKey.values()];
  }, [catalogModels, order]);

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    return orderedModels.filter(model => {
      const key = modelVisibilityKey(model);
      if (filter === 'local' && model.isPlugin) return false;
      if (filter === 'provider' && !model.isPlugin) return false;
      if (filter === 'hidden' && !hiddenSet.has(key)) return false;
      if (!query) return true;
      const label = metadata[key]?.label ?? '';
      return (
        model.name.toLowerCase().includes(query) ||
        label.toLowerCase().includes(query) ||
        providerLabelFor(model, 'ollama').toLowerCase().includes(query)
      );
    });
  }, [orderedModels, search, filter, hiddenSet, metadata]);

  /**
   * Hiding a single model applies at once, the way it did before this screen
   * gained ordering: one switch, one effect, no trip through Save.
   */
  const setEnabled = async (key: string, enabled: boolean) => {
    const previous = hidden;
    const next = enabled
      ? previous.filter(entry => entry !== key)
      : [...previous, key];
    setHidden(next);
    await persist({ hidden: next }, () => setHidden(previous));
  };

  const bulkSet = (enabled: boolean) => {
    const keys = new Set(visibleModels.map(modelVisibilityKey));
    const previous = hidden;
    const next = enabled
      ? previous.filter(entry => !keys.has(entry))
      : [...new Set([...previous, ...keys])];
    setHidden(next);
    void persist({ hidden: next }, () => setHidden(previous));
  };

  /** Drop `fromKey` immediately above or below `toKey`, as shown while dragging. */
  const moveTo = (fromKey: string, toKey: string, edge: DropEdge) => {
    if (fromKey === toKey) return;
    const keys = orderedModels.map(modelVisibilityKey);
    const from = keys.indexOf(fromKey);
    if (from === -1) return;
    keys.splice(from, 1);
    const target = keys.indexOf(toKey);
    if (target === -1) return;
    keys.splice(edge === 'after' ? target + 1 : target, 0, fromKey);
    const previous = order;
    setOrder(keys);
    void persist({ order: keys }, () => setOrder(previous));
  };

  const nextMetadata = (
    current: Record<string, ModelPresentation>,
    key: string,
    patch: ModelPresentation
  ) => {
    const next = { ...current, [key]: { ...current[key], ...patch } };
    if (!next[key].label && !next[key].avatar) delete next[key];
    return next;
  };

  /** Typing stays local; `commit` writes it through. */
  const updateMetadata = (
    key: string,
    patch: ModelPresentation,
    commit = false
  ) => {
    const previous = metadata;
    const next = nextMetadata(previous, key, patch);
    setMetadata(next);
    if (commit) void persist({ metadata: next }, () => setMetadata(previous));
  };

  const handleAvatarPick = (key: string) => {
    pendingAvatarKey.current = key;
    fileInputRef.current?.click();
  };

  const handleAvatarFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const key = pendingAvatarKey.current;
    event.target.value = '';
    if (!file || !key) return;
    if (!file.type.startsWith('image/')) {
      toast.error(t('modelManager.catalog.pictureInvalid'));
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      toast.error(t('modelManager.catalog.pictureTooLarge'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        updateMetadata(key, { avatar: reader.result }, true);
      }
    };
    reader.readAsDataURL(file);
  };

  /**
   * Every edit on this screen writes straight through, so nothing sits in a
   * pending state waiting to be confirmed. On failure the previous value is
   * restored so the list never shows something the server did not accept.
   */
  const persist = async (
    update: Partial<{
      hidden: string[];
      order: string[];
      metadata: Record<string, ModelPresentation>;
    }>,
    revert: () => void
  ) => {
    setSaving(true);
    try {
      const response = await ollamaApi.setModelVisibility(update);
      if (!response.success) {
        revert();
        toast.error(
          response.error ?? t('modelManager.catalog.visibilityFailed')
        );
        return;
      }
      await loadModels();
    } catch (error) {
      revert();
      toast.error(
        getErrorMessage(error, t('modelManager.catalog.visibilityFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const filters: { id: CatalogFilter; label: string }[] = [
    { id: 'all', label: t('modelManager.catalog.filterAll') },
    { id: 'local', label: t('modelManager.catalog.filterLocal') },
    { id: 'provider', label: t('modelManager.catalog.filterProviders') },
    { id: 'hidden', label: t('modelManager.catalog.filterHidden') },
  ];

  return (
    <div className='space-y-3' data-testid='model-catalog'>
      <div className='flex items-baseline justify-between gap-3'>
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
          {t('modelManager.sections.catalog')}
          <span className='ms-2 text-xs font-normal text-gray-500 dark:text-gray-400'>
            {catalogModels.length}
          </span>
        </h4>
        {saving && (
          <span className='text-xs text-gray-500 dark:text-gray-400'>
            {t('modelManager.catalog.saving')}
          </span>
        )}
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-[180px] flex-1'>
          <Search className='pointer-events-none absolute start-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400' />
          <Input
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder={t('modelManager.catalog.searchPlaceholder')}
            className='ps-9'
          />
        </div>
        <select
          value={filter}
          onChange={event => setFilter(event.target.value as CatalogFilter)}
          className='h-9 rounded-lg border border-gray-200 bg-white px-2 text-xs text-gray-700 dark:border-dark-300 dark:bg-dark-100 dark:text-gray-200'
          aria-label={t('modelManager.catalog.filterAll')}
        >
          {filters.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
        <Button size='sm' variant='outline' onClick={() => bulkSet(true)}>
          {t('modelManager.catalog.enableAll')}
        </Button>
        <Button size='sm' variant='outline' onClick={() => bulkSet(false)}>
          {t('modelManager.catalog.disableAll')}
        </Button>
      </div>

      <input
        ref={fileInputRef}
        type='file'
        accept='image/*'
        onChange={handleAvatarFile}
        className='hidden'
      />

      <div className='divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-dark-200/60 dark:border-dark-300'>
        {visibleModels.length === 0 && (
          <p className='px-3 py-6 text-center text-xs text-gray-500 dark:text-gray-400'>
            {catalogModels.length === 0
              ? t('modelManager.catalog.noModels')
              : t('modelManager.catalog.empty')}
          </p>
        )}
        {visibleModels.map(model => {
          const key = modelVisibilityKey(model);
          const entry = metadata[key] ?? {};
          const enabled = !hiddenSet.has(key);
          const isEditing = editing === key;
          return (
            <div
              key={key}
              draggable
              onDragStart={() => setDragKey(key)}
              onDragEnd={() => {
                setDragKey(null);
                setDropTarget(null);
              }}
              onDragOver={event => {
                event.preventDefault();
                if (!dragKey || dragKey === key) return;
                // Which half of the row the pointer is over decides whether
                // the model lands above or below it.
                const rect = event.currentTarget.getBoundingClientRect();
                const edge =
                  event.clientY - rect.top < rect.height / 2
                    ? 'before'
                    : 'after';
                setDropTarget(current =>
                  current?.key === key && current.edge === edge
                    ? current
                    : { key, edge }
                );
              }}
              onDrop={event => {
                event.preventDefault();
                if (dragKey) {
                  moveTo(
                    dragKey,
                    key,
                    dropTarget?.key === key ? dropTarget.edge : 'before'
                  );
                }
                setDragKey(null);
                setDropTarget(null);
              }}
              className={cn(
                'relative flex flex-col gap-2 px-3 py-2',
                dragKey === key && 'opacity-50'
              )}
            >
              {dropTarget?.key === key && dragKey && dragKey !== key && (
                <span
                  aria-hidden='true'
                  className={cn(
                    'pointer-events-none absolute inset-x-0 h-0.5 bg-primary-500',
                    dropTarget.edge === 'before' ? 'top-0' : 'bottom-0'
                  )}
                />
              )}
              <div className='flex w-full min-w-0 items-center gap-2 pe-1'>
                <GripVertical
                  className='h-4 w-4 shrink-0 cursor-grab text-gray-300 dark:text-dark-500'
                  aria-hidden='true'
                />
                <button
                  type='button'
                  onClick={() => handleAvatarPick(key)}
                  title={t('modelManager.catalog.setPicture')}
                  className='flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-gray-200 bg-gray-50 text-gray-400 dark:border-dark-300 dark:bg-dark-200'
                >
                  {entry.avatar ? (
                    <img
                      src={entry.avatar}
                      alt=''
                      className='h-full w-full object-cover'
                    />
                  ) : (
                    <ImageIcon className='h-3.5 w-3.5' />
                  )}
                </button>
                <div className='min-w-0 flex-1'>
                  <span className='block truncate text-sm text-gray-900 dark:text-gray-100'>
                    {entry.label || model.name}
                  </span>
                  <span className='block truncate text-[11px] text-gray-500 dark:text-gray-400'>
                    {entry.label ? `${model.name} · ` : ''}
                    {providerLabelFor(
                      model,
                      t('modelManager.catalog.providerOllama')
                    )}
                  </span>
                </div>
                {!enabled && (
                  <span className='shrink-0 rounded-md bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 dark:bg-dark-200 dark:text-gray-400'>
                    {t('modelManager.catalog.hidden')}
                  </span>
                )}
                <button
                  type='button'
                  onClick={() => setEditing(isEditing ? null : key)}
                  title={t('modelManager.catalog.rename')}
                  className='flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-200'
                >
                  {isEditing ? (
                    <X className='h-3.5 w-3.5' />
                  ) : (
                    <Pencil className='h-3.5 w-3.5' />
                  )}
                </button>
                <button
                  type='button'
                  onClick={() => void setEnabled(key, !enabled)}
                  aria-pressed={!enabled}
                  title={
                    enabled
                      ? t('modelManager.catalog.hide')
                      : t('modelManager.catalog.show')
                  }
                  aria-label={
                    enabled
                      ? t('modelManager.catalog.hide')
                      : t('modelManager.catalog.show')
                  }
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors',
                    enabled
                      ? 'text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-dark-200'
                      : 'text-warning-600 hover:bg-gray-100 dark:text-warning-500 dark:hover:bg-dark-200'
                  )}
                >
                  {enabled ? (
                    <Eye className='h-4 w-4' />
                  ) : (
                    <EyeOff className='h-4 w-4' />
                  )}
                </button>
              </div>

              {isEditing && (
                <div className='flex flex-wrap items-center gap-2 ps-8'>
                  <Input
                    value={entry.label ?? ''}
                    onChange={event =>
                      updateMetadata(key, { label: event.target.value })
                    }
                    onBlur={event =>
                      updateMetadata(key, { label: event.target.value }, true)
                    }
                    placeholder={model.name}
                    className='h-8 max-w-xs text-xs'
                  />
                  {entry.avatar && (
                    <Button
                      size='sm'
                      variant='ghost'
                      onClick={() => updateMetadata(key, { avatar: '' }, true)}
                    >
                      {t('modelManager.catalog.clearPicture')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default SettingsModelCatalog;
