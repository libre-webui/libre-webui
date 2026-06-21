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
import {
  Brain,
  Clock,
  Database,
  HardDrive,
  RefreshCw,
  Sparkles,
  Trash2,
  TrendingUp,
  Zap,
} from 'lucide-react';
import type { Persona } from '@/types';
import { cn } from '@/utils';
import { ParameterSlider, ToggleSwitch } from './PersonaFormControls';
import type {
  ExtendedFormData,
  MemoryStatus,
  UpdatePersonaSettings,
} from './types';

interface PersonaMemoryTabProps {
  formData: ExtendedFormData;
  persona: Persona | null;
  memoryStatus: MemoryStatus | null;
  loadingMemoryStatus: boolean;
  wipingMemories: boolean;
  onSettingsChange: UpdatePersonaSettings;
  onWipeMemories: () => void;
}

export function PersonaMemoryTab({
  formData,
  persona,
  memoryStatus,
  loadingMemoryStatus,
  wipingMemories,
  onSettingsChange,
  onWipeMemories,
}: PersonaMemoryTabProps) {
  const { t } = useTranslation();

  return (
    <div className='space-y-6'>
      <div className='rounded-xl overflow-hidden border border-emerald-200/50 dark:border-emerald-700/30'>
        <div className='px-5 py-4 bg-gradient-to-r from-emerald-500 to-teal-500 dark:from-emerald-600 dark:to-teal-600'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-3'>
              <div className='w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center'>
                <Database className='h-5 w-5 text-white' />
              </div>
              <div>
                <h3 className='font-semibold text-white'>
                  {t('personaForm.memory.title')}
                </h3>
                <p className='text-xs text-white/80'>
                  {t('personaForm.memory.subtitle')}
                </p>
              </div>
            </div>
            <ToggleSwitch
              label=''
              checked={formData.memory_settings?.enabled || false}
              onChange={checked =>
                onSettingsChange('memory_settings', { enabled: checked })
              }
            />
          </div>
        </div>

        {formData.memory_settings?.enabled && persona?.id && (
          <div className='px-5 py-4 bg-emerald-50 dark:bg-emerald-900/20 border-b border-emerald-100 dark:border-emerald-800/30'>
            {loadingMemoryStatus ? (
              <div className='flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400'>
                <RefreshCw className='h-4 w-4 animate-spin' />
                {t('personaForm.memory.loading')}
              </div>
            ) : memoryStatus ? (
              <div className='grid grid-cols-3 gap-4'>
                <div className='text-center'>
                  <div className='flex items-center justify-center gap-1 text-2xl font-bold text-emerald-700 dark:text-emerald-300'>
                    <Database className='h-5 w-5' />
                    {memoryStatus.memory_count.toLocaleString()}
                  </div>
                  <p className='text-xs text-emerald-600 dark:text-emerald-400'>
                    {t('personaForm.memory.memories')}
                  </p>
                </div>
                <div className='text-center'>
                  <div className='flex items-center justify-center gap-1 text-2xl font-bold text-emerald-700 dark:text-emerald-300'>
                    <HardDrive className='h-5 w-5' />
                    {memoryStatus.size_mb.toFixed(1)}
                  </div>
                  <p className='text-xs text-emerald-600 dark:text-emerald-400'>
                    {t('personaForm.memory.mbUsed')}
                  </p>
                </div>
                <div className='text-center'>
                  <div className='flex items-center justify-center gap-1 text-2xl font-bold text-emerald-700 dark:text-emerald-300'>
                    <Clock className='h-5 w-5' />
                    {memoryStatus.last_backup
                      ? new Date(memoryStatus.last_backup).toLocaleDateString()
                      : t('personaForm.memory.never')}
                  </div>
                  <p className='text-xs text-emerald-600 dark:text-emerald-400'>
                    {t('personaForm.memory.lastBackup')}
                  </p>
                </div>
              </div>
            ) : (
              <p className='text-sm text-emerald-600 dark:text-emerald-400'>
                {t('personaForm.memory.noData')}
              </p>
            )}
          </div>
        )}

        {formData.memory_settings?.enabled && (
          <div className='p-5 bg-white dark:bg-dark-100 space-y-4'>
            <ParameterSlider
              label={t('personaForm.memory.maxMemories')}
              value={formData.memory_settings.max_memories}
              min={100}
              max={10000}
              step={100}
              hint={t('personaForm.memory.maxMemoriesHint')}
              format={v => v.toLocaleString()}
              colorClass='text-emerald-700 dark:text-emerald-300'
              onChange={v =>
                onSettingsChange('memory_settings', { max_memories: v })
              }
            />
            <ParameterSlider
              label={t('personaForm.memory.retention')}
              value={formData.memory_settings.retention_days}
              min={7}
              max={365}
              step={7}
              hint={t('personaForm.memory.retentionHint')}
              format={v => `${Math.round(v)} days`}
              colorClass='text-emerald-700 dark:text-emerald-300'
              onChange={v =>
                onSettingsChange('memory_settings', { retention_days: v })
              }
            />
            <ToggleSwitch
              label={t('personaForm.memory.autoCleanup')}
              checked={formData.memory_settings.auto_cleanup}
              onChange={checked =>
                onSettingsChange('memory_settings', { auto_cleanup: checked })
              }
              colorClass='text-emerald-700 dark:text-emerald-300'
            />

            {persona?.id && memoryStatus && memoryStatus.memory_count > 0 && (
              <div className='pt-4 border-t border-gray-200 dark:border-dark-300'>
                <div className='flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800/30'>
                  <div>
                    <p className='text-sm font-medium text-red-700 dark:text-red-300'>
                      {t('personaForm.memory.wipeAll')}
                    </p>
                    <p className='text-xs text-red-600 dark:text-red-400'>
                      {t('personaForm.memory.wipeCannot')}
                    </p>
                  </div>
                  <button
                    type='button'
                    onClick={onWipeMemories}
                    disabled={wipingMemories}
                    className='px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5'
                  >
                    {wipingMemories ? (
                      <RefreshCw className='h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Trash2 className='h-3.5 w-3.5' />
                    )}
                    {wipingMemories
                      ? t('personaForm.memory.wiping')
                      : t('personaForm.memory.wipeButton')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {!formData.memory_settings?.enabled && (
          <div className='p-5 bg-gray-50 dark:bg-dark-50'>
            <p className='text-sm text-gray-500 dark:text-gray-400 text-center'>
              {t('personaForm.memory.enableHint')}
            </p>
          </div>
        )}
      </div>

      <div className='rounded-xl overflow-hidden border border-primary-200/50 dark:border-primary-700/30'>
        <div className='px-5 py-4 bg-primary-600 dark:bg-primary-600'>
          <div className='flex items-center justify-between'>
            <div className='flex items-center gap-3'>
              <div className='w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center'>
                <TrendingUp className='h-5 w-5 text-white' />
              </div>
              <div>
                <h3 className='font-semibold text-white'>
                  {t('personaForm.learning.title')}
                </h3>
                <p className='text-xs text-white/80'>
                  {t('personaForm.learning.subtitle')}
                </p>
              </div>
            </div>
            <ToggleSwitch
              label=''
              checked={formData.mutation_settings?.enabled || false}
              onChange={checked =>
                onSettingsChange('mutation_settings', { enabled: checked })
              }
            />
          </div>
        </div>

        {formData.mutation_settings?.enabled && (
          <div className='p-5 bg-white dark:bg-dark-100 space-y-5'>
            <div>
              <label className='block text-sm font-medium text-primary-700 dark:text-primary-300 mb-3'>
                {t('personaForm.learning.speed')}
              </label>
              <div className='grid grid-cols-3 gap-3'>
                {[
                  {
                    level: 'low' as const,
                    icon: Zap,
                    label: t('personaForm.learning.slow'),
                    desc: t('personaForm.learning.slowDesc'),
                  },
                  {
                    level: 'medium' as const,
                    icon: TrendingUp,
                    label: t('personaForm.learning.balanced'),
                    desc: t('personaForm.learning.balancedDesc'),
                  },
                  {
                    level: 'high' as const,
                    icon: Sparkles,
                    label: t('personaForm.learning.fast'),
                    desc: t('personaForm.learning.fastDesc'),
                  },
                ].map(({ level, icon: Icon, label, desc }) => (
                  <button
                    key={level}
                    type='button'
                    onClick={() =>
                      onSettingsChange('mutation_settings', {
                        sensitivity: level,
                      })
                    }
                    className={cn(
                      'p-3 rounded-xl text-center transition-all border',
                      formData.mutation_settings?.sensitivity === level
                        ? 'bg-primary-600 border-primary-600 text-white shadow-lg'
                        : 'bg-primary-50 dark:bg-primary-900/20 border-primary-200 dark:border-primary-700/30 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/30'
                    )}
                  >
                    <Icon className='h-5 w-5 mx-auto mb-1' />
                    <p className='text-sm font-medium'>{label}</p>
                    <p className='text-[10px] opacity-70'>{desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <ToggleSwitch
              label={t('personaForm.learning.autoAdapt')}
              checked={formData.mutation_settings.auto_adapt}
              onChange={checked =>
                onSettingsChange('mutation_settings', { auto_adapt: checked })
              }
              colorClass='text-primary-700 dark:text-primary-300'
            />

            <div className='p-4 bg-primary-50 dark:bg-primary-900/20 rounded-xl'>
              <p className='text-xs font-medium text-primary-700 dark:text-primary-300 mb-2 flex items-center gap-1.5'>
                <Brain className='h-3.5 w-3.5' />
                {t('personaForm.learning.whatLearns')}
              </p>
              <div className='grid grid-cols-2 gap-2 text-xs text-primary-600 dark:text-primary-400'>
                <div className='flex items-center gap-1.5'>
                  <div className='w-1 h-1 rounded-full bg-primary-400' />
                  {t('personaForm.learning.conversationTone')}
                </div>
                <div className='flex items-center gap-1.5'>
                  <div className='w-1 h-1 rounded-full bg-primary-400' />
                  {t('personaForm.learning.responseStyle')}
                </div>
                <div className='flex items-center gap-1.5'>
                  <div className='w-1 h-1 rounded-full bg-primary-400' />
                  {t('personaForm.learning.userPreferences')}
                </div>
                <div className='flex items-center gap-1.5'>
                  <div className='w-1 h-1 rounded-full bg-primary-400' />
                  {t('personaForm.learning.topicInterests')}
                </div>
              </div>
            </div>
          </div>
        )}

        {!formData.mutation_settings?.enabled && (
          <div className='p-5 bg-gray-50 dark:bg-dark-50'>
            <p className='text-sm text-gray-500 dark:text-gray-400 text-center'>
              {t('personaForm.learning.enableHint')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
