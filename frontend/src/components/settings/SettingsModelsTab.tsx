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
import type { ChatProviderType, OllamaModel, UserPreferences } from '@/types';
import { SettingsToggle } from './SettingsToggle';
import {
  chatModelOptionKey,
  chatModelSelectionKeyForModels,
  findChatModelForSelection,
  withUnavailableChatModel,
} from '@/utils/chatModelSelection';
import { SettingsModelCatalog } from '@/components/settings/SettingsModelCatalog';
import { useAuthStore } from '@/store/authStore';

interface SelectOption {
  value: string;
  label: string;
}

interface SettingsModelsTabProps {
  models: OllamaModel[];
  selectedModel: string;
  selectedProviderType: ChatProviderType | null;
  selectedProviderId: string | null;
  systemMessage: string;
  tempSystemMessage: string;
  loading: boolean;
  preferences: UserPreferences;
  currentVisionModel: string;
  visionModelOptions: SelectOption[];
  currentTaskModel: string;
  autoTitleTaskModelOptions: SelectOption[];
  onModelChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onSystemMessageChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSystemMessageSave: () => void;
  onAutoTitleChange: (autoTitle: boolean) => void;
  onAutoTitleTaskModelChange: (taskModel: string) => void;
  onVisionModelChange: (visionModel: string) => void;
}

export function SettingsModelsTab({
  models,
  selectedModel,
  selectedProviderType,
  selectedProviderId,
  systemMessage,
  tempSystemMessage,
  loading,
  preferences,
  currentVisionModel,
  visionModelOptions,
  currentTaskModel,
  autoTitleTaskModelOptions,
  onModelChange,
  onSystemMessageChange,
  onSystemMessageSave,
  onAutoTitleChange,
  onAutoTitleTaskModelChange,
  onVisionModelChange,
}: SettingsModelsTabProps) {
  const { user, systemInfo } = useAuthStore();
  const isSettingsAdmin =
    user?.role === 'admin' || systemInfo?.requiresAuth === false;
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
      </div>

      {isSettingsAdmin && (
        <div className='rounded-lg border border-gray-200 dark:border-dark-300 bg-white dark:bg-dark-100 p-4'>
          <SettingsModelCatalog />
        </div>
      )}
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
