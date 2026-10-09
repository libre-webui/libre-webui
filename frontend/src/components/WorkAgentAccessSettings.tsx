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
import type { WorkAgentAccessMode } from '@/types/work';
import { workApi } from '@/utils/api';

const MODES: readonly WorkAgentAccessMode[] = [
  'disabled',
  'admins',
  'all-users',
];

/**
 * Administrator control over who may run agent CLIs inside Work sandboxes.
 * The backend enforces the mode on every Work request and run; this card
 * only reads and writes the setting. Keys live in Settings → Connections.
 */
export const WorkAgentAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<WorkAgentAccessMode | null>(null);
  const [lockedByEnv, setLockedByEnv] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    workApi
      .agentAccess()
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

  const handleChange = async (next: WorkAgentAccessMode) => {
    setSaving(true);
    try {
      const response = await workApi.setAgentAccess(next);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Agent access update failed.');
      }
      setMode(response.data.mode);
      toast.success(t('userManager.workAgentAccess.saved'));
    } catch {
      toast.error(t('userManager.workAgentAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'
      data-testid='work-agent-access-settings'
    >
      <div className='flex flex-wrap items-center justify-between gap-4'>
        <div className='min-w-0 flex-1'>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.workAgentAccess.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.workAgentAccess.description')}
          </p>
          {lockedByEnv && (
            <p className='text-xs text-amber-600 dark:text-amber-400 mt-1'>
              {t('userManager.workAgentAccess.lockedByEnv')}
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
              data-testid='work-agent-access-mode'
              aria-label={t('userManager.workAgentAccess.title')}
              value={mode ?? 'disabled'}
              disabled={saving || mode === null || lockedByEnv}
              onChange={event =>
                void handleChange(event.target.value as WorkAgentAccessMode)
              }
              options={MODES.map(value => ({
                value,
                label: t(`userManager.workAgentAccess.modes.${value}`),
              }))}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkAgentAccessSettings;
