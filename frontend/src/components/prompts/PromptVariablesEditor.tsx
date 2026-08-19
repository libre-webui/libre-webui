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

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import { modalFieldClass, modalLabelClass } from '@/components/ui';
import type {
  PromptVariable,
  PromptVariableType,
} from '@/utils/api/promptsApi';

const VARIABLE_TYPES: PromptVariableType[] = [
  'text',
  'number',
  'select',
  'boolean',
];

interface PromptVariablesEditorProps {
  variables: PromptVariable[];
  onChange: (variables: PromptVariable[]) => void;
}

/**
 * Typed declaration of the `{{placeholders}}` used by a prompt. The backend
 * accepts undeclared placeholders, so this editor stays optional: it only
 * adds labels, defaults and select options for the composer to render.
 */
export const PromptVariablesEditor: React.FC<PromptVariablesEditorProps> = ({
  variables,
  onChange,
}) => {
  const { t } = useTranslation();

  const patch = (index: number, updates: Partial<PromptVariable>) =>
    onChange(
      variables.map((variable, position) =>
        position === index ? { ...variable, ...updates } : variable
      )
    );

  return (
    <div>
      <span className={modalLabelClass}>{t('promptsPage.form.variables')}</span>
      <p className='mb-2 text-[11px] text-gray-400 dark:text-dark-500'>
        {t('promptsPage.form.variablesHint')}
      </p>
      <div className='space-y-2'>
        {variables.map((variable, index) => (
          <div
            key={index}
            data-testid='prompt-variable-row'
            className='rounded-xl border border-black/[0.06] bg-black/[0.02] p-2.5 dark:border-white/[0.07] dark:bg-white/[0.03]'
          >
            <div className='flex items-center gap-2'>
              <input
                type='text'
                value={variable.name}
                onChange={event => patch(index, { name: event.target.value })}
                placeholder={t('promptsPage.form.variableName')}
                aria-label={t('promptsPage.form.variableName')}
                className={modalFieldClass}
                maxLength={64}
              />
              <select
                value={variable.type}
                onChange={event =>
                  patch(index, {
                    type: event.target.value as PromptVariableType,
                    options:
                      event.target.value === 'select'
                        ? (variable.options ?? [])
                        : undefined,
                  })
                }
                aria-label={t('promptsPage.form.variableType')}
                className={modalFieldClass}
              >
                {VARIABLE_TYPES.map(type => (
                  <option key={type} value={type}>
                    {t(`promptsPage.variableTypes.${type}`)}
                  </option>
                ))}
              </select>
              <button
                type='button'
                onClick={() =>
                  onChange(
                    variables.filter((_, position) => position !== index)
                  )
                }
                aria-label={t('promptsPage.form.removeVariable')}
                data-testid='prompt-variable-remove'
                className='shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-500/10 hover:text-red-500'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>
            <div className='mt-2 flex items-center gap-2'>
              <input
                type='text'
                value={variable.label ?? ''}
                onChange={event => patch(index, { label: event.target.value })}
                placeholder={t('promptsPage.form.variableLabel')}
                aria-label={t('promptsPage.form.variableLabel')}
                className={modalFieldClass}
                maxLength={120}
              />
              <input
                type='text'
                value={variable.default ?? ''}
                onChange={event =>
                  patch(index, { default: event.target.value })
                }
                placeholder={t('promptsPage.form.variableDefault')}
                aria-label={t('promptsPage.form.variableDefault')}
                className={modalFieldClass}
                maxLength={500}
              />
              <label className='flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] text-gray-600 dark:text-dark-600'>
                <input
                  type='checkbox'
                  checked={variable.required === true}
                  onChange={event =>
                    patch(index, { required: event.target.checked })
                  }
                  className='h-3.5 w-3.5 rounded border-gray-300 dark:border-dark-400'
                />
                {t('promptsPage.form.variableRequired')}
              </label>
            </div>
            {variable.type === 'select' && (
              <input
                type='text'
                value={(variable.options ?? []).join(', ')}
                onChange={event =>
                  patch(index, {
                    options: event.target.value
                      .split(',')
                      .map(option => option.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={t('promptsPage.form.variableOptionsPlaceholder')}
                aria-label={t('promptsPage.form.variableOptions')}
                className={`${modalFieldClass} mt-2`}
              />
            )}
          </div>
        ))}
        <button
          type='button'
          onClick={() =>
            onChange([...variables, { name: '', type: 'text' as const }])
          }
          data-testid='prompt-add-variable'
          className='flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium text-primary-600 transition-colors hover:bg-primary-500/10 dark:text-primary-400'
        >
          <Plus className='h-3.5 w-3.5' />
          {t('promptsPage.form.addVariable')}
        </button>
      </div>
    </div>
  );
};
