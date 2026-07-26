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

import { Check, ImageIcon, Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@/components/ui';
import type { ImageGenModel, ImageGenPlugin } from '@/utils/api';
import type { ImageGenSettings } from '@/types';
import { SettingsToggle } from './SettingsToggle';

interface SettingsImageGenerationTabProps {
  loading: boolean;
  settings: ImageGenSettings;
  effectiveSettings: ImageGenSettings;
  models: ImageGenModel[];
  plugins: ImageGenPlugin[];
  sizes: string[];
  qualities: string[];
  styles: string[];
  onSettingChange: (
    key: keyof ImageGenSettings,
    value: string | boolean
  ) => void;
  onModelChange: (modelName: string) => void;
  onReset: () => void;
  onSave: () => void;
}

export function SettingsImageGenerationTab({
  loading,
  settings,
  effectiveSettings,
  models,
  plugins,
  sizes,
  qualities,
  styles,
  onSettingChange,
  onModelChange,
  onReset,
  onSave,
}: SettingsImageGenerationTabProps) {
  const { t } = useTranslation();

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.imageGen.title')}
        </h3>
        <p className='text-sm text-gray-600 dark:text-gray-400 mb-6'>
          {t('settings.imageGen.description')}
        </p>

        {loading ? (
          <div className='flex items-center justify-center py-8'>
            <Loader2 className='h-8 w-8 animate-spin text-primary-500' />
            <span className='ms-3 text-gray-600 dark:text-gray-400'>
              {t('settings.imageGen.loadingProviders')}
            </span>
          </div>
        ) : models.length === 0 ? (
          <div className='rounded-lg border border-yellow-200 bg-yellow-500/10 p-4 dark:border-yellow-800 dark:bg-yellow-900/20'>
            <div className='flex items-start gap-3'>
              <ImageIcon className='h-5 w-5 text-yellow-600 dark:text-yellow-400 mt-0.5' />
              <div>
                <h4 className='text-sm font-medium text-ink'>
                  {t('settings.imageGen.noProviders')}
                </h4>
                <p className='mt-1 text-sm text-ink-muted'>
                  {t('settings.imageGen.noProvidersDescription')}
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
                    {t('settings.imageGen.enable')}
                  </h4>
                  <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                    {t('settings.imageGen.enableDescription')}
                  </p>
                </div>
                <SettingsToggle
                  checked={settings.enabled}
                  onChange={checked => onSettingChange('enabled', checked)}
                />
              </div>
            </div>

            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-4'>
                {t('settings.imageGen.configuration')}
              </h4>
              <div className='space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    {t('settings.imageGen.model')}
                  </label>
                  <Select
                    value={effectiveSettings.model}
                    onChange={event => onModelChange(event.target.value)}
                    disabled={!settings.enabled}
                    options={[
                      {
                        value: '',
                        label: t('settings.model.selectModel'),
                      },
                      ...models.map(model => ({
                        value: model.model,
                        label: `${model.model} (${model.plugin})`,
                      })),
                    ]}
                  />
                  <p className='text-xs text-gray-500 mt-1'>
                    {t('settings.imageGen.modelDescription')}
                  </p>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    {t('settings.imageGen.size')}
                  </label>
                  <Select
                    value={effectiveSettings.size}
                    onChange={event =>
                      onSettingChange('size', event.target.value)
                    }
                    disabled={!settings.enabled || sizes.length === 0}
                    options={[
                      ...(sizes.length > 0
                        ? sizes.map(size => ({
                            value: size,
                            label: size,
                          }))
                        : [
                            { value: '1024x1024', label: '1024x1024' },
                            { value: '1792x1024', label: '1792x1024' },
                            { value: '1024x1792', label: '1024x1792' },
                          ]),
                    ]}
                  />
                  <p className='text-xs text-gray-500 mt-1'>
                    {t('settings.imageGen.sizeDescription')}
                  </p>
                </div>

                {qualities.length > 0 && (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      {t('settings.imageGen.quality')}
                    </label>
                    <Select
                      value={effectiveSettings.quality}
                      onChange={event =>
                        onSettingChange('quality', event.target.value)
                      }
                      disabled={!settings.enabled}
                      options={qualities.map(quality => ({
                        value: quality,
                        label:
                          quality.charAt(0).toUpperCase() + quality.slice(1),
                      }))}
                    />
                    <p className='text-xs text-gray-500 mt-1'>
                      {t('settings.imageGen.qualityDescription')}
                    </p>
                  </div>
                )}

                {styles.length > 0 && (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      {t('settings.imageGen.style')}
                    </label>
                    <Select
                      value={effectiveSettings.style}
                      onChange={event =>
                        onSettingChange('style', event.target.value)
                      }
                      disabled={!settings.enabled}
                      options={styles.map(style => ({
                        value: style,
                        label: style.charAt(0).toUpperCase() + style.slice(1),
                      }))}
                    />
                    <p className='text-xs text-gray-500 mt-1'>
                      {t('settings.imageGen.styleDescription')}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {plugins.length > 0 && (
              <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                  {t('settings.imageGen.availableProviders')}
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
                        ({plugin.models?.length || 0}{' '}
                        {t('settings.imageGen.models')})
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
              <Button
                onClick={onReset}
                variant='outline'
                className='flex items-center gap-2'
              >
                <RotateCcw size={16} />
                {t('common.reset')}
              </Button>
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
