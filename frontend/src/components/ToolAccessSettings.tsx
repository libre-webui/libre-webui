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
import { toolsApi } from '@/utils/api/toolsApi';

type ToolAccessMode = 'admins' | 'all-users';

/**
 * Administrator control over who may call tool servers. The backend enforces
 * the mode on every request; this card only reads and writes the setting.
 */
export const ToolAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ToolAccessMode | null>(null);
  const [lockedByEnv, setLockedByEnv] = useState(false);
  const [saving, setSaving] = useState(false);
  // A failed initial fetch would otherwise leave the toggle disabled for
  // the rest of the session; offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    toolsApi
      .getAccessMode()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setMode(response.data.mode);
          setLockedByEnv(response.data.lockedByEnv);
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
    const next: ToolAccessMode = checked ? 'all-users' : 'admins';
    setSaving(true);
    try {
      const response = await toolsApi.setAccessMode(next);
      if (!response.success) {
        throw new Error(response.error || 'Tool access update failed.');
      }
      setMode(next);
      toast.success(t('userManager.tools.saved'));
    } catch {
      toast.error(t('userManager.tools.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.tools.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.tools.description')}
          </p>
          {lockedByEnv && (
            <p className='text-xs text-amber-600 dark:text-amber-400 mt-1'>
              {t('userManager.tools.lockedByEnv')}
            </p>
          )}
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
            disabled={saving || mode === null || lockedByEnv}
          />
        )}
      </div>
    </div>
  );
};

export default ToolAccessSettings;
