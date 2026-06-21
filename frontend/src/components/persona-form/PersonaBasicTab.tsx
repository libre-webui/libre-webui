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

import { useTranslation } from 'react-i18next';
import { AvatarUpload } from '@/components/AvatarUpload';
import { PersonaBackgroundUpload } from '@/components/PersonaBackgroundUpload';
import type { OllamaModel, PersonaParameters } from '@/types';
import type { ExtendedFormData } from './types';

interface PersonaBasicTabProps {
  formData: ExtendedFormData;
  availableModels: OllamaModel[];
  onFieldChange: <K extends keyof ExtendedFormData>(
    key: K,
    value: ExtendedFormData[K]
  ) => void;
  onParameterChange: (
    key: keyof PersonaParameters,
    value: string | number
  ) => void;
}

export function PersonaBasicTab({
  formData,
  availableModels,
  onFieldChange,
  onParameterChange,
}: PersonaBasicTabProps) {
  const { t } = useTranslation();

  return (
    <div className='space-y-6'>
      <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
            {t('personaForm.basic.name')} *
          </label>
          <input
            type='text'
            value={formData.name}
            onChange={e => onFieldChange('name', e.target.value)}
            className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors'
            placeholder={t('personaForm.basic.namePlaceholder')}
            required
          />
        </div>

        <div>
          <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
            {t('personaForm.basic.model')} *
          </label>
          <select
            value={formData.model}
            onChange={e => onFieldChange('model', e.target.value)}
            className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors'
            required
          >
            <option value=''>{t('personaForm.basic.selectModel')}</option>
            {availableModels.map(model => (
              <option key={model.name} value={model.name}>
                {model.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
          {t('personaForm.basic.description')}
        </label>
        <textarea
          value={formData.description}
          onChange={e => onFieldChange('description', e.target.value)}
          className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors resize-none'
          rows={3}
          placeholder={t('personaForm.basic.descriptionPlaceholder')}
        />
      </div>

      <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
        <AvatarUpload
          value={formData.avatar || ''}
          onChange={url => onFieldChange('avatar', url)}
        />
        <PersonaBackgroundUpload
          value={formData.background || ''}
          onChange={url => onFieldChange('background', url)}
        />
      </div>

      <div>
        <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
          {t('personaForm.basic.systemPrompt')}
        </label>
        <textarea
          value={formData.parameters.system_prompt}
          onChange={e => onParameterChange('system_prompt', e.target.value)}
          className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors resize-none font-mono text-sm'
          rows={6}
          placeholder={t('personaForm.basic.systemPromptPlaceholder')}
        />
        <p className='text-xs text-gray-500 dark:text-dark-600 mt-2'>
          {t('personaForm.basic.systemPromptHint')}
        </p>
      </div>
    </div>
  );
}
