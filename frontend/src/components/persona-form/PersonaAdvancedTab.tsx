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
import { Database, Info } from 'lucide-react';
import type { EmbeddingModel } from '@/types';

interface PersonaAdvancedTabProps {
  embeddingModel?: string;
  embeddingModels: EmbeddingModel[];
  onEmbeddingModelChange: (modelId: string) => void;
}

export function PersonaAdvancedTab({
  embeddingModel,
  embeddingModels,
  onEmbeddingModelChange,
}: PersonaAdvancedTabProps) {
  const { t } = useTranslation();
  const detectedEmbeddingModels = embeddingModels.filter(
    (model: EmbeddingModel & { isDetectedEmbedding?: boolean }) =>
      model.isDetectedEmbedding
  );
  const otherModels = embeddingModels.filter(
    (model: EmbeddingModel & { isDetectedEmbedding?: boolean }) =>
      !model.isDetectedEmbedding
  );

  return (
    <div className='space-y-6'>
      <div className='rounded-xl p-5 bg-gradient-to-br from-primary-50 to-primary-100/50 dark:from-primary-900/30 dark:to-primary-800/20 border border-primary-200/50 dark:border-primary-700/30'>
        <div className='flex items-center gap-2 mb-4'>
          <Database className='h-5 w-5 text-primary-600 dark:text-primary-400' />
          <h3 className='font-semibold text-primary-900 dark:text-primary-100'>
            {t('personaForm.advanced.embeddingModel')}
          </h3>
        </div>
        <p className='text-xs text-primary-600 dark:text-primary-400 mb-3'>
          {t('personaForm.advanced.embeddingHint')}
        </p>
        <select
          value={embeddingModel}
          onChange={e => onEmbeddingModelChange(e.target.value)}
          className='w-full px-3 py-2.5 border border-primary-200 dark:border-primary-700 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20'
        >
          {embeddingModels.length === 0 ? (
            <option value='' disabled>
              {t('personaForm.advanced.noModels')}
            </option>
          ) : (
            <>
              {detectedEmbeddingModels.length > 0 && (
                <optgroup label={t('personaForm.advanced.embeddingModels')}>
                  {detectedEmbeddingModels.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.description}
                    </option>
                  ))}
                </optgroup>
              )}
              {otherModels.length > 0 && (
                <optgroup label={t('personaForm.advanced.otherModels')}>
                  {otherModels.map(model => (
                    <option key={model.id} value={model.id}>
                      {model.name} - {model.description}
                    </option>
                  ))}
                </optgroup>
              )}
            </>
          )}
        </select>
        {embeddingModels.length === 0 && (
          <div className='mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg'>
            <p className='text-sm text-amber-800 dark:text-amber-200'>
              {t('personaForm.advanced.installHint')}{' '}
              <code className='px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 rounded text-xs'>
                ollama pull nomic-embed-text
              </code>
            </p>
          </div>
        )}
        <p className='text-[10px] text-primary-500 dark:text-primary-500 mt-2'>
          {t('personaForm.advanced.recommended')}
        </p>
      </div>

      <div className='p-4 bg-gray-50 dark:bg-dark-50 rounded-xl border border-gray-200 dark:border-dark-300'>
        <div className='flex items-start gap-3'>
          <Info className='h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0' />
          <div>
            <p className='text-sm font-medium text-gray-700 dark:text-gray-300'>
              {t('personaForm.advanced.aboutTitle')}
            </p>
            <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
              {t('personaForm.advanced.aboutDescription')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
