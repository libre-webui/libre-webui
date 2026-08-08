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

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Button } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { useAuthStore } from '@/store/authStore';
import type { WorkAccessMode } from '@/types/work';
import { workApi } from '@/utils/api/workApi';

/**
 * Administrator control over who may use Work. The backend enforces the
 * mode on every request; this card only reads and writes the setting.
 */
export const WorkAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const refreshWorkAccess = useAuthStore(state => state.refreshWorkAccess);
  const [mode, setMode] = useState<WorkAccessMode | null>(null);
  const [saving, setSaving] = useState(false);
  // A failed initial fetch would otherwise leave the toggle disabled for
  // the rest of the session; offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    workApi
      .access()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setMode(response.data.mode);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const handleChange = async (checked: boolean) => {
    const next: WorkAccessMode = checked ? 'all-users' : 'admins';
    setSaving(true);
    try {
      const response = await workApi.setAccess(next);
      if (!response.success) {
        throw new Error('Work access update failed.');
      }
      setMode(next);
      await refreshWorkAccess();
      toast.success(t('userManager.workAccess.saved'));
    } catch {
      toast.error(t('userManager.workAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.workAccess.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.workAccess.description')}
          </p>
        </div>
        {mode === null && loadFailed ? (
          <Button
            size='sm'
            variant='outline'
            onClick={() => {
              setLoadFailed(false);
              setLoadAttempt(attempt => attempt + 1);
            }}
          >
            {t('common.retry')}
          </Button>
        ) : (
          <SettingsToggle
            checked={mode === 'all-users'}
            onChange={handleChange}
            disabled={saving || mode === null}
          />
        )}
      </div>
    </div>
  );
};

export default WorkAccessSettings;
