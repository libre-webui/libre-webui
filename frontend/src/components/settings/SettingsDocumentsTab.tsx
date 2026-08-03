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

import { useCallback, useEffect, useState } from 'react';
import { BookOpen, Check, Database, RotateCcw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@/components/ui';
import { documentsApi } from '@/utils/api';
import type {
  DocumentSummary,
  EmbeddingStatus,
  KnowledgeCollection,
  UserPreferences,
} from '@/types';
import { SettingsToggle } from './SettingsToggle';

type EmbeddingSettings = UserPreferences['embeddingSettings'];

interface SelectOption {
  value: string;
  label: string;
}

interface SettingsDocumentsTabProps {
  settings: EmbeddingSettings;
  effectiveSettings: EmbeddingSettings;
  modelOptions: SelectOption[];
  status: EmbeddingStatus | null;
  regenerating: boolean;
  onSettingChange: (
    key: keyof EmbeddingSettings,
    value: string | number | boolean
  ) => void;
  onReset: () => void;
  onRegenerate: () => void;
  onSave: () => void;
}

export function SettingsDocumentsTab({
  settings,
  effectiveSettings,
  modelOptions,
  status,
  regenerating,
  onSettingChange,
  onReset,
  onRegenerate,
  onSave,
}: SettingsDocumentsTabProps) {
  const { t } = useTranslation();

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.documents.title')}
        </h3>

        <div className='bg-gray-50 dark:bg-dark-50 p-4 rounded-lg border border-gray-200 dark:border-dark-300 space-y-4'>
          <div className='flex items-center justify-between'>
            <div>
              <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                {t('settings.documents.embeddings.title')}
              </h4>
              <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                {t('settings.documents.embeddings.enable')}
              </p>
            </div>
            <SettingsToggle
              checked={settings.enabled}
              onChange={checked => onSettingChange('enabled', checked)}
            />
          </div>

          {settings.enabled && (
            <div className='space-y-4 pt-4 border-t border-gray-200 dark:border-dark-300'>
              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  {t('settings.documents.embeddings.model')}
                </label>
                <Select
                  value={effectiveSettings.model}
                  onChange={event =>
                    onSettingChange('model', event.target.value)
                  }
                  options={modelOptions}
                />
                <p className='text-xs text-gray-500 mt-1'>
                  {t('settings.documents.embeddings.modelDescription')}
                </p>
              </div>

              <RangeSetting
                label={t('settings.documents.embeddings.chunkSize')}
                value={settings.chunkSize}
                min={500}
                max={2000}
                step={100}
                description={t(
                  'settings.documents.embeddings.chunkSizeDescription'
                )}
                onChange={value => onSettingChange('chunkSize', value)}
              />

              <RangeSetting
                label={t('settings.documents.embeddings.chunkOverlap')}
                value={settings.chunkOverlap}
                min={50}
                max={500}
                step={50}
                description={t(
                  'settings.documents.embeddings.chunkOverlapDescription'
                )}
                onChange={value => onSettingChange('chunkOverlap', value)}
              />

              <RangeSetting
                label={t('settings.documents.embeddings.similarityThreshold')}
                value={settings.similarityThreshold}
                min={0.3}
                max={0.9}
                step={0.05}
                description={t(
                  'settings.documents.embeddings.similarityDescription'
                )}
                format={value => value.toFixed(2)}
                onChange={value =>
                  onSettingChange('similarityThreshold', value)
                }
              />
            </div>
          )}
        </div>

        {status && (
          <div className='bg-gray-50 dark:bg-dark-100 p-4 rounded-lg border border-gray-200 dark:border-dark-300'>
            <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-2'>
              {t('settings.documents.embeddings.status')}
            </h4>
            <div className='text-sm text-gray-700 dark:text-gray-300 space-y-1'>
              <div>
                {t('settings.documents.embeddings.statusLabel')}:{' '}
                <span
                  className={
                    status.available
                      ? 'font-medium text-green-600 dark:text-green-400'
                      : 'font-medium text-red-600 dark:text-red-400'
                  }
                >
                  {status.available
                    ? t('settings.documents.embeddings.available')
                    : t('settings.documents.embeddings.unavailable')}
                </span>
              </div>
              <div>
                {t('settings.documents.embeddings.model')}:{' '}
                <span className='font-medium'>{status.model}</span>
              </div>
              <div>
                {t('settings.documents.embeddings.chunksWithEmbeddings')}:{' '}
                <span className='font-medium'>
                  {status.chunksWithEmbeddings} / {status.totalChunks}
                </span>
              </div>
              {status.totalChunks > 0 && (
                <div>
                  {t('settings.documents.embeddings.coverage')}:{' '}
                  <span className='font-medium'>
                    {Math.round(
                      (status.chunksWithEmbeddings / status.totalChunks) * 100
                    )}
                    %
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
          <div className='flex gap-2'>
            <Button
              onClick={onReset}
              variant='outline'
              className='flex items-center gap-2'
            >
              <RotateCcw size={16} />
              {t('settings.generation.resetDefaults')}
            </Button>
            {settings.enabled && status && status.totalChunks > 0 && (
              <Button
                onClick={onRegenerate}
                disabled={regenerating}
                variant='outline'
                className='flex items-center gap-2 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-600 hover:bg-orange-50 dark:hover:bg-orange-900/20'
              >
                <Database size={16} />
                {regenerating
                  ? t('settings.documents.embeddings.regenerating')
                  : t('settings.documents.embeddings.regenerate')}
              </Button>
            )}
          </div>
          <Button onClick={onSave} className='flex items-center gap-2'>
            <Check size={16} />
            {t('settings.saveSettings')}
          </Button>
        </div>

        <KnowledgeCollectionsSection />
      </div>
    </div>
  );
}

function KnowledgeCollectionsSection() {
  const { t } = useTranslation();
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [newName, setNewName] = useState('');

  const reload = useCallback(async () => {
    try {
      const [collectionsResponse, documentsResponse] = await Promise.all([
        documentsApi.getCollections(),
        documentsApi.getDocuments(),
      ]);
      if (collectionsResponse.success && collectionsResponse.data) {
        setCollections(collectionsResponse.data);
      }
      if (documentsResponse.success && documentsResponse.data) {
        setDocuments(documentsResponse.data);
      }
    } catch {
      // Section stays empty when the backend is unreachable.
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    const response = await documentsApi.createCollection(name);
    if (response.success) void reload();
  };

  const handleDelete = async (collectionId: string) => {
    if (!window.confirm(t('settings.documents.collections.deleteConfirm'))) {
      return;
    }
    const response = await documentsApi.deleteCollection(collectionId);
    if (response.success) void reload();
  };

  const handleAssign = async (
    documentId: string,
    collectionId: string | null
  ) => {
    const response = await documentsApi.setDocumentCollection(
      documentId,
      collectionId
    );
    if (response.success) void reload();
  };

  return (
    <div className='pt-4 border-t border-gray-200 dark:border-dark-300'>
      <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-1'>
        {t('settings.documents.collections.title')}
      </h4>
      <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
        {t('settings.documents.collections.description')}
      </p>

      <div className='mb-3 flex gap-2'>
        <input
          value={newName}
          onChange={event => setNewName(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') void handleCreate();
          }}
          placeholder={t('settings.documents.collections.namePlaceholder')}
          className='flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-dark-300 dark:bg-dark-50 dark:text-dark-900'
        />
        <Button
          size='sm'
          onClick={() => void handleCreate()}
          disabled={!newName.trim()}
        >
          {t('settings.documents.collections.create')}
        </Button>
      </div>

      {collections.length > 0 && (
        <div className='mb-4 flex flex-wrap gap-1.5'>
          {collections.map(collection => (
            <span
              key={collection.id}
              className='inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 dark:border-dark-300 dark:bg-dark-200 dark:text-dark-800'
            >
              <BookOpen className='h-3 w-3' />
              {collection.name}
              <span className='tabular-nums text-gray-400 dark:text-dark-500'>
                {collection.documentCount ?? 0}
              </span>
              <button
                onClick={() => void handleDelete(collection.id)}
                className='text-gray-400 transition-colors hover:text-red-500 dark:text-dark-500'
                title={t('common.delete')}
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}

      {documents.length > 0 && collections.length > 0 && (
        <div className='divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-dark-300 dark:border-dark-300'>
          {documents.map(document => (
            <div
              key={document.id}
              className='flex items-center justify-between gap-3 px-3 py-2'
            >
              <p className='min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-dark-900'>
                {document.filename}
              </p>
              <select
                value={document.collectionId ?? ''}
                onChange={event =>
                  void handleAssign(document.id, event.target.value || null)
                }
                className='rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 focus:outline-none dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
              >
                <option value=''>
                  {t('settings.documents.collections.none')}
                </option>
                {collections.map(collection => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface RangeSettingProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  description: string;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}

function RangeSetting({
  label,
  value,
  min,
  max,
  step,
  description,
  format = nextValue => String(nextValue),
  onChange,
}: RangeSettingProps) {
  return (
    <div>
      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
        {label}: {format(value)}
      </label>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className='w-full range-slider'
      />
      <p className='text-xs text-gray-500 mt-1'>{description}</p>
    </div>
  );
}
