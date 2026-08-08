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
import { Globe } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { SettingsToggle } from '@/components/settings/SettingsToggle';
import { searchApi } from '@/utils/api';

/**
 * Administrator configuration for web search through a SearXNG instance.
 * The backend queries the engine server-side; when enabled, the chat
 * composer offers a search toggle and Work tasks with network access get a
 * web_search tool.
 */
export const SettingsSearchTab: React.FC = () => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    searchApi
      .getConfig()
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        setEnabled(response.data.enabled);
        setUrl(response.data.url ?? '');
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (nextEnabled = enabled) => {
    setSaving(true);
    try {
      const response = await searchApi.setConfig(nextEnabled, url.trim());
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Search settings update failed.');
      }
      setEnabled(response.data.enabled);
      setUrl(response.data.url ?? '');
      toast.success(t('settings.search.saved'));
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('settings.search.saveFailed')
      );
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const response = await searchApi.test();
      if (!response.success || !response.data?.ok) {
        throw new Error(response.error || t('settings.search.testFailed'));
      }
      toast.success(
        t('settings.search.testOk', { results: response.data.results })
      );
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('settings.search.testFailed')
      );
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-gray-100'>
          <Globe className='h-5 w-5 text-primary-500' />
          {t('settings.search.title')}
        </h3>
        <p className='mt-1 text-sm text-gray-500 dark:text-gray-400'>
          {t('settings.search.description')}
        </p>
      </div>

      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
        <div className='flex items-center justify-between gap-4'>
          <div>
            <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
              {t('settings.search.enableLabel')}
            </h4>
            <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
              {t('settings.search.enableDescription')}
            </p>
          </div>
          <SettingsToggle
            checked={enabled}
            onChange={checked => {
              setEnabled(checked);
              void save(checked);
            }}
            disabled={saving || !loaded || (!enabled && !url.trim())}
          />
        </div>
      </div>

      <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4 space-y-3'>
        <label className='block'>
          <span className='mb-1 block text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.search.urlLabel')}
          </span>
          <span className='mb-2 block text-xs text-gray-500 dark:text-gray-400'>
            {t('settings.search.urlDescription')}
          </span>
          <Input
            value={url}
            onChange={event => setUrl(event.target.value)}
            placeholder='http://searxng:8080'
            spellCheck={false}
            dir='ltr'
          />
        </label>
        <div className='flex justify-end gap-2'>
          <Button
            size='sm'
            variant='outline'
            onClick={() => void test()}
            disabled={testing || saving || !enabled}
          >
            {testing ? t('settings.search.testing') : t('settings.search.test')}
          </Button>
          <Button
            size='sm'
            onClick={() => void save()}
            disabled={saving || !loaded}
          >
            {t('settings.search.save')}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SettingsSearchTab;
