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

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PersonaParameters } from '@/types';
import { ParameterSlider } from './PersonaFormControls';
import type { ParameterSliderConfig } from './types';

interface PersonaParametersTabProps {
  parameters: PersonaParameters;
  onParameterChange: (
    key: keyof PersonaParameters,
    value: string | number
  ) => void;
}

export function PersonaParametersTab({
  parameters,
  onParameterChange,
}: PersonaParametersTabProps) {
  const { t } = useTranslation();
  const sliders = useMemo<ParameterSliderConfig[]>(
    () => [
      {
        key: 'temperature',
        label: t('personaForm.parameters.temperature'),
        min: 0,
        max: 2,
        step: 0.1,
        hint: t('personaForm.parameters.temperatureHint'),
        format: (v: number) => v.toFixed(1),
      },
      {
        key: 'top_p',
        label: t('personaForm.parameters.topP'),
        min: 0,
        max: 1,
        step: 0.1,
        hint: t('personaForm.parameters.topPHint'),
        format: (v: number) => v.toFixed(1),
      },
      {
        key: 'top_k',
        label: t('personaForm.parameters.topK'),
        min: 1,
        max: 100,
        step: 1,
        hint: t('personaForm.parameters.topKHint'),
        format: (v: number) => String(Math.round(v)),
      },
      {
        key: 'context_window',
        label: t('personaForm.parameters.contextWindow'),
        min: 128,
        max: 131072,
        step: 128,
        hint: t('personaForm.parameters.contextWindowHint'),
        format: (v: number) => String(Math.round(v)),
      },
      {
        key: 'max_tokens',
        label: t('personaForm.parameters.maxTokens'),
        min: 1,
        max: 8192,
        step: 1,
        hint: t('personaForm.parameters.maxTokensHint'),
        format: (v: number) => String(Math.round(v)),
      },
      {
        key: 'repeat_penalty',
        label: t('personaForm.parameters.repeatPenalty'),
        min: 0.5,
        max: 2,
        step: 0.1,
        hint: t('personaForm.parameters.repeatPenaltyHint'),
        format: (v: number) => v.toFixed(1),
      },
    ],
    [t]
  );

  return (
    <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
      {sliders.map(({ key, label, min, max, step, hint, format }) => (
        <ParameterSlider
          key={key}
          label={label}
          value={(parameters[key] as number) || 0}
          min={min}
          max={max}
          step={step}
          hint={hint}
          format={format}
          onChange={v => onParameterChange(key, v)}
        />
      ))}
    </div>
  );
}
