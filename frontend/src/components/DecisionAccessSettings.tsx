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

import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Button } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import {
  decisionsApi,
  type DecisionAccessState,
} from '@/utils/api/decisionsApi';

/**
 * Administrator control over who may use decision models, in Chat and
 * through the Decisions API. The backend enforces the mode on every request;
 * this card only reads and writes it.
 */
export const DecisionAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const titleId = useId();
  const [access, setAccess] = useState<DecisionAccessState | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    decisionsApi
      .getAccess()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) setAccess(response.data);
        else setLoadFailed(true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const handleChange = async (checked: boolean) => {
    const next = checked ? ('all-users' as const) : ('admins' as const);
    setSaving(true);
    try {
      const response = await decisionsApi.setAccessMode(next);
      if (!response.success) {
        throw new Error('Decision models access update failed.');
      }
      setAccess(current => (current ? { ...current, mode: next } : current));
      toast.success(t('userManager.decisionAccess.saved'));
    } catch {
      toast.error(t('userManager.decisionAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      data-testid='decision-access-settings'
      className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'
    >
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4
            id={titleId}
            className='text-sm font-medium text-gray-900 dark:text-gray-100'
          >
            {t('userManager.decisionAccess.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.decisionAccess.description')}
          </p>
          {access?.lockedByEnv && (
            <p className='text-xs text-amber-600 dark:text-amber-400 mt-1'>
              {t('userManager.decisionAccess.lockedByEnv')}
            </p>
          )}
        </div>
        {access === null && loadFailed ? (
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
            aria-labelledby={titleId}
            checked={access?.mode === 'all-users'}
            onChange={checked => void handleChange(checked)}
            disabled={saving || access === null || access.lockedByEnv}
          />
        )}
      </div>
    </div>
  );
};

export default DecisionAccessSettings;
