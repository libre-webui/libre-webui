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

import {
  Check,
  Loader2,
  Play,
  RotateCcw,
  ShieldOff,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@/components/ui';
import {
  getTTSModelOptionValue,
  type TTSModel,
  type TTSPlugin,
  type TTSVoiceProfile,
} from '@/utils/api';
import type { TTSSettings } from '@/types';
import { unlockTTSAudioPlayback } from '@/utils/ttsBatching';
import { SettingsToggle } from './SettingsToggle';

interface SettingsTtsTabProps {
  loading: boolean;
  settings: TTSSettings;
  effectiveSettings: TTSSettings;
  models: TTSModel[];
  plugins: TTSPlugin[];
  voices: string[];
  voiceProfiles: TTSVoiceProfile[];
  selectableVoiceProfiles: TTSVoiceProfile[];
  loadingVoiceProfiles: boolean;
  testing: boolean;
  onSettingChange: (
    key: keyof TTSSettings,
    value: string | number | boolean
  ) => void;
  onModelChange: (modelName: string, pluginId: string) => void;
  onVoiceChange: (voice: string, voiceProfileId: string) => void;
  onDeleteVoiceProfile: (profile: TTSVoiceProfile) => void;
  onRevokeVoiceProfile: (profile: TTSVoiceProfile) => void;
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
  voiceProfiles,
  selectableVoiceProfiles,
  loadingVoiceProfiles,
  testing,
  onSettingChange,
  onModelChange,
  onVoiceChange,
  onDeleteVoiceProfile,
  onRevokeVoiceProfile,
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
                  onChange={checked => {
                    // Invoke resume synchronously while this checkbox change
                    // still carries browser user activation.
                    if (checked) void unlockTTSAudioPlayback();
                    onSettingChange('autoPlay', checked);
                  }}
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

                {voices.length > 0 || selectableVoiceProfiles.length > 0 ? (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      {t('settings.tts.voice')}
                    </label>
                    <Select
                      aria-label={t('settings.tts.voice')}
                      value={
                        effectiveSettings.voiceProfileId
                          ? savedVoiceOptionValue(
                              effectiveSettings.voiceProfileId
                            )
                          : effectiveSettings.voice
                      }
                      onChange={event => {
                        const savedVoiceId = parseSavedVoiceOptionValue(
                          event.target.value
                        );
                        onVoiceChange(
                          savedVoiceId ? '' : event.target.value,
                          savedVoiceId || ''
                        );
                      }}
                      disabled={!settings.enabled}
                      options={[
                        { value: '', label: t('settings.tts.selectVoice') },
                        ...voices.map(voice => ({
                          value: voice,
                          label: voice.charAt(0).toUpperCase() + voice.slice(1),
                        })),
                        ...selectableVoiceProfiles.map(profile => ({
                          value: savedVoiceOptionValue(profile.id),
                          label: t('settings.tts.savedVoiceOption', {
                            name: profile.name,
                            defaultValue: '{{name}} (saved voice)',
                          }),
                          key: `saved-voice-${profile.id}`,
                        })),
                      ]}
                    />
                    <p className='text-xs text-gray-500 mt-1'>
                      {t('settings.tts.voiceDescription')}
                    </p>
                  </div>
                ) : loadingVoiceProfiles ? (
                  <div className='flex items-center gap-2 rounded-lg bg-gray-50 p-3 text-xs text-gray-600 dark:bg-dark-50 dark:text-gray-400'>
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    {t('settings.tts.loadingSavedVoices', {
                      defaultValue: 'Loading saved voices…',
                    })}
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

      {(loadingVoiceProfiles || voiceProfiles.length > 0) && (
        <div className='rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
          <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
            {t('settings.tts.savedVoices', {
              defaultValue: 'Saved voices',
            })}
          </h4>
          {loadingVoiceProfiles ? (
            <div className='mt-3 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              {t('settings.tts.loadingSavedVoices', {
                defaultValue: 'Loading saved voices…',
              })}
            </div>
          ) : (
            <div className='mt-3 space-y-2'>
              {voiceProfiles.map(profile => (
                <div
                  key={profile.id}
                  className='flex items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 dark:border-dark-300 dark:bg-dark-50'
                >
                  <div className='min-w-0'>
                    <p className='truncate text-sm text-gray-800 dark:text-gray-200'>
                      {profile.name}
                      {profile.consentStatus === 'revoked' && (
                        <span className='ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400'>
                          {t('settings.tts.consentRevoked', {
                            defaultValue: 'Consent withdrawn',
                          })}
                        </span>
                      )}
                      {profile.consentStatus === 'expired' && (
                        <span className='ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'>
                          {t('settings.tts.consentExpired', {
                            defaultValue: 'Consent expired',
                          })}
                        </span>
                      )}
                    </p>
                    <p className='truncate text-xs text-gray-500 dark:text-gray-400'>
                      {profile.pluginId} · {profile.model}
                      {' · '}
                      {t('settings.tts.transferCount', {
                        total: profile.transferCount ?? 0,
                        defaultValue: 'sent to provider {{total}}×',
                      })}
                      {profile.consentExpiresAt &&
                        profile.consentStatus === 'active' && (
                          <>
                            {' · '}
                            {t('settings.tts.consentExpires', {
                              date: new Intl.DateTimeFormat(undefined, {
                                dateStyle: 'medium',
                              }).format(profile.consentExpiresAt),
                              defaultValue: 'consent until {{date}}',
                            })}
                          </>
                        )}
                    </p>
                  </div>
                  {(profile.consentStatus ?? 'active') === 'active' && (
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={() => onRevokeVoiceProfile(profile)}
                      aria-label={t('settings.tts.revokeSavedVoice', {
                        name: profile.name,
                        defaultValue: 'Withdraw consent for {{name}}',
                      })}
                      className='shrink-0 px-2 text-amber-600 hover:bg-amber-50 hover:text-amber-700 dark:hover:bg-amber-950/30'
                    >
                      <ShieldOff className='h-4 w-4' />
                    </Button>
                  )}
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={() => onDeleteVoiceProfile(profile)}
                    aria-label={t('settings.tts.deleteSavedVoice', {
                      name: profile.name,
                      defaultValue: 'Delete saved voice {{name}}',
                    })}
                    className='shrink-0 px-2 text-red-600 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30'
                  >
                    <Trash2 className='h-4 w-4' />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SAVED_VOICE_OPTION_PREFIX = '__saved_voice__:';

function savedVoiceOptionValue(id: string): string {
  return `${SAVED_VOICE_OPTION_PREFIX}${id}`;
}

function parseSavedVoiceOptionValue(value: string): string | undefined {
  return value.startsWith(SAVED_VOICE_OPTION_PREFIX)
    ? value.slice(SAVED_VOICE_OPTION_PREFIX.length)
    : undefined;
}
