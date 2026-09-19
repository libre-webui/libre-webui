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

/**
 * Administrator opt-in for the embedded Cordis engine.
 *
 * The engine runs tools with real filesystem access that Libre WebUI's tool
 * approval flow does not mediate, so it ships disabled and an administrator
 * turns it on here — the same posture as the Agents section.
 *
 * Toggling takes effect immediately in both directions: enabling starts the
 * engine on its next request, and disabling disposes it. There is no restart
 * step, which is why this card is the intended way to manage the feature
 * rather than editing `cordis.config.yml`.
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { Button } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { useAuthStore } from '@/store/authStore';
import { useChatStore } from '@/store/chatStore';
import cordisApi from '@/utils/api/cordisApi';

export const CordisAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const systemInfo = useAuthStore(state => state.systemInfo);
  const setSystemInfo = useAuthStore(state => state.setSystemInfo);
  const loadModels = useChatStore(state => state.loadModels);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lockedBy, setLockedBy] = useState<'env' | 'config-file' | null>(null);
  const [saving, setSaving] = useState(false);
  // A failed initial fetch would otherwise leave the toggle disabled for the
  // rest of the session; offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    cordisApi
      .getAccess()
      .then(access => {
        if (cancelled) return;
        setEnabled(access.enabled);
        setLockedBy(access.lockedByEnv ? (access.lockedBy ?? 'env') : null);
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
      const access = await cordisApi.setAccess(checked);
      setEnabled(access.enabled);
      // The sidebar and the route guard read the flag from system info; update
      // it in place so the Cordis Engine section appears or disappears without
      // a re-login.
      if (systemInfo) {
        setSystemInfo({ ...systemInfo, cordisEnabled: access.enabled });
      }
      await loadModels({ quiet: true });
      toast.success(t('userManager.cordisAccess.saved'));
    } catch {
      // A pinned value is the one failure an operator can act on, and the
      // server names the source in its message.
      toast.error(t('userManager.cordisAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'
      data-testid='cordis-access-settings'
    >
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.cordisAccess.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.cordisAccess.description')}
          </p>
          {lockedBy && (
            <p
              className='text-xs text-amber-600 dark:text-amber-400 mt-1'
              data-testid='cordis-access-locked'
            >
              {lockedBy === 'env'
                ? t('userManager.cordisAccess.lockedByEnv')
                : t('userManager.cordisAccess.lockedByFile')}
            </p>
          )}
        </div>
        {enabled === null && loadFailed ? (
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
            checked={enabled === true}
            onChange={handleChange}
            disabled={saving || enabled === null || lockedBy !== null}
          />
        )}
      </div>
    </div>
  );
};

export default CordisAccessSettings;
