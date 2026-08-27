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

import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';

export interface BulkModelUpdateProgress {
  current: number;
  total: number;
  modelName: string;
  status: 'starting' | 'success' | 'error';
  error?: string;
}

interface BulkOperationsSectionProps {
  modelCount: number;
  updating: boolean;
  progress: BulkModelUpdateProgress | null;
  onUpdateAll: () => void;
}

export function BulkOperationsSection({
  modelCount,
  updating,
  progress,
  onUpdateAll,
}: BulkOperationsSectionProps) {
  const { t } = useTranslation();

  return (
    <section
      data-testid='model-manager-bulk-operations'
      aria-labelledby='model-manager-bulk-operations-title'
      aria-busy={updating}
      className={cn(
        'rounded-2xl border p-4',
        'bg-white/60 dark:bg-white/[0.03]',
        'border-gray-200/80 dark:border-white/10'
      )}
    >
      <h3
        id='model-manager-bulk-operations-title'
        className='text-lg font-semibold text-gray-900 dark:text-dark-800'
      >
        {t('settings.model.bulkOperations')}
      </h3>
      <div className='mt-4'>
        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
          {t('settings.model.updateAll')}
        </h4>
        <p className='mb-3 mt-2 text-xs text-gray-500 dark:text-gray-400'>
          {t('settings.model.updateAllDescription')}
        </p>

        {updating && progress && <UpdateProgressPanel progress={progress} />}

        <Button
          onClick={onUpdateAll}
          variant='outline'
          size='sm'
          className='w-full'
          disabled={updating || modelCount === 0}
          aria-busy={updating}
        >
          {updating
            ? t('settings.model.updating')
            : t('settings.model.updateAllButton', { count: modelCount })}
        </Button>
      </div>
    </section>
  );
}

interface UpdateProgressPanelProps {
  progress: BulkModelUpdateProgress;
}

function UpdateProgressPanel({ progress }: UpdateProgressPanelProps) {
  const { t } = useTranslation();
  const percent =
    progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  return (
    <div className='mb-4 space-y-3' aria-live='polite'>
      <div className='flex items-center justify-between text-xs'>
        <span className='font-medium text-gray-600 dark:text-dark-600'>
          {t('settings.model.updatingModel', {
            name: progress.modelName,
            current: progress.current,
            total: progress.total,
          })}
        </span>
        <span className='font-semibold text-primary-600 dark:text-primary-400'>
          {percent}%
        </span>
      </div>
      <div
        role='progressbar'
        aria-label={t('settings.model.updateAll')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className='h-3 w-full rounded-full bg-gray-200 dark:bg-dark-300'
      >
        <div
          className='h-3 rounded-full bg-primary-600 transition-[width] duration-150 ease-out motion-reduce:transition-none dark:bg-primary-400'
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className='flex items-center justify-between text-xs'>
        <span className='text-gray-500 dark:text-dark-500'>
          {t('settings.model.status')}:{' '}
          {progress.status === 'starting' ? (
            <span className='text-accent-500 dark:text-accent-400'>
              {t('settings.model.statusStarting')}
            </span>
          ) : progress.status === 'success' ? (
            <span className='text-success-600 dark:text-success-500'>
              {t('settings.model.statusComplete')}
            </span>
          ) : (
            <span className='text-error-600 dark:text-error-500'>
              {t('settings.model.statusError')}: {progress.error}
            </span>
          )}
        </span>
        <span className='text-[10px] text-gray-400 dark:text-dark-600'>
          {t('settings.model.modelsProgress', {
            current: progress.current,
            total: progress.total,
          })}
        </span>
      </div>
    </div>
  );
}
