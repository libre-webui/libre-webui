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

import type React from 'react';
import { useTranslation } from 'react-i18next';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { useChatStore } from '@/store/chatStore';
import { formatTimestamp } from '@/utils';
import type {
  ImportMergeStrategy,
  SettingsImportResult,
} from './useSettingsDataImport';

function ArchivedChatsSection() {
  const { t, i18n } = useTranslation();
  const { sessions, setSessionArchived, deleteSession } = useChatStore();
  const archivedSessions = sessions.filter(session => session.archived);

  return (
    <div>
      <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
        {t('settings.data.archivedChats.title')}
      </h3>
      {archivedSessions.length === 0 ? (
        <p className='text-xs text-gray-500 dark:text-gray-400'>
          {t('settings.data.archivedChats.empty')}
        </p>
      ) : (
        <div className='divide-y divide-gray-100 rounded-xl border border-gray-200 dark:divide-dark-300 dark:border-dark-300'>
          {archivedSessions.map(session => (
            <div
              key={session.id}
              className='flex items-center justify-between gap-3 px-3 py-2'
            >
              <div className='min-w-0 flex-1'>
                <p className='truncate text-sm font-medium text-gray-900 dark:text-dark-900'>
                  {session.title}
                </p>
                <p className='text-[11px] tabular-nums text-gray-400 dark:text-dark-500'>
                  {formatTimestamp(session.updatedAt, i18n.language)}
                </p>
              </div>
              <div className='flex shrink-0 items-center gap-1'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => setSessionArchived(session.id, false)}
                  className='h-8 gap-1.5 px-2 text-xs'
                  title={t('settings.data.archivedChats.unarchive')}
                >
                  <ArchiveRestore className='h-3.5 w-3.5' />
                  {t('settings.data.archivedChats.unarchive')}
                </Button>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => {
                    if (window.confirm(t('chat.session.deleteConfirm'))) {
                      void deleteSession(session.id);
                    }
                  }}
                  className='h-8 w-8 p-0 text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20'
                  title={t('chat.session.deleteChat')}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SettingsDataTabProps {
  sessionCount: number;
  loading: boolean;
  importing: boolean;
  showImportOptions: boolean;
  mergeStrategy: ImportMergeStrategy;
  importResult: SettingsImportResult | null;
  importFileInputRef: React.RefObject<HTMLInputElement | null>;
  onExportData: () => void;
  onImportFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onClearAllHistory: () => void;
  onMergeStrategyChange: (strategy: ImportMergeStrategy) => void;
  onConfirmImport: () => void;
  onCancelImport: () => void;
  onDismissImportResult: () => void;
}

export function SettingsDataTab({
  sessionCount,
  loading,
  importing,
  showImportOptions,
  mergeStrategy,
  importResult,
  importFileInputRef,
  onExportData,
  onImportFileSelect,
  onClearAllHistory,
  onMergeStrategyChange,
  onConfirmImport,
  onCancelImport,
  onDismissImportResult,
}: SettingsDataTabProps) {
  const { t } = useTranslation();

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.data.title')}
        </h3>
        <div className='space-y-4'>
          <div className='grid grid-cols-1 md:grid-cols-3 gap-4'>
            <div className='flex flex-col'>
              <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                {t('settings.data.export')}
              </h4>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-3 flex-1'>
                {t('settings.data.exportDescription')}
              </p>
              <p className='mb-3 text-[11px] text-amber-700 dark:text-amber-300'>
                {t('settings.data.archiveScope', {
                  defaultValue:
                    'Excludes accounts and secrets, cloned voices, generated media, personas and notes, and Work data or volumes.',
                })}
              </p>
              <Button
                onClick={onExportData}
                variant='outline'
                size='sm'
                className='w-full'
              >
                {t('settings.data.exportAll')}
              </Button>
            </div>

            <div className='flex flex-col'>
              <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                {t('settings.data.import')}
              </h4>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-3 flex-1'>
                {t('settings.data.importDescription')}
              </p>
              <input
                ref={importFileInputRef}
                type='file'
                accept='.json'
                onChange={onImportFileSelect}
                className='hidden'
              />
              <Button
                onClick={() => importFileInputRef.current?.click()}
                variant='outline'
                size='sm'
                className='w-full'
                disabled={importing}
              >
                {importing
                  ? t('settings.data.importing')
                  : t('settings.data.importData')}
              </Button>
            </div>

            <div className='flex flex-col'>
              <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                {t('settings.data.clearSessions')}
              </h4>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-3 flex-1'>
                {t('settings.data.clearSessionsDescription')}
              </p>
              <Button
                onClick={onClearAllHistory}
                variant='outline'
                size='sm'
                className='w-full text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 border-red-200 hover:border-red-300 dark:border-red-800 dark:hover:border-red-700'
                disabled={sessionCount === 0 || loading}
              >
                {loading
                  ? t('settings.data.clearing')
                  : t('settings.data.clearAll', {
                      count: sessionCount,
                    })}
              </Button>
            </div>
          </div>

          {showImportOptions && (
            <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg'>
              <h5 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-3'>
                {t('settings.data.importOptions')}
              </h5>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                {t('settings.data.importOptionsDescription')}
              </p>
              <div className='space-y-2 mb-4'>
                <label className='flex items-center'>
                  <input
                    type='radio'
                    name='mergeStrategy'
                    value='skip'
                    checked={mergeStrategy === 'skip'}
                    onChange={event =>
                      onMergeStrategyChange(
                        event.target.value as ImportMergeStrategy
                      )
                    }
                    className='me-2'
                  />
                  <span className='text-sm text-gray-700 dark:text-gray-300'>
                    {t('settings.data.skipDuplicates')}
                  </span>
                </label>
                <label className='flex items-center'>
                  <input
                    type='radio'
                    name='mergeStrategy'
                    value='overwrite'
                    checked={mergeStrategy === 'overwrite'}
                    onChange={event =>
                      onMergeStrategyChange(
                        event.target.value as ImportMergeStrategy
                      )
                    }
                    className='me-2'
                  />
                  <span className='text-sm text-gray-700 dark:text-gray-300'>
                    {t('settings.data.overwrite')}
                  </span>
                </label>
              </div>
              <div className='flex gap-2'>
                <Button
                  onClick={onConfirmImport}
                  size='sm'
                  disabled={importing}
                >
                  {importing
                    ? t('settings.data.importing')
                    : t('settings.data.import')}
                </Button>
                <Button onClick={onCancelImport} variant='outline' size='sm'>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          )}

          {importResult && (
            <div className='mt-4 p-4 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg'>
              <h5 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-2'>
                {t('settings.data.importResults')}
              </h5>
              <div className='text-xs text-gray-700 dark:text-gray-300 space-y-1'>
                <div>
                  {t('settings.data.preferences')}:{' '}
                  {importResult.preferences.imported
                    ? t('settings.data.imported')
                    : t('settings.data.failed')}
                </div>
                <div>
                  {t('settings.data.sessions')}:{' '}
                  {importResult.sessions.imported}{' '}
                  {t('settings.data.importedLabel')},{' '}
                  {importResult.sessions.overwritten}{' '}
                  {t('settings.data.overwrittenLabel', {
                    defaultValue: 'overwritten',
                  })}
                  , {importResult.sessions.skipped} {t('settings.data.skipped')}
                </div>
                <div>
                  {t('settings.data.documents')}:{' '}
                  {importResult.documents.imported}{' '}
                  {t('settings.data.importedLabel')},{' '}
                  {importResult.documents.overwritten}{' '}
                  {t('settings.data.overwrittenLabel', {
                    defaultValue: 'overwritten',
                  })}
                  , {importResult.documents.skipped}{' '}
                  {t('settings.data.skipped')}
                </div>
                <div>
                  {t('settings.data.sessionFolders', {
                    defaultValue: 'Session folders',
                  })}
                  : {importResult.sessionFolders.imported}{' '}
                  {t('settings.data.importedLabel')},{' '}
                  {importResult.sessionFolders.overwritten}{' '}
                  {t('settings.data.overwrittenLabel', {
                    defaultValue: 'overwritten',
                  })}
                  , {importResult.sessionFolders.skipped}{' '}
                  {t('settings.data.skipped')}
                </div>
                <div>
                  {t('settings.data.knowledgeCollections', {
                    defaultValue: 'Knowledge collections',
                  })}
                  : {importResult.knowledgeCollections.imported}{' '}
                  {t('settings.data.importedLabel')},{' '}
                  {importResult.knowledgeCollections.overwritten}{' '}
                  {t('settings.data.overwrittenLabel', {
                    defaultValue: 'overwritten',
                  })}
                  , {importResult.knowledgeCollections.skipped}{' '}
                  {t('settings.data.skipped')}
                </div>
                {importResult.warnings.length > 0 && (
                  <div className='mt-2'>
                    <p className='font-medium'>
                      {t('settings.data.warnings', {
                        defaultValue: 'Warnings',
                      })}
                      :
                    </p>
                    {importResult.warnings.map((warning, index) => (
                      <p
                        key={`warning-${index}`}
                        className='text-amber-700 dark:text-amber-300'
                      >
                        • {warning}
                      </p>
                    ))}
                  </div>
                )}
              </div>
              <Button
                onClick={onDismissImportResult}
                variant='outline'
                size='sm'
                className='mt-2'
              >
                {t('common.close')}
              </Button>
            </div>
          )}
        </div>
      </div>

      <ArchivedChatsSection />
    </div>
  );
}
