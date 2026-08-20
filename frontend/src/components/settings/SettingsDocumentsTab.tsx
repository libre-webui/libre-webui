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

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Check,
  Database,
  FileText,
  RotateCcw,
  Trash2,
  X,
  Share2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Button, Select } from '@/components/ui';
import { ShareDialog } from '@/components/ShareDialog';
import { formatFileSize } from '@/utils';
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
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [pendingCollectionDelete, setPendingCollectionDelete] = useState<
    string | null
  >(null);
  const [shareCollection, setShareCollection] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [pendingDocumentDelete, setPendingDocumentDelete] = useState<
    string | null
  >(null);

  const { data } = useQuery({
    queryKey: ['knowledge-collections'],
    queryFn: async (): Promise<{
      collections: KnowledgeCollection[];
      documents: DocumentSummary[];
    }> => {
      const [collectionsResponse, documentsResponse] = await Promise.all([
        documentsApi.getCollections(),
        documentsApi.getDocuments(),
      ]);

      return {
        collections:
          collectionsResponse.success && collectionsResponse.data
            ? collectionsResponse.data
            : [],
        documents:
          documentsResponse.success && documentsResponse.data
            ? documentsResponse.data
            : [],
      };
    },
  });
  const { collections = [], documents = [] } = data ?? {};

  const reload = () =>
    queryClient.invalidateQueries({ queryKey: ['knowledge-collections'] });

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    try {
      const response = await documentsApi.createCollection(name);
      if (!response.success) throw new Error(response.error);
      await reload();
    } catch {
      toast.error(t('settings.documents.collections.createFailed'));
    }
  };

  const handleDeleteCollection = async (collectionId: string) => {
    setPendingCollectionDelete(null);
    try {
      const response = await documentsApi.deleteCollection(collectionId);
      if (!response.success) throw new Error(response.error);
      await reload();
    } catch {
      toast.error(t('settings.documents.collections.deleteFailed'));
    }
  };

  const handleDeleteDocument = async (documentId: string) => {
    setPendingDocumentDelete(null);
    try {
      const response = await documentsApi.deleteDocument(documentId);
      if (!response.success) throw new Error(response.error);
      window.dispatchEvent(new Event('libre:documents-updated'));
      await reload();
    } catch {
      toast.error(t('settings.documents.library.deleteFailed'));
    }
  };

  const handleAssign = async (
    documentId: string,
    collectionId: string | null
  ) => {
    try {
      const response = await documentsApi.setDocumentCollection(
        documentId,
        collectionId
      );
      if (!response.success) throw new Error(response.error);
      await reload();
    } catch {
      toast.error(t('settings.documents.collections.assignFailed'));
    }
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
          {collections.map(collection =>
            pendingCollectionDelete === collection.id ? (
              <span
                key={collection.id}
                className='inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'
              >
                {t('settings.documents.collections.deleteConfirm')}
                <button
                  onClick={() => void handleDeleteCollection(collection.id)}
                  className='font-medium underline decoration-red-400 underline-offset-2 hover:text-red-800 dark:hover:text-red-200'
                >
                  {t('common.delete')}
                </button>
                <button
                  onClick={() => setPendingCollectionDelete(null)}
                  className='text-red-400 hover:text-red-600 dark:hover:text-red-300'
                  title={t('common.cancel')}
                >
                  <X className='h-3 w-3' />
                </button>
              </span>
            ) : (
              <span
                key={collection.id}
                className='inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 dark:border-dark-300 dark:bg-dark-200 dark:text-dark-800'
              >
                <BookOpen className='h-3 w-3' />
                {collection.name}
                <span className='tabular-nums text-gray-400 dark:text-dark-500'>
                  {collection.documentCount ?? 0}
                </span>
                {collection.shared ? (
                  <span className='text-[10px] uppercase text-gray-400 dark:text-dark-500'>
                    {t('settings.documents.collections.shared')}
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() =>
                        setShareCollection({
                          id: collection.id,
                          name: collection.name,
                        })
                      }
                      className='text-gray-400 transition-colors hover:text-primary-500 dark:text-dark-500'
                      title={t('settings.documents.collections.share')}
                      data-testid='collection-share'
                    >
                      <Share2 className='h-3 w-3' />
                    </button>
                    <button
                      onClick={() => setPendingCollectionDelete(collection.id)}
                      className='text-gray-400 transition-colors hover:text-red-500 dark:text-dark-500'
                      title={t('common.delete')}
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </>
                )}
              </span>
            )
          )}
        </div>
      )}

      <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-1'>
        {t('settings.documents.library.title')}
      </h4>
      <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
        {t('settings.documents.library.description')}
      </p>

      {documents.length === 0 ? (
        <p className='text-sm text-gray-500 dark:text-gray-400'>
          {t('settings.documents.library.empty')}
        </p>
      ) : (
        <div className='divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-dark-300 dark:border-dark-300'>
          {documents.map(document => (
            <div
              key={document.id}
              className='flex items-center justify-between gap-3 px-3 py-2'
            >
              {pendingDocumentDelete === document.id ? (
                <>
                  <p className='min-w-0 flex-1 truncate text-sm text-red-700 dark:text-red-300'>
                    {t('settings.documents.library.deleteConfirm', {
                      name: document.filename,
                    })}
                  </p>
                  <Button
                    size='sm'
                    variant='outline'
                    className='text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-900/20'
                    onClick={() => void handleDeleteDocument(document.id)}
                  >
                    {t('common.delete')}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setPendingDocumentDelete(null)}
                  >
                    {t('common.cancel')}
                  </Button>
                </>
              ) : (
                <>
                  <FileText className='h-4 w-4 shrink-0 text-gray-400 dark:text-dark-500' />
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-sm text-gray-900 dark:text-dark-900'>
                      {document.filename}
                    </p>
                    <p className='text-xs text-gray-400 dark:text-dark-500'>
                      {formatFileSize(document.size)}
                      {' · '}
                      {document.sessionId
                        ? t('settings.documents.library.chatScope')
                        : t('settings.documents.library.everyChatScope')}
                    </p>
                  </div>
                  {collections.length > 0 && (
                    <select
                      value={document.collectionId ?? ''}
                      onChange={event =>
                        void handleAssign(
                          document.id,
                          event.target.value || null
                        )
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
                  )}
                  <button
                    onClick={() => setPendingDocumentDelete(document.id)}
                    className='text-gray-400 transition-colors hover:text-red-500 dark:text-dark-500'
                    title={t('common.delete')}
                  >
                    <Trash2 className='h-4 w-4' />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {shareCollection && (
        <ShareDialog
          resourceType='knowledge-collection'
          resourceId={shareCollection.id}
          resourceLabel={shareCollection.name}
          onClose={() => setShareCollection(null)}
        />
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
