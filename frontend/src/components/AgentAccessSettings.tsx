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
import { useChatStore } from '@/store/chatStore';
import { libreClawApi } from '@/utils/api/libreClawApi';
import { agentCliApi } from '@/utils/api/agentCliApi';

/**
 * Independent administrator opt-ins for Libre Claw and installed CLI chat
 * models. Both decisions are enforced by the corresponding backend routes.
 */
export const AgentAccessSettings: React.FC<{ kind?: 'claw' | 'cli' }> = ({
  kind = 'claw',
}) => {
  const { t } = useTranslation();
  const systemInfo = useAuthStore(state => state.systemInfo);
  const setSystemInfo = useAuthStore(state => state.setSystemInfo);
  const loadModels = useChatStore(state => state.loadModels);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [lockedByEnv, setLockedByEnv] = useState(false);
  const [saving, setSaving] = useState(false);
  // A failed initial fetch would otherwise leave the toggle disabled for
  // the rest of the session; offer a retry instead.
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const cli = kind === 'cli';
  const labelKey = cli
    ? 'userManager.agentCliAccess'
    : 'userManager.agentAccess';

  useEffect(() => {
    let cancelled = false;
    const request = cli ? agentCliApi.getAccess() : libreClawApi.access();
    request
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
  }, [loadAttempt, cli]);

  const handleChange = async (checked: boolean) => {
    setSaving(true);
    try {
      const response = await (cli
        ? agentCliApi.setAccess(checked)
        : libreClawApi.setAccess(checked));
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Agent access update failed.');
      }
      setEnabled(response.data.enabled);
      // Update the relevant flag without coupling chat access to navigation.
      if (systemInfo) {
        setSystemInfo({
          ...systemInfo,
          [cli ? 'agentCliModelsEnabled' : 'agentsEnabled']:
            response.data.enabled,
        });
      }
      // The chat picker caches its catalogue independently of navigation.
      await loadModels({ quiet: true });
      toast.success(t('userManager.agentAccess.saved'));
    } catch {
      toast.error(t('userManager.agentAccess.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'
      data-testid={cli ? 'agent-cli-access-settings' : 'agent-access-settings'}
    >
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t(`${labelKey}.title`)}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t(`${labelKey}.description`)}
          </p>
          {lockedByEnv && (
            <p className='text-xs text-amber-600 dark:text-amber-400 mt-1'>
              {t(`${labelKey}.lockedByEnv`)}
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
            disabled={saving || enabled === null || lockedByEnv}
          />
        )}
      </div>
    </div>
  );
};

export default AgentAccessSettings;
