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
import { authApi } from '@/utils/api';

/**
 * Administrator step-up policy: whether every account must enroll a second
 * factor before password sign-in completes. The backend enforces the policy
 * at the login boundary; this card only reads and writes it.
 */
export const MfaPolicySettings: React.FC = () => {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<{
    mode: 'optional' | 'required';
    locked: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    authApi
      .getMfaPolicy()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setPolicy(response.data);
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
    const next = checked ? ('required' as const) : ('optional' as const);
    setSaving(true);
    try {
      const response = await authApi.setMfaPolicy(next);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'MFA policy update failed.');
      }
      setPolicy(response.data);
      toast.success(t('userManager.mfaPolicy.saved'));
    } catch {
      toast.error(t('userManager.mfaPolicy.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.mfaPolicy.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.mfaPolicy.description')}
          </p>
        </div>
        {policy === null && loadFailed && (
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
        )}
      </div>
      <div className='mt-3 flex items-center justify-between gap-4'>
        <div>
          <p className='text-sm text-gray-900 dark:text-gray-100'>
            {t('userManager.mfaPolicy.requireAll')}
          </p>
          <p className='text-xs text-gray-500 dark:text-gray-400'>
            {policy?.locked
              ? t('userManager.mfaPolicy.lockedByEnv')
              : t('userManager.mfaPolicy.requireAllHint')}
          </p>
        </div>
        <SettingsToggle
          checked={policy?.mode === 'required'}
          disabled={policy === null || policy.locked || saving}
          onChange={handleChange}
        />
      </div>
    </div>
  );
};

export default MfaPolicySettings;
