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
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui';
import { PromptVariablesEditor } from '@/components/prompts/PromptVariablesEditor';
import type {
  Prompt,
  PromptInput,
  PromptVariable,
} from '@/utils/api/promptsApi';

/** Mirrors the backend's slug rule so bad input is caught before the round trip. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface PromptModalProps {
  open: boolean;
  prompt: Prompt | null;
  /** Starter values for a new prompt; ignored while editing an existing one. */
  prefill?: PromptInput | null;
  saving: boolean;
  onClose: () => void;
  onSave: (payload: PromptInput) => void;
}

export function PromptModal({
  open,
  prompt,
  prefill = null,
  saving,
  onClose,
  onSave,
}: PromptModalProps) {
  if (!open) return null;
  return (
    <PromptModalForm
      key={prompt?.id ?? (prefill ? `template-${prefill.slug}` : 'new')}
      prompt={prompt}
      prefill={prefill}
      saving={saving}
      onClose={onClose}
      onSave={onSave}
    />
  );
}

// The guard above remounts this form per target so its state initializes
// directly from props.
function PromptModalForm({
  prompt,
  prefill,
  saving,
  onClose,
  onSave,
}: Omit<PromptModalProps, 'open'>) {
  const { t } = useTranslation();
  const seed = prompt ?? prefill;
  const [slug, setSlug] = useState(seed?.slug ?? '');
  const [title, setTitle] = useState(seed?.title ?? '');
  const [description, setDescription] = useState(seed?.description ?? '');
  const [content, setContent] = useState(seed?.content ?? '');
  const [variables, setVariables] = useState<PromptVariable[]>(
    seed?.variables ?? []
  );
  const [tags, setTags] = useState((seed?.tags ?? []).join(', '));

  const slugValid = SLUG_PATTERN.test(slug.trim());
  const valid =
    slugValid && title.trim().length > 0 && content.trim().length > 0;

  const handleSave = () => {
    if (!valid) return;
    onSave({
      slug: slug.trim(),
      title: title.trim(),
      description: description.trim() || undefined,
      content,
      // Blank rows are the editor's "in progress" state, never a variable.
      variables: variables.filter(variable => variable.name.trim().length > 0),
      tags: tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean),
    });
  };

  return (
    <ModalShell
      titleId='prompt-modal-title'
      title={prompt ? t('promptsPage.editPrompt') : t('promptsPage.newPrompt')}
      onClose={onClose}
      widthClassName='max-w-2xl'
      testId='prompt-modal'
      footer={
        <>
          <Button variant='ghost' size='sm' onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            size='sm'
            onClick={handleSave}
            disabled={saving || !valid}
            data-testid='prompt-save'
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <div className='grid gap-3 sm:grid-cols-2'>
        <div>
          <label htmlFor='prompt-slug' className={modalLabelClass}>
            {t('promptsPage.form.slug')}
          </label>
          <input
            id='prompt-slug'
            data-testid='prompt-slug'
            type='text'
            value={slug}
            onChange={event => setSlug(event.target.value)}
            placeholder={t('promptsPage.form.slugPlaceholder')}
            className={modalFieldClass}
            maxLength={64}
            autoFocus
          />
          <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
            {slug.trim().length > 0 && !slugValid
              ? t('promptsPage.form.slugInvalid')
              : t('promptsPage.form.slugHint')}
          </p>
        </div>
        <div>
          <label htmlFor='prompt-title' className={modalLabelClass}>
            {t('promptsPage.form.title')}
          </label>
          <input
            id='prompt-title'
            data-testid='prompt-title'
            type='text'
            value={title}
            onChange={event => setTitle(event.target.value)}
            placeholder={t('promptsPage.form.titlePlaceholder')}
            className={modalFieldClass}
            maxLength={200}
          />
        </div>
      </div>

      <div>
        <label htmlFor='prompt-description' className={modalLabelClass}>
          {t('promptsPage.form.description')}
        </label>
        <input
          id='prompt-description'
          type='text'
          value={description}
          onChange={event => setDescription(event.target.value)}
          placeholder={t('promptsPage.form.descriptionPlaceholder')}
          className={modalFieldClass}
          maxLength={500}
        />
      </div>

      <div>
        <label htmlFor='prompt-content' className={modalLabelClass}>
          {t('promptsPage.form.content')}
        </label>
        <textarea
          id='prompt-content'
          data-testid='prompt-content'
          value={content}
          onChange={event => setContent(event.target.value)}
          placeholder={t('promptsPage.form.contentPlaceholder')}
          rows={8}
          className={modalFieldClass}
          maxLength={50_000}
        />
        <p className='mt-1 text-[11px] text-gray-400 dark:text-dark-500'>
          {t('promptsPage.form.contentHint')}
        </p>
      </div>

      <PromptVariablesEditor variables={variables} onChange={setVariables} />

      <div>
        <label htmlFor='prompt-tags' className={modalLabelClass}>
          {t('promptsPage.form.tags')}
        </label>
        <input
          id='prompt-tags'
          type='text'
          value={tags}
          onChange={event => setTags(event.target.value)}
          placeholder={t('promptsPage.form.tagsPlaceholder')}
          className={modalFieldClass}
        />
      </div>
    </ModalShell>
  );
}
