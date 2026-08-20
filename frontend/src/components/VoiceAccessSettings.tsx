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
import {
  voiceAccessApi,
  type VoiceAccessModes,
  type VoiceFeatureKey,
} from '@/utils/api/voiceAccessApi';

const FEATURES: Array<{ key: VoiceFeatureKey; labelKey: string }> = [
  { key: 'stt', labelKey: 'userManager.voice.features.stt' },
  { key: 'tts', labelKey: 'userManager.voice.features.tts' },
  { key: 'voice-mode', labelKey: 'userManager.voice.features.voiceMode' },
  {
    key: 'voice-cloning',
    labelKey: 'userManager.voice.features.voiceCloning',
  },
];

/**
 * Administrator control over the voice governance modes: who may use STT,
 * TTS, hands-free voice mode, and voice cloning. The backend enforces each
 * mode on every request; this card only reads and writes the settings.
 */
export const VoiceAccessSettings: React.FC = () => {
  const { t } = useTranslation();
  const [modes, setModes] = useState<VoiceAccessModes | null>(null);
  const [saving, setSaving] = useState<VoiceFeatureKey | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    voiceAccessApi
      .getModes()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setModes(response.data);
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

  const handleChange = async (feature: VoiceFeatureKey, checked: boolean) => {
    const next = checked ? ('all-users' as const) : ('admins' as const);
    setSaving(feature);
    try {
      const response = await voiceAccessApi.setMode(feature, next);
      if (!response.success) {
        throw new Error(response.error || 'Voice access update failed.');
      }
      setModes(current =>
        current
          ? { ...current, [feature]: { ...current[feature], mode: next } }
          : current
      );
      toast.success(t('userManager.voice.saved'));
    } catch {
      toast.error(t('userManager.voice.saveFailed'));
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
      <div className='flex items-start justify-between gap-4'>
        <div>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('userManager.voice.title')}
          </h4>
          <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
            {t('userManager.voice.description')}
          </p>
        </div>
        {modes === null && loadFailed && (
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
      <div className='mt-3 space-y-2'>
        {FEATURES.map(feature => {
          const entry = modes?.[feature.key];
          return (
            <div
              key={feature.key}
              className='flex items-center justify-between gap-4'
            >
              <div>
                <p className='text-xs text-gray-700 dark:text-gray-300'>
                  {t(feature.labelKey)}
                </p>
                {entry?.lockedByEnv && (
                  <p className='text-xs text-amber-600 dark:text-amber-400'>
                    {t('userManager.voice.lockedByEnv')}
                  </p>
                )}
              </div>
              <SettingsToggle
                checked={entry?.mode === 'all-users'}
                onChange={checked => handleChange(feature.key, checked)}
                disabled={
                  entry === undefined ||
                  saving === feature.key ||
                  entry.lockedByEnv
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VoiceAccessSettings;
