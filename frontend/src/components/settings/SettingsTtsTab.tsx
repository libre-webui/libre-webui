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

import { Check, Loader2, Play, RotateCcw, Square, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@/components/ui';
import {
  getTTSModelOptionValue,
  type TTSModel,
  type TTSPlugin,
} from '@/utils/api';
import type { TTSSettings } from '@/types';
import { SettingsToggle } from './SettingsToggle';

interface SettingsTtsTabProps {
  loading: boolean;
  settings: TTSSettings;
  effectiveSettings: TTSSettings;
  models: TTSModel[];
  plugins: TTSPlugin[];
  voices: string[];
  testing: boolean;
  onSettingChange: (
    key: keyof TTSSettings,
    value: string | number | boolean
  ) => void;
  onModelChange: (modelName: string, pluginId: string) => void;
  onReset: () => void;
  onTest: () => void;
  onSave: () => void;
}

export function SettingsTtsTab({
  loading,
  settings,
  effectiveSettings,
  models,
  plugins,
  voices,
  testing,
  onSettingChange,
  onModelChange,
  onReset,
  onTest,
  onSave,
}: SettingsTtsTabProps) {
  const { t } = useTranslation();
  const selectedModel = models.find(
    model =>
      model.model === effectiveSettings.model &&
      (!effectiveSettings.pluginId ||
        model.plugin === effectiveSettings.pluginId)
  );

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.tts.title')}
        </h3>
        <p className='text-sm text-gray-600 dark:text-gray-400 mb-6'>
          {t('settings.tts.description')}
        </p>

        {loading ? (
          <div className='flex items-center justify-center py-8'>
            <Loader2 className='h-8 w-8 animate-spin text-primary-500' />
            <span className='ms-3 text-gray-600 dark:text-gray-400'>
              {t('settings.tts.loadingProviders')}
            </span>
          </div>
        ) : models.length === 0 ? (
          <div className='rounded-lg border border-yellow-200 bg-yellow-500/10 p-4 dark:border-yellow-800 dark:bg-yellow-900/20'>
            <div className='flex items-start gap-3'>
              <Volume2 className='h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5' />
              <div>
                <h4 className='text-sm font-medium text-ink'>
                  {t('settings.tts.noProviders')}
                </h4>
                <p className='mt-1 text-sm text-ink-muted'>
                  {t('settings.tts.noProvidersDescription')}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className='space-y-6'>
            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <div className='flex items-center justify-between'>
                <div>
                  <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {t('settings.tts.enable')}
                  </h4>
                  <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                    {t('settings.tts.enableDescription')}
                  </p>
                </div>
                <SettingsToggle
                  checked={settings.enabled}
                  onChange={checked => onSettingChange('enabled', checked)}
                />
              </div>
            </div>

            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <div className='flex items-center justify-between'>
                <div>
                  <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {t('settings.tts.autoPlay')}
                  </h4>
                  <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                    {t('settings.tts.autoPlayDescription')}
                  </p>
                </div>
                <SettingsToggle
                  checked={settings.autoPlay}
                  disabled={!settings.enabled}
                  onChange={checked => onSettingChange('autoPlay', checked)}
                />
              </div>
            </div>

            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <div className='flex items-center justify-between'>
                <div>
                  <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {t('settings.tts.streamSentences')}
                  </h4>
                  <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                    {t('settings.tts.streamSentencesDescription')}
                  </p>
                </div>
                <SettingsToggle
                  checked={settings.streamSentences !== false}
                  disabled={!settings.enabled}
                  onChange={checked =>
                    onSettingChange('streamSentences', checked)
                  }
                />
              </div>
            </div>

            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-4'>
                {t('settings.tts.voiceConfiguration')}
              </h4>
              <div className='space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    {t('settings.tts.model')}
                  </label>
                  <Select
                    aria-label={t('settings.tts.model')}
                    value={
                      selectedModel ? getTTSModelOptionValue(selectedModel) : ''
                    }
                    onChange={event => {
                      const model = models.find(
                        candidate =>
                          getTTSModelOptionValue(candidate) ===
                          event.target.value
                      );
                      if (model) onModelChange(model.model, model.plugin);
                    }}
                    disabled={!settings.enabled}
                    options={[
                      {
                        value: '',
                        label: t('settings.model.selectModel'),
                      },
                      ...models.map(model => ({
                        value: getTTSModelOptionValue(model),
                        label: `${model.model} (${model.plugin})`,
                        key: `${model.plugin}:${model.model}`,
                      })),
                    ]}
                  />
                  <p className='text-xs text-gray-500 mt-1'>
                    {t('settings.tts.modelDescription')}
                  </p>
                </div>

                {voices.length > 0 ? (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      {t('settings.tts.voice')}
                    </label>
                    <Select
                      aria-label={t('settings.tts.voice')}
                      value={effectiveSettings.voice}
                      onChange={event =>
                        onSettingChange('voice', event.target.value)
                      }
                      disabled={!settings.enabled}
                      options={[
                        { value: '', label: t('settings.tts.selectVoice') },
                        ...voices.map(voice => ({
                          value: voice,
                          label: voice.charAt(0).toUpperCase() + voice.slice(1),
                        })),
                      ]}
                    />
                    <p className='text-xs text-gray-500 mt-1'>
                      {t('settings.tts.voiceDescription')}
                    </p>
                  </div>
                ) : (
                  <p className='rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-dark-50 dark:text-gray-400'>
                    {t('settings.tts.providerDefaultVoice')}
                  </p>
                )}
              </div>
            </div>

            {selectedModel?.config?.supports_voice_cloning && (
              <div className='rounded-lg border border-primary-500/20 bg-primary-500/[0.06] p-4'>
                <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
                  {t('settings.tts.voiceCloningAvailable')}
                </h4>
                <p className='mt-1 text-xs text-gray-600 dark:text-gray-400'>
                  {t('settings.tts.voiceCloningAvailableDescription')}
                </p>
              </div>
            )}

            {plugins.length > 0 && (
              <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                  {t('settings.tts.availableProviders')}
                </h4>
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-2'>
                  {plugins.map(plugin => (
                    <div
                      key={plugin.id}
                      className='flex items-center gap-2 p-2 bg-white dark:bg-dark-100 rounded border border-gray-200 dark:border-dark-300'
                    >
                      <div className='w-2 h-2 rounded-full bg-green-500' />
                      <span className='text-sm text-gray-700 dark:text-gray-300'>
                        {plugin.name}
                      </span>
                      <span className='text-xs text-gray-500 dark:text-gray-400'>
                        ({plugin.models?.length || 0} {t('settings.tts.models')}
                        )
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
              <div className='flex gap-2'>
                <Button
                  onClick={onReset}
                  variant='outline'
                  className='flex items-center gap-2'
                >
                  <RotateCcw size={16} />
                  {t('common.reset')}
                </Button>
                <Button
                  onClick={onTest}
                  variant='outline'
                  disabled={!settings.enabled || !effectiveSettings.model}
                  className='flex items-center gap-2'
                >
                  {testing ? (
                    <>
                      <Square size={16} />
                      {t('settings.tts.stop')}
                    </>
                  ) : (
                    <>
                      <Play size={16} />
                      {t('settings.tts.test')}
                    </>
                  )}
                </Button>
              </div>
              <Button onClick={onSave} className='flex items-center gap-2'>
                <Check size={16} />
                {t('settings.saveSettings')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
