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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { ArchiveRestore, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import {
  recoveryApi,
  type RecoveryDrillOverview,
} from '@/utils/api/recoveryApi';

const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

const formatSeconds = (seconds: number | null): string => {
  if (seconds === null) return '—';
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)} min`;
  return `${seconds} s`;
};

/**
 * Verified recovery drills: the instance regularly proves it can back up,
 * restore into an isolated environment, and verify the result. Shows the
 * demonstrated restore time (RTO) and drill spacing (achievable RPO).
 */
export const RecoveryDrillsPanel: React.FC = () => {
  const { t } = useTranslation();
  const { user } = useAuthStore();
  const [overview, setOverview] = useState<RecoveryDrillOverview | null>(null);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await recoveryApi.getDrills();
      if (response.success && response.data) {
        setOverview(response.data);
      }
    } catch {
      // Non-admin or older backend: leave the panel hidden.
    }
  }, []);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [user?.role, load]);

  if (user?.role !== 'admin' || !overview) return null;

  const latest = overview.drills[0];
  const lastPassed = overview.drills.find(drill => drill.status === 'passed');

  const handleRun = async () => {
    setRunning(true);
    try {
      const response = await recoveryApi.runDrill();
      if (response.success && response.data) {
        if (response.data.status === 'passed') {
          toast.success(t('systemPage.recovery.passed'));
        } else {
          toast.error(response.data.error || t('systemPage.recovery.failed'));
        }
      } else {
        toast.error(response.message || t('systemPage.recovery.failed'));
      }
    } catch (error) {
      const apiError = error as { response?: { data?: { message?: string } } };
      toast.error(
        apiError.response?.data?.message || t('systemPage.recovery.failed')
      );
    } finally {
      setRunning(false);
      await load();
    }
  };

  return (
    <section
      data-testid='recovery-drills-panel'
      className='rounded-2xl border border-gray-200 bg-white p-4 dark:border-dark-200 dark:bg-dark-25'
    >
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div>
          <h3 className='flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100'>
            <ArchiveRestore className='h-4 w-4 text-primary-500' />
            {t('systemPage.recovery.title')}
          </h3>
          <p className='mt-0.5 text-xs text-gray-500 dark:text-dark-500'>
            {overview.supported
              ? overview.intervalHours
                ? t('systemPage.recovery.scheduleOn', {
                    hours: overview.intervalHours,
                  })
                : t('systemPage.recovery.scheduleOff')
              : t('systemPage.recovery.teamUnsupported')}
          </p>
        </div>
        {overview.supported && (
          <Button size='sm' onClick={() => void handleRun()} disabled={running}>
            {running ? (
              <span className='flex items-center gap-2'>
                <Loader2 className='h-4 w-4 animate-spin' />
                {t('systemPage.recovery.running')}
              </span>
            ) : (
              t('systemPage.recovery.runNow')
            )}
          </Button>
        )}
      </div>

      {lastPassed && (
        <div className='mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4'>
          <div>
            <p className='text-xs text-gray-500 dark:text-dark-500'>
              {t('systemPage.recovery.lastPassed')}
            </p>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {new Date(lastPassed.startedAt).toLocaleString()}
            </p>
          </div>
          <div>
            <p className='text-xs text-gray-500 dark:text-dark-500'>
              {t('systemPage.recovery.restoreTime')}
            </p>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {lastPassed.restoreMs !== null
                ? `${(lastPassed.restoreMs / 1000).toFixed(1)} s`
                : '—'}
            </p>
          </div>
          <div>
            <p className='text-xs text-gray-500 dark:text-dark-500'>
              {t('systemPage.recovery.drillSpacing')}
            </p>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {formatSeconds(lastPassed.rpoSeconds)}
            </p>
          </div>
          <div>
            <p className='text-xs text-gray-500 dark:text-dark-500'>
              {t('systemPage.recovery.archiveSize')}
            </p>
            <p className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {formatBytes(lastPassed.snapshotBytes)}
            </p>
          </div>
        </div>
      )}

      {latest && latest.status === 'failed' && (
        <p className='mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300'>
          {t('systemPage.recovery.lastFailed', {
            date: new Date(latest.startedAt).toLocaleString(),
          })}
          {latest.error ? ` — ${latest.error}` : ''}
        </p>
      )}

      {overview.drills.length > 0 && (
        <div className='mt-3 max-h-48 overflow-y-auto'>
          <table className='w-full text-xs'>
            <thead>
              <tr className='text-left text-gray-500 dark:text-dark-500'>
                <th className='py-1 pe-3 font-medium'>
                  {t('systemPage.recovery.columns.when')}
                </th>
                <th className='py-1 pe-3 font-medium'>
                  {t('systemPage.recovery.columns.origin')}
                </th>
                <th className='py-1 pe-3 font-medium'>
                  {t('systemPage.recovery.columns.status')}
                </th>
                <th className='py-1 font-medium'>
                  {t('systemPage.recovery.columns.restore')}
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.drills.slice(0, 10).map(drill => (
                <tr
                  key={drill.id}
                  className='border-t border-gray-100 text-gray-700 dark:border-dark-200 dark:text-dark-800'
                >
                  <td className='py-1 pe-3'>
                    {new Date(drill.startedAt).toLocaleString()}
                  </td>
                  <td className='py-1 pe-3'>
                    {drill.origin === 'manual'
                      ? t('systemPage.recovery.originManual')
                      : t('systemPage.recovery.originScheduled')}
                  </td>
                  <td className='py-1 pe-3'>
                    <span
                      className={
                        drill.status === 'passed'
                          ? 'text-green-600 dark:text-green-400'
                          : drill.status === 'failed'
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-gray-500 dark:text-dark-500'
                      }
                    >
                      {t(`systemPage.recovery.status.${drill.status}`)}
                    </span>
                  </td>
                  <td className='py-1'>
                    {drill.restoreMs !== null
                      ? `${(drill.restoreMs / 1000).toFixed(1)} s`
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

export default RecoveryDrillsPanel;
