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
import { Button, Select } from '@/components/ui';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import type { StrandsAccessMode } from '@/types';
import { strandsApi } from '@/utils/api/strandsApi';

const MODES: readonly StrandsAccessMode[] = ['disabled', 'admins', 'all-users'];

/**
 * Administrator control over who may use the embedded Strands agent engine.
 * The backend enforces the mode on every REST, WebSocket, and Work request;
 * this card only reads and writes the setting.
 */
export const StrandsAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const systemInfo = useAuthStore(state => state.systemInfo);
  const setSystemInfo = useAuthStore(state => state.setSystemInfo);
  const loadModels = useChatStore(state => state.loadModels);
  const [mode, setMode] = useState<StrandsAccessMode | null>(null);
  const [lockedByEnv, setLockedByEnv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    strandsApi
      .getAccess()
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

  const handleChange = async (next: StrandsAccessMode) => {
    setSaving(true);
    try {
      const response = await strandsApi.setAccess(next);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Strands access update failed.');
      }
      setMode(response.data.mode);
      if (systemInfo) {
        setSystemInfo({ ...systemInfo, strandsAccess: response.data.mode });
      }
      // The chat picker caches its catalogue independently of navigation.
      await loadModels({ quiet: true });
      toast.success(t('userManager.strandsAccess.saved'));
    } catch {
      toast.error(t('userManager.strandsAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'
      data-testid='strands-access-settings'
    >
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div className='min-w-0 flex-1'>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.strandsAccess.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.strandsAccess.description')}
          </p>
          {lockedByEnv && (
            <p className='text-xs text-amber-600 dark:text-amber-400 mt-1'>
              {t('userManager.strandsAccess.lockedByEnv')}
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
          <div className='w-44'>
            <Select
              data-testid='strands-access-mode'
              aria-label={t('userManager.strandsAccess.title')}
              value={mode ?? 'disabled'}
              disabled={saving || mode === null || lockedByEnv}
              onChange={event =>
                void handleChange(event.target.value as StrandsAccessMode)
              }
              options={MODES.map(value => ({
                value,
                label: t(`userManager.strandsAccess.modes.${value}`),
              }))}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default StrandsAccessSettings;
