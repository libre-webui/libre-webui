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
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { ollamaApi } from '@/utils/api';
import type { OllamaRuntimeSettings } from '@/utils/api/modelApi';

/**
 * Administrator control over the Ollama provider itself: whether the app
 * treats Ollama as present at all (disabled = no health checks, no polling,
 * no "unavailable" noise on plugin-only installs), and which endpoint the
 * provider talks to — any Ollama-compatible gateway, local or remote.
 */
export const OllamaProviderSettings: React.FC = () => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<OllamaRuntimeSettings | null>(null);
  const [draftUrl, setDraftUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    ollamaApi
      .getSettings()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setSettings(response.data);
          setDraftUrl(response.data.baseUrl);
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

  const applyUpdate = async (update: Partial<OllamaRuntimeSettings>) => {
    setSaving(true);
    try {
      const response = await ollamaApi.updateSettings(update);
      if (!response.success || !response.data) {
        throw new Error(response.message || 'update failed');
      }
      setSettings(response.data);
      setDraftUrl(response.data.baseUrl);
      toast.success(t('userManager.ollamaProvider.saved'));
    } catch {
      toast.error(t('userManager.ollamaProvider.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const urlDirty = settings !== null && draftUrl.trim() !== settings.baseUrl;

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.ollamaProvider.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.ollamaProvider.description')}
          </p>
        </div>
        {settings === null && loadFailed ? (
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
            checked={settings?.enabled === true}
            onChange={checked => void applyUpdate({ enabled: checked })}
            disabled={saving || settings === null}
          />
        )}
      </div>

      {settings !== null && (
        <div className='mt-3 flex items-center gap-2'>
          <input
            className='min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 font-mono text-xs text-gray-900 focus:border-primary-400 focus:outline-none dark:border-dark-300 dark:bg-dark-50 dark:text-gray-100'
            value={draftUrl}
            onChange={event => setDraftUrl(event.target.value)}
            placeholder='http://localhost:11434'
            spellCheck={false}
            aria-label={t('userManager.ollamaProvider.baseUrlLabel')}
          />
          <Button
            size='sm'
            variant='outline'
            onClick={() => void applyUpdate({ baseUrl: draftUrl.trim() })}
            disabled={saving || !urlDirty || !draftUrl.trim()}
          >
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default OllamaProviderSettings;
