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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePlus2, Pencil, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  Button,
  IconAction,
  ModalShell,
  Switch,
  modalFieldClass,
  modalLabelClass,
} from '@/components/ui';
import { skillsApi } from '@/utils/api';
import type {
  Skill,
  SkillFileSummary,
  SkillInput,
} from '@/utils/api/skillsApi';

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

      {skill && <SkillFilesEditor skillId={skill.id} />}
    </ModalShell>
  );
}

/**
 * Companion files bundled with the skill. Edits apply immediately through
 * the files endpoints — they are per-file resources, not part of the
 * versioned instruction document.
 */
function SkillFilesEditor({ skillId }: { skillId: string }) {
  const { t } = useTranslation();
  const [files, setFiles] = useState<SkillFileSummary[] | null>(null);
  /** null: closed; '': adding a new file; otherwise the path being edited. */
  const [editorFor, setEditorFor] = useState<string | null>(null);
  const [draftPath, setDraftPath] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    skillsApi
      .listFiles(skillId)
      .then(response =>
        setFiles(response.success && response.data ? response.data : [])
      )
      .catch(() => setFiles([]));
  }, [skillId]);
  useEffect(() => {
    load();
  }, [load]);

  const openEditor = async (path: string | null) => {
    if (path === null) {
      setEditorFor('');
      setDraftPath('');
      setDraftContent('');
      return;
    }
    try {
      const response = await skillsApi.getFile(skillId, path);
      if (!response.success || !response.data) throw new Error(response.error);
      setEditorFor(path);
      setDraftPath(path);
      setDraftContent(response.data.content);
    } catch {
      toast.error(t('skillsPage.files.loadFailed'));
    }
  };

  const saveDraft = async () => {
    const path = draftPath.trim();
    if (!path) return;
    setBusy(true);
    try {
      const response = await skillsApi.putFile(skillId, path, draftContent);
      if (!response.success) throw new Error(response.error);
      if (editorFor && editorFor !== path) {
        await skillsApi.deleteFile(skillId, editorFor);
      }
      setEditorFor(null);
      load();
    } catch (error) {
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('skillsPage.files.saveFailed')
      );
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async (path: string) => {
    try {
      const response = await skillsApi.deleteFile(skillId, path);
      if (!response.success) throw new Error(response.error);
      if (editorFor === path) setEditorFor(null);
      load();
    } catch {
      toast.error(t('skillsPage.files.deleteFailed'));
    }
  };

  return (
    <div
      className='rounded-xl border border-black/[0.06] px-3 py-2.5 dark:border-white/[0.07]'
      data-testid='skill-files'
    >
      <div className='flex items-center justify-between gap-4'>
        <div>
          <p className='text-[13px] font-medium text-gray-900 dark:text-dark-900'>
            {t('skillsPage.files.title')}
          </p>
          <p className='text-[11px] text-gray-400 dark:text-dark-500'>
            {t('skillsPage.files.hint')}
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          onClick={() => void openEditor(null)}
          data-testid='skill-file-add'
        >
          <FilePlus2 className='me-1.5 h-3.5 w-3.5' />
          {t('skillsPage.files.add')}
        </Button>
      </div>

      {files && files.length > 0 && (
        <ul className='mt-2 space-y-1'>
          {files.map(file => (
            <li
              key={file.path}
              data-testid='skill-file-row'
              className='flex items-center gap-2 rounded-lg bg-black/[0.03] px-2 py-1.5 dark:bg-white/[0.04]'
            >
              <code
                className='min-w-0 flex-1 truncate text-[12px] text-gray-700 dark:text-dark-800'
                dir='ltr'
              >
                {file.path}
              </code>
              <span className='shrink-0 text-[11px] text-gray-400 dark:text-dark-500'>
                {file.size} B
              </span>
              <IconAction
                icon={Pencil}
                label={t('common.edit')}
                testId='skill-file-edit'
                onClick={() => void openEditor(file.path)}
              />
              <IconAction
                icon={Trash2}
                label={t('common.delete')}
                testId='skill-file-delete'
                destructive
                onClick={() => void removeFile(file.path)}
              />
            </li>
          ))}
        </ul>
      )}
      {files && files.length === 0 && editorFor === null && (
        <p className='mt-2 text-[11px] text-gray-400 dark:text-dark-500'>
          {t('skillsPage.files.empty')}
        </p>
      )}

      {editorFor !== null && (
        <div className='mt-2 space-y-2' data-testid='skill-file-editor'>
          <input
            type='text'
            value={draftPath}
            onChange={event => setDraftPath(event.target.value)}
            placeholder={t('skillsPage.files.pathPlaceholder')}
            dir='ltr'
            data-testid='skill-file-path'
            className={`${modalFieldClass} font-mono`}
            maxLength={200}
          />
          <textarea
            value={draftContent}
            onChange={event => setDraftContent(event.target.value)}
            placeholder={t('skillsPage.files.contentPlaceholder')}
            rows={6}
            dir='ltr'
            data-testid='skill-file-content'
            className={`${modalFieldClass} font-mono`}
          />
          <div className='flex items-center justify-end gap-2'>
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setEditorFor(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              size='sm'
              disabled={busy || !draftPath.trim()}
              onClick={() => void saveDraft()}
              data-testid='skill-file-save'
            >
              {busy ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
