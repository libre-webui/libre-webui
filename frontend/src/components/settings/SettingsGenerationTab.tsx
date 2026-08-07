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

import { Check, ChevronDown, RotateCcw } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Select } from '@/components/ui';
import { cn } from '@/utils';
import type {
  EmbeddingStatus,
  GenerationOptions,
  UserPreferences,
} from '@/types';
import { SettingsToggle } from './SettingsToggle';

type EmbeddingSettings = UserPreferences['embeddingSettings'];

interface SelectOption {
  value: string;
  label: string;
}

/** Which stored settings the tab reads and writes. */
export type GenerationScope = 'global' | 'model';

interface SettingsGenerationTabProps {
  generationOptions: GenerationOptions;
  generationScope: GenerationScope;
  /** The model a per-model scope would pin to, when one is selected. */
  scopedModel?: string;
  onGenerationScopeChange: (scope: GenerationScope) => void;
  embeddingSettings: EmbeddingSettings;
  effectiveEmbeddingSettings: EmbeddingSettings;
  embeddingModelOptions: SelectOption[];
  embeddingStatus: EmbeddingStatus | null;
  onGenerationOptionChange: (
    key: keyof GenerationOptions,
    value: string | number | boolean | string[] | undefined
  ) => void;
  onEmbeddingSettingsChange: (
    key: keyof EmbeddingSettings,
    value: string | number | boolean
  ) => void;
  onResetGenerationOptions: () => void;
  onSaveGenerationOptions: () => void;
  onResetEmbeddingSettings: () => void;
  onSaveEmbeddingSettings: () => void;
}

export function SettingsGenerationTab({
  generationOptions,
  generationScope,
  scopedModel,
  onGenerationScopeChange,
  embeddingSettings,
  effectiveEmbeddingSettings,
  embeddingModelOptions,
  embeddingStatus,
  onGenerationOptionChange,
  onEmbeddingSettingsChange,
  onResetGenerationOptions,
  onSaveGenerationOptions,
  onResetEmbeddingSettings,
  onSaveEmbeddingSettings,
}: SettingsGenerationTabProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedPanelId = useId();
  const scopeSelectId = useId();

  // A model can only be pinned when one is actually selected.
  const scopeOptions = [
    { value: 'global', label: t('settings.generation.scopeAll') },
    ...(scopedModel
      ? [
          {
            value: 'model',
            label: t('settings.generation.scopeModel', { model: scopedModel }),
          },
        ]
      : []),
  ];

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4'>
          {t('settings.generation.title')}
        </h3>
        <p className='text-sm text-gray-600 dark:text-gray-400 mb-4'>
          {t('settings.generation.description')}
        </p>

        {/* Without this, a save silently pinned whatever model the chat was on,
            and the values every other model falls back to could not be reached. */}
        <div className='mb-6 rounded-lg border border-gray-200 bg-white p-4 dark:border-dark-300 dark:bg-dark-100'>
          <label
            htmlFor={scopeSelectId}
            className='mb-2 block text-sm font-medium text-gray-900 dark:text-gray-100'
          >
            {t('settings.generation.scopeLabel')}
          </label>
          <Select
            id={scopeSelectId}
            value={generationScope}
            onChange={event =>
              onGenerationScopeChange(event.target.value as GenerationScope)
            }
            options={scopeOptions}
          />
          <p className='mt-2 text-xs text-gray-500 dark:text-gray-400'>
            {generationScope === 'model'
              ? t('settings.generation.scopeModelHint')
              : t('settings.generation.scopeAllHint')}
          </p>
        </div>

        <div className='rounded-lg border border-gray-200 bg-white dark:border-dark-300 dark:bg-dark-100'>
          <button
            type='button'
            aria-expanded={advancedOpen}
            aria-controls={advancedPanelId}
            onClick={() => setAdvancedOpen(open => !open)}
            className='flex w-full items-center justify-between gap-4 p-4 text-left'
          >
            <span>
              <span className='block text-sm font-medium text-gray-900 dark:text-gray-100'>
                {t('settings.generation.advancedSettings')}
              </span>
              <span className='mt-1 block text-xs text-gray-500 dark:text-gray-400'>
                {t('settings.generation.advancedSettingsDescription')}
              </span>
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 flex-shrink-0 text-gray-500 transition-transform',
                advancedOpen && 'rotate-180'
              )}
            />
          </button>

          {advancedOpen && (
            <div
              id={advancedPanelId}
              className='space-y-6 border-t border-gray-200 p-4 dark:border-dark-300'
            >
              <GenerationSection
                title={t('settings.generation.coreParameters')}
              >
                <NumberSetting
                  label={t('settings.generation.temperature')}
                  hint='(0.0-2.0)'
                  min={0}
                  max={2}
                  step={0.1}
                  value={generationOptions.temperature}
                  placeholder='0.8'
                  description={t('settings.generation.temperatureDescription')}
                  onChange={value =>
                    onGenerationOptionChange('temperature', value)
                  }
                />
                <NumberSetting
                  label={t('settings.generation.topP')}
                  hint='(0.0-1.0)'
                  min={0}
                  max={1}
                  step={0.05}
                  value={generationOptions.top_p}
                  placeholder='0.9'
                  description={t('settings.generation.topPDescription')}
                  onChange={value => onGenerationOptionChange('top_p', value)}
                />
                <NumberSetting
                  label={t('settings.generation.topK')}
                  hint='(1-100)'
                  min={1}
                  max={100}
                  value={generationOptions.top_k}
                  placeholder='40'
                  integer
                  description={t('settings.generation.topKDescription')}
                  onChange={value => onGenerationOptionChange('top_k', value)}
                />
                <NumberSetting
                  label={t('settings.generation.minP')}
                  hint='(0.0-1.0)'
                  min={0}
                  max={1}
                  step={0.05}
                  value={generationOptions.min_p}
                  placeholder='0.0'
                  description={t('settings.generation.minPDescription')}
                  onChange={value => onGenerationOptionChange('min_p', value)}
                />
              </GenerationSection>

              <GenerationSection
                title={t('settings.generation.generationControl')}
              >
                <NumberSetting
                  label={t('settings.generation.maxTokens')}
                  min={-1}
                  max={4096}
                  value={generationOptions.num_predict}
                  placeholder='128'
                  integer
                  description={t('settings.generation.maxTokensDescription')}
                  onChange={value =>
                    onGenerationOptionChange('num_predict', value)
                  }
                />
                <NumberSetting
                  label={t('settings.generation.repeatPenalty')}
                  hint='(0.0-2.0)'
                  min={0}
                  max={2}
                  step={0.1}
                  value={generationOptions.repeat_penalty}
                  placeholder='1.1'
                  description={t(
                    'settings.generation.repeatPenaltyDescription'
                  )}
                  onChange={value =>
                    onGenerationOptionChange('repeat_penalty', value)
                  }
                />
                <NumberSetting
                  label={t('settings.generation.contextLength')}
                  min={512}
                  max={32768}
                  step={512}
                  value={generationOptions.num_ctx}
                  placeholder='2048'
                  integer
                  description={t(
                    'settings.generation.contextLengthDescription'
                  )}
                  onChange={value => onGenerationOptionChange('num_ctx', value)}
                />
                <NumberSetting
                  label={t('settings.generation.seed')}
                  hint={`(${t('settings.generation.optional')})`}
                  value={generationOptions.seed}
                  placeholder={t('settings.generation.random')}
                  integer
                  description={t('settings.generation.seedDescription')}
                  onChange={value => onGenerationOptionChange('seed', value)}
                />
              </GenerationSection>

              <GenerationSection
                title={t('settings.generation.advancedOptions')}
              >
                <NumberSetting
                  label={t('settings.generation.presencePenalty')}
                  hint='(-2.0-2.0)'
                  min={-2}
                  max={2}
                  step={0.1}
                  value={generationOptions.presence_penalty}
                  placeholder='0.0'
                  description={t(
                    'settings.generation.presencePenaltyDescription'
                  )}
                  onChange={value =>
                    onGenerationOptionChange('presence_penalty', value)
                  }
                />
                <NumberSetting
                  label={t('settings.generation.frequencyPenalty')}
                  hint='(-2.0-2.0)'
                  min={-2}
                  max={2}
                  step={0.1}
                  value={generationOptions.frequency_penalty}
                  placeholder='0.0'
                  description={t(
                    'settings.generation.frequencyPenaltyDescription'
                  )}
                  onChange={value =>
                    onGenerationOptionChange('frequency_penalty', value)
                  }
                />

                <div className='md:col-span-2'>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                    {t('settings.generation.stopSequences')}
                    <span className='text-xs text-gray-500 ms-1'>
                      ({t('settings.generation.commaSeparated')})
                    </span>
                  </label>
                  <input
                    type='text'
                    value={generationOptions.stop?.join(', ') ?? ''}
                    onChange={event =>
                      onGenerationOptionChange(
                        'stop',
                        event.target.value
                          ? event.target.value
                              .split(',')
                              .map(sequence => sequence.trim())
                              .filter(Boolean)
                          : undefined
                      )
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
                    placeholder='\\n, ###, STOP'
                  />
                  <p className='text-xs text-gray-500 mt-1'>
                    {t('settings.generation.stopSequencesDescription')}
                  </p>
                </div>
              </GenerationSection>

              <div className='flex justify-between items-center pt-4 border-t border-gray-200 dark:border-dark-300'>
                <Button
                  onClick={onResetGenerationOptions}
                  variant='outline'
                  className='flex items-center gap-2'
                >
                  <RotateCcw size={16} />
                  {t('settings.generation.resetDefaults')}
                </Button>
                <Button
                  onClick={onSaveGenerationOptions}
                  className='flex items-center gap-2'
                >
                  <Check size={16} />
                  {t('settings.generation.saveOptions')}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className='mt-6'>
          <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              {t('settings.generation.embeddingSettings')}
            </label>
            <div className='space-y-4'>
              <div className='flex items-center justify-between'>
                <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                  {t('settings.generation.enableEmbeddings')}
                </span>
                <SettingsToggle
                  checked={embeddingSettings.enabled}
                  onChange={checked =>
                    onEmbeddingSettingsChange('enabled', checked)
                  }
                />
              </div>

              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                  {t('settings.documents.embeddings.model')}
                </label>
                <Select
                  value={effectiveEmbeddingSettings.model}
                  onChange={event =>
                    onEmbeddingSettingsChange('model', event.target.value)
                  }
                  options={embeddingModelOptions}
                  disabled={!embeddingSettings.enabled}
                />
              </div>

              <EmbeddingNumberSetting
                label={t('settings.documents.embeddings.chunkSize')}
                hint={t('settings.documents.embeddings.chunkSizeInTokens')}
                value={embeddingSettings.chunkSize}
                min={1}
                disabled={!embeddingSettings.enabled}
                onChange={value =>
                  onEmbeddingSettingsChange('chunkSize', value)
                }
              />
              <EmbeddingNumberSetting
                label={t('settings.documents.embeddings.chunkOverlap')}
                hint={t('settings.documents.embeddings.chunkOverlapInTokens')}
                value={embeddingSettings.chunkOverlap}
                min={0}
                disabled={!embeddingSettings.enabled}
                onChange={value =>
                  onEmbeddingSettingsChange('chunkOverlap', value)
                }
              />
              <EmbeddingNumberSetting
                label={t('settings.documents.embeddings.similarityThreshold')}
                value={embeddingSettings.similarityThreshold}
                min={0}
                max={1}
                step={0.01}
                disabled={!embeddingSettings.enabled}
                onChange={value =>
                  onEmbeddingSettingsChange('similarityThreshold', value)
                }
              />
            </div>

            {embeddingStatus && (
              <div className='mt-4'>
                <div className='flex items-center justify-between text-sm'>
                  <span className='text-gray-700 dark:text-gray-300'>
                    {t('settings.documents.embeddings.status')}:
                  </span>
                  <span className='font-medium text-gray-900 dark:text-gray-100'>
                    {embeddingStatus.available
                      ? t('settings.documents.embeddings.available')
                      : t('settings.documents.embeddings.unavailable')}
                  </span>
                </div>
                {embeddingStatus.available && (
                  <div className='flex items-center justify-between text-sm mt-1'>
                    <span className='text-gray-700 dark:text-gray-300'>
                      {t('settings.documents.embeddings.chunksWithEmbeddings')}:
                    </span>
                    <span className='font-medium text-gray-900 dark:text-gray-100'>
                      {embeddingStatus.chunksWithEmbeddings} /{' '}
                      {embeddingStatus.totalChunks}
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className='flex justify-between items-center mt-4'>
              <Button
                onClick={onResetEmbeddingSettings}
                variant='outline'
                className='flex items-center gap-2'
              >
                <RotateCcw size={16} />
                {t('settings.generation.resetDefaults')}
              </Button>
              <Button
                onClick={onSaveEmbeddingSettings}
                className='flex items-center gap-2'
              >
                <Check size={16} />
                {t('settings.saveSettings')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface GenerationSectionProps {
  title: string;
  children: ReactNode;
}

function GenerationSection({ title, children }: GenerationSectionProps) {
  return (
    <div className='bg-white dark:bg-dark-100 rounded-lg p-4 border border-gray-200 dark:border-dark-300'>
      <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-4'>
        {title}
      </h4>
      <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>{children}</div>
    </div>
  );
}

interface NumberSettingProps {
  label: string;
  value?: number;
  placeholder: string;
  description: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  onChange: (value: number | undefined) => void;
}

function NumberSetting({
  label,
  value,
  placeholder,
  description,
  hint,
  min,
  max,
  step,
  integer = false,
  onChange,
}: NumberSettingProps) {
  return (
    <div>
      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
        {label}
        {hint && <span className='text-xs text-gray-500 ms-1'>{hint}</span>}
      </label>
      <input
        type='number'
        min={min}
        max={max}
        step={step}
        value={value ?? ''}
        placeholder={placeholder}
        onChange={event =>
          onChange(
            event.target.value
              ? integer
                ? parseInt(event.target.value)
                : parseFloat(event.target.value)
              : undefined
          )
        }
        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
      />
      <p className='text-xs text-gray-500 mt-1'>{description}</p>
    </div>
  );
}

interface EmbeddingNumberSettingProps {
  label: string;
  value: number;
  min: number;
  max?: number;
  step?: number;
  hint?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}

function EmbeddingNumberSetting({
  label,
  value,
  min,
  max,
  step,
  hint,
  disabled,
  onChange,
}: EmbeddingNumberSettingProps) {
  return (
    <div>
      <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
        {label}
        {hint && <span className='text-xs text-gray-500 ms-1'>{hint}</span>}
      </label>
      <input
        type='number'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md focus:ring-2 focus:ring-primary-500 focus:border-transparent bg-white dark:bg-dark-200 text-gray-900 dark:text-gray-100'
        disabled={disabled}
      />
    </div>
  );
}
