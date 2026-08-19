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

import React from 'react';
import { useTranslation } from 'react-i18next';
import { History, Loader2 } from 'lucide-react';
import { Button, ModalShell } from '@/components/ui';
import { formatTimestamp } from '@/utils';

export interface VersionEntry {
  version: number;
  /** The revisioned body: prompt content or skill instructions. */
  body: string;
  createdAt: number;
}

interface VersionHistoryModalProps {
  title: string;
  entries: VersionEntry[];
  loading: boolean;
  /** Version currently live; it cannot be rolled back onto itself. */
  currentVersion: number;
  rollingBackTo: number | null;
  onRollback: (version: number) => void;
  onClose: () => void;
  testId?: string;
}

/**
 * Revision list for a versioned resource. Rollback re-saves the picked
 * revision as a new version rather than rewriting history, so nothing a
 * user wrote is ever destroyed.
 */
export const VersionHistoryModal: React.FC<VersionHistoryModalProps> = ({
  title,
  entries,
  loading,
  currentVersion,
  rollingBackTo,
  onRollback,
  onClose,
  testId,
}) => {
  const { t, i18n } = useTranslation();

  return (
    <ModalShell
      titleId='version-history-title'
      title={title}
      subtitle={t('promptsPage.history.subtitle')}
      onClose={onClose}
      widthClassName='max-w-2xl'
      testId={testId}
      footer={
        <Button variant='ghost' size='sm' onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      {loading ? (
        <div className='flex items-center justify-center py-10'>
          <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
        </div>
      ) : entries.length === 0 ? (
        <div className='py-10 text-center'>
          <History className='mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-dark-400' />
          <p className='text-sm text-gray-400 dark:text-dark-500'>
            {t('promptsPage.history.empty')}
          </p>
        </div>
      ) : (
        <div className='space-y-2'>
          {entries.map(entry => (
            <div
              key={entry.version}
              data-testid='version-history-entry'
              className='rounded-2xl border border-black/[0.06] bg-white/60 px-4 py-3 dark:border-white/[0.07] dark:bg-dark-100/60'
            >
              <div className='flex items-center justify-between gap-3'>
                <div className='min-w-0'>
                  <p className='text-[13px] font-medium text-gray-900 dark:text-dark-900'>
                    {t('promptsPage.versionLabel', { version: entry.version })}
                    {entry.version === currentVersion && (
                      <span className='ms-2 rounded-full bg-primary-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-600 dark:text-primary-400'>
                        {t('promptsPage.history.current')}
                      </span>
                    )}
                  </p>
                  <p className='mt-0.5 text-[11px] text-gray-400 dark:text-dark-500'>
                    {formatTimestamp(entry.createdAt, i18n.language)}
                  </p>
                </div>
                <Button
                  size='sm'
                  variant='outline'
                  disabled={
                    entry.version === currentVersion || rollingBackTo !== null
                  }
                  onClick={() => onRollback(entry.version)}
                  data-testid='version-rollback'
                >
                  {rollingBackTo === entry.version
                    ? t('promptsPage.history.rollingBack')
                    : t('promptsPage.history.rollback')}
                </Button>
              </div>
              <pre className='mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/[0.03] p-2.5 text-[11px] leading-5 text-gray-600 scrollbar-thin dark:bg-white/[0.04] dark:text-dark-600'>
                {entry.body}
              </pre>
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
};
