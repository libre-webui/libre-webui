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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  ModalShell,
  Switch,
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui';
import type { Skill, SkillInput } from '@/utils/api/skillsApi';

/** Mirrors the backend's slug rule so bad input is caught before the round trip. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface SkillModalProps {
  open: boolean;
  skill: Skill | null;
  /** Starter values for a new skill; ignored while editing an existing one. */
  prefill?: SkillInput | null;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: SkillInput) => void;
}

export function SkillModal({
  open,
  skill,
  prefill = null,
  saving,
  onClose,
  onSave,
}: SkillModalProps) {
  if (!open) return null;
  return (
    <SkillModalForm
      key={skill?.id ?? (prefill ? `template-${prefill.slug}` : 'new')}
      skill={skill}
      prefill={prefill}
      saving={saving}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

// The guard above remounts this form per target so its state initializes
// directly from props.
function SkillModalForm({
  skill,
  prefill,
  saving,
  onClose,
  onSave,
}: Omit<SkillModalProps, 'open'>) {
  const { t } = useTranslation();
  const seed = skill ?? prefill;
  const [slug, setSlug] = useState(seed?.slug ?? '');
  const [name, setName] = useState(seed?.name ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [instructions, setInstructions] = useState(seed?.instructions ?? '');
  const [enabled, setEnabled] = useState(seed?.enabled ?? true);

  const slugValid = SLUG_PATTERN.test(slug.trim());
  const valid =
    slugValid &&
    name.trim().length > 0 &&
    description.trim().length > 0 &&
    instructions.trim().length > 0;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      slug: slug.trim(),
      name: name.trim(),
      description: description.trim(),
      instructions,
      enabled,
    });
  };

  return (
    <ModalShell
      titleId='skill-modal-title'
      title={skill ? t('skillsPage.editSkill') : t('skillsPage.newSkill')}
      onClose={onClose}
      widthClassName='max-w-2xl'
      testId='skill-modal'
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size='sm'
            onClick={handleSave}
            disabled={saving || !valid}
            data-testid='skill-save'
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <div>
          <label htmlFor='skill-slug' className={modalLabelClass}>
            {t('skillsPage.form.slug')}
          </label>
          <input
            id='skill-slug'
            data-testid='skill-slug'
            type='text'
            value={slug}
            onChange={event => setSlug(event.target.value)}
            placeholder={t('skillsPage.form.slugPlaceholder')}
            className={modalFieldClass}
            maxLength={64}
            autoFocus
          />
          <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
            {slug.trim().length > 0 && !slugValid
              ? t('skillsPage.form.slugInvalid')
              : t('skillsPage.form.slugHint')}
          </p>
        </div>
        <div>
          <label htmlFor='skill-name' className={modalLabelClass}>
            {t('skillsPage.form.name')}
          </label>
          <input
            id='skill-name'
            data-testid='skill-name'
            type='text'
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder={t('skillsPage.form.namePlaceholder')}
            className={modalFieldClass}
            maxLength={200}
          />
        </div>
      </div>

      <div>
        <label htmlFor='skill-description' className={modalLabelClass}>
          {t('skillsPage.form.description')}
        </label>
        <textarea
          id='skill-description'
          data-testid='skill-description'
          value={description}
          onChange={event => setDescription(event.target.value)}
          placeholder={t('skillsPage.form.descriptionPlaceholder')}
          rows={2}
          className={modalFieldClass}
          maxLength={1000}
        />
        <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
          {t('skillsPage.form.descriptionHint')}
        </p>
      </div>

      <div>
        <label htmlFor='skill-instructions' className={modalLabelClass}>
          {t('skillsPage.form.instructions')}
        </label>
        <textarea
          id='skill-instructions'
          data-testid='skill-instructions'
          value={instructions}
          onChange={event => setInstructions(event.target.value)}
          placeholder={t('skillsPage.form.instructionsPlaceholder')}
          rows={10}
          className={`${modalFieldClass} font-mono`}
          maxLength={50_000}
        />
        <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
          {t('skillsPage.form.instructionsHint')}
        </p>
      </div>

      <div className='flex items-center justify-between gap-4 rounded-xl border border-black/[0.06] px-3 py-2.5 dark:border-white/[0.07]'>
        <div>
          <p className='text-[13px] font-medium text-gray-900 dark:text-dark-900'>
            {t('skillsPage.form.enabled')}
          </p>
          <p className='text-[11px] text-gray-400 dark:text-dark-500'>
            {t('skillsPage.form.enabledHint')}
          </p>
        </div>
        <Switch checked={enabled} onChange={setEnabled} />
      </div>
    </ModalShell>
  );
}
