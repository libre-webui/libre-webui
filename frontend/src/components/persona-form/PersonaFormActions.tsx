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
import { Check } from 'lucide-react';
import type { Persona } from '@/types';
import { Button } from '@/components/ui/Button';

interface PersonaFormActionsProps {
  persona: Persona | null;
  submitting: boolean;
  saveAndClose: boolean;
  lastSaved: Date | null;
  onCancel: () => void;
  onSave: () => void;
  onSaveAndClose: () => void;
}

export function PersonaFormActions({
  persona,
  submitting,
  saveAndClose,
  lastSaved,
  onCancel,
  onSave,
  onSaveAndClose,
}: PersonaFormActionsProps) {
  const { t } = useTranslation();

  return (
    <div className='flex items-center justify-between'>
      <Button
        type='button'
        variant='ghost'
        onClick={onCancel}
        disabled={submitting}
        className='text-gray-600 dark:text-gray-400'
      >
        {t('personaForm.actions.cancel')}
      </Button>

      <div className='flex items-center gap-3'>
        {lastSaved && (
          <div className='flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400'>
            <Check className='h-4 w-4' />
            <span>{t('personaForm.saved')}</span>
          </div>
        )}
        <Button
          type='button'
          variant='outline'
          onClick={onSave}
          disabled={submitting}
        >
          {submitting && !saveAndClose
            ? t('personaForm.actions.saving')
            : t('personaForm.actions.save')}
        </Button>
        <Button type='button' onClick={onSaveAndClose} disabled={submitting}>
          {submitting && saveAndClose
            ? t('personaForm.actions.saving')
            : persona
              ? t('personaForm.actions.saveClose')
              : t('personaForm.actions.create')}
        </Button>
      </div>
    </div>
  );
}
