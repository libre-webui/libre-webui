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
import { libreClawApi } from '@/utils/api/libreClawApi';

/**
 * Administrator opt-in for the Agents section (Libre Claw and agent CLI
 * models). Disabled by default: agent CLIs run on the host as the server
 * user, outside the Work sandbox. The backend enforces the setting on
 * every request; this card only reads and writes it.
 */
export const AgentAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const systemInfo = useAuthStore(state => state.systemInfo);
  const setSystemInfo = useAuthStore(state => state.setSystemInfo);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lockedByEnv, setLockedByEnv] = useState(false);
  const [saving, setSaving] = useState(false);
  // A failed initial fetch would otherwise leave the toggle disabled for
  // the rest of the session; offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    libreClawApi
      .access()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setEnabled(response.data.enabled);
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
    setSaving(true);
    try {
      const response = await libreClawApi.setAccess(checked);
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Agent access update failed.');
      }
      setEnabled(response.data.enabled);
      // The navigation reads the flag from system info; update it in place
      // so the Agents section appears or disappears without a re-login.
      if (systemInfo) {
        setSystemInfo({ ...systemInfo, agentsEnabled: response.data.enabled });
      }
      toast.success(t('userManager.agentAccess.saved'));
    } catch {
      toast.error(t('userManager.agentAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.agentAccess.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.agentAccess.description')}
          </p>
          {lockedByEnv && (
            <p className='text-xs text-amber-600 dark:text-amber-400 mt-1'>
              {t('userManager.agentAccess.lockedByEnv')}
            </p>
          )}
        </div>
        {enabled === null && loadFailed ? (
          <Button
            size='sm'
            variant='outline'
            onClick={() => setLoadAttempt(attempt => attempt + 1)}
          >
            {t('common.retry')}
          </Button>
        ) : (
          <SettingsToggle
            checked={enabled === true}
            onChange={handleChange}
            disabled={saving || enabled === null || lockedByEnv}
          />
        )}
      </div>
    </div>
  );
};

export default AgentAccessSettings;
