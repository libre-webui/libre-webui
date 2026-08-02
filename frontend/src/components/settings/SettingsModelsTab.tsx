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

import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select, Textarea } from '@/components/ui';
import type {
  ChatProviderType,
  OllamaModel,
  SystemInfo,
  User,
  UserPreferences,
} from '@/types';
import { SettingsToggle } from './SettingsToggle';
import {
  chatModelOptionKey,
  chatModelSelectionKeyForModels,
  findChatModelForSelection,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';

interface SelectOption {
  value: string;
  label: string;
}

interface UpdateProgress {
  current: number;
  total: number;
  modelName: string;
  status: 'starting' | 'success' | 'error';
  error?: string;
}

interface SettingsModelsTabProps {
  models: OllamaModel[];
  selectedModel: string;
  selectedProviderType: ChatProviderType | null;
  selectedProviderId: string | null;
  systemMessage: string;
  tempSystemMessage: string;
  loading: boolean;
  user: User | null;
  systemInfo: SystemInfo | null;
  preferences: UserPreferences;
  currentVisionModel: string;
  visionModelOptions: SelectOption[];
  currentTaskModel: string;
  autoTitleTaskModelOptions: SelectOption[];
  updatingModelPullAccess: boolean;
  updatingAllModels: boolean;
  updateProgress: UpdateProgress | null;
  onModelPullAccessToggle: (allowUserModelPull: boolean) => void;
  onModelChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onSystemMessageChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSystemMessageSave: () => void;
  onAutoTitleChange: (autoTitle: boolean) => void;
  onAutoTitleTaskModelChange: (taskModel: string) => void;
  onVisionModelChange: (visionModel: string) => void;
  onUpdateAllModels: () => void;
}

export function SettingsModelsTab({
  models,
  selectedModel,
  selectedProviderType,
  selectedProviderId,
  systemMessage,
  tempSystemMessage,
  loading,
  user,
  systemInfo,
  preferences,
  currentVisionModel,
  visionModelOptions,
  currentTaskModel,
  autoTitleTaskModelOptions,
  updatingModelPullAccess,
  updatingAllModels,
  updateProgress,
  onModelPullAccessToggle,
  onModelChange,
  onSystemMessageChange,
  onSystemMessageSave,
  onAutoTitleChange,
  onAutoTitleTaskModelChange,
  onVisionModelChange,
  onUpdateAllModels,
}: SettingsModelsTabProps) {
  const { t } = useTranslation();
  const selectedSelection = {
    model: selectedModel,
    providerType: selectedProviderType,
    providerId: selectedProviderId,
  };
  const selectorModels = withUnavailableChatModel(models, selectedSelection);
  const selectedModelKey = selectedModel
    ? chatModelSelectionKeyForModels(selectorModels, selectedSelection)
    : '';
  const selectedModelDetails = findChatModelForSelection(
    selectorModels,
    selectedSelection
  );

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.model.title')}
        </h3>
        <div className='space-y-6'>
          {user?.role === 'admin' && (
            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <div className='flex items-center justify-between'>
                <div className='flex flex-col pe-4'>
                  <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                    {t('settings.model.modelPullAccess')}
                  </span>
                  <span className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                    {t('settings.model.modelPullAccessDescription')}
                  </span>
                </div>
                <SettingsToggle
                  checked={systemInfo?.allowUserModelPull ?? true}
                  onChange={onModelPullAccessToggle}
                  disabled={updatingModelPullAccess}
                />
              </div>
            </div>
          )}

          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              {t('settings.model.defaultModel')}
            </label>
            <Select
              value={selectedModelKey}
              onChange={onModelChange}
              options={[
                { value: '', label: t('settings.model.selectModel') },
                ...selectorModels.map(model => ({
                  value: chatModelOptionKey(model),
                  label: model.isLegacySelection
                    ? `${model.name} (provider not recorded${
                        model.isUnavailable ? ', unavailable' : ''
                      })`
                    : model.isPersona
                      ? `${model.personaName} (${t('settings.model.persona')})`
                      : model.isPlugin
                        ? `${model.name} (${model.pluginName || model.pluginId}${
                            model.isUnavailable ? ', unavailable' : ''
                          })`
                        : `${model.name} (Ollama${
                            model.isUnavailable ? ', unavailable' : ''
                          })`,
                })),
              ]}
            />
            <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
              {t('settings.model.defaultModelDescription')}
            </p>
          </div>

          {selectedModel && (
            <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                {t('settings.model.currentModelInfo')}
              </label>
              <div className='bg-gray-50 dark:bg-dark-50 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
                <div className='grid grid-cols-1 sm:grid-cols-2 gap-3'>
                  <ModelInfoItem
                    label={`${t('settings.model.name')}:`}
                    value={selectedModel}
                    truncate
                  />
                  {selectedModelDetails?.details && (
                    <>
                      <ModelInfoItem
                        label={`${t('settings.model.size')}:`}
                        value={selectedModelDetails.details.parameter_size}
                      />
                      <ModelInfoItem
                        label={`${t('settings.model.family')}:`}
                        value={selectedModelDetails.details.family}
                      />
                      <ModelInfoItem
                        label={`${t('settings.model.format')}:`}
                        value={selectedModelDetails.details.format}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              {t('settings.systemMessage.title')}
            </label>
            <Textarea
              value={tempSystemMessage}
              onChange={onSystemMessageChange}
              placeholder={t('settings.systemMessage.placeholder')}
              className='w-full min-h-[100px] bg-gray-50 dark:bg-dark-50 border-gray-200 dark:border-dark-300 text-gray-900 dark:text-gray-100'
              rows={4}
            />
            <div className='flex items-center justify-between mt-3'>
              <p className='text-xs text-gray-500 dark:text-gray-400'>
                {t('settings.systemMessage.description')}
              </p>
              <Button
                onClick={onSystemMessageSave}
                size='sm'
                disabled={loading || tempSystemMessage === systemMessage}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        </div>

        <div className='mt-6'>
          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              {t('settings.model.specializedModels', {
                defaultValue: 'Specialized Models',
              })}
            </label>
            <div className='grid grid-cols-1 gap-5 lg:grid-cols-2'>
              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  {t('settings.model.visionModel', {
                    defaultValue: 'Vision Model',
                  })}
                </label>
                <Select
                  data-testid='vision-model-select'
                  value={currentVisionModel}
                  onChange={event => onVisionModelChange(event.target.value)}
                  options={visionModelOptions}
                />
                <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
                  {t('settings.model.visionModelDescription', {
                    defaultValue:
                      'Used automatically whenever the outgoing chat context contains images. Choose a model that supports image input.',
                  })}
                </p>
              </div>

              <div className='lg:border-s lg:border-gray-200 lg:ps-5 dark:lg:border-dark-300'>
                <div className='flex items-center justify-between'>
                  <div className='flex flex-col pe-4'>
                    <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                      {t('settings.model.autoTitle.enable')}
                    </span>
                    <span className='text-xs text-gray-500 dark:text-gray-400'>
                      {t('settings.model.autoTitle.enableDescription')}
                    </span>
                  </div>
                  <SettingsToggle
                    checked={preferences.titleSettings?.autoTitle || false}
                    onChange={onAutoTitleChange}
                  />
                </div>

                {preferences.titleSettings?.autoTitle && (
                  <div className='mt-4'>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                      {t('settings.model.autoTitle.taskModel')}
                    </label>
                    <Select
                      value={currentTaskModel}
                      onChange={event =>
                        onAutoTitleTaskModelChange(event.target.value)
                      }
                      options={autoTitleTaskModelOptions}
                    />
                    <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
                      {t('settings.model.autoTitle.taskModelDescription')}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className='mt-6'>
          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              {t('settings.model.bulkOperations')}
            </label>
            <div className='space-y-3'>
              <div>
                <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  {t('settings.model.updateAll')}
                </h4>
                <p className='text-xs text-gray-500 dark:text-gray-400 mb-3'>
                  {t('settings.model.updateAllDescription')}
                </p>

                {updatingAllModels && updateProgress && (
                  <UpdateProgressPanel progress={updateProgress} />
                )}

                <Button
                  onClick={onUpdateAllModels}
                  variant='outline'
                  size='sm'
                  className='w-full'
                  disabled={updatingAllModels || loading || models.length === 0}
                >
                  {updatingAllModels
                    ? t('settings.model.updating')
                    : t('settings.model.updateAllButton', {
                        count: models.length,
                      })}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ModelInfoItemProps {
  label: string;
  value?: string;
  truncate?: boolean;
}

function ModelInfoItem({ label, value, truncate = false }: ModelInfoItemProps) {
  return (
    <div className='flex items-center justify-between p-3 bg-white dark:bg-dark-100 rounded-md border border-gray-200 dark:border-dark-300'>
      <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
        {label}
      </span>
      <span
        className={
          truncate
            ? 'text-sm font-semibold text-gray-900 dark:text-gray-100 truncate ms-2'
            : 'text-sm font-semibold text-gray-900 dark:text-gray-100'
        }
      >
        {value}
      </span>
    </div>
  );
}

interface UpdateProgressPanelProps {
  progress: UpdateProgress;
}

function UpdateProgressPanel({ progress }: UpdateProgressPanelProps) {
  const { t } = useTranslation();
  const percent = Math.round((progress.current / progress.total) * 100);

  return (
    <div className='mb-4 space-y-3'>
      <div className='flex items-center justify-between text-xs'>
        <span className='text-gray-600 dark:text-dark-600 font-medium'>
          {t('settings.model.updatingModel', {
            name: progress.modelName,
            current: progress.current,
            total: progress.total,
          })}
        </span>
        <span className='text-primary-600 dark:text-primary-400 font-semibold'>
          {percent}%
        </span>
      </div>
      <div className='w-full bg-gray-200 dark:bg-dark-300 rounded-full h-3 shadow-subtle'>
        <div
          className='bg-gradient-to-r from-primary-500 to-primary-600 dark:from-primary-400 dark:to-primary-500 h-3 rounded-full transition-all duration-500 ease-out shadow-glow'
          style={{
            width: `${(progress.current / progress.total) * 100}%`,
          }}
        />
      </div>
      <div className='text-xs flex items-center justify-between'>
        <span className='text-gray-500 dark:text-dark-500'>
          {t('settings.model.status')}:{' '}
          {progress.status === 'starting' ? (
            <span className='text-accent-500 dark:text-accent-400'>
              {t('settings.model.statusStarting')}
            </span>
          ) : progress.status === 'success' ? (
            <span className='text-success-600 dark:text-success-500'>
              {t('settings.model.statusComplete')}
            </span>
          ) : progress.status === 'error' ? (
            <span className='text-error-600 dark:text-error-500'>
              {t('settings.model.statusError')}: {progress.error}
            </span>
          ) : (
            ''
          )}
        </span>
        <span className='text-gray-400 dark:text-dark-600 text-[10px]'>
          {t('settings.model.modelsProgress', {
            current: progress.current,
            total: progress.total,
          })}
        </span>
      </div>
    </div>
  );
}
